import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'quarto.' で始める。
const STORE = 'quarto.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'quarto', text: '4つの属性が揃ったら勝ちの対戦パズル' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
//
// クアルト: 16 個のコマ（4 属性 × 2 択）を交互に「相手に渡して」「置く」。
// 縦・横・斜めの 1 列 4 個が、どれか 1 つの属性で揃えば置いた人の勝ち。
//
// コマは 0〜15 の整数で表す。ビットがそのまま属性（0/1 がどちらを指すかに意味はなく、
// 「4 個とも同じビット」であれば揃ったことになる）。
//   bit0: 色（明/暗）  bit1: 高さ（高/低）  bit2: 形（丸/四角）  bit3: 中（なし/あり）

const LINES = [
  [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
  [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
  [0, 5, 10, 15], [3, 6, 9, 12],
];

function lineWins(board, line) {
  const ids = line.map((i) => board[i]);
  if (ids.some((v) => v == null)) return false;
  for (let bit = 0; bit < 4; bit++) {
    const first = (ids[0] >> bit) & 1;
    if (ids.every((v) => ((v >> bit) & 1) === first)) return true;
  }
  return false;
}
function findWinLine(board) {
  return LINES.find((line) => lineWins(board, line)) || null;
}

let G = null; // 対局中の状態。null ならタイトル（モード選択）画面

function newGame(mode) {
  cpuNextGive = null;
  G = { mode, board: Array(16).fill(null), placed: new Set(), given: null, turn: 1, phase: 'give', winner: null, winLine: null };
  render();
  maybeCpuTurn();
}

function playerLabel(p) {
  if (p === 'draw') return '引き分け';
  if (G.mode === 'cpu') return p === 1 ? 'あなた' : 'CPU';
  if (G.mode === 'watch') return p === 1 ? 'CPU 1' : 'CPU 2';
  return p === 1 ? '1人目' : '2人目';
}

// 人・CPU 共通の手
function givePiece(id) {
  G.given = id;
  G.turn = G.turn === 1 ? 2 : 1;
  G.phase = 'place';
  render();
  maybeCpuTurn();
}
function placePiece(cell) {
  G.board[cell] = G.given;
  G.placed.add(G.given);
  G.given = null;
  const line = findWinLine(G.board);
  if (line) { G.winner = G.turn; G.winLine = line; render(); return; }
  if (G.placed.size === 16) { G.winner = 'draw'; render(); return; }
  G.phase = 'give';
  render();
  maybeCpuTurn();
}

// ---- CPU（ai.js を Worker で動かす。置く手と渡すコマを一度に決め、渡すほうは次の手番まで取っておく） ----
const cpu = new Worker('./ai.js', { type: 'module' });
let cpuAsk = 0; // 対局をやり直したあとに、前の局の答えが届いても使わない
let cpuNextGive = null;
function maybeCpuTurn() {
  if (!G || !isCpu(G.turn) || G.winner) return;
  const game = G;
  const wait = G.mode === 'watch' ? 900 : 400; // 見るだけのときは、目で追えるようにゆっくり
  if (G.phase === 'give' && cpuNextGive != null) {
    const id = cpuNextGive;
    cpuNextGive = null;
    setTimeout(() => { if (G === game) givePiece(id); }, wait);
    return;
  }
  const id = ++cpuAsk;
  const started = performance.now();
  cpu.onmessage = (e) => {
    if (e.data.id !== cpuAsk || G !== game) return;
    setTimeout(() => {
      if (G !== game) return;
      if (G.phase === 'place') { cpuNextGive = e.data.give; placePiece(e.data.cell); } else givePiece(e.data.give);
    }, Math.max(0, wait - (performance.now() - started)));
  };
  cpu.postMessage({ id, board: G.board, hand: G.phase === 'place' ? G.given : null, timeMs: 1500 });
}

// ---- 3D の盤（three.js）。ドラッグで回す、ピンチで寄る ----
const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
camera.position.set(0, 8, 7.5);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 18;
controls.maxPolarAngle = Math.PI / 2 - 0.05; // 盤の下にはもぐらない
controls.target.set(0, 0.3, 0);
controls.update();
controls.addEventListener('change', draw);

// 影は付けない。環境光（RoomEnvironment）と弱い向きの光で質感を出す
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 8, 4);
scene.add(sun);

// 木目（灰色の濃淡）。色はマテリアルの color で付ける。上下・左右につながるように周期を整数にする
function woodTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = (y + 9 * Math.sin((2 * Math.PI * x) / S * 2) + 3 * Math.sin((2 * Math.PI * x) / S * 7)) / S;
      const ring = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t * 14), 6);
      const v = 255 * (0.9 - 0.16 * ring + (Math.random() - 0.5) * 0.05);
      const p = (y * S + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}
const GRAIN = woodTexture();
const wood = (color, o = {}) => new THREE.MeshPhysicalMaterial({
  color, map: GRAIN, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35, envMapIntensity: 0.7, side: THREE.DoubleSide, ...o,
});

const board = new THREE.Mesh(new RoundedBoxGeometry(6.6, 0.36, 6.6, 4, 0.14), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

const DESK = new THREE.Group(); // 机の天板と盤の影。ホームでは消す
scene.add(DESK);
// ---- 机の天板。盤の下に木の板を敷き、地平線まで続ける ----
{
  const box = new THREE.Box3().setFromObject(board);
  const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  const S = 1024, PLANK = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  ['#4b3121', '#432b1c', '#503524', '#472f1f'].forEach((col, i) => {
    for (let y = i * PLANK; y < S; y += PLANK * 4) {
      g.save();
      g.beginPath(); g.rect(0, y, S, PLANK); g.clip();
      g.fillStyle = col; g.fillRect(0, y, S, PLANK);
      for (let k = 0; k < 36; k++) { // 木目の線
        const y0 = y + Math.random() * PLANK, a = 2 + Math.random() * 4, f = 60 + Math.random() * 120;
        g.strokeStyle = `rgba(24, 12, 4, ${0.06 + Math.random() * 0.14})`;
        g.lineWidth = 0.5 + Math.random() * 2;
        g.beginPath();
        for (let x = 0; x <= S; x += 16) g.lineTo(x, y0 + a * Math.sin(x / f + k));
        g.stroke();
      }
      g.restore();
      g.fillStyle = 'rgba(0, 0, 0, 0.45)'; g.fillRect(0, y, S, 2); // 板のすき間
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const FAR = 1500; // 地平線まで続いて見える広さ
  tex.repeat.set(FAR / (w * 3.2), FAR / (w * 3.2));
  const table = new THREE.Mesh(new THREE.PlaneGeometry(FAR, FAR),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, envMapIntensity: 0.4 }));
  table.rotation.x = -Math.PI / 2;
  table.position.y = box.min.y - 0.01;
  table.renderOrder = -1;
  DESK.add(table);
  // 盤の落とす影
  const sc = document.createElement('canvas');
  sc.width = sc.height = 256;
  const sg = sc.getContext('2d');
  const shade = sg.createRadialGradient(128, 128, 0, 128, 128, 128 * 0.48);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)'); shade.addColorStop(0.55, 'rgba(0, 0, 0, 0.4)'); shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
  sg.fillStyle = shade; sg.fillRect(0, 0, 256, 256);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 3.2, w * 3.2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(sc), transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = box.min.y - 0.005;
  DESK.add(shadow);
}

// ホーム画面では盤を斜め上からの向きで止め、机を消して宙に浮かべる。対局に入ったら机を戻す
{
  const HOME_CAM = camera.position.clone();
  let wasHome = false;
  const watch = () => {
    const home = !!canvas.offsetParent && !!canvas.closest('.title, #homeBoard');
    if (home !== wasHome) {
      DESK.visible = controls.enabled = !home;
      camera.position.copy(HOME_CAM); controls.update(); draw();
      wasHome = home;
    }
    requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
}

const CELL_COLOR = { base: 0x4a2e1c, open: 0xb08a3a, win: 0xffd35c };
const cellGeo = new THREE.CircleGeometry(0.42, 48);
const grooveGeo = new THREE.RingGeometry(0.42, 0.47, 48);
const GROOVE = new THREE.MeshStandardMaterial({ color: 0x24160d, roughness: 0.9 });
const cellMeshes = [...Array(16).keys()].map((i) => {
  const m = new THREE.Mesh(cellGeo, wood(CELL_COLOR.base, { roughness: 0.7, clearcoat: 0 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((i % 4) - 1.5, 0.004, Math.floor(i / 4) - 1.5);
  m.userData.cell = i;
  const ring = new THREE.Mesh(grooveGeo, GROOVE);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(m.position.x, 0.003, m.position.z);
  scene.add(m, ring);
  return m;
});

const WOOD = [wood(0xead3a8), wood(0x5a3820)];
const WOOD_IN = [wood(0x9c8461, { clearcoat: 0 }), wood(0x2e1c10, { clearcoat: 0 })]; // 溝の底は少し暗く
const HOLE_D = 0.12; // 溝の深さ

// 丸いコマ：断面を回して作る。角は小さく丸め、くぼみは本当に掘る
function roundGeo(h, hollow) {
  const R = 0.34, b = 0.04, rh = 0.15, e = 0.02;
  const pts = [new THREE.Vector2(0, 0)];
  const arc = (cx, cy, r, a0, a1) => { for (let k = 0; k <= 4; k++) { const a = a0 + ((a1 - a0) * k) / 4; pts.push(new THREE.Vector2(cx + r * Math.cos(a), cy + r * Math.sin(a))); } };
  arc(R - b, b, b, -Math.PI / 2, 0);
  arc(R - b, h - b, b, 0, Math.PI / 2);
  if (hollow) { arc(rh + e, h - e, e, Math.PI / 2, Math.PI); pts.push(new THREE.Vector2(rh, h - HOLE_D)); }
  else pts.push(new THREE.Vector2(0, h));
  return new THREE.LatheGeometry(pts, 56);
}
// 四角いコマ：角を丸めた四角を押し出し、ふちを面取りする
function roundRect(half, r) {
  const s = new THREE.Shape();
  s.moveTo(-half + r, -half);
  s.lineTo(half - r, -half); s.quadraticCurveTo(half, -half, half, -half + r);
  s.lineTo(half, half - r); s.quadraticCurveTo(half, half, half - r, half);
  s.lineTo(-half + r, half); s.quadraticCurveTo(-half, half, -half, half - r);
  s.lineTo(-half, -half + r); s.quadraticCurveTo(-half, -half, -half + r, -half);
  return s;
}
function squareGeo(h, hollow) {
  const bv = 0.035;
  const shape = roundRect(0.3 - bv, 0.05);
  if (hollow) shape.holes.push(roundRect(0.13 + bv, 0.03));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: h - 2 * bv, bevelEnabled: true, bevelThickness: bv, bevelSize: bv, bevelSegments: 3, curveSegments: 6 });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bv, 0);
  return geo;
}

function pieceMesh(id) {
  const dark = id & 1;
  const tall = !((id >> 1) & 1);
  const round = !((id >> 2) & 1);
  const hollow = (id >> 3) & 1;
  const h = tall ? 1.1 : 0.55;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(round ? roundGeo(h, hollow) : squareGeo(h, hollow), WOOD[dark]));
  if (hollow) { // 溝の底
    const floor = new THREE.Mesh(round ? new THREE.CircleGeometry(0.15, 40) : new THREE.ShapeGeometry(roundRect(0.13, 0.03)), WOOD_IN[dark]);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = h - HOLE_D;
    g.add(floor);
  }
  return g;
}

// コマは 16 個とも最初から盤に出しておく。まだ置いていないコマは盤のふちの決まった場所に並ぶ
function homePos(id) {
  const k = (id & 3) - 1.5, d = 2.75;
  return [[k, d], [d, -k], [-k, -d], [-d, k]][id >> 2];
}
const pieces = [...Array(16).keys()].map((id) => {
  const m = pieceMesh(id);
  m.traverse((o) => { o.userData.piece = id; });
  scene.add(m);
  return m;
});
// 渡されたコマの足もとの印
const givenMark = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.46, 48), new THREE.MeshBasicMaterial({ color: CELL_COLOR.win }));
givenMark.rotation.x = -Math.PI / 2;
scene.add(givenMark);
const LIFT = 0.35; // 渡されたコマは持ち上げて見せる

// ホーム画面に飾る盤面
const DEMO_BOARD = Array(16).fill(null);
[[0, 5], [5, 10], [6, 3], [9, 14], [10, 0], [15, 9]].forEach(([cell, id]) => { DEMO_BOARD[cell] = id; });
function syncScene() {
  const bd = G ? G.board : DEMO_BOARD;
  pieces.forEach((m, id) => {
    const cell = bd.indexOf(id);
    if (cell >= 0) moveTo(m, cellMeshes[cell].position.x, 0, cellMeshes[cell].position.z);
    else { const [x, z] = homePos(id); moveTo(m, x, G && G.given === id ? LIFT : 0, z); }
  });
  kick();
  givenMark.visible = !!G && G.given != null;
  if (givenMark.visible) { const [x, z] = homePos(G.given); givenMark.position.set(x, 0.004, z); }
  const open = G && canPlace();
  cellMeshes.forEach((m, i) => m.material.color.setHex(
    G && G.winLine && G.winLine.includes(i) ? CELL_COLOR.win : open && G.board[i] == null ? CELL_COLOR.open : CELL_COLOR.base));
  draw();
}

// ---- 動き。動いているあいだだけ毎フレーム描く ----
const anims = new Map(); // コマ → { from, to, t0, dur, arc }
function moveTo(m, x, y, z) {
  const to = new THREE.Vector3(x, y, z);
  if (!m.userData.shown) { m.userData.shown = true; m.position.copy(to); return; } // 最初は飛ばさずに置く
  const a = anims.get(m);
  if (a ? a.to.distanceTo(to) < 1e-3 : m.position.distanceTo(to) < 1e-3) return;
  const d = Math.hypot(to.x - m.position.x, to.z - m.position.z);
  anims.set(m, { from: m.position.clone(), to, t0: performance.now(), dur: Math.min(700, 250 + 120 * d), arc: d > 0.3 ? 0.5 + 0.12 * d : 0 });
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
let raf = 0;
function kick() { if (!raf) raf = requestAnimationFrame(loop); }
function loop(now) {
  anims.forEach((a, m) => {
    const t = Math.min(1, (now - a.t0) / a.dur);
    m.position.lerpVectors(a.from, a.to, ease(t));
    m.position.y += Math.sin(Math.PI * t) * a.arc; // 持ち上げて運び、そっと下ろす
    if (t === 1) anims.delete(m);
  });
  let busy = anims.size > 0;
  if (G && G.given != null && !anims.has(pieces[G.given])) { // 渡されたコマは手に持っているようにゆれる
    pieces[G.given].position.y = LIFT + 0.06 * Math.sin(now / 300);
    busy = true;
  }
  if (G && G.winLine) { // 揃った列のコマが跳ねる
    G.winLine.forEach((c, k) => {
      const m = pieces[G.board[c]];
      if (!anims.has(m)) m.position.y = 0.3 * Math.abs(Math.sin(now / 260 - k * 0.5));
    });
    busy = true;
  }
  draw();
  raf = busy ? requestAnimationFrame(loop) : 0;
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 縦長の画面でも盤の横が切れないように、縦の画角を広げる
  camera.fov = w < h ? (2 * Math.atan(Math.tan((19 * Math.PI) / 180) * (h / w)) * 180) / Math.PI : 38;
  camera.updateProjectionMatrix();
  draw();
}).observe(canvas);

// 動かさずに離したらタップ（ドラッグは回転）
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  downAt = null;
  if (!G || !isInteractive()) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...cellMeshes, ...pieces], true)[0];
  if (!hit) return;
  const id = hit.object.userData.piece;
  if (id != null && !G.placed.has(id) && id !== G.given) { if (G.phase === 'give') givePiece(id); return; }
  const cell = id != null ? G.board.indexOf(id) : hit.object.userData.cell;
  if (canPlace() && cell >= 0 && G.board[cell] == null) placePiece(cell);
});

function isCpu(p) { return G.mode === 'watch' || (G.mode === 'cpu' && p === 2); }
function isInteractive() { return !G.winner && !isCpu(G.turn); }
function canPlace() { return isInteractive() && G.phase === 'place'; }

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  stage.innerHTML = G ? gameHTML() : titleHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  if (G) bindGame(); else bindTitle();
}

function titleHTML() {
  return `
    <div class="title">
      <h2>クアルト</h2>
      <p class="hint">4 属性のどれか 1 つが縦・横・斜めの 1 列に揃えば勝ち</p>
      <div class="board3d" id="board3d"></div>
      <button class="pill pill--big" data-start="cpu">CPU と対戦</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
      <button class="pill pill--big" data-start="watch">CPU 同士の対戦を見る</button>
    </div>`;
}
function bindTitle() {
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.start)));
}

function gameHTML() {
  let status;
  if (G.winner) status = G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  else if (G.phase === 'give') status = `${playerLabel(G.turn)} の番：相手に渡すコマを盤のふちから選ぶ`;
  else status = `${playerLabel(G.turn)} の番：渡されたコマを置く`;

  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
    </div>` : '';

  return `
    <div class="game">
      <div class="game__top"><button class="pill" data-title>← ホーム</button></div>
      <p class="status">${status}</p>
      <div class="board3d" id="board3d"></div>
      <p class="hint">ドラッグで回す・ピンチで寄る</p>
      ${again}
    </div>`;
}

function bindGame() {
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();

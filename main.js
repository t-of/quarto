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

// 斜め上から見た立体のコマ。高さの違いがひと目でわかるように、背の高さをはっきり変える。
function pieceSVG(id, size) {
  const dark = id & 1;
  const tall = !((id >> 1) & 1);
  const round = !((id >> 2) & 1);
  const hollow = (id >> 3) & 1;
  const [top, left, right, line] = dark
    ? ['#6b5340', '#4f3c2c', '#3b2c20', '#1e1610']
    : ['#fbf5e8', '#eadcc0', '#cdbb98', '#8a7a5e'];
  const r = 26;
  const h = tall ? 66 : 30;
  const st = `stroke="${line}" stroke-width="2" stroke-linejoin="round"`;
  let body;
  if (round) {
    const k = 10, by = 106, ty = by - h;
    body = `<path d="M${50 - r} ${ty}V${by}A${r} ${k} 0 0 0 ${50 + r} ${by}V${ty}Z" fill="${left}" ${st}/>`
      + `<path d="M50 ${ty}V${by + k}A${r} ${k} 0 0 0 ${50 + r} ${by}V${ty}Z" fill="${right}"/>`
      + `<path d="M${50 - r} ${ty}V${by}A${r} ${k} 0 0 0 ${50 + r} ${by}V${ty}" fill="none" ${st}/>`
      + `<ellipse cx="50" cy="${ty}" rx="${r}" ry="${k}" fill="${top}" ${st}/>`
      + (hollow ? `<ellipse cx="50" cy="${ty}" rx="${r * 0.45}" ry="${k * 0.45}" fill="${right}" stroke="${line}" stroke-width="1.5"/>`
        + `<ellipse cx="50" cy="${ty + k * 0.12}" rx="${r * 0.36}" ry="${k * 0.3}" fill="${left}"/>` : ''); // 溝：奥の壁と底
  } else {
    const k = 13, ty = 116 - k - h;
    const pt = (x, y) => `${x} ${y}`;
    body = `<path d="M${pt(50 - r, ty)}L${pt(50, ty + k)}V${ty + k + h}L${pt(50 - r, ty + h)}Z" fill="${left}" ${st}/>`
      + `<path d="M${pt(50, ty + k)}L${pt(50 + r, ty)}V${ty + h}L${pt(50, ty + k + h)}Z" fill="${right}" ${st}/>`
      + `<path d="M${pt(50 - r, ty)}L${pt(50, ty + k)}L${pt(50 + r, ty)}L${pt(50, ty - k)}Z" fill="${top}" ${st}/>`
      + (hollow ? `<path d="M${pt(50 - r * 0.45, ty)}L${pt(50, ty + k * 0.45)}L${pt(50 + r * 0.45, ty)}L${pt(50, ty - k * 0.45)}Z" fill="${right}" stroke="${line}" stroke-width="1.5"/>`
        + `<path d="M${pt(50 - r * 0.33, ty + k * 0.12)}L${pt(50, ty + k * 0.45)}L${pt(50 + r * 0.33, ty + k * 0.12)}L${pt(50, ty - k * 0.2)}Z" fill="${left}"/>` : ''); // 溝：奥の壁と底
  }
  return `<svg viewBox="0 0 100 120" width="${size}" height="${size * 1.2}" aria-hidden="true">${body}</svg>`;
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
function remainingPieces() {
  return [...Array(16).keys()].filter((id) => !G.placed.has(id) && id !== G.given);
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
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 6, 5.6);
const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 14;
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

const board = new THREE.Mesh(new RoundedBoxGeometry(4.8, 0.36, 4.8, 4, 0.14), wood(0x6a4329, { clearcoat: 0.5 }));
board.position.y = -0.18;
scene.add(board);

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

const pieceMeshes = new Map(); // マス番号 → コマ
// ホーム画面に飾る盤面
const DEMO_BOARD = Array(16).fill(null);
[[0, 5], [5, 10], [6, 3], [9, 14], [10, 0], [15, 9]].forEach(([cell, id]) => { DEMO_BOARD[cell] = id; });
function syncScene() {
  (G ? G.board : DEMO_BOARD).forEach((id, i) => {
    if (id != null && !pieceMeshes.has(i)) {
      const m = pieceMesh(id);
      m.position.set(cellMeshes[i].position.x, 0, cellMeshes[i].position.z);
      m.traverse((o) => { o.userData.cell = i; });
      scene.add(m);
      pieceMeshes.set(i, m);
    } else if (id == null && pieceMeshes.has(i)) {
      scene.remove(pieceMeshes.get(i));
      pieceMeshes.delete(i);
    }
  });
  const open = G && canPlace();
  cellMeshes.forEach((m, i) => m.material.color.setHex(
    G && G.winLine && G.winLine.includes(i) ? CELL_COLOR.win : open && G.board[i] == null ? CELL_COLOR.open : CELL_COLOR.base));
  draw();
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
  if (!G || !canPlace()) return;
  const r = canvas.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const hit = ray.intersectObjects([...cellMeshes, ...pieceMeshes.values()], true)[0];
  if (hit && G.board[hit.object.userData.cell] == null) placePiece(hit.object.userData.cell);
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
  const interactive = isInteractive();
  let status;
  if (G.winner) status = G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  else if (G.phase === 'give') status = `${playerLabel(G.turn)} の番：相手に渡すコマを選ぶ`;
  else status = `${playerLabel(G.turn)} の番：渡されたコマを置く`;

  const canGive = interactive && G.phase === 'give';
  const tray = remainingPieces().map((id) => `<button class="piece-btn${canGive ? '' : ' piece-btn--off'}" data-piece="${id}" ${canGive ? '' : 'disabled'}>${pieceSVG(id, 32)}</button>`).join('');

  // 枠はいつも置いておく（出たり消えたりすると盤の大きさが変わるため）
  const given = `<div class="given">${G.given != null ? `<span>渡されたコマ</span>${pieceSVG(G.given, 40)}` : ''}</div>`;

  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
    </div>` : '';

  return `
    <div class="game">
      <div class="game__top"><button class="pill" data-title>← ホーム</button></div>
      <p class="status">${status}</p>
      ${given}
      <div class="board3d" id="board3d"></div>
      <p class="hint">ドラッグで回す・ピンチで寄る</p>
      <div class="tray">${tray}</div>
      ${again}
    </div>`;
}

function bindGame() {
  document.querySelectorAll('.piece-btn:not(.piece-btn--off)').forEach((b) => b.addEventListener('click', () => givePiece(Number(b.dataset.piece))));
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
function wouldWin(board, id, cell) {
  const b = board.slice();
  b[cell] = id;
  return !!findWinLine(b);
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
      + (hollow ? `<ellipse cx="50" cy="${ty}" rx="${r * 0.45}" ry="${k * 0.45}" fill="rgba(0,0,0,.45)"/>` : '');
  } else {
    const k = 13, ty = 116 - k - h;
    const pt = (x, y) => `${x} ${y}`;
    body = `<path d="M${pt(50 - r, ty)}L${pt(50, ty + k)}V${ty + k + h}L${pt(50 - r, ty + h)}Z" fill="${left}" ${st}/>`
      + `<path d="M${pt(50, ty + k)}L${pt(50 + r, ty)}V${ty + h}L${pt(50, ty + k + h)}Z" fill="${right}" ${st}/>`
      + `<path d="M${pt(50 - r, ty)}L${pt(50, ty + k)}L${pt(50 + r, ty)}L${pt(50, ty - k)}Z" fill="${top}" ${st}/>`
      + (hollow ? `<path d="M${pt(50 - r * 0.45, ty)}L${pt(50, ty + k * 0.45)}L${pt(50 + r * 0.45, ty)}L${pt(50, ty - k * 0.45)}Z" fill="rgba(0,0,0,.45)"/>` : '');
  }
  return `<svg viewBox="0 0 100 120" width="${size}" height="${size * 1.2}" aria-hidden="true">${body}</svg>`;
}

let G = null; // 対局中の状態。null ならタイトル（モード選択）画面

function newGame(mode) {
  G = { mode, board: Array(16).fill(null), placed: new Set(), given: null, turn: 1, phase: 'give', winner: null, winLine: null };
  render();
  maybeCpuTurn();
}

function playerLabel(p) {
  if (p === 'draw') return '引き分け';
  if (G.mode === 'cpu') return p === 1 ? 'あなた' : 'CPU';
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

// ---- CPU（素直な手: 置けば勝てるなら置く／相手が勝てるコマは渡さない） ----
function maybeCpuTurn() {
  if (!G || G.mode !== 'cpu' || G.turn !== 2 || G.winner) return;
  setTimeout(() => { if (G.phase === 'place') cpuPlace(); else cpuGive(); }, 400);
}
function emptyCells() {
  return G.board.map((v, i) => (v == null ? i : null)).filter((i) => i != null);
}
function remainingPieces() {
  return [...Array(16).keys()].filter((id) => !G.placed.has(id) && id !== G.given);
}
function cpuPlace() {
  const empties = emptyCells();
  const winCell = empties.find((i) => wouldWin(G.board, G.given, i));
  placePiece(winCell != null ? winCell : empties[Math.floor(Math.random() * empties.length)]);
}
function cpuGive() {
  const remaining = remainingPieces();
  const empties = emptyCells();
  const safe = remaining.filter((id) => !empties.some((i) => wouldWin(G.board, id, i)));
  const pool = safe.length ? safe : remaining;
  givePiece(pool[Math.floor(Math.random() * pool.length)]);
}

// ---- 3D の盤（three.js）。ドラッグで回す、ピンチで寄る ----
const canvas = document.createElement('canvas');
canvas.className = 'board3d__canvas';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
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

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3a2e24, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(3, 8, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
scene.add(sun);

const slab = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.3, 4.6), new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.8 }));
slab.position.y = -0.15;
slab.receiveShadow = true;
scene.add(slab);

const CELL_COLOR = { base: 0x3e3026, open: 0x9c7a2e, win: 0xffd35c };
const cellGeo = new THREE.CircleGeometry(0.44, 40);
const cellMeshes = [...Array(16).keys()].map((i) => {
  const m = new THREE.Mesh(cellGeo, new THREE.MeshStandardMaterial({ color: CELL_COLOR.base, roughness: 0.9 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set((i % 4) - 1.5, 0.005, Math.floor(i / 4) - 1.5);
  m.receiveShadow = true;
  m.userData.cell = i;
  scene.add(m);
  return m;
});

const WOOD = [0xeadcc0, 0x4f3c2c].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
const HOLE = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 });
function pieceMesh(id) {
  const dark = id & 1;
  const tall = !((id >> 1) & 1);
  const round = !((id >> 2) & 1);
  const hollow = (id >> 3) & 1;
  const h = tall ? 1.1 : 0.55;
  const g = new THREE.Group();
  const body = new THREE.Mesh(round ? new THREE.CylinderGeometry(0.34, 0.34, h, 40) : new THREE.BoxGeometry(0.6, h, 0.6), WOOD[dark]);
  body.position.y = h / 2;
  body.castShadow = body.receiveShadow = true;
  g.add(body);
  if (hollow) { // 上の面のくぼみ
    const hole = new THREE.Mesh(round ? new THREE.CircleGeometry(0.15, 32) : new THREE.PlaneGeometry(0.26, 0.26), HOLE);
    hole.rotation.x = -Math.PI / 2;
    hole.position.y = h + 0.002;
    g.add(hole);
  }
  return g;
}

const pieceMeshes = new Map(); // マス番号 → コマ
function syncScene() {
  G.board.forEach((id, i) => {
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
  const open = canPlace();
  cellMeshes.forEach((m, i) => m.material.color.setHex(
    G.winLine && G.winLine.includes(i) ? CELL_COLOR.win : open && G.board[i] == null ? CELL_COLOR.open : CELL_COLOR.base));
  draw();
}

function draw() { renderer.render(scene, camera); }
new ResizeObserver(() => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
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

function isInteractive() { return !G.winner && !(G.mode === 'cpu' && G.turn === 2); }
function canPlace() { return isInteractive() && G.phase === 'place'; }

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) { stage.innerHTML = titleHTML(); bindTitle(); return; }
  stage.innerHTML = gameHTML();
  document.getElementById('board3d').appendChild(canvas);
  syncScene();
  bindGame();
}

function titleHTML() {
  return `
    <div class="title">
      <h2>クアルト</h2>
      <p class="hint">4 属性のどれか 1 つが縦・横・斜めの 1 列に揃えば勝ち</p>
      <button class="pill pill--big" data-start="cpu">CPU と対戦</button>
      <button class="pill pill--big" data-start="2p">2人で対戦（1台で交互）</button>
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

  const given = G.given != null ? `<div class="given"><span>渡されたコマ</span>${pieceSVG(G.given, 40)}</div>` : '';

  const again = G.winner ? `
    <div class="result">
      <button class="pill pill--big" data-again>もう一度</button>
      <button class="pill" data-title>モードを選び直す</button>
    </div>` : '';

  return `
    <div class="game">
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

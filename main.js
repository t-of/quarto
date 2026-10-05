'use strict';

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

function pieceSVG(id, size) {
  const dark = id & 1;
  const tall = !((id >> 1) & 1);
  const round = !((id >> 2) & 1);
  const hollow = (id >> 3) & 1;
  const fill = dark ? '#2a2724' : '#f4f1ea';
  const stroke = dark ? '#17140f' : '#b9ad9a';
  const r = tall ? 42 : 30;
  const shape = round
    ? `<circle cx="50" cy="50" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`
    : `<rect x="${50 - r}" y="${50 - r}" width="${r * 2}" height="${r * 2}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`;
  const hole = hollow ? `<circle cx="50" cy="50" r="${r * 0.4}" fill="var(--bg)"/>` : '';
  return `<svg viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">${shape}${hole}</svg>`;
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

// ---- 画面 ----
function render() {
  const stage = document.getElementById('stage');
  if (!G) { stage.innerHTML = titleHTML(); bindTitle(); return; }
  stage.innerHTML = gameHTML();
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
  const interactive = !G.winner && !(G.mode === 'cpu' && G.turn === 2);
  let status;
  if (G.winner) status = G.winner === 'draw' ? '引き分け' : `${playerLabel(G.winner)} の勝ち！`;
  else if (G.phase === 'give') status = `${playerLabel(G.turn)} の番：相手に渡すコマを選ぶ`;
  else status = `${playerLabel(G.turn)} の番：渡されたコマを置く`;

  const cells = G.board.map((id, i) => {
    const win = G.winLine && G.winLine.includes(i);
    const clickable = interactive && G.phase === 'place' && id == null;
    return `<div class="cell${win ? ' cell--win' : ''}${clickable ? ' cell--open' : ''}" data-cell="${i}">${id != null ? pieceSVG(id, 44) : ''}</div>`;
  }).join('');

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
      <div class="board">${cells}</div>
      <div class="tray">${tray}</div>
      ${again}
    </div>`;
}

function bindGame() {
  document.querySelectorAll('.cell--open').forEach((c) => c.addEventListener('click', () => placePiece(Number(c.dataset.cell))));
  document.querySelectorAll('.piece-btn:not(.piece-btn--off)').forEach((b) => b.addEventListener('click', () => givePiece(Number(b.dataset.piece))));
  const again = document.querySelector('[data-again]');
  if (again) again.addEventListener('click', () => newGame(G.mode));
  const title = document.querySelector('[data-title]');
  if (title) title.addEventListener('click', () => { G = null; render(); });
}

render();

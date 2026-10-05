// クアルトの CPU（Web Worker）。1 手 =「置く＋渡す」を 1 段として、αβ 探索を時間いっぱい深くしていく。
// 空きマスが 10 前後まで減ると最後まで読み切るので、そこからは負けない（勝てる局面は必ず勝つ）。
//
// 盤は長さ 16 の配列（空きは null か -1）、コマは 0〜15（ビットが属性）。main.js と同じ表し方。

const LINES = [
  [0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15],
  [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
  [0, 5, 10, 15], [3, 6, 9, 12],
];
const WIN = 1000;

// 「あと 1 個で揃う列」が求める属性を 2 つのマスクにまとめる。
// コマ p を置けば勝てる ⇔ (p & ones) || (~p & zeros)。列ごとの条件の OR がそのまま全体の条件になる。
function threats(b) {
  let ones = 0, zeros = 0;
  for (const line of LINES) {
    let filled = 0, a1 = 15, a0 = 15;
    for (const i of line) {
      const v = b[i];
      if (v >= 0) { filled++; a1 &= v; a0 &= ~v & 15; }
    }
    if (filled === 3) { ones |= a1; zeros |= a0; }
  }
  return [ones, zeros];
}
const deadly = (p, t) => (p & t[0]) || (~p & t[1] & 15);

// Zobrist ハッシュ（32 ビット 2 本を 53 ビットの数にして Map のキーにする）
const rnd = () => (Math.random() * 2 ** 32) >>> 0;
const Z1 = Array.from({ length: 16 * 16 + 16 }, rnd);
const Z2 = Array.from({ length: 16 * 16 + 16 }, rnd);

export function bestMove(board, hand, timeMs = 1500) {
  const b = board.map((v) => (v == null ? -1 : v));
  let avail = 0;
  for (let p = 0; p < 16; p++) avail |= 1 << p;
  for (const v of b) if (v >= 0) avail &= ~(1 << v);
  if (hand != null) avail &= ~(1 << hand);
  let h1 = 0, h2 = 0;
  b.forEach((v, i) => { if (v >= 0) { h1 ^= Z1[i * 16 + v]; h2 ^= Z2[i * 16 + v]; } });

  const tt = new Map(); // key → [depth, value, flag(0 正確 / 1 下限 / 2 上限), bestCell, bestGive]
  const deadline = performance.now() + timeMs;
  let nodes = 0;
  const TIMEOUT = {};

  // 手番の人が hand を持っている局面の評価（手番から見た値）
  function search(hand, avail, depth, alpha, beta, ply) {
    if ((++nodes & 4095) === 0 && performance.now() > deadline) throw TIMEOUT;
    const t = threats(b);
    if (deadly(hand, t)) return WIN - ply;
    if (avail === 0) return 0; // 最後の 1 個を置いて揃わない → 引き分け
    if (depth === 0) return 0;

    const k1 = h1 ^ Z1[256 + hand], k2 = h2 ^ Z2[256 + hand];
    const key = (k1 >>> 0) * 2097152 + (k2 >>> 11);
    const e = tt.get(key);
    let firstCell = -1, firstGive = -1;
    if (e) {
      if (e[0] >= depth) {
        if (e[2] === 0) return e[1];
        if (e[2] === 1 && e[1] >= beta) return e[1];
        if (e[2] === 2 && e[1] <= alpha) return e[1];
      }
      firstCell = e[3]; firstGive = e[4];
    }

    const a0 = alpha;
    let best = -Infinity, bc = -1, bg = -1;
    const cells = order(firstCell, (i) => b[i] < 0);
    outer:
    for (const c of cells) {
      b[c] = hand; h1 ^= Z1[c * 16 + hand]; h2 ^= Z2[c * 16 + hand];
      const t2 = threats(b);
      const gives = order(c === firstCell ? firstGive : -1, (p) => (avail >> p) & 1 && !deadly(p, t2));
      let v;
      if (!gives.length) {
        v = -(WIN - ply - 1); // どれを渡しても相手が揃える
        if (v > best) { best = v; bc = c; bg = lowest(avail); }
      }
      for (const p of gives) {
        v = -search(p, avail & ~(1 << p), depth - 1, -beta, -alpha, ply + 1);
        if (v > best) { best = v; bc = c; bg = p; }
        if (v > alpha) alpha = v;
        if (alpha >= beta) { undo(c, hand); break outer; }
      }
      undo(c, hand);
    }
    tt.set(key, [depth, best, best <= a0 ? 2 : best >= beta ? 1 : 0, bc, bg]);
    return best;
  }
  function undo(c, hand) { b[c] = -1; h1 ^= Z1[c * 16 + hand]; h2 ^= Z2[c * 16 + hand]; }

  // 渡すだけの手番（盤が空のときの最初の 1 手など）
  if (hand == null) {
    const t = threats(b);
    const gives = shuffle([...Array(16).keys()].filter((p) => (avail >> p) & 1 && !deadly(p, t)));
    return { cell: null, give: gives.length ? gives[0] : lowest(avail) };
  }

  const win = b.findIndex((v, i) => v < 0 && wins(b, i, hand));
  if (win >= 0) return { cell: win, give: null };
  if (!avail) return { cell: b.indexOf(-1), give: null }; // 最後の 1 マス

  const empties = b.reduce((n, v) => n + (v < 0), 0);
  let move = null;
  for (let depth = 1; depth <= empties; depth++) {
    try {
      const v = search(hand, avail, depth, -Infinity, Infinity, 0);
      const e = tt.get(rootKey(hand));
      move = { cell: e[3], give: avail ? e[4] : null, value: v, depth };
      if (Math.abs(v) >= WIN - 20) break; // 勝ち負けが決まった
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break;
    }
  }
  return move;

  function rootKey(hand) { return ((h1 ^ Z1[256 + hand]) >>> 0) * 2097152 + ((h2 ^ Z2[256 + hand]) >>> 11); }
}

function wins(b, i, p) {
  b[i] = p;
  const ok = lineWon(b, i);
  b[i] = -1;
  return ok;
}
function lineWon(b, i) {
  return LINES.some((line) => line.includes(i) && line.every((j) => b[j] >= 0)
    && [0, 1, 2, 3].some((bit) => line.every((j) => ((b[j] >> bit) & 1) === ((b[line[0]] >> bit) & 1))));
}
// 0〜15 のうち ok なものを、first を先頭にして並べる（同じ値の手が毎回同じにならないよう残りは混ぜる）
function order(first, ok) {
  const list = shuffle([...Array(16).keys()].filter(ok));
  const i = list.indexOf(first);
  if (i > 0) { list.splice(i, 1); list.unshift(first); }
  return list;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function lowest(mask) { for (let p = 0; p < 16; p++) if ((mask >> p) & 1) return p; return null; }

if (typeof WorkerGlobalScope !== 'undefined') {
  self.onmessage = (e) => self.postMessage({ id: e.data.id, ...bestMove(e.data.board, e.data.hand, e.data.timeMs) });
}

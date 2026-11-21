// Sokoban solver: push-optimal A* over pushes, solved room by room.
//
// Why this beats a plain move-A*: the score is 1,000 points only at the
// push-optimal count P*, and a solution even one push over P* earns under
// half. So the search must minimise pushes, not moves. The levels this
// competition draws are a hallway with rooms off it (3-4 boxes each), and
// a box that leaves its room can never come back, so each room is an
// independent push-optimal subproblem and P* is the sum of the rooms'
// optima. This solver therefore:
//
//   1. cuts the hallway (dead squares of the player's row) out of the
//      floor and takes each connected part holding boxes as a room;
//   2. solves each room with A* over pushes: a state is the sorted box
//      squares plus the player's reachable region (named by its lowest
//      square), the cost is pushes, and the estimate is the cheapest
//      assignment of boxes to goals by true walking distance, which is
//      admissible (one push moves one box one square, so the assignment
//      total can fall by at most one per push) and consistent;
//   3. prunes two deadlocks no solution can leave: a box on a dead square
//      (no pull-back path from any goal reaches it) and a frozen 2x2 block
//      of walls and boxes holding a box off its goal;
//   4. expands every push into the player's shortest walk to the pushing
//      square, and walks on to the next room through the hallway.
//
// Budgets are counts of states, never the wall clock: the two graded runs
// must agree byte for byte, so nothing here reads the time, the
// environment, or any randomness. Node 22 runs this file as it is (plain
// JavaScript in a .ts file, no type syntax to strip).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, in states expanded. The generator keeps a room only when
// its own push search solves it within 250,000 states, and A* with the
// assignment estimate expands a subset of that search's states, so these
// caps sit far above what any drawn room needs.
const ROOM_STATE_CAP = 250_000;
const GLOBAL_STATE_CAP = 500_000;

// [dx, dy, step letter, push letter], in a fixed order: every tie in the
// search and every walk breaks the same way on every run.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/** A level in XSB: width, height, walls, goals, boxes (sorted) and player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The live squares: every square a box can ever be pushed from onto a
 * goal, found by pulling back from the goals over open floor. A box on a
 * square this misses can never reach a goal, whatever the other boxes do.
 */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let i = 0; i < queue.length; i++) {
    const x = queue[i];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const z = y - d;
      if (y < 0 || y >= size || z < 0 || z >= size) continue;
      if (!wall[y] && !wall[z] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The level's rooms: the parts left when the hallway's dead squares are cut out. */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q >= 0 && q < wall.length && !wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the pushing square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after `moves` (case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of `level` within `cap` states: {pushes, moves}
 * (moves in LURD, an upper letter marking a push), or null when the search
 * gives up. A* over pushes with the assignment estimate and the two
 * deadlock prunes; the first solved state popped from the open list is
 * push-optimal because the estimate is consistent.
 */
function solvePushes(level, cap) {
  const { w, h, wall, goals, boxes, player } = level;
  const size = w * h;
  const n = boxes.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(level);
  if (boxes.some((b) => !live[b])) return null;

  // Walking distance from each goal to every square, over walls alone.
  const dist = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let i = 0; i < q.length; i++) {
      for (const [dx, dy] of DIRS) {
        const m = q[i] + dy * w + dx;
        if (m < 0 || m >= size || wall[m] || d[m] >= 0) continue;
        d[m] = d[q[i]] + 1;
        q.push(m);
      }
    }
    return d;
  });

  // The estimate: the cheapest assignment of boxes to goals (exact by
  // permutation while the box count is small, else each box to its nearest
  // goal). An unreachable pairing counts as a huge distance, so it never
  // wins the minimum while a reachable one exists.
  const BIG = 1_000_000;
  let perms = null;
  if (n <= 5) {
    perms = [];
    const idx = goals.map((_, i) => i);
    const build = (a, k) => {
      if (k === a.length) {
        perms.push(a.slice());
        return;
      }
      for (let i = k; i < a.length; i++) {
        [a[k], a[i]] = [a[i], a[k]];
        build(a, k + 1);
        [a[k], a[i]] = [a[i], a[k]];
      }
    };
    build(idx, 0);
  }
  const estimate = (bs) => {
    if (perms !== null) {
      let best = BIG;
      for (const p of perms) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = dist[p[i]][bs[i]];
          sum += d < 0 ? BIG : d;
          if (sum >= best) break;
        }
        if (sum < best) best = sum;
      }
      return best;
    }
    let sum = 0;
    for (const b of bs) {
      let m = BIG;
      for (let j = 0; j < n; j++) {
        const d = dist[j][b];
        if (d >= 0 && d < m) m = d;
      }
      sum += m;
    }
    return sum;
  };

  // Scratch: two stamped arrays for the player's reachable region (the
  // state being expanded, and the region a push would leave), one stack,
  // and the box occupancy mask.
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let tick = 0;

  // The squares the player reaches from `from`, marked in `arr` with a
  // fresh stamp; returns the region's lowest square, which names it.
  const regionLow = (from, arr) => {
    const stamp = ++tick;
    let low = from;
    let sp = 0;
    stack[sp++] = from;
    arr[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp];
      if (p < low) low = p;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (q < 0 || q >= size || wall[q] || occupied[q] || arr[q] === stamp) continue;
        arr[q] = stamp;
        stack[sp++] = q;
      }
    }
    return low;
  };

  // Whether the box just pushed to `t` sits in a frozen 2x2 block: four
  // squares of walls and boxes, a box among them off its goal.
  const frozenBlock = (t) => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      if (a < 0 || a % w === w - 1 || a + w + 1 >= size) continue;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
      if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
      if ((occupied[a] && !goalSet[a]) || (occupied[b] && !goalSet[b])) return true;
      if ((occupied[c] && !goalSet[c]) || (occupied[d] && !goalSet[d])) return true;
    }
    return false;
  };

  // The open list: a binary heap on [f, h, insertion order, state, g].
  const heap = [];
  const heapLess = (a, b) =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  const solved = (bs) => bs.every((b) => goalSet[b]);
  const keyOf = (bs, low) => low + ':' + bs.join(',');

  const sBoxes = [boxes.slice()];
  const sPlayer = [player];
  const sParent = [-1];
  const sPush = [null];
  const sG = [0];
  const best = new Map();
  for (const b of boxes) occupied[b] = 1;
  const low0 = regionLow(player, seen);
  for (const b of boxes) occupied[b] = 0;
  best.set(keyOf(boxes, low0), 0);
  const h0 = estimate(boxes);
  let seq = 0;
  heapPush([h0, h0, seq++, 0, 0]);

  let found = solved(boxes) ? 0 : -1;
  let expanded = 0;
  while (found < 0 && heap.length > 0) {
    const [, , , s, g] = heapPop();
    if (g !== sG[s]) continue; // superseded by a cheaper route to this state
    if (solved(sBoxes[s])) {
      found = s;
      break;
    }
    if (++expanded > cap) return null;
    const bs = sBoxes[s];
    for (const b of bs) occupied[b] = 1;
    regionLow(sPlayer[s], seen);
    const regionStamp = tick;
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k];
        const d = dy * w + dx;
        const t = b + d;
        const behind = b - d;
        if (t < 0 || t >= size || behind < 0 || behind >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[behind] !== regionStamp) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(t);
        let key = null;
        let nb = null;
        if (!frozen) {
          nb = bs.slice();
          nb[bi] = t;
          nb.sort((a, bb) => a - bb);
          const nlow = regionLow(b, mark);
          key = keyOf(nb, nlow);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || key === null) continue;
        const ng = g + 1;
        const prev = best.get(key);
        if (prev !== undefined && sG[prev] <= ng) continue;
        const idx = sBoxes.length;
        best.set(key, idx);
        sBoxes.push(nb);
        sPlayer.push(b);
        sParent.push(s);
        sPush.push({ from: b, to: t, dir: k });
        sG.push(ng);
        const hh = estimate(nb);
        heapPush([ng + hh, hh, seq++, idx, ng]);
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The pushes back to the start, then the moves: walk to each pushing
  // square, then push.
  const chain = [];
  for (let s = found; s > 0; s = sParent[s]) chain.push(s);
  chain.reverse();
  let moves = '';
  let curPlayer = player;
  let curBoxes = boxes.slice();
  for (const s of chain) {
    const { from, to, dir } = sPush[s];
    const step = to - from;
    for (const b of curBoxes) occupied[b] = 1;
    moves += walkTo(level, occupied, curPlayer, from - step);
    for (const b of curBoxes) occupied[b] = 0;
    moves += DIRS[dir][3];
    curPlayer = from;
    curBoxes = sBoxes[s];
  }
  return { pushes: chain.length, moves };
}

/** The whole level solved room by room, or over the whole level when it has no rooms. */
function solveLevel(text) {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let moves = '';
    let player = level.player;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub = {
        w: level.w,
        h: level.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const solved = solvePushes(sub, ROOM_STATE_CAP);
      if (solved === null) {
        const whole = solvePushes(level, GLOBAL_STATE_CAP);
        return whole === null ? '' : whole.moves;
      }
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
    }
    return moves;
  }
  const whole = solvePushes(level, GLOBAL_STATE_CAP);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch (err) {
    console.error(`sokoban: ${id}: ${err instanceof Error ? err.message : String(err)}; writing an empty solution`);
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}

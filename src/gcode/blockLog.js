// Every block the program ran, in the order it ran them.
//
// The moves say where the machine went; they do not say which lines it read
// on the way. S6000 M3, #100 = 5, a WHILE head on its third pass — none of
// them moves anything, and single block on a control stops after each of
// them all the same. So the reader writes down each block as it runs it:
// the line, the file, and how many moves had been made before it. A block's
// own moves are then the ones up to where the next block starts.
//
// Kept in typed arrays, because a loop of a hundred thousand passes is a
// few hundred thousand blocks and an object each is a lot of memory for
// three numbers.

const START = 1024;

export class BlockLog {
  /** @param {number} [limit] blocks kept before the record stops */
  constructor(limit = 1000000) {
    this.count = 0;
    this.limit = limit;
    this.truncated = false;
    this.line = new Int32Array(START);
    this.move = new Int32Array(START);
    this.src = new Int32Array(START);
    /** File names, by index; 0 is the main program. */
    this.sources = [null];
    this.sourceIndex = new Map([[null, 0]]);
  }

  /** A block is about to run. Returns its index, or -1 once the record is full. */
  push(line, move, source) {
    if (this.count >= this.limit) {
      this.truncated = true;
      return -1;
    }
    if (this.count === this.line.length) {
      const grow = (a) => {
        const b = new Int32Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.line = grow(this.line);
      this.move = grow(this.move);
      this.src = grow(this.src);
    }
    let s = this.sourceIndex.get(source ?? null);
    if (s === undefined) {
      s = this.sources.length;
      this.sources.push(source);
      this.sourceIndex.set(source, s);
    }
    const i = this.count++;
    this.line[i] = line;
    this.move[i] = move;
    this.src[i] = s;
    return i;
  }

  /** What the record holds, trimmed, for the program's result. */
  finish() {
    return {
      count: this.count,
      truncated: this.truncated,
      line: this.line.subarray(0, this.count),
      move: this.move.subarray(0, this.count),
      src: this.src.subarray(0, this.count),
      sources: this.sources,
    };
  }
}

/** Block i of a finished log: its line and file. */
export function blockAt(log, i) {
  if (!log || i < 0 || i >= log.count) return null;
  return { line: log.line[i], source: log.sources[log.src[i]] };
}

/** The first move after block i has run: where the machine waits once it has. */
export function moveAfter(log, i, moveCount) {
  if (i < 0) return 0;
  return i + 1 < log.count ? log.move[i + 1] : moveCount;
}

/** The last block whose start is at or before move k (binary search). */
function lastStartingBy(log, k) {
  let lo = 0;
  let hi = log.count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (log.move[mid] <= k) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * The last block that has run, for a machine at the start of move k: the
 * one that made move k − 1. Blocks with no motion between it and move k
 * are still to come, one press each.
 */
export function blockBeforeMove(log, k) {
  return lastStartingBy(log, k - 1);
}

/** The block that makes move k. */
export function blockOfMove(log, k) {
  return lastStartingBy(log, k);
}

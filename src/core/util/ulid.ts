/**
 * Minimal monotonic ULID (https://github.com/ulid/spec): 48-bit ms time +
 * 80-bit randomness, Crockford base32, lexicographically time-sortable —
 * manifest ids sort chronologically by filename. Dependency-free.
 */
import * as crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = 0;
let lastRandom: number[] = [];

export function ulid(now: number = Date.now()): string {
  let time = now;
  if (time === lastTime) {
    // Monotonic within the same millisecond: increment the random part.
    incrementRandom();
  } else {
    lastTime = time;
    lastRandom = [...crypto.randomBytes(16)].slice(0, 16).map((b) => b & 31);
  }

  let timePart = '';
  for (let i = 9; i >= 0; i--) {
    timePart = (ALPHABET[time % 32] as string) + timePart;
    time = Math.floor(time / 32);
  }
  const randomPart = lastRandom.map((v) => ALPHABET[v] as string).join('');
  return timePart + randomPart;
}

function incrementRandom(): void {
  for (let i = lastRandom.length - 1; i >= 0; i--) {
    const v = lastRandom[i] as number;
    if (v < 31) {
      lastRandom[i] = v + 1;
      return;
    }
    lastRandom[i] = 0;
  }
  // Overflow (astronomically unlikely): bump the time base.
  lastTime++;
}

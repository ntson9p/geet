/**
 * A Windows path with its drive letter in upper case (`d:\Code\x` →
 * `D:\Code\x`); any other path as it is. `scripts/vitest.mjs` starts Vitest
 * from this form (vitest-dev/vitest#11872).
 *
 * @param {string} p
 * @returns {string}
 */
export function upperDriveLetter(p) {
  return p.replace(/^[a-z](?=:)/u, (drive) => drive.toUpperCase());
}

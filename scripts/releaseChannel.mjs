/**
 * Which Marketplace channel a version is for (POST-P14cr), by the project's
 * convention (docs/releasing.md): an **odd minor is a pre-release**, an even
 * minor a stable release — `0.1.x` pre-release, `0.2.x` stable, `0.3.x`
 * pre-release… The release workflow's verify job applies the same rule to
 * the tag, and `npm run package` (scripts/package.mjs) to the VSIX.
 *
 * The Marketplace takes `major.minor.patch` only: a semver pre-release or
 * build suffix (`0.1.0-beta.1`) is refused here, before vsce would refuse it.
 *
 * @param {string} version package.json's `version`
 * @returns {'pre-release' | 'stable'}
 */
export function releaseChannel(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (m === null) {
    throw new Error(
      `version "${version}" is not major.minor.patch: the Marketplace takes no pre-release or build suffix ` +
        '(an odd minor makes a pre-release instead)',
    );
  }
  return Number(m[2]) % 2 === 1 ? 'pre-release' : 'stable';
}

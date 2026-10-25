/** Supported toolkit publication tags. Prereleases never advance the stable channel. */
const CORE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const STABLE = new RegExp(`^${CORE}$`);
const RC = new RegExp(`^${CORE}-rc\\.(?:0|[1-9]\\d*)$`);

export type ReleaseDistTag = "latest" | "rc";

export function isStableReleaseTag(version: string): boolean {
  return version.trim() === version && STABLE.test(version);
}

/** Refuse unsupported tag syntax rather than treating a tag as a dev branch. */
export function releaseDistTag(version: string): ReleaseDistTag {
  if (isStableReleaseTag(version)) return "latest";
  if (version.trim() === version && RC.test(version)) return "rc";
  throw new Error(`Unsupported release tag ${JSON.stringify(version)}: expected N.N.N or N.N.N-rc.N.`);
}

// Release-tag arithmetic for the self-update. Deliberately dependency-free so
// it can be run directly by the contract test (`npm run test:selfupdate`).

export const stripV = (s: string): string => s.replace(/^v/, "").trim();

/**
 * true when `a` is a strictly higher semver than `b`.
 *
 * "Strictly higher" is the whole safety rule: the guardian installs a release
 * only when it is genuinely newer, so a channel switch back to stable (whose
 * latest may be older than the develop build in place) parks rather than
 * silently downgrading. Anything unparseable answers false — never deploy on a
 * tag we could not read.
 */
export function isNewer(a: string, b: string): boolean {
  const pa = stripV(a).split(".").map(Number);
  const pb = stripV(b).split(".").map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  if (stripV(a) === "" || stripV(b) === "") return false;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * Newest tag out of a GitHub releases atom feed (entries are newest-first).
 *
 * Used for the `develop` channel, which needs prereleases included — the
 * /releases/latest redirect excludes them, and api.github.com is capped at 60
 * requests/hour per IP on an egress address shared with every other Cloudflare
 * tenant. The feed carries neither limitation.
 */
export function parseAtomTag(xml: string): string | null {
  // ⚠ Anchor on `Repository/{digits}/` — the feed's own top-level <id> is
  //   `tag:github.com,2008:https://github.com/...`, and a looser pattern grabs
  //   that URL instead of the newest release's tag.
  const m = xml.match(
    new RegExp("<id>tag:github\\.com,2008:Repository/\\d+/([^<]+)</id>"),
  );
  const tag = (m?.[1] || "").trim();
  return /^v\d+\.\d+\.\d+/.test(tag) ? tag : null;
}

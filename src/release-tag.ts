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
 * Pick the newest stable release for one component of a monorepo.
 *
 * A monorepo publishes every component's releases in the same repository, so
 * GitHub's own "latest" answers for the whole repo and can name another
 * component's build. Releases carry a tag prefix instead (`Admin/v0.1.2`), and
 * the guardian reads the list (newest first) and takes the first stable release
 * whose tag has that prefix. Drafts, prereleases and malformed tags are skipped.
 *
 * With an empty prefix this is the plain "newest stable vX.Y.Z" rule.
 */
export function pickRelease<T extends { tag_name?: string; prerelease?: boolean; draft?: boolean }>(
  releases: T[],
  prefix: string,
): (T & { tag: string }) | null {
  for (const r of releases) {
    const tag = r.tag_name || "";
    if (r.draft || r.prerelease || !tag.startsWith(prefix)) continue;
    const bare = tag.slice(prefix.length);
    if (/^v\d+\.\d+\.\d+$/.test(bare)) return { ...r, tag: bare };
  }
  return null;
}

/**
 * pickRelease over every page of the releases list, newest page first.
 *
 * ⚠ The guardian used to read only the first page (`per_page=100`). In a
 * monorepo every component releases into the same list, so once a component's
 * newest stable release fell behind 100 newer releases of other components it
 * answered "no stable release" and the update stopped (2026-10-18). Read pages
 * until the release is found or a page comes back short (the last page).
 */
export async function pickReleaseAcrossPages<
  T extends { tag_name?: string; prerelease?: boolean; draft?: boolean },
>(
  fetchPage: (page: number) => Promise<T[]>,
  prefix: string,
  perPage: number,
): Promise<(T & { tag: string }) | null> {
  for (let page = 1; ; page++) {
    const list = await fetchPage(page);
    const picked = pickRelease(list, prefix);
    if (picked) return picked;
    if (list.length < perPage) return null;
  }
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

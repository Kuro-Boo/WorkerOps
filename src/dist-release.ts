/**
 * Pull a signed, version-pinned release from the distribution endpoint.
 *
 * ## Pulled, never pushed
 *
 * This module only looks up which version is offered and fetches a version
 * the guardian named. Nothing can push a release into this guardian.
 * Automatic updates run from `scheduled` (on by default; the owner can switch
 * them off), and the owner picks the channel (release-ops.ts).
 *
 * ## One endpoint for every product
 *
 * The source is derived from PRODUCT_ID — there is no per-product URL:
 *   GET {UPDATE_ORIGIN}/v1/dist/{PRODUCT_ID}/channels/{channel}.json
 *   GET {UPDATE_ORIGIN}/v1/dist/{PRODUCT_ID}/{version}/manifest.json
 *   GET {UPDATE_ORIGIN}/v1/dist/{PRODUCT_ID}/blobs/{sha256}
 *
 * ## Order of checks
 *
 * The manifest signature is verified BEFORE any artifact is fetched — an
 * unsigned instruction never makes us download anything. Each artifact is then
 * bound to the manifest by size and sha256 (TLS alone does not cover a swapped
 * object at rest).
 */
import type { Env } from "./types";
import type { Config, ReleaseChannel } from "./config";
import { verifyManifest, verifyArtifacts, type Manifest, type SignedRelease } from "./signed-release";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MANIFEST_LIMIT = 256 * 1024;

export interface Pointer {
  product_id: string;
  channel: string;
  version: string;
  kind: string;
  severity: string;
  notes: string | null;
}

function base(env: Env): string {
  return (env.UPDATE_ORIGIN ?? "https://update.entamy.com").replace(/\/+$/, "");
}

/** Prefer a service binding when present (a Worker may not reach another Worker on the same zone over its public URL). */
async function get(env: Env, path: string): Promise<Response> {
  const url = `${base(env)}${path}`;
  return env.UPDATE ? env.UPDATE.fetch(url) : fetch(url);
}

export async function channelPointer(env: Env, config: Config, channel: ReleaseChannel = config.releaseChannel): Promise<Pointer | null> {
  if (!config.productId) throw new Error("PRODUCT_ID is not configured");
  const r = await get(env, `/v1/dist/${config.productId}/channels/${channel}.json`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`release channel lookup failed: HTTP ${r.status}`);
  const p = (await r.json()) as Pointer;
  if (!p || !VERSION_RE.test(p.version) || p.product_id !== config.productId) throw new Error("release channel pointer is invalid");
  return p;
}

/** Fetch the named version and verify signature, identity and artifacts. */
export async function fetchDistRelease(env: Env, config: Config, version: string): Promise<SignedRelease> {
  if (!config.productId) throw new Error("PRODUCT_ID is not configured");
  if (!VERSION_RE.test(version)) throw new Error("release version is invalid");

  const mr = await get(env, `/v1/dist/${config.productId}/${version}/manifest.json`);
  if (mr.status === 404) throw new Error(`release ${version} is not available (missing or withdrawn)`);
  if (!mr.ok) throw new Error(`release manifest fetch failed: HTTP ${mr.status}`);
  const text = await mr.text();
  if (text.length > MANIFEST_LIMIT) throw new Error("release manifest is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("release manifest is not JSON"); }

  // 1. Signature first. No artifact is fetched until this passes.
  const manifest: Manifest = await verifyManifest(env, parsed, config.productId);
  if (manifest.version !== version) throw new Error("release identity does not match");
  if ((manifest.kind ?? "code") !== "code") throw new Error("release is not code");

  // 2. Artifacts by sha256, checked against the manifest (size and digest).
  const files = new Map<string, Uint8Array>();
  for (const a of manifest.artifacts) {
    const r = await get(env, `/v1/dist/${config.productId}/blobs/${a.sha256}`);
    if (!r.ok) throw new Error(`${a.name} fetch failed: HTTP ${r.status}`);
    let body: ReadableStream<Uint8Array> | null = r.body;
    if (r.headers.get("x-entamy-encoding") === "gzip" && body) body = body.pipeThrough(new DecompressionStream("gzip"));
    files.set(a.name, new Uint8Array(await new Response(body).arrayBuffer()));
  }
  return verifyArtifacts(manifest, files);
}

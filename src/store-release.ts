/**
 * Releases kept in a KV namespace of the guardian's own account (RELEASE_STORE).
 *
 * For an app whose account is cut off from everything else (Entamy Billing):
 * nothing is fetched from outside the account. A person approves a version by
 * putting it into the KV namespace; the guardian only ever deploys what is there.
 * There is no signature — putting it into the KV is the approval, and anyone
 * who can write the KV can already change the Worker directly.
 *
 * Same layout as the distribution endpoint, so the rest of the update flow
 * (verify artifacts → migrations → deploy → health → confirm or revert) is shared:
 *
 *   release/{product}/channels/{channel}.json   pointer to the offered version
 *   release/{product}/{version}/manifest.json   manifest (no signature)
 *   release/{product}/blobs/{sha256}            artifact bytes
 *   release/{product}/revoked.json              versions never to deploy again ["1.2.3", …]
 *
 * Every read is checked again (size and sha256 against the manifest), every time.
 */
import type { Env } from "./types";
import type { ReleaseChannel } from "./config";
import { verifyArtifacts, type Manifest, type SignedRelease } from "./signed-release";
import type { Pointer } from "./dist-release";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MANIFEST_LIMIT = 256 * 1024;

const prefix = (product: string) => `release/${product}`;

/** Versions a person listed as never to be deployed again. */
export async function revokedVersions(store: KVNamespace, product: string): Promise<Set<string>> {
  const raw = await store.get(`${prefix(product)}/revoked.json`);
  if (!raw) return new Set();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("revoked list is not JSON"); }
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) throw new Error("revoked list is invalid");
  return new Set(parsed as string[]);
}

/** The offered version, or null when none is offered (or the offered one is revoked). */
export async function storePointer(store: KVNamespace, product: string, channel: ReleaseChannel): Promise<Pointer | null> {
  const raw = await store.get(`${prefix(product)}/channels/${channel}.json`);
  if (!raw) return null;
  let p: Pointer;
  try { p = JSON.parse(raw) as Pointer; } catch { throw new Error("release channel pointer is not JSON"); }
  if (!p || !VERSION_RE.test(p.version) || p.product_id !== product) throw new Error("release channel pointer is invalid");
  if ((await revokedVersions(store, product)).has(p.version)) return null;
  return p;
}

/** Read the named version from the store and check it against its manifest. */
export async function fetchStoreRelease(store: KVNamespace, product: string, version: string): Promise<SignedRelease> {
  if (!VERSION_RE.test(version)) throw new Error("release version is invalid");
  if ((await revokedVersions(store, product)).has(version)) throw new Error(`release ${version} is revoked`);
  const text = await store.get(`${prefix(product)}/${version}/manifest.json`);
  if (text === null) throw new Error(`release ${version} is not in the store`);
  if (text.length > MANIFEST_LIMIT) throw new Error("release manifest is too large");
  let manifest: Manifest;
  try { manifest = JSON.parse(text) as Manifest; } catch { throw new Error("release manifest is not JSON"); }
  if (!manifest || manifest.schema !== "entamy.release/2" || manifest.product !== product
    || manifest.version !== version || !Array.isArray(manifest.artifacts)) {
    throw new Error("release identity is invalid");
  }
  if ((manifest.kind ?? "code") !== "code") throw new Error("release is not code");
  const files = new Map<string, Uint8Array>();
  for (const a of manifest.artifacts) {
    if (!a || typeof a.name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(a.name)
      || typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256)
      || !Number.isSafeInteger(a.size) || a.size < 0) {
      throw new Error("release artifact metadata is invalid");
    }
    const data = await store.get(`${prefix(product)}/blobs/${a.sha256}`, "arrayBuffer");
    if (data === null) throw new Error(`${a.name} is not in the store`);
    files.set(a.name, new Uint8Array(data));
  }
  return verifyArtifacts(manifest, files);
}

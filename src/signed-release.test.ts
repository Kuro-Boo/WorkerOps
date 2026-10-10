import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyArtifacts, verifyManifest } from "./signed-release.ts";
import { channelPointer, fetchDistRelease } from "./dist-release.ts";
import { loadConfig } from "./config.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const worker = Buffer.from("export default {fetch(){return new Response('ok')}}");
const migrations = Buffer.from(JSON.stringify({ migrations: [{ name: "0001_core.sql", sql: "CREATE TABLE example(id TEXT);" }] }));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const manifest = {
  schema: "entamy.release/2" as const,
  kind: "code" as const,
  product: "mushmanager",
  version: "1.2.3",
  main_module: "worker.js",
  artifacts: [
    { name: "worker.js", sha256: sha(worker), size: worker.byteLength },
    { name: "migrations.json", role: "migrations", sha256: sha(migrations), size: migrations.byteLength },
  ],
  migrations: ["0001_core.sql"],
  signature: { alg: "ed25519" as const, key_id: "test", sig: "" },
};
const canonical = (value: Record<string, unknown>): string => {
  const { signature: _signature, ...unsigned } = value;
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(unsigned));
};
manifest.signature.sig = sign(null, Buffer.from(canonical(manifest)), privateKey).toString("base64url");
const PUBKEYS = JSON.stringify([{ key_id: "test", pub: publicRaw.toString("base64url") }]);

// ── signature and artifacts ─────────────────────────────────────────────────
const env = { RELEASE_PUBKEYS: PUBKEYS } as never;
const m = await verifyManifest(env, manifest, "mushmanager");
const verified = await verifyArtifacts(m, new Map([["worker.js", new Uint8Array(worker)], ["migrations.json", new Uint8Array(migrations)]]));
assert.equal(verified.manifest.version, "1.2.3");
assert.equal(verified.migrations[0]?.name, "0001_core.sql");
await assert.rejects(() => verifyManifest(env, { ...manifest, version: "9.9.9" }, "mushmanager"), /signature does not match/);
await assert.rejects(() => verifyManifest(env, manifest, "otherproduct"), /identity is invalid/);
await assert.rejects(() => verifyArtifacts(m, new Map([
  ["worker.js", new Uint8Array(Buffer.from("x".repeat(worker.byteLength)))], ["migrations.json", new Uint8Array(migrations)],
])), /digest does not match/);
console.log("  ok   signed release: signature and artifacts");

// ── pull from the distribution endpoint ─────────────────────────────────────
const fetched: string[] = [];
const blobs: Record<string, Buffer> = { [sha(worker)]: worker, [sha(migrations)]: migrations };
const dist = (yanked = false) => ({
  async fetch(url: string): Promise<Response> {
    const path = new URL(url).pathname;
    fetched.push(path);
    if (path === "/v1/dist/mushmanager/channels/stable.json") {
      return Response.json({ product_id: "mushmanager", channel: "stable", version: "1.2.3", kind: "code", severity: "important", notes: null });
    }
    if (path === "/v1/dist/mushmanager/1.2.3/manifest.json") {
      return yanked ? new Response("{}", { status: 404 }) : Response.json(manifest);
    }
    const b = /^\/v1\/dist\/mushmanager\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (b && blobs[b[1]!]) return new Response(blobs[b[1]!]);
    return new Response("{}", { status: 404 });
  },
});
const pullEnv = { RELEASE_PUBKEYS: PUBKEYS, PRODUCT_ID: "mushmanager", UPDATE: dist() } as never;
const config = loadConfig(pullEnv);
assert.equal(config.productId, "mushmanager");
assert.equal(config.releaseChannel, "stable");
const pointer = await channelPointer(pullEnv, config);
assert.equal(pointer?.version, "1.2.3");
const pulled = await fetchDistRelease(pullEnv, config, "1.2.3");
assert.equal(pulled.manifest.version, "1.2.3");
assert.ok(pulled.worker.includes("Response('ok')"));
// The signature is checked before any artifact is fetched.
fetched.length = 0;
const badEnv = { RELEASE_PUBKEYS: JSON.stringify([{ key_id: "test", pub: Buffer.alloc(32, 1).toString("base64url") }]), PRODUCT_ID: "mushmanager", UPDATE: dist() } as never;
await assert.rejects(() => fetchDistRelease(badEnv, loadConfig(badEnv), "1.2.3"), /signature does not match/);
assert.ok(!fetched.some((p) => p.includes("/blobs/")), "no artifact is fetched before the signature passes");
// A withdrawn (yanked) version is not installed.
const yankEnv = { RELEASE_PUBKEYS: PUBKEYS, PRODUCT_ID: "mushmanager", UPDATE: dist(true) } as never;
await assert.rejects(() => fetchDistRelease(yankEnv, loadConfig(yankEnv), "1.2.3"), /not available/);
// The older name RELEASE_PRODUCT is still read.
assert.equal(loadConfig({ RELEASE_PRODUCT: "mushmanager" } as never).productId, "mushmanager");
console.log("  ok   pull from distribution endpoint");

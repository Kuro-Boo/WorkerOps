import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyArtifacts, verifyManifest } from "./signed-release.ts";
import { channelPointer, fetchDistRelease } from "./dist-release.ts";
import { loadConfig } from "./config.ts";
import { autoUpdateTick, LAST_AUTO_CHECK_KEY, PIN_KEY, releaseInfo, resolveConfig, setAuto, setChannel } from "./release-ops.ts";

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

// ── automatic updates and the owner's channel ───────────────────────────────
const kv = () => {
  const m = new Map<string, string>();
  return { async get(k: string) { return m.get(k) ?? null; }, async put(k: string, v: string) { m.set(k, v); }, async delete(k: string) { m.delete(k); } };
};
const ownerEnv = { RELEASE_PUBKEYS: PUBKEYS, PRODUCT_ID: "mushmanager", UPDATE: dist(), WORKEROPS_STATE: kv() } as never as Record<string, never>;
await (ownerEnv.WORKEROPS_STATE as never as ReturnType<typeof kv>).put("workerops:release:version", "1.2.3");
const ownerConfig = loadConfig(ownerEnv as never);
// Never chosen: automatic updates are on, and the installer's channel is used.
let info = await releaseInfo(ownerEnv as never, ownerConfig);
assert.equal(info.auto, true);
assert.equal(info.channel, "stable");
// The tick looks up the channel even though the owner never touched the switch.
fetched.length = 0;
await autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig);
assert.ok(fetched.includes("/v1/dist/mushmanager/channels/stable.json"));
// The owner picks dev: the dev pointer is read from then on.
await setChannel(ownerEnv as never, ownerConfig, "dev");
fetched.length = 0;
info = await releaseInfo(ownerEnv as never, ownerConfig);
assert.equal(info.channel, "dev");
assert.ok(fetched.includes("/v1/dist/mushmanager/channels/dev.json"));
await assert.rejects(() => setChannel(ownerEnv as never, ownerConfig, "beta"), /stable" or "dev/);
// The concierge's "check now": within the day the tick does not look; once the gate key is deleted,
// the very next tick does. The key name is the contract with CoreSystem/concierge.
assert.equal(LAST_AUTO_CHECK_KEY, "workerops:release:last_auto_check");
fetched.length = 0;
await autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig);
assert.equal(fetched.length, 0, "the daily gate holds");
await (ownerEnv.WORKEROPS_STATE as never as ReturnType<typeof kv>).delete(LAST_AUTO_CHECK_KEY);
await autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig);
assert.ok(fetched.includes("/v1/dist/mushmanager/channels/dev.json"), "deleting the gate makes the next tick look");
// Switched off by the owner: the tick does nothing, not even a lookup.
await setAuto(ownerEnv as never, ownerConfig, false);
assert.equal((await releaseInfo(ownerEnv as never, ownerConfig)).auto, false);
await (ownerEnv.WORKEROPS_STATE as never as ReturnType<typeof kv>).delete("workerops:release:last_auto_check");
fetched.length = 0;
await autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig);
assert.equal(fetched.length, 0);
console.log("  ok   automatic updates on by default, owner picks the channel");

// ── a version named by the operator (Admin → concierge → PIN_KEY) ──────────
// 委託の版は Admin が配る(core-offering 3 節)。印がある間はチャンネルを見ず、その版に合わせる。
// 持ち主の自動更新が切れていても合わせる。戻した版を何度も試さない。名前は連絡係との約束。
{
  const st = ownerEnv.WORKEROPS_STATE as never as ReturnType<typeof kv>;
  assert.equal(PIN_KEY, "workerops:release:pinned");
  await st.put(PIN_KEY, "1.2.3");
  fetched.length = 0;
  await autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig);
  assert.equal(fetched.length, 0, "already on the named version: nothing is fetched");
  assert.equal((await releaseInfo(ownerEnv as never, ownerConfig)).pinned, "1.2.3", "the named version is reported");
  // A different (here: older, not on the endpoint) version is fetched by its own manifest, not by the channel.
  await st.put(PIN_KEY, "1.2.2");
  fetched.length = 0;
  await assert.rejects(() => autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig), /not available/);
  assert.ok(fetched.includes("/v1/dist/mushmanager/1.2.2/manifest.json"), "the named version is looked up even with auto off");
  assert.ok(!fetched.some((p) => p.includes("/channels/")), "the channel is not followed while a version is named");
  // A version that was put in and reverted is not tried again every minute.
  await st.put("workerops:release:failed:1.2.2", "{}");
  fetched.length = 0;
  await autoUpdateTick(ownerEnv as never, {} as ExecutionContext, ownerConfig);
  assert.equal(fetched.length, 0);
  await st.delete(PIN_KEY);
  assert.equal((await releaseInfo(ownerEnv as never, ownerConfig)).pinned, null);
}
console.log("  ok   a version named by the operator wins over the channel");

// ── a guardian without PRODUCT_ID follows what the app declares ─────────────
// (guardians installed before PRODUCT_ID existed: no settings are touched)
const appSays = (body: Record<string, unknown>) => ({
  async fetch(): Promise<Response> { return Response.json({ ok: true, version: "1.2.0", ...body }); },
});
const legacyEnv = { UPDATE: dist(), WORKEROPS_STATE: kv(), APP_SERVICE: appSays({ product_id: "mushmanager", update_policy: { auto: false, channel: "stable" } }) } as never;
const legacy = await resolveConfig(legacyEnv, loadConfig(legacyEnv));
assert.equal(legacy.productId, "mushmanager");
info = await releaseInfo(legacyEnv, legacy);
assert.equal(info.auto, false, "the app's choice wins");
assert.equal(info.managedBy, "app");
assert.equal(info.current, "1.2.0", "the running version comes from the app");
assert.equal(info.newer, true);
await assert.rejects(() => setAuto(legacyEnv, legacy, true), /admin screen/);
// With no RELEASE_PUBKEYS, the bundled keys of the default endpoint are used: our test key is not among them.
await assert.rejects(() => fetchDistRelease(legacyEnv, legacy, "1.2.3"), /not trusted/);
console.log("  ok   product and update choices declared by the app");

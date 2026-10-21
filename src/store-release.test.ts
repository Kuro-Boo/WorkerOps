import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channelPointer, fetchDistRelease } from "./dist-release.ts";
import { loadConfig } from "./config.ts";
import { autoUpdateTick } from "./release-ops.ts";
import { failedKey } from "./signed-release.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const worker = Buffer.from("export default {fetch(){return new Response('ok')}}");
const migrations = Buffer.from(JSON.stringify({ migrations: [{ name: "0005_x.sql", sql: "CREATE TABLE x(id TEXT);" }] }));
const manifest = {
  schema: "entamy.release/2", kind: "code", product: "billing", version: "0.1.0", main_module: "worker.js",
  artifacts: [
    { name: "worker.js", sha256: sha(worker), size: worker.byteLength },
    { name: "migrations.json", role: "migrations", sha256: sha(migrations), size: migrations.byteLength },
  ],
  migrations: ["0005_x.sql"],
};

/** KV of the guardian's account. Records the keys read. */
const store = (entries: Record<string, string | Buffer>) => {
  const m = new Map(Object.entries(entries));
  const reads: string[] = [];
  return {
    reads,
    async get(k: string, type?: string) {
      reads.push(k);
      const v = m.get(k);
      if (v === undefined) return null;
      if (type === "arrayBuffer") { const b = Buffer.from(v); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      return String(v);
    },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  };
};
const P = "release/billing";
const full = (extra: Record<string, string | Buffer> = {}) => store({
  [`${P}/channels/stable.json`]: JSON.stringify({ product_id: "billing", channel: "stable", version: "0.1.0", kind: "code", severity: "normal", notes: null }),
  [`${P}/0.1.0/manifest.json`]: JSON.stringify(manifest),
  [`${P}/blobs/${sha(worker)}`]: worker,
  [`${P}/blobs/${sha(migrations)}`]: migrations,
  ...extra,
});
const kv = () => {
  const m = new Map<string, string>();
  return { async get(k: string) { return m.get(k) ?? null; }, async put(k: string, v: string) { m.set(k, v); }, async delete(k: string) { m.delete(k); } };
};
const envOf = (s: ReturnType<typeof store>) => ({ PRODUCT_ID: "billing", RELEASE_STORE: s, WORKEROPS_STATE: kv() }) as never as Record<string, never>;

// ── read from the store (no signature: putting it there is the approval) ──────
{
  const env = envOf(full());
  const config = loadConfig(env as never);
  assert.equal((await channelPointer(env as never, config))?.version, "0.1.0");
  const rel = await fetchDistRelease(env as never, config, "0.1.0");
  assert.equal(rel.migrations[0]?.name, "0005_x.sql");
  assert.ok(rel.worker.includes("Response('ok')"));
  console.log("  ok   store release: pointer and verified artifacts");
}

// ── every read is checked again ─────────────────────────────────────────────
{
  const swapped = full({ [`${P}/blobs/${sha(worker)}`]: Buffer.from("x".repeat(worker.byteLength)) });
  await assert.rejects(() => fetchDistRelease(envOf(swapped) as never, loadConfig(envOf(swapped) as never), "0.1.0"), /digest does not match/);
  const other = full({ [`${P}/0.1.0/manifest.json`]: JSON.stringify({ ...manifest, product: "cms" }) });
  await assert.rejects(() => fetchDistRelease(envOf(other) as never, loadConfig(envOf(other) as never), "0.1.0"), /identity is invalid/);
  const badName = full({ [`${P}/0.1.0/manifest.json`]: JSON.stringify({ ...manifest, artifacts: [{ ...manifest.artifacts[0], name: "../x" }] }) });
  await assert.rejects(() => fetchDistRelease(envOf(badName) as never, loadConfig(envOf(badName) as never), "0.1.0"), /metadata is invalid/);
  console.log("  ok   store release: swapped blob, wrong product, bad name are refused");
}

// ── revoked versions are never offered nor fetched ──────────────────────────
{
  const env = envOf(full({ [`${P}/revoked.json`]: JSON.stringify(["0.1.0"]) }));
  const config = loadConfig(env as never);
  assert.equal(await channelPointer(env as never, config), null);
  await assert.rejects(() => fetchDistRelease(env as never, config, "0.1.0"), /revoked/);
  console.log("  ok   store release: revoked");
}

// ── the tick reads the store every time, and skips a version it reverted ────
{
  const s = full();
  const env = { ...envOf(s), APP_SERVICE: { async fetch() { return Response.json({ ok: true, version: "0.0.1" }); } } } as never as Record<string, never>;
  const config = loadConfig(env as never);
  await autoUpdateTick(env as never, {} as ExecutionContext, config);
  const first = s.reads.filter((k) => k.endsWith("manifest.json")).length;
  assert.equal(first, 1, "the offered version is fetched");
  await autoUpdateTick(env as never, {} as ExecutionContext, config);
  assert.equal(s.reads.filter((k) => k.endsWith("manifest.json")).length, 2, "no daily gate for a store");
  await (env.WORKEROPS_STATE as never as ReturnType<typeof kv>).put(failedKey("0.1.0"), "{}");
  await autoUpdateTick(env as never, {} as ExecutionContext, config);
  assert.equal(s.reads.filter((k) => k.endsWith("manifest.json")).length, 2, "a reverted version is not tried again");
  console.log("  ok   store release: every tick, reverted version skipped");
}

// ── which health states count as healthy (HEALTH_OK_STATES, opt-in) ─────────
{
  const { probeHealth } = await import("./health.ts");
  const app = (state: string) => ({ async fetch() { return Response.json({ state, ok: state === "ok", version: "0.1.0" }); } });
  const plain = loadConfig({} as never);
  assert.equal((await probeHealth({ APP_SERVICE: app("degraded") } as never, plain)).ok, false, "unset: only ok counts (unchanged)");
  const lenient = loadConfig({ HEALTH_OK_STATES: "ok,degraded" } as never);
  assert.equal((await probeHealth({ APP_SERVICE: app("degraded") } as never, lenient)).ok, true);
  assert.equal((await probeHealth({ APP_SERVICE: app("down") } as never, lenient)).ok, false, "down is never healthy");
  console.log("  ok   health: HEALTH_OK_STATES");
}

// ── an internal product is read with its caller key (RELEASE_READ_KEY) ──────
{
  const seen: Array<string | null> = [];
  const update = { async fetch(_url: string, init?: RequestInit) { seen.push(new Headers(init?.headers).get("x-entamy-internal")); return new Response("{}", { status: 404 }); } };
  const withKey = { PRODUCT_ID: "admin", UPDATE: update, RELEASE_READ_KEY: "ik_admin", WORKEROPS_STATE: kv() } as never;
  await channelPointer(withKey, loadConfig(withKey));
  const without = { PRODUCT_ID: "cms", UPDATE: update, WORKEROPS_STATE: kv() } as never;
  await channelPointer(without, loadConfig(without));
  assert.deepEqual(seen, ["ik_admin", null]);
  console.log("  ok   dist: RELEASE_READ_KEY is sent only when set");
}

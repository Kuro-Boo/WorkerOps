import { fetchRetry, type RetryOptions } from "./retry";
import { placementOfD1, type D1Location } from "./placement-map";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export class CfError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Static assets for a new version: the completion token and routing config. */
export interface VersionAssets {
  jwt: string;
  config?: Record<string, unknown>;
}

/**
 * Where a version runs. It is part of each version: a version uploaded without it takes the Worker
 * back to "wherever the request landed" (confirmed on a test Worker 2026-11-11).
 */
export type Placement = { region: string } | { mode: "smart" };
const PLACEMENT_REGION = /^(aws|gcp|azure):[a-z0-9-]{2,40}$/;
/** Where a Worker runs when nothing names a place (see getSettings). */
export const DEFAULT_PLACEMENT: Placement = { region: "aws:ap-northeast-1" };

const regionOf = (m: D1Location | undefined) =>
  placementOfD1(m?.served_by_primary === false ? undefined : m?.served_by_colo, m?.served_by_region);

/** A Worker's modules, the first-class shape a version is uploaded from. */
export interface WorkerCode {
  mainModule: string;
  modules: File[];
}

/** `content/v2` as received, so it can be stored and parsed later. */
export interface RawCode {
  contentType: string;
  mainModule: string;
  body: ArrayBuffer;
}

/** Parse stored `content/v2` back into modules. */
export async function parseCode(raw: RawCode): Promise<WorkerCode> {
  const form = await new Response(raw.body, { headers: { "content-type": raw.contentType } }).formData();
  const modules: File[] = [];
  // The part name is the module name; keep each part's content type.
  for (const [name, v] of form) if (typeof v !== "string") modules.push(new File([v as File], name, { type: (v as File).type }));
  if (!modules.some((m) => m.name === raw.mainModule)) throw new Error("stored code has no main module");
  return { mainModule: raw.mainModule, modules };
}

interface CfEnvelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

/**
 * Minimal Cloudflare Workers API client for the version/deployment lifecycle.
 * Endpoints verified against developers.cloudflare.com (Versions: Upload Version,
 * Deployments: Create Deployment).
 */
export class CfClient {
  private readonly base: string;
  private readonly account: string;

  constructor(
    private readonly token: string,
    accountId: string,
    private readonly scriptName: string,
    private readonly retry: RetryOptions,
  ) {
    this.account = `${CF_BASE}/accounts/${accountId}`;
    this.base = `${this.account}/workers/scripts/${encodeURIComponent(scriptName)}`;
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async parse<T>(res: Response, op: string): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new CfError(res.status, `${op}: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const data = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!data || data.success !== true) {
      const msg =
        data?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ||
        "unknown error";
      throw new CfError(res.status, `${op}: ${msg}`);
    }
    return data.result;
  }

  /**
   * Current script bindings, compatibility settings and placement (to preserve on redeploy).
   * A Worker runs next to its D1 when the D1 can be located (2026-11-11, the owner's decision); else in
   * `region` (the signed release's placement_region); else where it runs now; and a Worker placed nowhere
   * runs in Tokyo (2026-11-12, the owner's decision: "prefer Osaka or Tokyo when the place is unknown").
   * Unplaced, a Worker runs at whichever edge took the request, which from Japan was often San Jose, far
   * from a D1 in Japan.
   */
  async getSettings(region?: unknown, appD1?: () => Promise<D1Location | undefined>): Promise<{
    bindings: unknown[];
    compatibility_date: string;
    compatibility_flags: string[];
    placement?: Placement;
    /** The placement is the one next to the app's D1. */
    fromD1: boolean;
    /** Nothing named a place, so the placement is the default one (DEFAULT_PLACEMENT). */
    fromDefault?: boolean;
    /** The Worker's placement mode now ("smart", "targeted" or none). */
    currentMode?: string;
  }> {
    const res = await fetchRetry(
      `${this.base}/settings`,
      { headers: this.auth() },
      this.retry,
    );
    const r = await this.parse<{
      bindings?: unknown[];
      compatibility_date?: string;
      compatibility_flags?: string[];
      placement?: { mode?: string } | null;
    }>(res, "getSettings");
    const nextToD1 = await this.placementNextToD1(r.bindings ?? [], appD1);
    const named = nextToD1 ?? (typeof region === "string" && PLACEMENT_REGION.test(region)
      ? { region }
      : await this.currentPlacement(r.placement?.mode));
    const placement = named ?? DEFAULT_PLACEMENT;
    return {
      bindings: r.bindings ?? [],
      compatibility_date: r.compatibility_date ?? "2024-11-01",
      compatibility_flags: r.compatibility_flags ?? [],
      ...(placement ? { placement } : {}),
      fromD1: !!nextToD1,
      ...(named ? {} : { fromDefault: true }),
      ...(r.placement?.mode ? { currentMode: r.placement.mode } : {}),
    };
  }

  /**
   * The region next to the app's D1 primary: D1 answers which location served a query. Best effort: a
   * token without D1 access, or a D1 that does not answer, must not stop an update or a revert.
   */
  private async placementNextToD1(bindings: unknown[], appD1?: () => Promise<D1Location | undefined>): Promise<Placement | undefined> {
    const located = regionOf(await appD1?.());
    if (located) return { region: located };
    const d1s = bindings.filter((b) => (b as { type?: string })?.type === "d1") as Array<{ name?: string; id?: string; database_id?: string }>;
    const d1 = d1s.find((b) => b.name === "DB") ?? d1s[0];
    const id = d1?.id ?? d1?.database_id;
    if (!id) return undefined;
    try {
      const res = await fetchRetry(`${this.account}/d1/database/${encodeURIComponent(id)}/query`, {
        method: "POST",
        headers: { ...this.auth(), "content-type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      }, this.retry);
      const r = await this.parse<Array<{ meta?: D1Location }>>(res, "d1Location");
      const region = regionOf(r[0]?.meta);
      return region ? { region } : undefined;
    } catch (e) {
      console.warn("placement: could not locate the D1", this.scriptName, e);
      return undefined;
    }
  }

  /**
   * The current placement, in the form a version upload accepts. `settings` gives a targeted region
   * only as a bare id (`target: [12]`), which an upload rejects (10021); the script list has its name.
   * Best effort: a revert must not stop because the list could not be read.
   */
  async currentPlacement(mode: string | undefined): Promise<Placement | undefined> {
    if (mode === "smart") return { mode: "smart" };
    if (mode !== "targeted") return undefined;
    try {
      const res = await fetchRetry(`${this.account}/workers/scripts`, { headers: this.auth() }, this.retry);
      const list = await this.parse<Array<{ id?: string; placement?: { target?: Array<{ region?: string }> } }>>(res, "listScripts");
      const region = list.find((s) => s.id === this.scriptName)?.placement?.target?.[0]?.region;
      if (region && PLACEMENT_REGION.test(region)) return { region };
      console.warn("placement: targeted region not found", this.scriptName);
    } catch (e) {
      console.warn("placement: could not read the targeted region", this.scriptName, e);
    }
    return undefined;
  }

  /**
   * The version_id currently serving 100% of traffic (best-effort). With `whole`, null unless one
   * version has all of it (a split deployment has no single serving version — follow.ts).
   */
  async getActiveVersionId(whole = false): Promise<string | null> {
    const res = await fetchRetry(
      `${this.base}/deployments`,
      { headers: this.auth() },
      this.retry,
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      result?: { deployments?: unknown[] } | unknown[];
    } | null;
    const result = data?.result;
    const list = Array.isArray(result)
      ? result
      : ((result as { deployments?: unknown[] })?.deployments ?? []);
    const latest = (list as Array<{ versions?: Array<{ version_id?: string; percentage?: number }> }>)[0];
    const versions = latest?.versions;
    if (!Array.isArray(versions) || versions.length === 0) return null;
    const active =
      versions.find((v) => v.percentage === 100) ?? (whole ? undefined : versions[0]);
    return active?.version_id ?? null;
  }

  /**
   * Upload a new version (does NOT deploy). Returns the new version id.
   *
   * Without `assets`, the version keeps the app's current static assets
   * (`keep_assets: true`). A version is a full snapshot: leaving it out drops
   * every asset and the whole public site falls through to the Worker
   * (confirmed on a test Worker 2026-10-16). It is accepted by a Worker that
   * has no assets, so it is always sent.
   */
  async uploadVersion(
    script: string,
    bindings: unknown[],
    compatibilityDate: string,
    compatibilityFlags: string[],
    assets?: VersionAssets | "none",
    placement?: Placement,
  ): Promise<string> {
    return this.uploadModules(
      { mainModule: "worker.js", modules: [new File([script], "worker.js", { type: "application/javascript+module" })] },
      bindings,
      compatibilityDate,
      compatibilityFlags,
      assets,
      placement,
    );
  }

  /**
   * Upload a version made of the given modules (the shape `getContent` returns).
   * `assets`: new assets / "none" = a version without any (takes the site's
   * pages down) / omitted = keep the current ones.
   */
  async uploadModules(
    code: WorkerCode,
    bindings: unknown[],
    compatibilityDate: string,
    compatibilityFlags: string[],
    assets?: VersionAssets | "none",
    placement?: Placement,
  ): Promise<string> {
    const metadata = {
      main_module: code.mainModule,
      bindings,
      compatibility_date: compatibilityDate,
      compatibility_flags: compatibilityFlags,
      ...(assets === "none" ? {} : assets ? { assets } : { keep_assets: true }),
      ...(placement ? { placement } : {}),
    };
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    for (const m of code.modules) form.append(m.name, m, m.name);
    const res = await fetchRetry(
      `${this.base}/versions`,
      { method: "POST", headers: this.auth(), body: form },
      this.retry,
    );
    const r = await this.parse<{ id: string }>(res, "uploadVersion");
    return r.id;
  }

  /** The newest UPLOADED version (deployed or not). */
  async getLatestVersionId(): Promise<string | null> {
    const res = await fetchRetry(`${this.base}/versions?per_page=1`, { headers: this.auth() }, this.retry);
    const r = await this.parse<{ items?: Array<{ id?: string }> }>(res, "getLatestVersionId");
    return r.items?.[0]?.id ?? null;
  }

  /**
   * The code of the NEWEST UPLOADED version, as raw multipart (every module,
   * with its content type) — not necessarily the one serving: a version
   * uploaded but never deployed is what comes back (tried 2026-10-16). There
   * is no per-version form either (`?version=` is ignored), so a previous
   * version's code has to be kept by us (assets.ts). Callers check that the
   * newest version is the active one first (assets.ts `servingCode`).
   */
  async getContentRaw(): Promise<RawCode> {
    const res = await fetchRetry(`${this.base}/content/v2`, { headers: this.auth() }, this.retry);
    if (!res.ok) throw new CfError(res.status, `getContent: HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    const mainModule = res.headers.get("cf-entrypoint") ?? "";
    if (!contentType.startsWith("multipart/form-data") || !mainModule)
      throw new CfError(res.status, "getContent: unexpected response");
    return { contentType, mainModule, body: await res.arrayBuffer() };
  }

  /** Register the full asset manifest; returns which hashes still have to be sent. */
  async assetsUploadSession(
    manifest: Record<string, { hash: string; size: number }>,
  ): Promise<{ jwt: string; buckets: string[][] }> {
    const res = await fetchRetry(
      `${this.base}/assets-upload-session`,
      {
        method: "POST",
        headers: { ...this.auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ manifest }),
      },
      this.retry,
    );
    const r = await this.parse<{ jwt: string; buckets?: string[][] }>(res, "assetsUploadSession");
    return { jwt: r.jwt, buckets: r.buckets ?? [] };
  }

  /**
   * Send one bucket of files (base64). Authorised by the session's upload
   * token, not the API token. Returns the completion token once the last
   * bucket is in (201 with `jwt`), otherwise null.
   */
  async uploadAssetBucket(
    uploadJwt: string,
    files: Array<{ hash: string; base64: string; type: string }>,
  ): Promise<string | null> {
    const form = new FormData();
    // An empty type would be replaced by application/octet-stream; the API reads
    // "application/null" as "send no Content-Type" (direct-upload docs).
    for (const f of files) form.append(f.hash, new File([f.base64], f.hash, { type: f.type || "application/null" }));
    const res = await fetchRetry(
      `${this.account}/workers/assets/upload?base64=true`,
      { method: "POST", headers: { Authorization: `Bearer ${uploadJwt}` }, body: form },
      this.retry,
    );
    const r = await this.parse<{ jwt?: string } | null>(res, "uploadAssets");
    return r?.jwt ?? null;
  }

  /** Deploy a version to 100% (used for both activate and rollback). */
  async deployVersion(versionId: string, message: string): Promise<void> {
    return this.deployVersions([{ percentage: 100, version_id: versionId }], message);
  }

  /** 割合を並べた配備(確かめてから配る段の 100% と 0%・trial.ts)。割合の合計は 100。 */
  async deployVersions(versions: Array<{ version_id: string; percentage: number }>, message: string): Promise<void> {
    const body = {
      strategy: "percentage",
      versions,
      // Only "workers/message" is a user-settable annotation; "workers/triggered_by"
      // is rejected by the API (error 10210) — CF sets it internally.
      annotations: {
        "workers/message": message.slice(0, 200),
      },
    };
    const res = await fetchRetry(
      `${this.base}/deployments`,
      {
        method: "POST",
        headers: { ...this.auth(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      this.retry,
    );
    await this.parse(res, "deployVersion");
  }
}

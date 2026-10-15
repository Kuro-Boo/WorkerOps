import { fetchRetry, type RetryOptions } from "./retry";

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
    scriptName: string,
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

  /** Current script bindings & compatibility settings (to preserve on redeploy). */
  async getSettings(): Promise<{
    bindings: unknown[];
    compatibility_date: string;
    compatibility_flags: string[];
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
    }>(res, "getSettings");
    return {
      bindings: r.bindings ?? [],
      compatibility_date: r.compatibility_date ?? "2024-11-01",
      compatibility_flags: r.compatibility_flags ?? [],
    };
  }

  /** The version_id currently serving 100% of traffic (best-effort). */
  async getActiveVersionId(): Promise<string | null> {
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
      versions.find((v) => v.percentage === 100) ?? versions[0];
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
  ): Promise<string> {
    return this.uploadModules(
      { mainModule: "worker.js", modules: [new File([script], "worker.js", { type: "application/javascript+module" })] },
      bindings,
      compatibilityDate,
      compatibilityFlags,
      assets,
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
  ): Promise<string> {
    const metadata = {
      main_module: code.mainModule,
      bindings,
      compatibility_date: compatibilityDate,
      compatibility_flags: compatibilityFlags,
      ...(assets === "none" ? {} : assets ? { assets } : { keep_assets: true }),
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
    const body = {
      strategy: "percentage",
      versions: [{ percentage: 100, version_id: versionId }],
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

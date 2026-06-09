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

  constructor(
    private readonly token: string,
    accountId: string,
    scriptName: string,
    private readonly retry: RetryOptions,
  ) {
    this.base = `${CF_BASE}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;
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

  /** Upload a new version (does NOT deploy). Returns the new version id. */
  async uploadVersion(
    script: string,
    bindings: unknown[],
    compatibilityDate: string,
    compatibilityFlags: string[],
  ): Promise<string> {
    const metadata = {
      main_module: "worker.js",
      bindings,
      compatibility_date: compatibilityDate,
      compatibility_flags: compatibilityFlags,
    };
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    form.append(
      "worker.js",
      new Blob([script], { type: "application/javascript+module" }),
      "worker.js",
    );
    const res = await fetchRetry(
      `${this.base}/versions`,
      { method: "POST", headers: this.auth(), body: form },
      this.retry,
    );
    const r = await this.parse<{ id: string }>(res, "uploadVersion");
    return r.id;
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

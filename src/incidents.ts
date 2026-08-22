import type { Config } from "./config";
import { fetchRetry } from "./retry";
import { errMsg } from "./util";

/**
 * How often the app Worker failed over the last 24h, read from Cloudflare's
 * GraphQL Analytics API.
 *
 * ⚠ Deliberately NOT counted by the guardian itself. The proxy sees every
 *   failure it forwards, but recording them would mean a KV write per failed
 *   request — and failures arrive in bursts (an incident on 2026-08-22 produced
 *   ~40/hour for 12 hours), so the counter would burn the Free plan's 1,000
 *   KV writes/day precisely when the site is already in trouble. Analytics is
 *   the authoritative source, costs no writes, and also sees failures that
 *   never reached the guardian.
 */
export interface AppIncidents {
  available: boolean;
  /** Reason the numbers are missing (token lacks Account Analytics:Read, etc). */
  reason?: string;
  windowHours: number;
  since: string;
  /** Invocations that did not succeed (exception / exceeded limits / …). */
  failed: number;
  succeeded: number;
  /** Failures split by Cloudflare's invocation status. */
  byStatus: Record<string, number>;
  /** Distinct hours in the window with at least one failure — "how spread out". */
  affectedHours: number;
  /** Most recent hour bucket that contained a failure. */
  lastFailureHour: string | null;
}

interface InvocationRow {
  sum?: { requests?: number };
  dimensions?: { status?: string; datetimeHour?: string };
}

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const WINDOW_HOURS = 24;

// `clientDisconnected` is the visitor closing the connection (or a long
// streaming response being cut short) — the Worker did its job, so it is
// neither a failure nor a success here.
const NOT_A_FAILURE = new Set(["success", "clientDisconnected"]);

const QUERY =
  "query($a:string!,$s:Time!,$e:Time!,$n:string!){viewer{accounts(filter:{accountTag:$a}){" +
  "workersInvocationsAdaptive(limit:1000,filter:{datetime_geq:$s,datetime_leq:$e,scriptName:$n}){" +
  "sum{requests}dimensions{status datetimeHour}}}}}";

export async function fetchAppIncidents(
  config: Config,
): Promise<AppIncidents> {
  const since = new Date(
    Date.now() - WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const empty: AppIncidents = {
    available: false,
    windowHours: WINDOW_HOURS,
    since,
    failed: 0,
    succeeded: 0,
    byStatus: {},
    affectedHours: 0,
    lastFailureHour: null,
  };

  if (!config.token || !config.accountId || !config.appWorkerName) {
    return { ...empty, reason: "cf_config_missing" };
  }

  try {
    const res = await fetchRetry(
      GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: QUERY,
          variables: {
            a: config.accountId,
            s: since,
            e: new Date().toISOString(),
            n: config.appWorkerName,
          },
        }),
      },
      // Kept under the health probe's 5s so analytics is never the long pole on
      // /status: the console polls every 5s and must stay responsive during an
      // outage, which is exactly when someone is looking at it.
      { max: 1, baseMs: config.retryBaseMs, timeoutMs: 4_000 },
    );
    if (!res.ok) return { ...empty, reason: `HTTP ${res.status}` };

    const body = (await res.json()) as {
      data?: {
        viewer?: {
          accounts?: { workersInvocationsAdaptive?: InvocationRow[] }[];
        };
      };
      errors?: { message?: string }[];
    };
    if (body.errors?.length) {
      // The usual case is a token without Account Analytics:Read. Surfacing the
      // message beats showing a zero that looks like "nothing ever failed".
      return { ...empty, reason: body.errors[0]?.message || "graphql_error" };
    }

    const rows =
      body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const out: AppIncidents = { ...empty, available: true };
    const hours = new Set<string>();
    for (const row of rows) {
      const n = Number(row.sum?.requests ?? 0);
      if (!n) continue;
      const status = row.dimensions?.status || "unknown";
      if (NOT_A_FAILURE.has(status)) {
        if (status === "success") out.succeeded += n;
        continue;
      }
      out.failed += n;
      out.byStatus[status] = (out.byStatus[status] ?? 0) + n;
      const hour = row.dimensions?.datetimeHour;
      if (hour) {
        hours.add(hour);
        if (!out.lastFailureHour || hour > out.lastFailureHour) {
          out.lastFailureHour = hour;
        }
      }
    }
    out.affectedHours = hours.size;
    return out;
  } catch (e) {
    return { ...empty, reason: errMsg(e) };
  }
}

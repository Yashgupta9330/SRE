/**
 * Real Worker metrics from the GraphQL Analytics API (workersInvocationsAdaptive).
 *
 * Returns the last 15 minutes, a baseline (the hour before), and a breakdown
 * by deployed version, so the agent can see WHEN a regression started.
 * Note: `errors` counts invocations that threw (status scriptThrewException
 * etc.); a handled HTTP 500 counts as a success in this dataset.
 */
import type { MonitoringProvider, ServiceMetrics } from "../types";
import { CloudflareApi, isoSeconds, minutesAgo, round } from "./api";
import { lookup, type ServiceCatalog } from "./catalog";

const CURRENT_MIN = 15;
const BASELINE_MIN = 60;

interface Group {
  sum: { requests: number; errors: number; subrequests?: number };
  quantiles: { wallTimeP50: number; wallTimeP95: number; wallTimeP99: number; cpuTimeP50?: number; cpuTimeP99?: number };
  dimensions?: { status?: string; scriptVersion?: string };
}

const QUERY = `
query ($accountTag: String!, $script: String!, $cFrom: Time!, $cTo: Time!, $bFrom: Time!, $bTo: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      current: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $cFrom, datetime_leq: $cTo }) {
        sum { requests errors subrequests }
        quantiles { wallTimeP50 wallTimeP95 wallTimeP99 cpuTimeP50 cpuTimeP99 }
      }
      baseline: workersInvocationsAdaptive(limit: 1, filter: { scriptName: $script, datetime_geq: $bFrom, datetime_leq: $bTo }) {
        sum { requests errors }
        quantiles { wallTimeP50 wallTimeP95 wallTimeP99 }
      }
      byStatus: workersInvocationsAdaptive(limit: 20, filter: { scriptName: $script, datetime_geq: $cFrom, datetime_leq: $cTo }, orderBy: [sum_requests_DESC]) {
        sum { requests errors }
        quantiles { wallTimeP50 wallTimeP95 wallTimeP99 }
        dimensions { status }
      }
      byVersion: workersInvocationsAdaptive(limit: 10, filter: { scriptName: $script, datetime_geq: $bFrom, datetime_leq: $cTo }, orderBy: [sum_requests_DESC]) {
        sum { requests errors }
        quantiles { wallTimeP50 wallTimeP95 wallTimeP99 }
        dimensions { scriptVersion }
      }
    }
  }
}`;

type Result = { viewer: { accounts: Record<"current" | "baseline" | "byStatus" | "byVersion", Group[]>[] } };

/** Wall time and CPU time are reported in microseconds. */
const ms = (us: number | undefined) => round((us ?? 0) / 1000, 1);
const pct = (part: number, total: number) => (total ? round((part / total) * 100, 2) : 0);

export class CloudflareMonitoringProvider implements MonitoringProvider {
  readonly name = "cloudflare-workers-analytics";

  constructor(
    private readonly api: CloudflareApi,
    private readonly catalog: ServiceCatalog,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listServices(): Promise<string[]> {
    return Object.keys(this.catalog);
  }

  async getServiceMetrics(service: string): Promise<ServiceMetrics> {
    const { script } = lookup(this.catalog, service);
    const now = this.now();
    const cFrom = minutesAgo(now, CURRENT_MIN);
    const data = await this.api.graphql<Result>(QUERY, {
      script,
      cFrom: isoSeconds(cFrom),
      cTo: isoSeconds(now),
      bFrom: isoSeconds(minutesAgo(now, CURRENT_MIN + BASELINE_MIN)),
      bTo: isoSeconds(cFrom)
    });
    const acct = data.viewer.accounts[0];
    const cur = acct?.current?.[0];
    const base = acct?.baseline?.[0];
    const requests = cur?.sum.requests ?? 0;
    const errors = cur?.sum.errors ?? 0;

    return {
      service,
      timestamp: now.toISOString(),
      window: `last ${CURRENT_MIN}m`,
      request_rate_rps: round(requests / (CURRENT_MIN * 60), 2),
      error_rate_percent: pct(errors, requests),
      p50_latency_ms: ms(cur?.quantiles.wallTimeP50),
      p95_latency_ms: ms(cur?.quantiles.wallTimeP95),
      p99_latency_ms: ms(cur?.quantiles.wallTimeP99),
      baseline: {
        window: `${CURRENT_MIN + BASELINE_MIN}m to ${CURRENT_MIN}m ago`,
        requests: base?.sum.requests ?? 0,
        error_rate_percent: pct(base?.sum.errors ?? 0, base?.sum.requests ?? 0),
        p50_latency_ms: ms(base?.quantiles.wallTimeP50),
        p95_latency_ms: ms(base?.quantiles.wallTimeP95),
        p99_latency_ms: ms(base?.quantiles.wallTimeP99)
      },
      by_version: (acct?.byVersion ?? []).map((g) => ({
        version: (g.dimensions?.scriptVersion ?? "unknown").slice(0, 8),
        requests: g.sum.requests,
        error_rate_percent: pct(g.sum.errors, g.sum.requests),
        p50_latency_ms: ms(g.quantiles.wallTimeP50),
        p95_latency_ms: ms(g.quantiles.wallTimeP95)
      })),
      extra: {
        requests,
        errors,
        subrequests: cur?.sum.subrequests ?? 0,
        cpu_time_p50_ms: ms(cur?.quantiles.cpuTimeP50),
        cpu_time_p99_ms: ms(cur?.quantiles.cpuTimeP99),
        invocation_status: (acct?.byStatus ?? []).map((g) => `${g.dimensions?.status}=${g.sum.requests}`).join(", ") || "none",
        latency_source: "Worker wall time (includes waiting on D1 and other subrequests)",
        ...(requests === 0 && { note: `No requests in the last ${CURRENT_MIN} minutes` })
      }
    };
  }
}

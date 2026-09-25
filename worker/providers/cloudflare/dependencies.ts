/**
 * Real dependency health: the service's D1 database, from D1 analytics
 * (d1AnalyticsAdaptiveGroups), compared with the previous hour.
 */
import type { DependencyProvider, DependencyStatus } from "../types";
import { CloudflareApi, isoSeconds, minutesAgo, round } from "./api";
import { lookup, type ServiceCatalog } from "./catalog";

const CURRENT_MIN = 15;
const BASELINE_MIN = 60;
/** Heuristics, like an alert rule: absolute latency, or a large jump vs the previous hour. */
const DEGRADED_P99_MS = 250;
const DEGRADED_RATIO = 5;

function ratio(current: number, baseline: number): number {
  return baseline > 0 ? current / baseline : 0;
}

const QUERY = `
query ($accountTag: String!, $db: String!, $cFrom: Time!, $cTo: Time!, $bFrom: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      current: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $db, datetime_geq: $cFrom, datetime_leq: $cTo }) {
        sum { readQueries writeQueries rowsRead rowsWritten }
        quantiles { queryBatchTimeMsP50 queryBatchTimeMsP99 }
      }
      baseline: d1AnalyticsAdaptiveGroups(limit: 1, filter: { databaseId: $db, datetime_geq: $bFrom, datetime_leq: $cFrom }) {
        sum { readQueries writeQueries rowsRead }
        quantiles { queryBatchTimeMsP50 queryBatchTimeMsP99 }
      }
    }
  }
}`;

interface Group {
  sum: { readQueries: number; writeQueries: number; rowsRead: number; rowsWritten?: number };
  quantiles: { queryBatchTimeMsP50: number; queryBatchTimeMsP99: number };
}

export class CloudflareDependencyProvider implements DependencyProvider {
  readonly name = "cloudflare-d1-analytics";

  constructor(
    private readonly api: CloudflareApi,
    private readonly catalog: ServiceCatalog,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getDependencyHealth(service: string): Promise<DependencyStatus[]> {
    const entry = lookup(this.catalog, service);
    if (!entry.d1DatabaseId) return [];
    const now = this.now();
    const cFrom = minutesAgo(now, CURRENT_MIN);
    const data = await this.api.graphql<{ viewer: { accounts: Record<"current" | "baseline", Group[]>[] } }>(QUERY, {
      db: entry.d1DatabaseId,
      cFrom: isoSeconds(cFrom),
      cTo: isoSeconds(now),
      bFrom: isoSeconds(minutesAgo(now, CURRENT_MIN + BASELINE_MIN))
    });
    const cur = data.viewer.accounts[0]?.current?.[0];
    const base = data.viewer.accounts[0]?.baseline?.[0];
    const queries = (cur?.sum.readQueries ?? 0) + (cur?.sum.writeQueries ?? 0);
    const baseQueries = (base?.sum.readQueries ?? 0) + (base?.sum.writeQueries ?? 0);
    const p99 = cur?.quantiles.queryBatchTimeMsP99 ?? 0;
    const baseP99 = base?.quantiles.queryBatchTimeMsP99 ?? 0;
    const rowsPerQuery = queries ? (cur?.sum.rowsRead ?? 0) / queries : 0;
    const baseRowsPerQuery = baseQueries ? (base?.sum.rowsRead ?? 0) / baseQueries : 0;

    const anomalies: string[] = [];
    const rowsRatio = ratio(rowsPerQuery, baseRowsPerQuery);
    const p99Ratio = ratio(p99, baseP99);
    if (rowsRatio >= DEGRADED_RATIO) {
      anomalies.push(`rows read per query ${round(rowsRatio, 0)}x the previous hour (${round(baseRowsPerQuery, 1)} → ${round(rowsPerQuery, 1)})`);
    }
    if (p99Ratio >= DEGRADED_RATIO) {
      anomalies.push(`batch time p99 ${round(p99Ratio, 0)}x the previous hour (${round(baseP99, 2)}ms → ${round(p99, 2)}ms)`);
    }
    if (p99 > DEGRADED_P99_MS) anomalies.push(`batch time p99 ${round(p99, 0)}ms exceeds ${DEGRADED_P99_MS}ms`);

    return [
      {
        name: `d1:${entry.d1DatabaseId.slice(0, 8)}`,
        type: "database",
        status: anomalies.length ? "degraded" : "healthy",
        latency_p99_ms: round(p99, 2),
        details: {
          window: `last ${CURRENT_MIN}m vs the previous hour`,
          anomalies: anomalies.join("; ") || "none",
          queries,
          rows_read: cur?.sum.rowsRead ?? 0,
          rows_read_per_query: round(rowsPerQuery, 1),
          batch_time_p50_ms: round(cur?.quantiles.queryBatchTimeMsP50 ?? 0, 2),
          batch_time_p99_ms: round(p99, 2),
          baseline_rows_read_per_query: round(baseRowsPerQuery, 1),
          baseline_batch_time_p99_ms: round(baseP99, 2),
          note: "D1 analytics has no error counts; see search_logs for query errors"
        }
      }
    ];
  }
}

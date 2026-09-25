/**
 * Real D1 data:
 *   getSlowQueries → D1 query insights (GraphQL d1QueriesAdaptiveGroups),
 *                    the same data as `wrangler d1 insights`
 *   getQueryPlan   → `EXPLAIN QUERY PLAN` via the D1 query API (read-only)
 */
import type { DatabaseProvider, DatabaseStats, QueryPlan, SlowQuery } from "../types";
import { CloudflareApi, isoSeconds, minutesAgo, round } from "./api";
import { lookup, type ServiceCatalog } from "./catalog";

/** Same window as the metrics, so an old, already-fixed query can't pose as a current problem. */
const WINDOW_MIN = 15;

const QUERY = `
query ($accountTag: String!, $filter: AccountD1QueriesAdaptiveGroupsFilter_InputObject) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      d1QueriesAdaptiveGroups(limit: 25, filter: $filter, orderBy: [sum_queryDurationMs_DESC]) {
        sum { queryDurationMs rowsRead rowsReturned }
        avg { queryDurationMs rowsRead rowsReturned }
        quantiles { queryDurationMsP95 }
        count
        dimensions { query }
      }
    }
  }
}`;

interface Group {
  sum: { queryDurationMs: number; rowsRead: number; rowsReturned: number };
  avg: { queryDurationMs: number; rowsRead: number; rowsReturned: number };
  quantiles: { queryDurationMsP95: number };
  count: number;
  dimensions: { query: string };
}

/** Stable short id for a query text (FNV-1a). */
export function queryIdOf(sql: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sql.length; i++) {
    h ^= sql.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `q-${h.toString(16).padStart(8, "0")}`;
}

/**
 * The app's workload = data queries. Excludes migrations/DDL, the agent's own
 * EXPLAIN / sqlite_master lookups, and D1 internals.
 */
export function isAppQuery(sql: string): boolean {
  return /^\s*(select|insert|update|delete|with)\b/i.test(sql) && !/sqlite_master|_cf_|d1_migrations/i.test(sql);
}

/** Only a single read-only SELECT may be explained. */
export function assertExplainable(sql: string): void {
  const body = sql.trim().replace(/;\s*$/, "");
  if (!/^(select|with)\b/i.test(body) || body.includes(";")) {
    throw new Error("Only single SELECT statements can be explained");
  }
}

function tablesIn(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+["`]?([a-zA-Z_][\w]*)/gi)].map((m) => m[1]);
}

export class CloudflareDatabaseProvider implements DatabaseProvider {
  readonly name = "cloudflare-d1";

  constructor(
    private readonly api: CloudflareApi,
    private readonly catalog: ServiceCatalog,
    private readonly now: () => Date = () => new Date()
  ) {}

  private databaseId(service: string): string {
    const entry = lookup(this.catalog, service);
    if (!entry.d1DatabaseId) throw new Error(`No D1 database is configured for ${service}`);
    return entry.d1DatabaseId;
  }

  private async groups(databaseId: string): Promise<Group[]> {
    const now = this.now();
    const data = await this.api.graphql<{ viewer: { accounts: { d1QueriesAdaptiveGroups: Group[] }[] } }>(QUERY, {
      filter: { AND: [{ databaseId, datetime_geq: isoSeconds(minutesAgo(now, WINDOW_MIN)), datetime_leq: isoSeconds(now) }] }
    });
    return (data.viewer.accounts[0]?.d1QueriesAdaptiveGroups ?? []).filter((g) => g.dimensions.query && isAppQuery(g.dimensions.query));
  }

  async getSlowQueries(service: string, limit = 5): Promise<DatabaseStats> {
    const databaseId = this.databaseId(service);
    const groups = await this.groups(databaseId);
    const totalMs = groups.reduce((s, g) => s + g.sum.queryDurationMs, 0);
    const queries: SlowQuery[] = groups.slice(0, limit).map((g) => ({
      queryId: queryIdOf(g.dimensions.query),
      query: g.dimensions.query,
      calls_per_min: round(g.count / WINDOW_MIN, 1),
      mean_ms: round(g.avg.queryDurationMs, 2),
      p95_ms: round(g.quantiles.queryDurationMsP95, 2),
      rows_examined_per_call: round(g.avg.rowsRead, 1),
      rows_returned_per_call: round(g.avg.rowsReturned, 1),
      percent_of_db_time: totalMs ? round((g.sum.queryDurationMs / totalMs) * 100, 1) : 0
    }));
    return {
      service,
      database: `D1 ${databaseId.slice(0, 8)} (last ${WINDOW_MIN}m)`,
      queries
    };
  }

  async getQueryPlan(service: string, queryId: string): Promise<QueryPlan> {
    const databaseId = this.databaseId(service);
    const groups = await this.groups(databaseId);
    const match = groups.find((g) => queryIdOf(g.dimensions.query) === queryId);
    if (!match) {
      throw new Error(`Unknown query id "${queryId}". Query ids from get_slow_queries: ${groups.slice(0, 5).map((g) => queryIdOf(g.dimensions.query)).join(", ")}`);
    }
    const sql = match.dimensions.query;
    assertExplainable(sql);

    // Placeholders are bound to NULL: the plan depends on the query shape, not the values.
    const params = (sql.match(/\?/g) ?? []).map(() => null);
    type D1Result = { results: Record<string, unknown>[] }[];
    const planRows = (
      await this.api.rest<D1Result>("POST", `/d1/database/${databaseId}/query`, { sql: `EXPLAIN QUERY PLAN ${sql}`, params })
    )[0]?.results ?? [];

    // Indent each step under its parent, like the sqlite3 shell does.
    const depth = new Map<number, number>();
    const plan = planRows.map((r) => {
      const d = (depth.get(Number(r.parent)) ?? -1) + 1;
      depth.set(Number(r.id), d);
      return `${"  ".repeat(d)}${String(r.detail)}`;
    });

    const tables = [...new Set(tablesIn(sql))];
    const indexRows = (
      await this.api.rest<D1Result>("POST", `/d1/database/${databaseId}/query`, {
        sql: `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`
      })
    )[0]?.results ?? [];

    return {
      service,
      queryId,
      query: sql,
      plan,
      indexes: indexRows
        .filter((r) => tables.length === 0 || tables.includes(String(r.tbl_name)))
        .map((r) => ({ name: String(r.name), definition: String(r.sql) }))
    };
  }
}

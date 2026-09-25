import { describe, expect, it } from "vitest";
import { CloudflareApi } from "../worker/providers/cloudflare/api";
import { parseCatalog } from "../worker/providers/cloudflare/catalog";
import { CloudflareDatabaseProvider, assertExplainable, isAppQuery, queryIdOf } from "../worker/providers/cloudflare/database";
import { CloudflareDeployProvider } from "../worker/providers/cloudflare/deploys";
import { CloudflareLogProvider } from "../worker/providers/cloudflare/logs";
import { CloudflareMonitoringProvider } from "../worker/providers/cloudflare/monitoring";
import { ServiceNotFoundError } from "../worker/providers/types";

const NOW = () => new Date("2026-09-26T10:30:00Z");
const catalog = parseCatalog({ "demo-shop": { script: "demo-shop", d1DatabaseId: "db-123" } });

/** Records calls and answers from canned handlers. */
class FakeApi extends CloudflareApi {
  calls: { kind: string; path?: string; body?: unknown; variables?: unknown }[] = [];
  constructor(
    private readonly onGraphql: (variables: Record<string, unknown>) => unknown = () => ({}),
    private readonly onRest: (method: string, path: string, body?: unknown) => unknown = () => ({})
  ) {
    super("acct", "token");
  }
  override async graphql<T>(_q: string, variables: Record<string, unknown>): Promise<T> {
    this.calls.push({ kind: "graphql", variables });
    return this.onGraphql(variables) as T;
  }
  override async rest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    this.calls.push({ kind: "rest", path, body });
    return this.onRest(method, path, body) as T;
  }
}

describe("CloudflareApi", () => {
  it("fails clearly when the token is missing", async () => {
    const api = new CloudflareApi("acct", undefined, async () => new Response("{}"));
    await expect(api.graphql("{}", {})).rejects.toThrow("CF_API_TOKEN");
  });

  it("surfaces GraphQL errors", async () => {
    const api = new CloudflareApi("acct", "t", async () => Response.json({ data: null, errors: [{ message: "bad field" }] }));
    await expect(api.graphql("{}", {})).rejects.toThrow("bad field");
  });
});

describe("catalog", () => {
  it("parses objects and JSON strings, and rejects unknown services", () => {
    expect(parseCatalog('{"a":{"script":"a"}}')).toEqual({ a: { script: "a", d1DatabaseId: undefined } });
    expect(() => new CloudflareMonitoringProvider(new FakeApi(), catalog).getServiceMetrics("nope")).rejects.toBeInstanceOf(
      ServiceNotFoundError
    );
  });
});

describe("CloudflareMonitoringProvider", () => {
  it("converts microseconds to ms and computes rates, baseline and per-version data", async () => {
    const q = (p50: number, p95: number, p99: number) => ({ wallTimeP50: p50, wallTimeP95: p95, wallTimeP99: p99, cpuTimeP50: 800, cpuTimeP99: 1500 });
    const api = new FakeApi(() => ({
      viewer: {
        accounts: [
          {
            current: [{ sum: { requests: 900, errors: 90, subrequests: 900 }, quantiles: q(70_000, 180_000, 250_000) }],
            baseline: [{ sum: { requests: 3600, errors: 0 }, quantiles: q(60_000, 75_000, 80_000) }],
            byStatus: [
              { sum: { requests: 810, errors: 0 }, quantiles: q(0, 0, 0), dimensions: { status: "success" } },
              { sum: { requests: 90, errors: 90 }, quantiles: q(0, 0, 0), dimensions: { status: "scriptThrewException" } }
            ],
            byVersion: [
              { sum: { requests: 900, errors: 90 }, quantiles: q(70_000, 180_000, 0), dimensions: { scriptVersion: "bbbbbbbb-2" } },
              { sum: { requests: 3600, errors: 0 }, quantiles: q(60_000, 75_000, 0), dimensions: { scriptVersion: "aaaaaaaa-1" } }
            ]
          }
        ]
      }
    }));
    const m = await new CloudflareMonitoringProvider(api, catalog, NOW).getServiceMetrics("demo-shop");
    expect(m).toMatchObject({ request_rate_rps: 1, error_rate_percent: 10, p50_latency_ms: 70, p95_latency_ms: 180, p99_latency_ms: 250 });
    expect(m.baseline).toMatchObject({ requests: 3600, p95_latency_ms: 75 });
    expect(m.by_version?.[0]).toMatchObject({ version: "bbbbbbbb", error_rate_percent: 10 });
    expect(m.extra.invocation_status).toBe("success=810, scriptThrewException=90");
    expect((api.calls[0].variables as Record<string, string>).cFrom).toBe("2026-09-26T10:15:00Z");
  });
});

describe("CloudflareDeployProvider", () => {
  it("lists recent deploys with messages and config diffs between versions", async () => {
    const versions: Record<string, { number: number; vars: Record<string, string> }> = {
      v3: { number: 3, vars: { FEATURE_FULLTEXT_SEARCH: "on", FAULT_ERROR_RATE: "0" } },
      v2: { number: 2, vars: { FEATURE_FULLTEXT_SEARCH: "off", FAULT_ERROR_RATE: "0" } },
      v1: { number: 1, vars: { FEATURE_FULLTEXT_SEARCH: "off" } }
    };
    const deployment = (id: string, created: string, message: string) => ({
      id: `d-${id}`,
      created_on: created,
      source: "wrangler",
      author_email: "dev@example.com",
      annotations: { "workers/message": message, "workers/triggered_by": "upload" },
      versions: [{ version_id: id, percentage: 100 }]
    });
    const api = new FakeApi(undefined, (_m, path) => {
      if (path.endsWith("/deployments")) {
        return {
          deployments: [
            deployment("v1", "2026-09-20T10:00:00Z", "Initial"),
            deployment("v3", "2026-09-26T10:20:00Z", "Enable full-text product search"),
            deployment("v2", "2026-09-26T09:00:00Z", "Baseline: category search")
          ]
        };
      }
      const id = path.split("/").pop()!;
      const v = versions[id];
      return {
        id,
        number: v.number,
        resources: { bindings: Object.entries(v.vars).map(([name, text]) => ({ type: "plain_text", name, text })) }
      };
    });
    const deploys = await new CloudflareDeployProvider(api, catalog, NOW).getRecentDeploys("demo-shop", 72);
    expect(deploys.map((d) => d.summary)).toEqual(["Enable full-text product search", "Baseline: category search"]);
    expect(deploys[0].configChanges).toEqual(["FEATURE_FULLTEXT_SEARCH: off → on"]);
    expect(deploys[1].configChanges).toEqual(["FAULT_ERROR_RATE: (unset) → 0"]);
    expect(deploys[0].version).toBe("#3 v3");
  });
});

describe("CloudflareDatabaseProvider", () => {
  const fullText = "SELECT id, name FROM products WHERE lower(name) LIKE ? OR lower(category) LIKE ? ORDER BY price LIMIT ?";
  const group = (query: string, totalMs: number, rowsRead: number) => ({
    sum: { queryDurationMs: totalMs, rowsRead: rowsRead * 10, rowsReturned: 200 },
    avg: { queryDurationMs: totalMs / 10, rowsRead, rowsReturned: 20 },
    quantiles: { queryDurationMsP95: totalMs / 5 },
    count: 60,
    dimensions: { query }
  });

  const api = () =>
    new FakeApi(
      () => ({
        viewer: {
          accounts: [
            {
              d1QueriesAdaptiveGroups: [
                group(fullText, 90, 10_000),
                group("SELECT * FROM products WHERE id = ?", 10, 1),
                group("CREATE INDEX idx ON products (category)", 5, 2),
                group("EXPLAIN QUERY PLAN SELECT 1", 1, 1)
              ]
            }
          ]
        }
      }),
      (_m, _path, body) => {
        const sql = (body as { sql: string }).sql;
        if (sql.startsWith("EXPLAIN")) {
          return [{ results: [{ id: 2, parent: 0, detail: "SCAN products" }, { id: 5, parent: 0, detail: "USE TEMP B-TREE FOR ORDER BY" }] }];
        }
        return [{ results: [{ name: "idx_products_category_price", tbl_name: "products", sql: "CREATE INDEX idx_products_category_price ON products (category, price)" }] }];
      }
    );

  it("ranks the app's queries by DB time and drops DDL and diagnostic queries", async () => {
    const stats = await new CloudflareDatabaseProvider(api(), catalog, NOW).getSlowQueries("demo-shop");
    expect(stats.queries.map((q) => q.query)).toEqual([fullText, "SELECT * FROM products WHERE id = ?"]);
    expect(stats.queries[0]).toMatchObject({ rows_examined_per_call: 10_000, percent_of_db_time: 90, calls_per_min: 4 });
  });

  it("explains a query by id with NULL-bound placeholders", async () => {
    const a = api();
    const plan = await new CloudflareDatabaseProvider(a, catalog, NOW).getQueryPlan("demo-shop", queryIdOf(fullText));
    expect(plan.plan).toEqual(["SCAN products", "USE TEMP B-TREE FOR ORDER BY"]);
    expect(plan.indexes[0].name).toBe("idx_products_category_price");
    const explain = a.calls.find((c) => c.kind === "rest" && (c.body as { sql: string }).sql.startsWith("EXPLAIN"));
    expect((explain?.body as { params: unknown[] }).params).toEqual([null, null, null]);
  });

  it("only explains single SELECT statements", () => {
    expect(() => assertExplainable("SELECT 1")).not.toThrow();
    expect(() => assertExplainable("DELETE FROM products")).toThrow();
    expect(() => assertExplainable("SELECT 1; DROP TABLE products")).toThrow();
    expect(isAppQuery("UPDATE products SET price = ?")).toBe(true);
    expect(isAppQuery("SELECT name FROM sqlite_master")).toBe(false);
  });
});

describe("CloudflareLogProvider", () => {
  it("searches each term, merges duplicates and ranks by matched terms", async () => {
    const events = [
      { timestamp: Date.parse("2026-09-26T10:29:00Z"), $metadata: { level: "error", message: "InventoryClient: connection reset" } },
      { timestamp: Date.parse("2026-09-26T10:28:00Z"), $metadata: { level: "log", message: "inventory ok" } }
    ];
    const api = new FakeApi(undefined, (_m, _p, body) => {
      const needle = (body as { parameters: { needle?: { value: string } } }).parameters.needle?.value ?? "";
      return { events: { events: events.filter((e) => e.$metadata.message.toLowerCase().includes(needle)) } };
    });
    const logs = await new CloudflareLogProvider(api, catalog, NOW).searchLogs("demo-shop", "inventory connection errors");
    expect(api.calls).toHaveLength(3); // one query per term
    expect(logs.map((l) => l.message)).toEqual(["InventoryClient: connection reset", "inventory ok"]);
    expect(logs[0]).toMatchObject({ level: "ERROR", timestamp: "2026-09-26T10:29:00Z" });
    const filter = (api.calls[0].body as { parameters: { filters: { value: string }[] } }).parameters.filters[0];
    expect(filter.value).toBe("demo-shop");
  });
});

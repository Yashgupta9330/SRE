import { describe, expect, it } from "vitest";
import { MockLogProvider } from "../worker/providers/mock/mock-logs";
import { MockMonitoringProvider } from "../worker/providers/mock/mock-monitoring";
import { KnowledgeBaseRunbookProvider } from "../worker/providers/runbook-provider";
import { ServiceNotFoundError } from "../worker/providers/types";
import { executeTool, toolDefinitions } from "../worker/tools/registry";
import { detectService, extractServiceMention, normalizeServiceName } from "../worker/tools/service-names";
import { FIXED_NOW, HashEmbedder, InMemoryRunbookRepo, InMemoryVectorIndex, mockToolContext } from "./fakes";

const SERVICES = ["payment-service", "order-service", "notification-service", "inventory-service"];

describe("MockMonitoringProvider", () => {
  const monitoring = new MockMonitoringProvider(undefined, FIXED_NOW);

  it("returns scenario metrics for a known service", async () => {
    const m = await monitoring.getServiceMetrics("payment-service");
    expect(m).toMatchObject({ service: "payment-service", p95_latency_ms: 1850, p99_latency_ms: 3200, error_rate_percent: 8.2 });
    expect(m.timestamp).toBe("2026-09-26T10:32:00.000Z");
  });

  it("throws ServiceNotFoundError for unknown services", async () => {
    await expect(monitoring.getServiceMetrics("billing-service")).rejects.toBeInstanceOf(ServiceNotFoundError);
  });
});

describe("MockLogProvider", () => {
  const logs = new MockLogProvider(undefined, FIXED_NOW);

  it("finds DB timeout / pool exhaustion lines for payment-service", async () => {
    const entries = await logs.searchLogs("payment-service", "database timeout");
    const text = entries.map((e) => e.message).join("\n");
    expect(text).toContain("DB connection timeout");
    expect(text).toContain("connection pool exhausted");
    // Most recent first, with timestamps derived from "now".
    expect(Date.parse(entries[0].timestamp)).toBeGreaterThan(Date.parse(entries[entries.length - 1].timestamp));
  });

  it("returns different data per service", async () => {
    const entries = await logs.searchLogs("notification-service", "kafka consumer lag");
    expect(entries.some((e) => e.message.includes("Consumer lag high"))).toBe(true);
    const order = await logs.searchLogs("order-service", "slow query");
    expect(order.some((e) => e.message.includes("Seq Scan") || e.message.includes("Slow query"))).toBe(true);
  });

  it("returns nothing for unrelated terms", async () => {
    expect(await logs.searchLogs("inventory-service", "kafka")).toEqual([]);
  });
});

describe("KnowledgeBaseRunbookProvider", () => {
  it("lazily seeds and keyword-searches when Vectorize is not available", async () => {
    const repo = new InMemoryRunbookRepo();
    const provider = new KnowledgeBaseRunbookProvider(repo, undefined, undefined);
    const results = await provider.searchRunbooks("database connection pool exhausted");
    expect(repo.rows.size).toBeGreaterThan(0);
    expect(results[0].slug).toBe("database-connection-pool-exhaustion");
    expect(results[0].matchedBy).toBe("keyword");
  });

  it("uses Vectorize results when available", async () => {
    const provider = new KnowledgeBaseRunbookProvider(new InMemoryRunbookRepo(), new InMemoryVectorIndex(), new HashEmbedder());
    const results = await provider.searchRunbooks("Kafka consumer lag. Tags: kafka, consumer lag, queue, backlog, rebalance");
    expect(results[0]).toMatchObject({ slug: "kafka-consumer-lag", matchedBy: "semantic" });
  });

  it("falls back to keyword search when Vectorize fails", async () => {
    const vectors = new InMemoryVectorIndex();
    vectors.failing = true;
    const provider = new KnowledgeBaseRunbookProvider(new InMemoryRunbookRepo(), vectors, new HashEmbedder());
    const results = await provider.searchRunbooks("high cpu throttling");
    expect(results[0]).toMatchObject({ slug: "high-cpu", matchedBy: "keyword" });
  });
});

describe("tools", () => {
  it("exposes all tool definitions", () => {
    expect(toolDefinitions().map((t) => t.name)).toEqual([
      "get_service_metrics",
      "search_logs",
      "get_recent_deploys",
      "get_dependency_health",
      "get_slow_queries",
      "get_query_plan",
      "search_runbook"
    ]);
  });

  it("normalizes service names from the LLM", async () => {
    const res = await executeTool("get_service_metrics", { service: "Payment Service" }, mockToolContext());
    expect(res).toMatchObject({ ok: true, data: { service: "payment-service" } });
  });

  it("returns a structured error (not a throw) for unknown services", async () => {
    const res = await executeTool("get_service_metrics", { service: "billing" }, mockToolContext());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Known services");
  });

  it("rejects missing arguments and unknown tools", async () => {
    expect(await executeTool("search_logs", { service: "payment-service" }, mockToolContext())).toMatchObject({ ok: false });
    expect(await executeTool("restart_database", {}, mockToolContext())).toMatchObject({ ok: false });
  });

  it("wraps provider failures", async () => {
    const ctx = mockToolContext();
    ctx.logs = { name: "broken", searchLogs: async () => { throw new Error("Loki 503"); } };
    const res = await executeTool("search_logs", { service: "payment-service", query: "error" }, ctx);
    expect(res).toEqual({ ok: false, error: "search_logs failed: Loki 503" });
  });
});

describe("service names", () => {
  it.each([
    ["API latency is high for payment-service. Investigate.", "payment-service"],
    ["Payment API latency is high.", "payment-service"],
    ["Payment service is slow again. Have we seen this before?", "payment-service"],
    ["order svc cpu is pegged", "order-service"],
    ["Notifications are delayed, notification-service lag?", "notification-service"],
    ["hello there", undefined]
  ])("detectService(%s)", (text, expected) => {
    expect(detectService(text, SERVICES)).toBe(expected);
  });

  it.each([
    ["demo-shop search is slow", "demo-shop"],
    ["the demo shop is throwing errors", "demo-shop"],
    ["shop is down", undefined]
  ])("detectService with hyphenated names (%s)", (text, expected) => {
    expect(detectService(text, ["demo-shop"])).toBe(expected);
  });

  it("captures service names that are not in the catalog", () => {
    expect(extractServiceMention("billing-service is throwing 500s")).toBe("billing-service");
    expect(extractServiceMention("the site is down")).toBeUndefined();
  });

  it("normalizes variants", () => {
    expect(normalizeServiceName("order", SERVICES)).toBe("order-service");
    expect(normalizeServiceName("Order_Service", SERVICES)).toBe("order-service");
    expect(normalizeServiceName("unknown-thing", SERVICES)).toBe("unknown-thing");
  });
});

describe("deploy, dependency and database tools", () => {
  it("lists recent deploys newest first, within the lookback window", async () => {
    const res = await executeTool("get_recent_deploys", { service: "payment-service" }, mockToolContext());
    expect(res.ok).toBe(true);
    const data = (res as { data: { deploys: { version: string; deployedAt: string }[] } }).data;
    expect(data.deploys.map((d) => d.version)).toEqual(["v2.14.0"]); // v2.13.2 is 3 days old, outside 72h
    expect(data.deploys[0].deployedAt).toBe("2026-09-26T10:17:00Z");
  });

  it("flags unhealthy dependencies", async () => {
    const res = await executeTool("get_dependency_health", { service: "notification-service" }, mockToolContext());
    expect(res).toMatchObject({ ok: true, data: { unhealthy: ["email-provider"] } });
  });

  it("returns slow queries ordered by DB time, with pool stats", async () => {
    const res = await executeTool("get_slow_queries", { service: "order-service" }, mockToolContext());
    const data = (res as { data: { queries: { queryId: string; percent_of_db_time: number }[]; connectionPool: object } }).data;
    expect(data.queries[0]).toMatchObject({ queryId: "q-ord-1", percent_of_db_time: 91 });
    expect(data.connectionPool).toBeDefined();
  });

  it("returns a query plan with indexes, and a helpful error for unknown ids", async () => {
    const ctx = mockToolContext();
    const plan = await executeTool("get_query_plan", { service: "order-service", query_id: "q-ord-1" }, ctx);
    const data = (plan as { data: { plan: string[]; indexes: { name: string }[] } }).data;
    expect(data.plan.some((l) => l.includes("Seq Scan on orders"))).toBe(true);
    expect(data.indexes.map((i) => i.name)).toContain("idx_orders_customer_email");

    const missing = await executeTool("get_query_plan", { service: "order-service", query_id: "q-nope" }, ctx);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("q-ord-1");
  });

  it("requires query_id for get_query_plan", async () => {
    expect(await executeTool("get_query_plan", { service: "order-service" }, mockToolContext())).toMatchObject({ ok: false });
  });
});

/**
 * Live integration test against the real Cloudflare APIs.
 * Skipped unless CF_API_TOKEN is set:
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… npx vitest run test/live-cloudflare.test.ts
 */
import { describe, expect, it } from "vitest";
import { createCloudflareProviders } from "../worker/providers/cloudflare";

const token = process.env.CF_API_TOKEN;
const accountId = process.env.CF_ACCOUNT_ID ?? "839453a1c373100cd160239b6327f708";
const catalog = { "demo-shop": { script: "demo-shop", d1DatabaseId: "bc0d3eba-d464-412a-bbd4-2ca43e843eba" } };
const only = (process.env.LIVE_ONLY ?? "metrics,deploys,database,dependencies,logs").split(",");

describe.skipIf(!token)("Cloudflare providers (live)", () => {
  const p = createCloudflareProviders({ accountId, apiToken: token, serviceCatalog: catalog });

  it.runIf(only.includes("metrics"))("reads Worker metrics", async () => {
    const m = await p.monitoring.getServiceMetrics("demo-shop");
    console.log("metrics", JSON.stringify(m, null, 1));
    expect(m.service).toBe("demo-shop");
  });

  it.runIf(only.includes("deploys"))("reads deploy history", async () => {
    const d = await p.deploys.getRecentDeploys("demo-shop", 72);
    console.log("deploys", JSON.stringify(d, null, 1));
    expect(d.length).toBeGreaterThan(0);
  });

  it.runIf(only.includes("database"))("reads D1 query insights and a query plan", async () => {
    const stats = await p.database.getSlowQueries("demo-shop", 5);
    console.log("slow queries", JSON.stringify(stats, null, 1));
    if (stats.queries[0]) {
      const plan = await p.database.getQueryPlan("demo-shop", stats.queries[0].queryId);
      console.log("plan", JSON.stringify(plan, null, 1));
      expect(plan.plan.length).toBeGreaterThan(0);
    }
  });

  it.runIf(only.includes("dependencies"))("reads D1 health", async () => {
    const deps = await p.dependencies.getDependencyHealth("demo-shop");
    console.log("dependencies", JSON.stringify(deps, null, 1));
    expect(deps[0].type).toBe("database");
  });

  it.runIf(only.includes("logs"))("searches Workers Logs", async () => {
    const logs = await p.logs.searchLogs("demo-shop", "search rows_read", { limit: 5 });
    console.log("logs", JSON.stringify(logs, null, 1));
    expect(Array.isArray(logs)).toBe(true);
  });
});

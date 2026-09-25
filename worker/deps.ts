/**
 * Composition root: the only place that decides which implementations are used.
 *
 * PROVIDER_MODE picks the infrastructure providers:
 *   cloudflare → real telemetry of Cloudflare Workers (Analytics API, Workers
 *                Logs, Deployments API, D1 insights) for SERVICE_CATALOG
 *   mock       → simulated services, for tests and offline demos
 * Other backends (Prometheus, Loki, Postgres, ...) implement the same
 * interfaces and plug in here. Nothing else changes.
 */
import { D1IncidentRepository, D1RunbookRepository, InvestigationRepository } from "./db/repositories";
import { WorkersAiLlm } from "./llm/workers-ai";
import { IncidentMemoryStore } from "./memory/incident-memory";
import { WorkersAiEmbedder } from "./memory/vectors";
import { MockLogProvider } from "./providers/mock/mock-logs";
import { MockMonitoringProvider } from "./providers/mock/mock-monitoring";
import { createCloudflareProviders } from "./providers/cloudflare";
import { MockDatabaseProvider, MockDependencyProvider, MockDeployProvider } from "./providers/mock/mock-platform";
import { KnowledgeBaseRunbookProvider } from "./providers/runbook-provider";
import type { ToolContext } from "./tools/types";

export type ProviderMode = "cloudflare" | "mock";

export function providerMode(env: Env): ProviderMode {
  // Widen the literal type wrangler generates from the current config value.
  return (env.PROVIDER_MODE as string) === "mock" ? "mock" : "cloudflare";
}

function infrastructureProviders(env: Env): Omit<ToolContext, "runbooks"> {
  if (providerMode(env) === "cloudflare") {
    return createCloudflareProviders({
      accountId: env.CF_ACCOUNT_ID,
      apiToken: env.CF_API_TOKEN,
      serviceCatalog: env.SERVICE_CATALOG
    });
  }
  return {
    monitoring: new MockMonitoringProvider(),
    logs: new MockLogProvider(),
    deploys: new MockDeployProvider(),
    dependencies: new MockDependencyProvider(),
    database: new MockDatabaseProvider()
  };
}

export function createDeps(env: Env) {
  const embedder = new WorkersAiEmbedder(env.AI, env.EMBEDDING_MODEL);
  const tools: ToolContext = {
    ...infrastructureProviders(env),
    runbooks: new KnowledgeBaseRunbookProvider(new D1RunbookRepository(env.DB), env.VECTORIZE, embedder)
  };
  return {
    llm: new WorkersAiLlm(env.AI, env.LLM_MODEL),
    embedder,
    tools,
    memory: new IncidentMemoryStore(new D1IncidentRepository(env.DB), env.VECTORIZE, embedder),
    investigations: new InvestigationRepository(env.DB)
  };
}

export type Deps = ReturnType<typeof createDeps>;

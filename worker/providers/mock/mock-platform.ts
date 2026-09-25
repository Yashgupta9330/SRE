/**
 * Mock deploy, dependency and database providers, backed by the scenarios.
 * Real equivalents: GitHub Deployments / Argo CD, an APM service map,
 * pg_stat_statements + EXPLAIN (or RDS Performance Insights).
 */
import {
  ServiceNotFoundError,
  type DatabaseProvider,
  type DatabaseStats,
  type DependencyProvider,
  type DependencyStatus,
  type DeployProvider,
  type Deployment,
  type QueryPlan
} from "../types";
import { MOCK_SCENARIOS, type MockScenario } from "./scenarios";

abstract class ScenarioProvider {
  constructor(
    protected readonly scenarios: Record<string, MockScenario> = MOCK_SCENARIOS,
    protected readonly now: () => Date = () => new Date()
  ) {}

  protected scenario(service: string): MockScenario {
    const s = this.scenarios[service];
    if (!s) throw new ServiceNotFoundError(service, Object.keys(this.scenarios));
    return s;
  }

  protected isoAgo(offsetSeconds: number): string {
    return new Date(this.now().getTime() - offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

export class MockDeployProvider extends ScenarioProvider implements DeployProvider {
  readonly name = "mock-deploys";

  async getRecentDeploys(service: string, hours: number): Promise<Deployment[]> {
    return this.scenario(service)
      .deploys.filter((d) => d.offsetSeconds <= hours * 3600)
      .sort((a, b) => a.offsetSeconds - b.offsetSeconds)
      .map((d) => ({
        service,
        version: d.version,
        deployedAt: this.isoAgo(d.offsetSeconds),
        deployedBy: d.deployedBy,
        summary: d.summary,
        changes: [...d.changes],
        configChanges: [...d.configChanges]
      }));
  }
}

export class MockDependencyProvider extends ScenarioProvider implements DependencyProvider {
  readonly name = "mock-dependencies";

  async getDependencyHealth(service: string): Promise<DependencyStatus[]> {
    return this.scenario(service).dependencies.map((d) => ({ ...d, details: { ...d.details } }));
  }
}

export class MockDatabaseProvider extends ScenarioProvider implements DatabaseProvider {
  readonly name = "mock-database";

  private db(service: string) {
    const db = this.scenario(service).database;
    if (!db) throw new Error(`No database statistics available for ${service}`);
    return db;
  }

  async getSlowQueries(service: string, limit = 5): Promise<DatabaseStats> {
    const db = this.db(service);
    return {
      service,
      database: db.database,
      ...(db.connectionPool && { connectionPool: { ...db.connectionPool } }),
      queries: [...db.slowQueries].sort((a, b) => b.percent_of_db_time - a.percent_of_db_time).slice(0, limit)
    };
  }

  async getQueryPlan(service: string, queryId: string): Promise<QueryPlan> {
    const db = this.db(service);
    const plan = db.plans[queryId];
    if (!plan) {
      const known = db.slowQueries.map((q) => q.queryId).join(", ");
      throw new Error(`No plan for query "${queryId}" on ${db.database}. Query ids from get_slow_queries: ${known}`);
    }
    return { service, ...plan, plan: [...plan.plan], indexes: plan.indexes.map((i) => ({ ...i })) };
  }
}

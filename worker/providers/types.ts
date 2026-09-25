/**
 * Infrastructure provider interfaces.
 *
 * Tools depend on these interfaces, never on a concrete implementation. Today
 * the monitoring and log providers are mocks; a PrometheusMonitoringProvider,
 * CloudWatchMonitoringProvider, LokiLogProvider, etc. can implement the same
 * interface and be swapped in inside `providers/index.ts` without touching
 * tools, the agent loop, or the workflow.
 */

export interface ServiceMetrics {
  service: string;
  /** ISO timestamp of the sample. */
  timestamp: string;
  window: string;
  request_rate_rps: number;
  error_rate_percent: number;
  p50_latency_ms?: number;
  p95_latency_ms?: number;
  p99_latency_ms?: number;
  /** Not every platform has these (a Worker has CPU time, not CPU %). */
  cpu_percent?: number;
  memory_percent?: number;
  /** The same metrics over an earlier window, for comparison. */
  baseline?: Record<string, number | string>;
  /** Metrics broken down by deployed version, when the platform tracks it. */
  by_version?: Record<string, number | string>[];
  /** Service-specific signals (DB pool usage, consumer lag, ...). */
  extra: Record<string, number | string>;
}

export interface MonitoringProvider {
  readonly name: string;
  /** Service catalog: the services this provider has telemetry for. */
  listServices(): Promise<string[]>;
  /** @throws ServiceNotFoundError when the service is unknown. */
  getServiceMetrics(service: string): Promise<ServiceMetrics>;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
}

export interface LogSearchOptions {
  limit?: number;
}

export interface LogProvider {
  readonly name: string;
  /** @throws ServiceNotFoundError when the service is unknown. */
  searchLogs(service: string, query: string, options?: LogSearchOptions): Promise<LogEntry[]>;
}

// ─── Deploys (e.g. GitHub Deployments, Argo CD, Spinnaker) ───────────────────

export interface Deployment {
  service: string;
  version: string;
  deployedAt: string;
  deployedBy: string;
  summary: string;
  changes: string[];
  configChanges: string[];
}

export interface DeployProvider {
  readonly name: string;
  /** Deploys of `service` within the last `hours`, most recent first. */
  getRecentDeploys(service: string, hours: number): Promise<Deployment[]>;
}

// ─── Dependencies (e.g. service mesh / APM service map, health checks) ──────

export interface DependencyStatus {
  name: string;
  type: "database" | "cache" | "queue" | "http";
  status: "healthy" | "degraded" | "down";
  latency_p95_ms?: number;
  latency_p99_ms?: number;
  error_rate_percent?: number;
  details: Record<string, number | string>;
}

export interface DependencyProvider {
  readonly name: string;
  getDependencyHealth(service: string): Promise<DependencyStatus[]>;
}

// ─── Database (e.g. pg_stat_statements, EXPLAIN, Performance Insights) ──────

export interface SlowQuery {
  queryId: string;
  query: string;
  calls_per_min: number;
  mean_ms: number;
  p95_ms?: number;
  rows_examined_per_call: number;
  rows_returned_per_call: number;
  percent_of_db_time: number;
}

export interface DatabaseStats {
  service: string;
  database: string;
  connectionPool?: Record<string, number | string>;
  /** Ordered by share of total database time. */
  queries: SlowQuery[];
}

export interface QueryPlan {
  service: string;
  queryId: string;
  query: string;
  /** EXPLAIN ANALYZE output, one line per entry. */
  plan: string[];
  /** Indexes on the tables the query touches. */
  indexes: { name: string; definition: string }[];
}

export interface DatabaseProvider {
  readonly name: string;
  /** Top queries by database time, plus connection pool stats. */
  getSlowQueries(service: string, limit?: number): Promise<DatabaseStats>;
  /** @throws Error when the query id is unknown. */
  getQueryPlan(service: string, queryId: string): Promise<QueryPlan>;
}

// ─── Runbooks ───────────────────────────────────────────────────────────────

export interface Runbook {
  slug: string;
  title: string;
  tags: string[];
  symptoms: string[];
  investigationSteps: string[];
  possibleCauses: string[];
  recommendedActions: string[];
  verificationSteps: string[];
}

export interface RunbookMatch extends Runbook {
  score: number;
  matchedBy: "semantic" | "keyword";
}

export interface RunbookProvider {
  readonly name: string;
  searchRunbooks(query: string, limit?: number): Promise<RunbookMatch[]>;
}

export class ServiceNotFoundError extends Error {
  constructor(
    public readonly service: string,
    public readonly knownServices: string[]
  ) {
    super(`Unknown service "${service}". Known services: ${knownServices.join(", ")}`);
    this.name = "ServiceNotFoundError";
  }
}

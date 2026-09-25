/**
 * SRE runbook knowledge base.
 *
 * This is DATA, not a prompt. It is seeded into D1 (source of truth) and
 * embedded into Vectorize (namespace "runbooks") so `search_runbook` can
 * retrieve the relevant entries semantically and hand them to the LLM as
 * evidence/context.
 */
import type { Runbook } from "../providers/types";

export const RUNBOOKS: Runbook[] = [
  {
    slug: "high-api-latency",
    title: "High API latency",
    tags: ["latency", "slow", "p95", "p99", "performance"],
    symptoms: [
      "p95/p99 latency well above baseline",
      "Users report slow responses or timeouts",
      "Upstream callers retrying, increasing load"
    ],
    investigationSteps: [
      "Compare current p95/p99 latency with the service baseline",
      "Check whether latency correlates with CPU, memory, or request rate",
      "Search logs for timeouts, slow requests and dependency errors",
      "Check dependency health: database, caches, downstream APIs",
      "Check for recent deploys or config changes"
    ],
    possibleCauses: [
      "Database connection pool exhaustion",
      "Slow or unindexed database queries",
      "CPU saturation or throttling",
      "Slow downstream dependency",
      "Recent deploy introduced a regression"
    ],
    recommendedActions: [
      "Identify the saturated resource before scaling blindly",
      "Roll back a recent deploy if latency started right after it",
      "Scale horizontally if CPU-bound and the dependency has headroom"
    ],
    verificationSteps: ["p95 latency returns to baseline", "Error rate returns below SLO", "No new timeout errors in logs"]
  },
  {
    slug: "database-connection-pool-exhaustion",
    title: "Database connection pool exhaustion",
    tags: ["database", "db", "connection pool", "hikari", "jdbc", "timeout"],
    symptoms: [
      "'connection pool exhausted' or 'Connection is not available' errors",
      "DB connection acquisition timeouts",
      "Active connections equal pool max, with requests pending",
      "High API latency while the database itself looks healthy"
    ],
    investigationSteps: [
      "Check pool metrics: active vs max connections and pending requests",
      "Confirm the database server has spare capacity (CPU, max_connections)",
      "Look for code holding connections longer than needed (external calls inside transactions)",
      "Check for connection leaks (connections never returned)"
    ],
    possibleCauses: [
      "Pool size too small for current traffic",
      "Connections held during slow external calls",
      "Connection leak",
      "Slow queries keeping connections busy"
    ],
    recommendedActions: [
      "Increase the pool size (e.g. 20 → 40) if the database has headroom",
      "Move external calls out of DB transactions",
      "Set a sensible connection timeout and leak detection threshold",
      "Roll back the change that increased connection hold time"
    ],
    verificationSteps: [
      "Pending connection requests drop to ~0",
      "No new pool-exhausted errors",
      "p95 latency and error rate return to baseline"
    ]
  },
  {
    slug: "slow-database-query",
    title: "Slow / expensive database query",
    tags: ["database", "slow query", "full table scan", "index", "query plan", "d1", "sqlite", "rows read"],
    symptoms: [
      "Slow query log entries",
      "Sequential / full table scans on large tables (SQLite/D1 plan shows 'SCAN <table>' instead of 'SEARCH … USING INDEX')",
      "Rows read per query far above rows returned",
      "High database CPU",
      "Endpoint-specific timeouts"
    ],
    investigationSteps: [
      "Find the slowest queries in logs or the DB slow query log",
      "Run EXPLAIN on the query to inspect the plan",
      "Check whether a recent deploy introduced the query",
      "Check the rows examined vs rows returned"
    ],
    possibleCauses: [
      "Missing index for a new filter",
      "Leading wildcard LIKE ('%term%') or a function such as lower() on the column, which prevents index use",
      "A feature flag or deploy that switched to a new query path",
      "Unbounded result sets",
      "Stale table statistics"
    ],
    recommendedActions: [
      "Add an appropriate index (e.g. expression index on lower(customer_email))",
      "Avoid leading-wildcard LIKE; use exact match or a search index",
      "Paginate and limit result sets",
      "Feature-flag off or roll back the new query path (Workers: `wrangler rollback` to the previous version)",
      "For text search on D1, use an FTS5 virtual table instead of LIKE '%term%'"
    ],
    verificationSteps: ["Query latency < 100ms", "No sequential scans in the query plan", "Database and service CPU back to normal"]
  },
  {
    slug: "high-cpu",
    title: "High CPU utilization",
    tags: ["cpu", "throttling", "gc", "saturation"],
    symptoms: ["CPU above 85% sustained", "CPU throttling on containers", "Long GC pauses", "Latency rising with CPU"],
    investigationSteps: [
      "Check CPU per pod and throttling percentage",
      "Correlate CPU with request rate — is it load or work per request?",
      "Search logs for GC pauses, slow queries and hot loops",
      "Check recent deploys"
    ],
    possibleCauses: [
      "Expensive query or result materialization per request",
      "Traffic spike",
      "Inefficient code path in a recent deploy",
      "CPU limits too low (throttling)"
    ],
    recommendedActions: [
      "Fix the expensive code path or query",
      "Scale out if the load is legitimate",
      "Raise CPU limits if throttling while nodes have headroom"
    ],
    verificationSteps: ["CPU below 70%", "Throttling near 0%", "Latency back to baseline"]
  },
  {
    slug: "kafka-consumer-lag",
    title: "Kafka consumer lag",
    tags: ["kafka", "consumer lag", "queue", "backlog", "rebalance"],
    symptoms: [
      "Consumer lag growing continuously",
      "Messages produced faster than consumed",
      "Frequent consumer group rebalances",
      "Delayed notifications / async jobs"
    ],
    investigationSteps: [
      "Compare produce rate vs consume rate",
      "Check number of active consumers vs partitions",
      "Search logs for rebalances, poll timeouts and commit failures",
      "Check latency of downstream dependencies the consumer calls"
    ],
    possibleCauses: [
      "Too few consumers for the partition count",
      "Slow downstream dependency per message",
      "max.poll.interval.ms exceeded causing rebalance storms",
      "Traffic burst (e.g. campaign)"
    ],
    recommendedActions: [
      "Scale consumers up to the partition count",
      "Reduce max.poll.records or process asynchronously to avoid poll timeouts",
      "Add timeouts / circuit breaker on slow downstream calls",
      "Throttle bulk producers"
    ],
    verificationSteps: ["Lag decreasing steadily", "No rebalances for 15 minutes", "Consume rate > produce rate"]
  },
  {
    slug: "elevated-error-rate",
    title: "Elevated error rate",
    tags: ["errors", "5xx", "503", "504", "error rate"],
    symptoms: [
      "5xx rate above SLO",
      "Spike in exceptions in logs",
      "Cloudflare Workers: invocations with status scriptThrewException",
      "Health checks may still pass"
    ],
    investigationSteps: [
      "Break down errors by endpoint and status code",
      "Search logs for the most frequent exception messages",
      "Check dependencies (DB, cache, downstream APIs)",
      "Check recent deploys and config changes"
    ],
    possibleCauses: ["Dependency failure or saturation", "Bad deploy", "Resource exhaustion (connections, memory)"],
    recommendedActions: [
      "Roll back a correlated deploy or config change (Workers: `wrangler rollback`)",
      "Mitigate the failing dependency",
      "Shed load or enable degraded mode if needed"
    ],
    verificationSteps: ["Error rate back below SLO", "No new exception spikes"]
  }
];

/** The text we embed for a runbook: what it is about, not how to fix it. */
export function runbookEmbeddingText(r: Runbook): string {
  return `${r.title}. Tags: ${r.tags.join(", ")}. Symptoms: ${r.symptoms.join("; ")}. Possible causes: ${r.possibleCauses.join("; ")}.`;
}

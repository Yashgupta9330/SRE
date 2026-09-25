/**
 * Mock infrastructure: what the "production environment" looks like right now.
 *
 * Each service has a scenario: current metrics, a realistic stream of log
 * lines, recent deploys, dependency health and database statistics.
 * Time offsets are seconds before "now", so timestamps always look live.
 *
 *   payment-service       → deploy holds DB connections during a slow external
 *                           call → connection pool exhaustion → high latency
 *   order-service         → new search query can't use an index → full table
 *                           scans → high DB + service CPU
 *   notification-service  → campaign burst + slow email provider + too few
 *                           consumers → Kafka consumer lag
 *   inventory-service     → healthy baseline (useful for "no issue found")
 *
 * The clues are spread across tools on purpose: no single tool output states
 * the root cause, so the agent has to correlate metrics, logs, deploys,
 * dependencies and database data.
 */

import type { DependencyStatus, LogLevel, QueryPlan, ServiceMetrics, SlowQuery } from "../types";

export interface MockLogLine {
  offsetSeconds: number;
  level: LogLevel;
  message: string;
}

export interface MockDeploy {
  offsetSeconds: number;
  version: string;
  deployedBy: string;
  summary: string;
  changes: string[];
  configChanges: string[];
}

export interface MockDatabase {
  database: string;
  connectionPool?: Record<string, number | string>;
  slowQueries: SlowQuery[];
  plans: Record<string, Omit<QueryPlan, "service">>;
}

export interface MockScenario {
  metrics: Omit<ServiceMetrics, "service" | "timestamp" | "window">;
  logs: MockLogLine[];
  deploys: MockDeploy[];
  dependencies: DependencyStatus[];
  database?: MockDatabase;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export const MOCK_SCENARIOS: Record<string, MockScenario> = {
  "payment-service": {
    metrics: {
      cpu_percent: 72,
      memory_percent: 68,
      p95_latency_ms: 1850,
      p99_latency_ms: 3200,
      error_rate_percent: 8.2,
      request_rate_rps: 1250,
      extra: {
        db_pool_active_connections: 20,
        db_pool_max_connections: 20,
        db_pool_pending_requests: 57,
        db_query_p95_ms: 45,
        baseline_p95_latency_ms: 210
      }
    },
    logs: [
      { offsetSeconds: 900, level: "INFO", message: "Deploy v2.14.0 rolled out: enabled async fraud-check calls (holds DB connection during external call)" },
      { offsetSeconds: 610, level: "WARN", message: "HikariPool-1 - Connection is not available, request timed out after 1000ms (active=20, idle=0, waiting=31)" },
      { offsetSeconds: 420, level: "WARN", message: "POST /v1/payments slow request: 1942ms (threshold 1000ms)" },
      { offsetSeconds: 302, level: "ERROR", message: "DB connection timeout after 2000ms acquiring connection from pool" },
      { offsetSeconds: 299, level: "ERROR", message: "DB connection timeout after 2000ms acquiring connection from pool" },
      { offsetSeconds: 297, level: "ERROR", message: "database connection pool exhausted: active=20 max=20 pending=57" },
      { offsetSeconds: 295, level: "WARN", message: "request latency exceeded 2 seconds: POST /v1/payments (2311ms)" },
      { offsetSeconds: 240, level: "ERROR", message: "PaymentController: 503 Service Unavailable - could not obtain JDBC connection" },
      { offsetSeconds: 180, level: "WARN", message: "Retrying charge authorization (attempt 2/3) after connection timeout" },
      { offsetSeconds: 120, level: "ERROR", message: "database connection pool exhausted: active=20 max=20 pending=64" },
      { offsetSeconds: 60, level: "INFO", message: "Postgres primary healthy: cpu=31% connections=112/500 replication_lag=0.2s" },
      { offsetSeconds: 30, level: "INFO", message: "Health check OK (liveness)" }
    ],
    deploys: [
      {
        offsetSeconds: 900,
        version: "v2.14.0",
        deployedBy: "ci/github-actions (PR #1482)",
        summary: "Async fraud-check before charge authorization",
        changes: [
          "PaymentService.authorize(): call fraud-api inside the existing DB transaction",
          "Add fraud_score column write to payments table",
          "Bump fraud-api client timeout from 300ms to 1500ms"
        ],
        configChanges: []
      },
      {
        offsetSeconds: 4 * DAY,
        version: "v2.13.2",
        deployedBy: "ci/github-actions (PR #1466)",
        summary: "Currency rounding fix",
        changes: ["Fix rounding for JPY amounts"],
        configChanges: []
      }
    ],
    dependencies: [
      {
        name: "postgres-payments",
        type: "database",
        status: "healthy",
        latency_p95_ms: 45,
        error_rate_percent: 0,
        details: { cpu_percent: 31, server_connections: "112/500", replication_lag_s: 0.2 }
      },
      {
        name: "fraud-api",
        type: "http",
        status: "degraded",
        latency_p95_ms: 850,
        error_rate_percent: 0.3,
        details: { baseline_p95_ms: 120, note: "latency elevated since new traffic from payment-service" }
      },
      {
        name: "redis-sessions",
        type: "cache",
        status: "healthy",
        latency_p95_ms: 2,
        error_rate_percent: 0,
        details: { hit_rate_percent: 97 }
      }
    ],
    database: {
      database: "postgres-payments",
      connectionPool: {
        pool: "HikariPool-1",
        max_connections: 20,
        active: 20,
        idle: 0,
        pending_requests: 57,
        avg_connection_hold_ms: 1450,
        baseline_connection_hold_ms: 60,
        connection_acquire_timeouts_per_min: 212
      },
      slowQueries: [
        { queryId: "q-pay-1", query: "UPDATE payments SET status = $1, fraud_score = $2 WHERE id = $3", calls_per_min: 9800, mean_ms: 4.1, p95_ms: 9, rows_examined_per_call: 1, rows_returned_per_call: 1, percent_of_db_time: 38 },
        { queryId: "q-pay-2", query: "INSERT INTO payments (id, order_id, amount, currency, status) VALUES ($1, $2, $3, $4, $5)", calls_per_min: 4700, mean_ms: 3.2, p95_ms: 7, rows_examined_per_call: 0, rows_returned_per_call: 1, percent_of_db_time: 22 },
        { queryId: "q-pay-3", query: "SELECT * FROM ledger_entries WHERE payment_id = $1", calls_per_min: 5100, mean_ms: 1.9, p95_ms: 4, rows_examined_per_call: 3, rows_returned_per_call: 3, percent_of_db_time: 14 }
      ],
      plans: {
        "q-pay-1": {
          queryId: "q-pay-1",
          query: "UPDATE payments SET status = $1, fraud_score = $2 WHERE id = $3",
          plan: [
            "Update on payments  (cost=0.43..8.45 rows=1) (actual time=0.061..0.061 rows=0 loops=1)",
            "  ->  Index Scan using payments_pkey on payments  (cost=0.43..8.45 rows=1) (actual time=0.021..0.022 rows=1 loops=1)",
            "        Index Cond: (id = $3)",
            "Planning Time: 0.09 ms",
            "Execution Time: 0.08 ms"
          ],
          indexes: [
            { name: "payments_pkey", definition: "UNIQUE btree (id)" },
            { name: "idx_payments_order_id", definition: "btree (order_id)" }
          ]
        }
      }
    }
  },

  "order-service": {
    metrics: {
      cpu_percent: 94,
      memory_percent: 71,
      p95_latency_ms: 1320,
      p99_latency_ms: 2640,
      error_rate_percent: 2.1,
      request_rate_rps: 830,
      extra: {
        db_slow_queries_per_min: 38,
        db_cpu_percent: 88,
        pods_ready: "6/6",
        cpu_throttled_percent: 41,
        baseline_p95_latency_ms: 260
      }
    },
    logs: [
      { offsetSeconds: 1500, level: "INFO", message: "Deploy v5.3.1 rolled out" },
      { offsetSeconds: 700, level: "WARN", message: "Slow query 4812ms: SELECT o.* FROM orders o JOIN order_items i ON i.order_id=o.id WHERE lower(o.customer_email) LIKE '%@example.com%' ORDER BY o.created_at DESC" },
      { offsetSeconds: 600, level: "WARN", message: "Slow query 5120ms: SELECT o.* FROM orders o JOIN order_items i ... WHERE lower(o.customer_email) LIKE ..." },
      { offsetSeconds: 480, level: "WARN", message: "CPU throttling detected on pod order-service-7c9f (throttled 41% of periods)" },
      { offsetSeconds: 420, level: "WARN", message: "GC pause 870ms (G1 Evacuation Pause)" },
      { offsetSeconds: 300, level: "ERROR", message: "GET /v1/orders/search timed out after 5000ms" },
      { offsetSeconds: 200, level: "WARN", message: "Slow query 4630ms: SELECT o.* FROM orders o JOIN order_items i ... WHERE lower(o.customer_email) LIKE ..." },
      { offsetSeconds: 90, level: "ERROR", message: "GET /v1/orders/search 504 Gateway Timeout" },
      { offsetSeconds: 20, level: "INFO", message: "Health check OK (liveness)" }
    ],
    deploys: [
      {
        offsetSeconds: 1500,
        version: "v5.3.1",
        deployedBy: "ci/github-actions (PR #933)",
        summary: "Order search by customer email",
        changes: [
          "New endpoint GET /v1/orders/search?email=<partial>",
          "OrderRepository.searchByEmail(): case-insensitive partial match on customer_email",
          "Support team dashboard now calls /v1/orders/search on every keystroke"
        ],
        configChanges: []
      },
      {
        offsetSeconds: 5 * DAY,
        version: "v5.2.0",
        deployedBy: "ci/github-actions (PR #917)",
        summary: "Order status webhooks",
        changes: ["Emit order.status_changed events"],
        configChanges: []
      }
    ],
    dependencies: [
      {
        name: "postgres-orders",
        type: "database",
        status: "degraded",
        latency_p95_ms: 4700,
        error_rate_percent: 0.8,
        details: { cpu_percent: 88, server_connections: "64/300", seq_scans_per_min: 41, cache_hit_ratio_percent: 71 }
      },
      {
        name: "redis-cache",
        type: "cache",
        status: "healthy",
        latency_p95_ms: 2,
        error_rate_percent: 0,
        details: { hit_rate_percent: 93 }
      },
      {
        name: "inventory-service",
        type: "http",
        status: "healthy",
        latency_p95_ms: 95,
        error_rate_percent: 0.1,
        details: {}
      }
    ],
    database: {
      database: "postgres-orders",
      connectionPool: { pool: "HikariPool-1", max_connections: 40, active: 22, idle: 18, pending_requests: 0 },
      slowQueries: [
        {
          queryId: "q-ord-1",
          query: "SELECT o.* FROM orders o JOIN order_items i ON i.order_id = o.id WHERE lower(o.customer_email) LIKE $1 ORDER BY o.created_at DESC LIMIT 50",
          calls_per_min: 420,
          mean_ms: 4710,
          p95_ms: 5900,
          rows_examined_per_call: 2310442,
          rows_returned_per_call: 18,
          percent_of_db_time: 91
        },
        { queryId: "q-ord-2", query: "SELECT * FROM orders WHERE id = $1", calls_per_min: 12000, mean_ms: 1.4, p95_ms: 3, rows_examined_per_call: 1, rows_returned_per_call: 1, percent_of_db_time: 4 },
        { queryId: "q-ord-3", query: "INSERT INTO order_items (order_id, sku, qty, price) VALUES ($1, $2, $3, $4)", calls_per_min: 3100, mean_ms: 2.2, p95_ms: 5, rows_examined_per_call: 0, rows_returned_per_call: 1, percent_of_db_time: 2 }
      ],
      plans: {
        "q-ord-1": {
          queryId: "q-ord-1",
          query: "SELECT o.* FROM orders o JOIN order_items i ON i.order_id = o.id WHERE lower(o.customer_email) LIKE $1 ORDER BY o.created_at DESC LIMIT 50",
          plan: [
            "Limit  (cost=412233.10..412233.22 rows=50) (actual time=4702.3..4702.4 rows=18 loops=1)",
            "  ->  Sort  (cost=412233.10..412240.51 rows=2963) (actual time=4702.3..4702.3 rows=18 loops=1)",
            "        Sort Key: o.created_at DESC",
            "        ->  Hash Join  (cost=198233.40..412134.66 rows=2963) (actual time=2210.8..4702.1 rows=18 loops=1)",
            "              Hash Cond: (i.order_id = o.id)",
            "              ->  Seq Scan on order_items i  (cost=0.00..171422.10 rows=6892210) (actual time=0.01..1302.7 rows=6892210 loops=1)",
            "              ->  Hash  (cost=198196.30..198196.30 rows=2963) (actual time=2189.5..2189.5 rows=6 loops=1)",
            "                    ->  Seq Scan on orders o  (cost=0.00..198196.30 rows=2963) (actual time=31.2..2189.4 rows=6 loops=1)",
            "                          Filter: (lower((customer_email)::text) ~~ '%@example.com%'::text)",
            "                          Rows Removed by Filter: 2310436",
            "Planning Time: 0.4 ms",
            "Execution Time: 4702.9 ms"
          ],
          indexes: [
            { name: "orders_pkey", definition: "UNIQUE btree (id)" },
            { name: "idx_orders_created_at", definition: "btree (created_at)" },
            { name: "idx_orders_customer_email", definition: "btree (customer_email)" },
            { name: "idx_order_items_order_id", definition: "btree (order_id)" }
          ]
        },
        "q-ord-2": {
          queryId: "q-ord-2",
          query: "SELECT * FROM orders WHERE id = $1",
          plan: [
            "Index Scan using orders_pkey on orders  (cost=0.43..8.45 rows=1) (actual time=0.02..0.02 rows=1 loops=1)",
            "  Index Cond: (id = $1)",
            "Execution Time: 0.04 ms"
          ],
          indexes: [{ name: "orders_pkey", definition: "UNIQUE btree (id)" }]
        }
      }
    }
  },

  "notification-service": {
    metrics: {
      cpu_percent: 35,
      memory_percent: 58,
      p95_latency_ms: 240,
      p99_latency_ms: 610,
      error_rate_percent: 0.4,
      request_rate_rps: 310,
      extra: {
        kafka_consumer_group: "notification-senders",
        kafka_topic: "notifications.outbound",
        kafka_consumer_lag: 184000,
        kafka_partitions: 12,
        kafka_active_consumers: 3,
        messages_consumed_per_sec: 140,
        messages_produced_per_sec: 950,
        email_provider_p95_ms: 2100
      }
    },
    logs: [
      { offsetSeconds: 1200, level: "INFO", message: "Marketing campaign 'autumn-sale' enqueued 1.2M notifications" },
      { offsetSeconds: 800, level: "WARN", message: "Email provider latency elevated: p95=2100ms (normal 180ms)" },
      { offsetSeconds: 640, level: "WARN", message: "Consumer poll timeout: max.poll.interval.ms (300000) exceeded, leaving group notification-senders" },
      { offsetSeconds: 600, level: "INFO", message: "Consumer group notification-senders rebalancing (generation 214)" },
      { offsetSeconds: 590, level: "WARN", message: "Commit failed for offsets on notifications.outbound-4: group rebalanced" },
      { offsetSeconds: 420, level: "WARN", message: "Consumer lag high: topic=notifications.outbound lag=161203 (threshold 10000)" },
      { offsetSeconds: 300, level: "INFO", message: "Consumer group notification-senders rebalancing (generation 215)" },
      { offsetSeconds: 180, level: "WARN", message: "Consumer lag high: topic=notifications.outbound lag=184000 (threshold 10000)" },
      { offsetSeconds: 60, level: "INFO", message: "Only 3 consumers active for 12 partitions (HPA max replicas = 3)" }
    ],
    deploys: [
      {
        offsetSeconds: 2 * DAY,
        version: "v3.8.0",
        deployedBy: "ci/github-actions (PR #402)",
        summary: "Upgrade email provider SDK",
        changes: ["Email SDK 4.x → 5.x", "Send emails synchronously inside the consumer loop (removed async batching)"],
        configChanges: ["max.poll.records: 100 → 500"]
      }
    ],
    dependencies: [
      {
        name: "kafka-main",
        type: "queue",
        status: "healthy",
        latency_p95_ms: 8,
        error_rate_percent: 0,
        details: { brokers_online: "3/3", under_replicated_partitions: 0 }
      },
      {
        name: "email-provider",
        type: "http",
        status: "degraded",
        latency_p95_ms: 2100,
        error_rate_percent: 1.2,
        details: { baseline_p95_ms: 180, provider_status_page: "Investigating elevated API latency" }
      },
      {
        name: "sms-provider",
        type: "http",
        status: "healthy",
        latency_p95_ms: 210,
        error_rate_percent: 0.1,
        details: {}
      }
    ],
    database: {
      database: "postgres-notifications",
      slowQueries: [
        { queryId: "q-not-1", query: "SELECT * FROM notification_templates WHERE id = $1", calls_per_min: 8400, mean_ms: 0.9, p95_ms: 2, rows_examined_per_call: 1, rows_returned_per_call: 1, percent_of_db_time: 61 }
      ],
      plans: {}
    }
  },

  "inventory-service": {
    metrics: {
      cpu_percent: 28,
      memory_percent: 44,
      p95_latency_ms: 95,
      p99_latency_ms: 180,
      error_rate_percent: 0.1,
      request_rate_rps: 540,
      extra: { db_pool_active_connections: 6, db_pool_max_connections: 30, baseline_p95_latency_ms: 90 }
    },
    logs: [
      { offsetSeconds: 600, level: "INFO", message: "Stock reconciliation job completed in 12s" },
      { offsetSeconds: 300, level: "INFO", message: "GET /v1/stock p95=92ms" },
      { offsetSeconds: 30, level: "INFO", message: "Health check OK (liveness)" }
    ],
    deploys: [
      {
        offsetSeconds: 6 * DAY,
        version: "v1.9.4",
        deployedBy: "ci/github-actions (PR #288)",
        summary: "Dependency updates",
        changes: ["Bump postgres driver"],
        configChanges: []
      }
    ],
    dependencies: [
      {
        name: "postgres-inventory",
        type: "database",
        status: "healthy",
        latency_p95_ms: 6,
        error_rate_percent: 0,
        details: { cpu_percent: 22, server_connections: "30/300" }
      }
    ],
    database: {
      database: "postgres-inventory",
      connectionPool: { pool: "HikariPool-1", max_connections: 30, active: 6, idle: 24, pending_requests: 0 },
      slowQueries: [
        { queryId: "q-inv-1", query: "SELECT qty FROM stock WHERE sku = $1 AND warehouse_id = $2", calls_per_min: 21000, mean_ms: 0.7, p95_ms: 2, rows_examined_per_call: 1, rows_returned_per_call: 1, percent_of_db_time: 70 }
      ],
      plans: {}
    }
  }
};

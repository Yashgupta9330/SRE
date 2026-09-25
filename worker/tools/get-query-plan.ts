import type { Tool } from "./types";

export const getQueryPlan: Tool<{ service: string; query_id: string }> = {
  definition: {
    name: "get_query_plan",
    description:
      "Get the EXPLAIN ANALYZE plan for a query (by query id from get_slow_queries) plus the indexes on the tables it touches. Use it to find full table scans, unusable indexes or bad joins. Read-only: does not change the database.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. order-service" },
        query_id: { type: "string", description: "Query id from get_slow_queries, e.g. q-ord-1" }
      },
      required: ["service", "query_id"]
    }
  },
  label: ({ service, query_id }) => `Checked query plan (${service}: ${query_id})`,
  execute: ({ service, query_id }, ctx) => ctx.database.getQueryPlan(service, query_id)
};

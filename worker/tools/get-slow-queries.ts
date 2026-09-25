import type { Tool } from "./types";

export const getSlowQueries: Tool<{ service: string }> = {
  definition: {
    name: "get_slow_queries",
    description:
      "Get database statistics for a service's database: top queries by share of DB time (query id, SQL, calls/min, mean and p95 ms, rows examined vs returned) and application connection pool usage. Use query ids with get_query_plan.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. order-service" }
      },
      required: ["service"]
    }
  },
  label: ({ service }) => `Checked database queries (${service})`,
  execute: ({ service }, ctx) => ctx.database.getSlowQueries(service, 5)
};

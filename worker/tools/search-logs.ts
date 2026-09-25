import type { Tool } from "./types";

export const searchLogs: Tool<{ service: string; query: string }> = {
  definition: {
    name: "search_logs",
    description:
      "Search recent application logs (last 30 minutes) for a service. Use focused keyword queries such as 'timeout', 'connection pool', 'slow query', 'error', 'deploy', 'consumer lag'. Call again with different terms to refine.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. payment-service" },
        query: { type: "string", description: "Keywords to search for, e.g. 'database timeout'" }
      },
      required: ["service", "query"]
    }
  },
  label: ({ service, query }) => `Searched logs (${service}: "${query}")`,
  async execute({ service, query }, ctx) {
    const entries = await ctx.logs.searchLogs(service, query, { limit: 15 });
    return {
      service,
      query,
      count: entries.length,
      entries,
      ...(entries.length === 0 && { hint: "No log lines matched. Try broader terms such as 'error', 'warn' or 'timeout'." })
    };
  }
};

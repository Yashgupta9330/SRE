import type { Tool } from "./types";

export const getDependencyHealth: Tool<{ service: string }> = {
  definition: {
    name: "get_dependency_health",
    description:
      "Get the health of a service's dependencies (databases, caches, queues, downstream HTTP APIs): status, p95 latency, error rate and details. Use it to tell whether a problem is inside the service or in something it calls.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. payment-service" }
      },
      required: ["service"]
    }
  },
  label: ({ service }) => `Checked dependency health (${service})`,
  async execute({ service }, ctx) {
    const dependencies = await ctx.dependencies.getDependencyHealth(service);
    return {
      service,
      unhealthy: dependencies.filter((d) => d.status !== "healthy").map((d) => d.name),
      dependencies
    };
  }
};

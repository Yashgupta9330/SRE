import type { Tool } from "./types";

export const getServiceMetrics: Tool<{ service: string }> = {
  definition: {
    name: "get_service_metrics",
    description:
      "Get current observability metrics for a service over the last 5 minutes: CPU %, memory %, p95/p99 latency (ms), error rate %, request rate, plus service-specific signals such as DB pool usage or Kafka consumer lag.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. payment-service" }
      },
      required: ["service"]
    }
  },
  label: ({ service }) => `Checked service metrics (${service})`,
  execute: ({ service }, ctx) => ctx.monitoring.getServiceMetrics(service)
};

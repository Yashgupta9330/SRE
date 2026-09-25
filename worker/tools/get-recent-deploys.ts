import type { Tool } from "./types";

const LOOKBACK_HOURS = 72;

export const getRecentDeploys: Tool<{ service: string }> = {
  definition: {
    name: "get_recent_deploys",
    description: `List deploys and config changes for a service in the last ${LOOKBACK_HOURS} hours (version, time, author, code changes, config changes). Many incidents start right after a change.`,
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name, e.g. payment-service" }
      },
      required: ["service"]
    }
  },
  label: ({ service }) => `Checked recent deploys (${service})`,
  async execute({ service }, ctx) {
    const deploys = await ctx.deploys.getRecentDeploys(service, LOOKBACK_HOURS);
    return { service, lookback_hours: LOOKBACK_HOURS, count: deploys.length, deploys };
  }
};

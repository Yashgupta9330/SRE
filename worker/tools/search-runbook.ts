import type { Tool } from "./types";

export const searchRunbook: Tool<{ query: string }> = {
  definition: {
    name: "search_runbook",
    description:
      "Search the SRE runbook knowledge base for troubleshooting guidance. Describe the symptom or suspected cause, e.g. 'database connection pool exhausted' or 'kafka consumer lag'. Returns symptoms, investigation steps, possible causes, recommended actions and verification steps.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Symptom or suspected cause to look up" }
      },
      required: ["query"]
    }
  },
  label: ({ query }) => `Checked runbooks ("${query}")`,
  async execute({ query }, ctx) {
    const results = await ctx.runbooks.searchRunbooks(query, 2);
    return {
      query,
      count: results.length,
      results,
      ...(results.length === 0 && { hint: "No matching runbook. Try describing the symptom differently." })
    };
  }
};

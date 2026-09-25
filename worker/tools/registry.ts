/**
 * Tool registry: the tools the LLM may call, and a safe executor.
 *
 * `executeTool` never throws — failures come back as `{ ok: false, error }`
 * so the LLM sees that data was unavailable instead of guessing it.
 */
import { ServiceNotFoundError } from "../providers/types";
import { getDependencyHealth } from "./get-dependency-health";
import { getQueryPlan } from "./get-query-plan";
import { getRecentDeploys } from "./get-recent-deploys";
import { getServiceMetrics } from "./get-service-metrics";
import { getSlowQueries } from "./get-slow-queries";
import { searchLogs } from "./search-logs";
import { searchRunbook } from "./search-runbook";
import { normalizeServiceName } from "./service-names";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "./types";

// Heterogeneous arg types → store as the loosest Tool type.
const TOOLS = [
  getServiceMetrics,
  searchLogs,
  getRecentDeploys,
  getDependencyHealth,
  getSlowQueries,
  getQueryPlan,
  searchRunbook
] as unknown as Tool[];
const BY_NAME = new Map(TOOLS.map((t) => [t.definition.name, t]));

export function toolDefinitions(): ToolDefinition[] {
  return TOOLS.map((t) => t.definition);
}

export function isKnownTool(name: string): boolean {
  return BY_NAME.has(name);
}

/** Validate and coerce raw LLM arguments: all our parameters are required strings. */
async function prepareArgs(tool: Tool, raw: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, string>> {
  const args: Record<string, string> = {};
  for (const key of tool.definition.parameters.required) {
    const value = raw[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Missing required argument "${key}"`);
    }
    const str = String(value).trim();
    if (!str) throw new Error(`Argument "${key}" must not be empty`);
    args[key] = str.slice(0, 200);
  }
  if (args.service) {
    args.service = normalizeServiceName(args.service, await ctx.monitoring.listServices());
  }
  return args;
}

export function toolLabel(name: string, raw: Record<string, unknown>): string {
  const tool = BY_NAME.get(name);
  if (!tool) return `Unknown tool ${name}`;
  const args = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v ?? "")]));
  return tool.label(args);
}

export async function executeTool(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}". Available: ${[...BY_NAME.keys()].join(", ")}` };
  try {
    const args = await prepareArgs(tool, rawArgs, ctx);
    return { ok: true, data: await tool.execute(args, ctx) };
  } catch (err) {
    if (err instanceof ServiceNotFoundError) return { ok: false, error: err.message };
    const message = err instanceof Error ? err.message : String(err);
    console.error(`tool ${name} failed`, err);
    return { ok: false, error: `${name} failed: ${message}` };
  }
}

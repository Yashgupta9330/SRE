import type {
  DatabaseProvider,
  DependencyProvider,
  DeployProvider,
  LogProvider,
  MonitoringProvider,
  RunbookProvider
} from "../providers/types";

/** JSON-schema tool definition, in the shape Workers AI function calling expects. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** Providers the tools can use. Tools never know whether these are mocks or real. */
export interface ToolContext {
  monitoring: MonitoringProvider;
  logs: LogProvider;
  runbooks: RunbookProvider;
  deploys: DeployProvider;
  dependencies: DependencyProvider;
  database: DatabaseProvider;
}

export interface Tool<Args = Record<string, string>> {
  definition: ToolDefinition;
  /** Short human-readable label for the UI activity feed. */
  label(args: Args): string;
  execute(args: Args, ctx: ToolContext): Promise<unknown>;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

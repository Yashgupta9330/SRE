import type { ToolDefinition } from "../tools/types";

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tool name, for role "tool". */
  name?: string;
}

export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface ChatRequest {
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface JsonRequest {
  messages: LlmMessage[];
  /** JSON schema the output must follow. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/** The only LLM surface the agent uses. Workers AI implements it; tests script it. */
export interface LlmClient {
  chat(request: ChatRequest): Promise<LlmResponse>;
  json<T>(request: JsonRequest): Promise<T>;
}

/**
 * Workers AI implementation of LlmClient (default model: Llama 3.3 70B).
 *
 * `env.AI.run()` executes inference on Cloudflare's GPU network. No API keys:
 * access is granted by the `ai` binding in wrangler.jsonc.
 */
import { normalizeToolCalls, parseInlineToolCalls, parseJsonObject } from "./parsing";
import type { ChatRequest, JsonRequest, LlmClient, LlmResponse } from "./types";

type LlamaModel = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface RawOutput {
  response?: unknown;
  tool_calls?: unknown;
}

export class WorkersAiLlm implements LlmClient {
  constructor(
    private readonly ai: Ai,
    private readonly model: string
  ) {}

  private async run(input: Record<string, unknown>): Promise<RawOutput> {
    // The model id comes from a wrangler var; the cast satisfies the typed AI binding.
    const out = (await this.ai.run(this.model as LlamaModel, input as never)) as unknown;
    if (typeof out === "string") return { response: out };
    if (!out || typeof out !== "object") throw new Error("Workers AI returned an empty response");
    return out as RawOutput;
  }

  async chat(req: ChatRequest): Promise<LlmResponse> {
    const out = await this.run({
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.2
    });
    const text = typeof out.response === "string" ? out.response : out.response ? JSON.stringify(out.response) : "";
    let toolCalls = normalizeToolCalls(out.tool_calls);
    if (toolCalls.length === 0 && req.tools?.length) {
      toolCalls = parseInlineToolCalls(text, req.tools.map((t) => t.name));
    }
    return { text: toolCalls.length ? "" : text.trim(), toolCalls };
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const out = await this.run({
      messages: req.messages,
      response_format: { type: "json_schema", json_schema: req.schema },
      max_tokens: req.maxTokens ?? 1024,
      temperature: 0
    });
    // In JSON mode Workers AI may return the object already parsed, or as a string.
    if (out.response && typeof out.response === "object") return out.response as T;
    if (typeof out.response === "string") return parseJsonObject(out.response) as T;
    throw new Error("Workers AI returned no JSON output");
  }
}

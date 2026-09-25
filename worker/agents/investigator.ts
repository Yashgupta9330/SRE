/**
 * The investigation agent loop: the LLM decides which tools to call.
 *
 *   LLM ──tool call──► executeTool ──► provider ──► result appended to context
 *    ▲                                                        │
 *    └──────────────── next turn ◄────────────────────────────┘
 *   ...until the LLM answers without tool calls (or the budget runs out).
 *
 * The loop knows nothing about Workflows. It receives a `durable` wrapper;
 * inside the Workflow that wrapper is `step.do`, so every LLM turn and every
 * tool call becomes its own checkpoint. On a retry/replay, completed steps
 * return their cached result instead of re-running.
 */
import type { ChatRole, PreviousIncident } from "../../shared/types";
import type { LlmClient, LlmMessage } from "../llm/types";
import { executeTool, toolDefinitions, toolLabel } from "../tools/registry";
import type { ToolContext, ToolResult } from "../tools/types";
import { investigationRequestPrompt, investigatorSystemPrompt } from "./prompts";

/** Runs `fn` as a named, checkpointed unit of work. */
export type Durable = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export const runDirectly: Durable = (_name, fn) => fn();

export interface ToolCallRecord {
  key: string;
  name: string;
  arguments: Record<string, unknown>;
  label: string;
  result: ToolResult;
  /** True when the LLM repeated an identical call and we reused the earlier result. */
  duplicate?: boolean;
}

export interface InvestigationRun {
  finalText: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  hitBudget: boolean;
}

export interface InvestigatorInput {
  userMessage: string;
  service?: string;
  knownServices: string[];
  history: { role: ChatRole; content: string }[];
  previousIncidents: PreviousIncident[];
  memoryWarning?: string;
}

export interface InvestigatorHooks {
  onToolStart?(call: { key: string; label: string }): Promise<void> | void;
  onToolEnd?(call: ToolCallRecord): Promise<void> | void;
}

export interface InvestigatorDeps {
  llm: LlmClient;
  tools: ToolContext;
  durable?: Durable;
  hooks?: InvestigatorHooks;
  maxTurns?: number;
  maxToolCalls?: number;
}

const MAX_CALLS_PER_TURN = 4;
/** Minimum evidence for a diagnosis about a known service (the database is the most common culprit). */
const BASELINE_TOOLS = ["get_service_metrics", "search_logs", "get_recent_deploys", "get_slow_queries"];
const MAX_TOOL_RESULT_CHARS = 3500;

function stableKey(name: string, args: Record<string, unknown>) {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => [k, String(args[k]).toLowerCase().trim()]);
  return `${name}:${JSON.stringify(sorted)}`;
}

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}…(truncated)` : s;
}

export async function runInvestigation(input: InvestigatorInput, deps: InvestigatorDeps): Promise<InvestigationRun> {
  const durable = deps.durable ?? runDirectly;
  const maxTurns = deps.maxTurns ?? 8;
  const maxToolCalls = deps.maxToolCalls ?? 14;
  const tools = toolDefinitions();

  const messages: LlmMessage[] = [
    { role: "system", content: investigatorSystemPrompt(input.knownServices) },
    // Short-term memory: recent turns of this conversation.
    ...input.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: investigationRequestPrompt(input) }
  ];

  const records: ToolCallRecord[] = [];
  const seen = new Map<string, ToolCallRecord>();
  let nudged = false;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await durable(`llm-turn-${turn}`, () => deps.llm.chat({ messages, tools }));

    if (response.toolCalls.length === 0) {
      // Evidence baseline: if the model tries to conclude about a known service
      // without metrics, logs and recent deploys, push back once.
      const called = new Set(records.filter((r) => r.result.ok).map((r) => r.name));
      const missing = BASELINE_TOOLS.filter((t) => !called.has(t));
      const knownService = input.service && input.knownServices.includes(input.service);
      if (knownService && missing.length > 0 && !nudged) {
        nudged = true;
        messages.push({ role: "assistant", content: response.text });
        messages.push({
          role: "user",
          content: `Before concluding, gather the missing evidence for ${input.service}: call ${missing.join(", ")}. Then make sure your diagnosis explains every abnormal metric.`
        });
        continue;
      }
      return { finalText: response.text, toolCalls: records, turns: turn + 1, hitBudget: false };
    }

    for (const [i, call] of response.toolCalls.slice(0, MAX_CALLS_PER_TURN).entries()) {
      if (records.length >= maxToolCalls) break;
      const key = `tool-${turn}-${i}-${call.name}`;
      const label = toolLabel(call.name, call.arguments);
      const dedupeKey = stableKey(call.name, call.arguments);
      const previous = seen.get(dedupeKey);

      let record: ToolCallRecord;
      if (previous) {
        record = { ...previous, key, duplicate: true };
      } else {
        await deps.hooks?.onToolStart?.({ key, label });
        const result = await durable(key, () => executeTool(call.name, call.arguments, deps.tools));
        record = { key, name: call.name, arguments: call.arguments, label, result };
        seen.set(dedupeKey, record);
        await deps.hooks?.onToolEnd?.(record);
      }
      records.push(record);

      // Llama 3.x native format: the assistant turn carries the call as JSON,
      // the tool turn carries the result.
      messages.push({ role: "assistant", content: JSON.stringify({ name: call.name, parameters: call.arguments }) });
      messages.push({
        role: "tool",
        name: call.name,
        content: record.duplicate
          ? JSON.stringify({ note: "Identical call already made; see the earlier result. Try different arguments or conclude." })
          : truncate(JSON.stringify(record.result), MAX_TOOL_RESULT_CHARS)
      });
    }

    if (records.length >= maxToolCalls) break;
  }

  // Budget exhausted: ask for a final answer with tools disabled.
  messages.push({
    role: "user",
    content: "Tool budget reached. Summarize your findings now using only the evidence collected above."
  });
  const final = await durable("llm-final", () => deps.llm.chat({ messages }));
  const finalText =
    final.text || "The investigation reached its tool budget before the model produced a summary; see the tool results.";
  return { finalText, toolCalls: records, turns: maxTurns, hitBudget: true };
}

import type { LlmToolCall } from "./types";

/** Parse a JSON object out of model text (tolerates ```json fences and surrounding prose). */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("Model did not return valid JSON");
  }
}

function toArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Normalize Workers AI `tool_calls` (arguments may be an object or a JSON string). */
export function normalizeToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const call = c as { name?: string; arguments?: unknown; function?: { name?: string; arguments?: unknown } };
    const name = call.name ?? call.function?.name;
    if (!name) return [];
    return [{ name, arguments: toArgs(call.arguments ?? call.function?.arguments) }];
  });
}

/**
 * Llama models sometimes emit a tool call as text instead of structured
 * `tool_calls`, e.g. `{"name": "search_logs", "parameters": {...}}` or
 * `<function=search_logs>{...}</function>`. Recover those so the loop still works.
 */
export function parseInlineToolCalls(text: string, knownTools: string[]): LlmToolCall[] {
  const calls: LlmToolCall[] = [];

  for (const m of text.matchAll(/<function=([\w-]+)>\s*(\{[\s\S]*?\})\s*<\/function>/g)) {
    if (knownTools.includes(m[1])) calls.push({ name: m[1], arguments: toArgs(m[2]) });
  }
  if (calls.length > 0) return calls;

  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("```")) return [];
  try {
    const parsed = parseJsonObjectOrArray(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const obj = item as { name?: string; parameters?: unknown; arguments?: unknown };
      if (obj?.name && knownTools.includes(obj.name)) {
        calls.push({ name: obj.name, arguments: toArgs(obj.parameters ?? obj.arguments) });
      }
    }
  } catch {
    // Not a tool call; it is a normal text answer.
  }
  return calls;
}

function parseJsonObjectOrArray(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(t.replace(/;\s*$/, ""));
}

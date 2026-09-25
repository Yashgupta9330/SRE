import { describe, expect, it } from "vitest";
import type { InvestigationResult } from "../shared/types";
import {
  analyzeInvestigation,
  conversationalResult,
  extractMemory,
  isConversational,
  isMemoryWorthy
} from "../worker/agents/analysis";
import { runInvestigation, type Durable, type InvestigatorInput } from "../worker/agents/investigator";
import { normalizeToolCalls, parseInlineToolCalls, parseJsonObject } from "../worker/llm/parsing";
import { ScriptedLlm, mockToolContext } from "./fakes";

const SERVICES = ["payment-service", "order-service", "notification-service", "inventory-service"];

const input = (overrides: Partial<InvestigatorInput> = {}): InvestigatorInput => ({
  userMessage: "API latency is high for payment-service. Investigate.",
  service: "payment-service",
  knownServices: SERVICES,
  history: [],
  previousIncidents: [],
  ...overrides
});

const call = (name: string, args: Record<string, unknown>) => ({ text: "", toolCalls: [{ name, arguments: args }] });
const answer = (text: string) => ({ text, toolCalls: [] });

describe("runInvestigation (agent tool loop)", () => {
  it("lets the LLM choose tools across multiple turns and feeds results back", async () => {
    const llm = new ScriptedLlm([
      call("get_service_metrics", { service: "payment-service" }),
      {
        text: "",
        toolCalls: [
          { name: "search_logs", arguments: { service: "payment-service", query: "database timeout" } },
          { name: "search_runbook", arguments: { query: "database connection pool exhausted" } }
        ]
      },
      call("get_recent_deploys", { service: "payment-service" }),
      call("get_slow_queries", { service: "payment-service" }),
      answer("Likely DB connection pool exhaustion.")
    ]);
    const steps: string[] = [];
    const durable: Durable = (name, fn) => {
      steps.push(name);
      return fn();
    };

    const run = await runInvestigation(input(), { llm, tools: mockToolContext(), durable });

    expect(run.finalText).toBe("Likely DB connection pool exhaustion.");
    expect(run.toolCalls.map((c) => c.name)).toEqual([
      "get_service_metrics",
      "search_logs",
      "search_runbook",
      "get_recent_deploys",
      "get_slow_queries"
    ]);
    expect(run.toolCalls.every((c) => c.result.ok)).toBe(true);
    // Every LLM turn and tool call is a separately named durable step.
    expect(steps).toEqual([
      "llm-turn-0",
      "tool-0-0-get_service_metrics",
      "llm-turn-1",
      "tool-1-0-search_logs",
      "tool-1-1-search_runbook",
      "llm-turn-2",
      "tool-2-0-get_recent_deploys",
      "llm-turn-3",
      "tool-3-0-get_slow_queries",
      "llm-turn-4"
    ]);
    // The last LLM call saw all tool results in its context.
    const lastContext = llm.chatRequests[4].messages.map((m) => m.content).join("\n");
    expect(lastContext).toContain("1850");
    expect(lastContext).toContain("connection pool exhausted");
  });

  it("passes previous incidents and conversation history to the LLM", async () => {
    const llm = new ScriptedLlm([call("get_service_metrics", { service: "payment-service" }), answer("done"), answer("done")]);
    await runInvestigation(
      input({
        history: [{ role: "user", content: "earlier question" }],
        previousIncidents: [
          {
            id: "m1",
            service: "payment-service",
            problem: "high API latency",
            cause: "DB connection pool exhaustion",
            resolution: "increased pool from 20 to 40",
            symptoms: [],
            evidence: [],
            occurrences: 1,
            createdAt: "2026-09-01T00:00:00Z",
            lastSeenAt: "2026-09-01T00:00:00Z",
            score: 0.82
          }
        ]
      }),
      { llm, tools: mockToolContext() }
    );
    const first = llm.chatRequests[0].messages;
    expect(first[1]).toEqual({ role: "user", content: "earlier question" });
    expect(first[2].content).toContain("increased pool from 20 to 40");
  });

  it("nudges once for missing baseline evidence (metrics, logs, deploys)", async () => {
    const llm = new ScriptedLlm([
      call("get_service_metrics", { service: "payment-service" }),
      answer("It is the pool."),
      {
        text: "",
        toolCalls: [
          { name: "search_logs", arguments: { service: "payment-service", query: "pool" } },
          { name: "get_recent_deploys", arguments: { service: "payment-service" } }
        ]
      },
      answer("Deploy v2.14.0 holds connections → pool exhausted.")
    ]);
    const run = await runInvestigation(input(), { llm, tools: mockToolContext() });
    expect(llm.chatRequests[2].messages.at(-1)?.content).toContain("search_logs, get_recent_deploys, get_slow_queries");
    expect(run.toolCalls.map((c) => c.name)).toEqual(["get_service_metrics", "search_logs", "get_recent_deploys"]);
    expect(run.finalText).toContain("v2.14.0");
  });

  it("nudges once if the model answers an incident without evidence", async () => {
    const llm = new ScriptedLlm([
      answer("It is probably the database."),
      call("get_service_metrics", { service: "payment-service" }),
      answer("Confirmed with metrics.")
    ]);
    const run = await runInvestigation(input(), { llm, tools: mockToolContext() });
    expect(run.toolCalls).toHaveLength(1);
    expect(run.finalText).toBe("Confirmed with metrics.");
  });

  it("answers conversational messages without tools", async () => {
    const llm = new ScriptedLlm([answer("Hi! Tell me what is wrong and with which service.")]);
    const run = await runInvestigation(input({ userMessage: "hello", service: undefined }), { llm, tools: mockToolContext() });
    expect(isConversational(run)).toBe(true);
    expect(conversationalResult(run).kind).toBe("conversation");
  });

  it("does not re-execute identical tool calls", async () => {
    const same = call("get_service_metrics", { service: "payment-service" });
    const llm = new ScriptedLlm([same, same, answer("done"), answer("done")]);
    let executions = 0;
    const durable: Durable = (name, fn) => {
      if (name.startsWith("tool-")) executions++;
      return fn();
    };
    const run = await runInvestigation(input(), { llm, tools: mockToolContext(), durable });
    expect(executions).toBe(1);
    expect(run.toolCalls[1].duplicate).toBe(true);
  });

  it("stops at the tool budget and forces a final answer", async () => {
    const script = Array.from({ length: 3 }, (_, i) => call("search_logs", { service: "payment-service", query: `q${i}` }));
    const llm = new ScriptedLlm([...script, answer("Summary with what we have.")]);
    const run = await runInvestigation(input(), { llm, tools: mockToolContext(), maxTurns: 3 });
    expect(run.hitBudget).toBe(true);
    expect(run.toolCalls).toHaveLength(3);
    expect(run.finalText).toBe("Summary with what we have.");
    expect(llm.chatRequests.at(-1)?.tools).toBeUndefined();
  });

  it("reports tool failures to the LLM instead of throwing", async () => {
    const llm = new ScriptedLlm([call("get_service_metrics", { service: "billing-service" }), answer("Could not retrieve metrics.")]);
    const run = await runInvestigation(input({ service: undefined }), { llm, tools: mockToolContext() });
    expect(run.toolCalls[0].result.ok).toBe(false);
    expect(llm.chatRequests[1].messages.at(-1)?.content).toContain("Unknown service");
  });

  it("propagates LLM failures (the workflow step retries / fails clearly)", async () => {
    const llm = new ScriptedLlm([new Error("AI 503")]);
    await expect(runInvestigation(input(), { llm, tools: mockToolContext() })).rejects.toThrow("AI 503");
  });
});

describe("analysis", () => {
  const runWith = async (script: ConstructorParameters<typeof ScriptedLlm>[0]) =>
    // Extra answer: the baseline-evidence nudge asks the model one more time.
    runInvestigation(input(), { llm: new ScriptedLlm([...script, answer("final")]), tools: mockToolContext() });

  const report = {
    summary: "Payment latency is caused by DB pool exhaustion.",
    likelyCause: "Database connection pool exhaustion",
    confidence: "high",
    evidence: ["p95 latency 1850ms", "'database connection pool exhausted' in logs"],
    previousIncidents: [],
    recommendation: "Increase the DB pool from 20 to 40 and monitor p95 latency.",
    nextSteps: ["Watch pending connections"]
  };

  it("produces a structured result and fills deterministic fields", async () => {
    const run = await runWith([call("get_service_metrics", { service: "payment-service" }), answer("pool exhaustion")]);
    const llm = new ScriptedLlm([], [report]);
    const result = await analyzeInvestigation(llm, { userMessage: "latency", service: "payment-service", previousIncidents: [], run });
    expect(result).toMatchObject({ kind: "investigation", confidence: "high", service: "payment-service" });
    expect(result.toolsUsed).toEqual(["Checked service metrics (payment-service)"]);
    expect(result.unavailable).toEqual([]);
  });

  it("forces confidence to unknown when every tool failed", async () => {
    const run = await runWith([call("get_service_metrics", { service: "nope" }), answer("n/a")]);
    const result = await analyzeInvestigation(new ScriptedLlm([], [report]), {
      userMessage: "latency",
      service: "payment-service",
      previousIncidents: [],
      run
    });
    expect(result.confidence).toBe("unknown");
    expect(result.unavailable[0]).toContain("Unknown service");
  });

  it("only extracts memory from confident diagnoses", async () => {
    const base: InvestigationResult = {
      kind: "investigation",
      service: "payment-service",
      summary: "",
      likelyCause: "Database connection pool exhaustion",
      confidence: "high",
      evidence: [],
      previousIncidents: [],
      recommendation: "",
      nextSteps: [],
      toolsUsed: [],
      unavailable: [],
      memory: { saved: false, recurrence: false, note: "" }
    };
    expect(isMemoryWorthy(base)).toBe(true);
    expect(isMemoryWorthy({ ...base, confidence: "low" })).toBe(false);
    expect(isMemoryWorthy({ ...base, likelyCause: "Undetermined" })).toBe(false);
    expect(isMemoryWorthy({ ...base, kind: "conversation" })).toBe(false);

    const llm = new ScriptedLlm([], [
      {
        shouldStore: true,
        service: "renamed-by-model",
        problem: "high API latency",
        cause: "DB connection pool exhaustion",
        resolution: "increase DB pool from 20 to 40",
        symptoms: ["p95 latency spike"],
        evidence: ["connection pool exhausted"]
      }
    ]);
    const extraction = await extractMemory(llm, "latency is high", base);
    expect(extraction).toMatchObject({ shouldStore: true, memory: { service: "payment-service", cause: "DB connection pool exhaustion" } });

    const skipped = await extractMemory(new ScriptedLlm([]), "hi", { ...base, kind: "conversation" });
    expect(skipped.shouldStore).toBe(false);
  });
});

describe("LLM output parsing", () => {
  it("normalizes Workers AI tool_calls with string or object arguments", () => {
    expect(normalizeToolCalls([{ name: "a", arguments: '{"x":1}' }, { name: "b", arguments: { y: 2 } }, { foo: 1 }])).toEqual([
      { name: "a", arguments: { x: 1 } },
      { name: "b", arguments: { y: 2 } }
    ]);
  });

  it("recovers tool calls Llama printed as text", () => {
    const known = ["search_logs"];
    expect(parseInlineToolCalls('{"name": "search_logs", "parameters": {"service": "payment-service", "query": "timeout"}}', known)).toEqual([
      { name: "search_logs", arguments: { service: "payment-service", query: "timeout" } }
    ]);
    expect(parseInlineToolCalls('<function=search_logs>{"service":"x","query":"y"}</function>', known)).toHaveLength(1);
    expect(parseInlineToolCalls("The cause is the database.", known)).toEqual([]);
  });

  it("extracts JSON from fenced or chatty output", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Here you go: {"a":2} hope that helps')).toEqual({ a: 2 });
  });
});

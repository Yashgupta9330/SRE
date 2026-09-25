/**
 * Post-investigation LLM steps:
 *   analyzeInvestigation → structured InvestigationResult (JSON mode)
 *   extractMemory        → the few facts worth remembering (JSON mode)
 *
 * The LLM writes the prose; facts the system already knows (which tools ran,
 * which failed, whether memory was saved) are filled in deterministically.
 */
import type { Confidence, InvestigationResult, PreviousIncident } from "../../shared/types";
import type { LlmClient } from "../llm/types";
import type { IncidentMemory } from "../memory/incident-memory";
import type { InvestigationRun, ToolCallRecord } from "./investigator";
import { ANALYST_SYSTEM_PROMPT, MEMORY_SYSTEM_PROMPT, formatPreviousIncidents } from "./prompts";

const CONFIDENCE: Confidence[] = ["high", "medium", "low", "unknown"];

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    likelyCause: { type: "string" },
    confidence: { type: "string", enum: CONFIDENCE },
    evidence: { type: "array", items: { type: "string" } },
    previousIncidents: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
    nextSteps: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "likelyCause", "confidence", "evidence", "previousIncidents", "recommendation", "nextSteps"]
};

const MEMORY_SCHEMA = {
  type: "object",
  properties: {
    shouldStore: { type: "boolean" },
    service: { type: "string" },
    problem: { type: "string" },
    cause: { type: "string" },
    resolution: { type: "string" },
    symptoms: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } }
  },
  required: ["shouldStore", "service", "problem", "cause", "resolution", "symptoms", "evidence"]
};

export interface AnalysisInput {
  userMessage: string;
  service?: string;
  previousIncidents: PreviousIncident[];
  run: InvestigationRun;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function str(v: unknown, max = 600): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function strList(v: unknown, maxItems = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(typeof x === "string" ? x : JSON.stringify(x), 300)).filter(Boolean).slice(0, maxItems);
}

function uniqueCalls(run: InvestigationRun): ToolCallRecord[] {
  return run.toolCalls.filter((c) => !c.duplicate);
}

export function toolsUsed(run: InvestigationRun): string[] {
  return uniqueCalls(run).map((c) => c.label);
}

/** Tool failures, phrased for the report ("Could not retrieve: ..."). */
export function unavailableData(run: InvestigationRun): string[] {
  return uniqueCalls(run).flatMap((c) => (c.result.ok ? [] : [`${c.label}: ${c.result.error}`]));
}

function formatEvidence(run: InvestigationRun): string {
  return uniqueCalls(run)
    .map((c) => {
      const body = c.result.ok ? JSON.stringify(c.result.data) : `FAILED: ${c.result.error}`;
      return `### ${c.name} ${JSON.stringify(c.arguments)}\n${body.slice(0, 3000)}`;
    })
    .join("\n\n");
}

const NO_MEMORY = { saved: false, recurrence: false, note: "" };

/** A message that needed no tools (greeting, question about the agent). */
export function isConversational(run: InvestigationRun): boolean {
  return run.toolCalls.length === 0;
}

export function conversationalResult(run: InvestigationRun, service?: string): InvestigationResult {
  return {
    kind: "conversation",
    service,
    summary: run.finalText || "I can investigate production issues. Describe the symptom and the service, e.g. \"API latency is high for payment-service\".",
    likelyCause: "",
    confidence: "unknown",
    evidence: [],
    previousIncidents: [],
    recommendation: "",
    nextSteps: [],
    toolsUsed: [],
    unavailable: [],
    memory: { ...NO_MEMORY, note: "Nothing to remember from this message." }
  };
}

/** Used when the analysis LLM call keeps failing: still return what we know. */
export function fallbackResult(input: AnalysisInput, reason: string): InvestigationResult {
  return {
    kind: "investigation",
    service: input.service,
    summary:
      (input.run.finalText ? `${input.run.finalText}\n\n` : "") +
      `(A structured report could not be generated: ${reason}.)`,
    likelyCause: "Undetermined (analysis step failed)",
    confidence: "low",
    evidence: [],
    previousIncidents: input.previousIncidents.map((p) => `${p.service}: ${p.cause} → ${p.resolution}`),
    recommendation: "Review the tool results above manually.",
    nextSteps: [],
    toolsUsed: toolsUsed(input.run),
    unavailable: unavailableData(input.run),
    memory: NO_MEMORY
  };
}

// ─── LLM steps ──────────────────────────────────────────────────────────────

export async function analyzeInvestigation(llm: LlmClient, input: AnalysisInput): Promise<InvestigationResult> {
  const unavailable = unavailableData(input.run);
  const raw = await llm.json<Record<string, unknown>>({
    schema: RESULT_SCHEMA,
    maxTokens: 1200,
    messages: [
      { role: "system", content: ANALYST_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `User request: ${input.userMessage}`,
          `Service: ${input.service ?? "not specified"}`,
          "",
          "Previous incidents from memory:",
          formatPreviousIncidents(input.previousIncidents),
          "",
          "Investigator findings:",
          input.run.finalText || "(none)",
          "",
          "Tool results:",
          formatEvidence(input.run) || "(no tools were called)",
          unavailable.length ? `\nCould not retrieve:\n- ${unavailable.join("\n- ")}` : ""
        ].join("\n")
      }
    ]
  });

  const confidence = CONFIDENCE.includes(raw.confidence as Confidence) ? (raw.confidence as Confidence) : "unknown";
  const allToolsFailed = uniqueCalls(input.run).every((c) => !c.result.ok);

  return {
    kind: "investigation",
    service: input.service,
    summary: str(raw.summary, 1200) || input.run.finalText,
    likelyCause: str(raw.likelyCause) || "Undetermined",
    // Guardrail: no successful tool call means no evidence, whatever the model claims.
    confidence: allToolsFailed ? "unknown" : confidence,
    evidence: strList(raw.evidence),
    previousIncidents: strList(raw.previousIncidents, 5),
    recommendation: str(raw.recommendation),
    nextSteps: strList(raw.nextSteps, 5),
    toolsUsed: toolsUsed(input.run),
    unavailable,
    memory: NO_MEMORY
  };
}

/** Deterministic gate: only concrete diagnoses backed by evidence become memories. */
export function isMemoryWorthy(result: InvestigationResult): boolean {
  if (result.kind !== "investigation" || !result.service) return false;
  if (result.confidence === "unknown" || result.confidence === "low") return false;
  return !/^(undetermined|unknown|n\/a|none)/i.test(result.likelyCause.trim()) && result.likelyCause.trim().length > 0;
}

export type MemoryExtraction = { shouldStore: false; reason: string } | { shouldStore: true; memory: IncidentMemory };

export async function extractMemory(
  llm: LlmClient,
  userMessage: string,
  result: InvestigationResult
): Promise<MemoryExtraction> {
  if (!isMemoryWorthy(result)) {
    return { shouldStore: false, reason: "No confident diagnosis to remember." };
  }
  const raw = await llm.json<Record<string, unknown>>({
    schema: MEMORY_SCHEMA,
    maxTokens: 600,
    messages: [
      { role: "system", content: MEMORY_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          userRequest: userMessage,
          service: result.service,
          summary: result.summary,
          likelyCause: result.likelyCause,
          confidence: result.confidence,
          evidence: result.evidence,
          recommendation: result.recommendation
        })
      }
    ]
  });

  if (raw.shouldStore === false) return { shouldStore: false, reason: "Model judged nothing worth remembering." };

  const memory: IncidentMemory = {
    // The service is known deterministically; do not let the model rename it.
    service: result.service!,
    problem: str(raw.problem, 200) || str(userMessage, 200),
    cause: str(raw.cause, 300) || result.likelyCause,
    resolution: str(raw.resolution, 300) || result.recommendation,
    symptoms: strList(raw.symptoms, 6),
    evidence: strList(raw.evidence, 6)
  };
  return { shouldStore: true, memory };
}

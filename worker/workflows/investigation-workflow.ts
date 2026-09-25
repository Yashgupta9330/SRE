/**
 * InvestigationWorkflow: durable orchestration of one investigation.
 *
 *   1. retrieve-memory   Vectorize (semantic) → D1 (structured records)
 *   2. investigate       LLM tool loop; the LLM decides the tool calls.
 *                        Each LLM turn and each tool call is its own step.
 *   3. analyze           LLM → structured InvestigationResult
 *   4. extract-memory    LLM → only the facts worth remembering
 *   5. persist-memory    D1 insert + Vectorize upsert (or record a recurrence)
 *   6. complete          save result to D1, notify the Agent
 *
 * Why a Workflow? Every `step.do` result is checkpointed. If the Worker is
 * evicted or a step fails, the instance resumes from the last completed step
 * with automatic retries: the LLM is not re-asked and tools are not re-run.
 *
 * Code OUTSIDE `step.do` can re-execute on replay, so it must be
 * deterministic. Progress reports are outside steps on purpose (cheap, and
 * the Agent de-duplicates them by key).
 *
 * `AgentWorkflow` (Agents SDK) links this instance to the Agent that started
 * it: `reportProgress` / `step.reportComplete` call back into that Agent,
 * which pushes updates to the browser over WebSocket.
 */
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { InvestigationParams, InvestigationResult, ProgressStep } from "../../shared/types";
import {
  analyzeInvestigation,
  conversationalResult,
  extractMemory,
  fallbackResult,
  isConversational,
  type MemoryExtraction
} from "../agents/analysis";
import { runInvestigation, type Durable, type InvestigationRun } from "../agents/investigator";
import type { SreAgent } from "../agents/sre-agent";
import { createDeps, type Deps } from "../deps";
import type { MemorySearchResult } from "../memory/incident-memory";

type Progress = ProgressStep;

const LLM_STEP = { retries: { limit: 2, delay: "2 seconds", backoff: "exponential" }, timeout: "2 minutes" } as const;
const IO_STEP = { retries: { limit: 3, delay: "1 second", backoff: "exponential" }, timeout: "30 seconds" } as const;

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export class InvestigationWorkflow extends AgentWorkflow<SreAgent, InvestigationParams, Progress, Env> {
  async run(event: AgentWorkflowEvent<InvestigationParams>, step: AgentWorkflowStep): Promise<InvestigationResult> {
    const params = event.payload;
    const deps = createDeps(this.env);
    const progress = (p: Progress) => this.reportProgress(p).catch(() => {});

    // step.do requires serializable return types; our results are plain JSON.
    const durable: Durable = (name, fn) =>
      step.do(name, LLM_STEP, fn as () => Promise<never>) as Promise<Awaited<ReturnType<typeof fn>>>;

    // ── 1. Retrieve memory ────────────────────────────────────────────────
    await progress({ key: "memory", label: "Retrieving previous incidents", status: "running" });
    const memory = await step.do("retrieve-memory", IO_STEP, async (): Promise<MemorySearchResult> =>
      deps.memory.search(params.userMessage, params.service)
    );
    await progress({
      key: "memory",
      label: memory.warning ? "Semantic memory degraded" : "Retrieved previous incidents",
      status: memory.warning ? "error" : "complete",
      detail: memory.warning ?? `${memory.incidents.length} relevant incident(s) found`
    });

    // ── 2. Investigate (LLM chooses tools) ────────────────────────────────
    await progress({ key: "investigate", label: "Investigating", status: "running" });
    const knownServices = await deps.tools.monitoring.listServices();
    let run: InvestigationRun;
    try {
      run = await runInvestigation(
        {
          userMessage: params.userMessage,
          service: params.service,
          knownServices,
          history: params.history,
          previousIncidents: memory.incidents,
          memoryWarning: memory.warning
        },
        {
          llm: deps.llm,
          tools: deps.tools,
          durable,
          hooks: {
            onToolStart: ({ key, label }) => progress({ key, label, status: "running" }),
            onToolEnd: (c) =>
              progress({
                key: c.key,
                label: c.label,
                status: c.result.ok ? "complete" : "error",
                detail: c.result.ok ? undefined : c.result.error
              })
          }
        }
      );
    } catch (err) {
      // LLM unavailable even after retries: fail clearly rather than guess.
      await progress({ key: "investigate", label: "Investigation failed", status: "error", detail: message(err) });
      await step.do("mark-failed", IO_STEP, () => deps.investigations.fail(params.investigationId, message(err)));
      throw new Error(`The language model is unavailable, so the investigation could not run: ${message(err)}`);
    }
    await progress({
      key: "investigate",
      label: "Investigation complete",
      status: "complete",
      detail: `${run.toolCalls.length} tool call(s)`
    });

    // A greeting / meta question: no report, nothing to remember.
    if (isConversational(run)) {
      const result = conversationalResult(run, params.service);
      await this.saveResult(step, deps, params.investigationId, result);
      await step.reportComplete(result);
      return result;
    }

    // ── 3. Analyze ────────────────────────────────────────────────────────
    await progress({ key: "analyze", label: "Analyzing evidence", status: "running" });
    const analysisInput = {
      userMessage: params.userMessage,
      service: params.service,
      previousIncidents: memory.incidents,
      run
    };
    let result: InvestigationResult;
    try {
      result = await step.do("analyze", LLM_STEP, () => analyzeInvestigation(deps.llm, analysisInput));
      await progress({ key: "analyze", label: "Analyzed evidence", status: "complete", detail: `confidence: ${result.confidence}` });
    } catch (err) {
      result = fallbackResult(analysisInput, message(err));
      await progress({ key: "analyze", label: "Analysis degraded", status: "error", detail: message(err) });
    }

    // ── 4. Extract memory ─────────────────────────────────────────────────
    await progress({ key: "memory-save", label: "Extracting investigation memory", status: "running" });
    let extraction: MemoryExtraction;
    try {
      extraction = await step.do("extract-memory", LLM_STEP, () => extractMemory(deps.llm, params.userMessage, result));
    } catch (err) {
      extraction = { shouldStore: false, reason: `memory extraction failed: ${message(err)}` };
    }

    // ── 5. Persist memory ─────────────────────────────────────────────────
    if (!extraction.shouldStore) {
      result.memory = { saved: false, recurrence: false, note: extraction.reason };
      await progress({ key: "memory-save", label: "No new memory saved", status: "complete", detail: extraction.reason });
    } else {
      const mem = extraction.memory;
      try {
        // Same incident seen before? Bump its counter instead of storing a duplicate.
        const existingId = await step.do("check-recurrence", IO_STEP, async () => {
          try {
            return await deps.memory.findRecurrence(mem);
          } catch {
            return null; // Vectorize down: just store a new memory.
          }
        });
        if (existingId) {
          await step.do("record-recurrence", IO_STEP, async () => {
            await deps.memory.recordRecurrence(existingId, new Date().toISOString());
          });
          result.memory = { saved: true, recurrence: true, note: "Matched an existing incident memory; recorded a recurrence." };
        } else {
          // Deterministic id (instance id), so a retried step cannot create duplicates.
          const memoryId = `mem-${params.investigationId}`;
          await step.do("persist-memory-d1", IO_STEP, async () => {
            await deps.memory.insert(memoryId, mem, params.investigationId, new Date().toISOString());
          });
          try {
            await step.do("persist-memory-vectorize", IO_STEP, () => deps.memory.index(memoryId, mem));
            result.memory = { saved: true, recurrence: false, note: `Stored: ${mem.problem} → ${mem.cause}` };
          } catch (err) {
            result.memory = { saved: true, recurrence: false, note: `Stored in D1, but semantic indexing failed: ${message(err)}` };
          }
        }
        await progress({ key: "memory-save", label: "Saved investigation memory", status: "complete", detail: result.memory.note });
      } catch (err) {
        result.memory = { saved: false, recurrence: false, note: `Could not save memory: ${message(err)}` };
        await progress({ key: "memory-save", label: "Saving memory failed", status: "error", detail: message(err) });
      }
    }

    // ── 6. Complete ───────────────────────────────────────────────────────
    await this.saveResult(step, deps, params.investigationId, result);
    await step.reportComplete(result);
    return result;
  }

  /** The D1 record is for polling/audit; if D1 is down, still deliver the report to the Agent. */
  private async saveResult(step: AgentWorkflowStep, deps: Deps, investigationId: string, result: InvestigationResult) {
    try {
      await step.do("save-result", IO_STEP, () => deps.investigations.complete(investigationId, result));
    } catch (err) {
      console.error("D1: could not save investigation result", err);
    }
  }
}

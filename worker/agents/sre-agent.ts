/**
 * SreAgent: one Agents SDK instance per conversation.
 *
 * An Agent is a Durable Object with built-in state sync: `this.setState()`
 * persists state in the object's SQLite storage and pushes it to every browser
 * connected via `useAgent()` over WebSocket. That state is the SHORT-TERM
 * memory of the conversation (messages + live investigation progress).
 *
 * The Agent does not investigate by itself. For each user message it starts
 * an InvestigationWorkflow (`this.runWorkflow`) and relays that workflow's
 * progress/completion callbacks into state, so the UI updates live.
 */
import { Agent, callable, type Connection } from "agents";
import type {
  ActiveInvestigation,
  AgentState,
  ChatMessage,
  InvestigationParams,
  InvestigationResult,
  ProgressStep
} from "../../shared/types";
import { InvestigationRepository } from "../db/repositories";
import { createDeps } from "../deps";
import { detectService, extractServiceMention } from "../tools/service-names";

const MAX_MESSAGES_IN_STATE = 40;
const HISTORY_TURNS_FOR_LLM = 6;
const MAX_MESSAGE_LENGTH = 2000;
/** If a workflow never called back (e.g. terminated), don't block the conversation forever. */
const STALE_INVESTIGATION_MS = 10 * 60 * 1000;

export class ChatBusyError extends Error {}

/** Condensed text of a message for the LLM's short-term context. */
function historyText(m: ChatMessage): string {
  if (m.role === "assistant" && m.result?.kind === "investigation") {
    const r = m.result;
    return `[Previous investigation of ${r.service ?? "unknown service"}] ${r.summary} Likely cause: ${r.likelyCause}. Recommendation: ${r.recommendation}`;
  }
  return m.content;
}

function renderResultText(r: InvestigationResult): string {
  if (r.kind === "conversation") return r.summary;
  return [
    "Investigation complete.",
    r.service ? `Service: ${r.service}` : "",
    `Likely cause: ${r.likelyCause} (confidence: ${r.confidence})`,
    r.evidence.length ? `Evidence:\n${r.evidence.map((e) => `- ${e}`).join("\n")}` : "",
    r.recommendation ? `Recommendation: ${r.recommendation}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class SreAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { messages: [], active: null };

  /** Browsers may read state but never write it directly; they call methods instead. */
  validateStateChange(_next: AgentState, source: Connection | "server") {
    if (source !== "server") throw new Error("State is read-only for clients");
  }

  private repo() {
    return new InvestigationRepository(this.env.DB);
  }

  /** D1 is the durable audit copy; its failure must not break the chat. */
  private async persistMessage(m: ChatMessage) {
    try {
      await this.repo().saveMessage(this.name, m);
    } catch (err) {
      console.error("D1: failed to persist message", err);
    }
  }

  private appendMessage(m: ChatMessage, patch: Partial<AgentState> = {}) {
    const messages = [...this.state.messages, m].slice(-MAX_MESSAGES_IN_STATE);
    this.setState({ ...this.state, ...patch, messages });
  }

  /**
   * Entry point for a user message: from POST /api/chat (Durable Object RPC)
   * or directly from the browser over WebSocket (@callable).
   */
  @callable()
  async sendMessage(text: string): Promise<{ investigationId: string }> {
    const message = String(text ?? "").trim();
    if (!message) throw new Error("Message must not be empty");
    if (message.length > MAX_MESSAGE_LENGTH) throw new Error(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);

    const active = this.state.active;
    if (active && Date.now() - Date.parse(active.startedAt) < STALE_INVESTIGATION_MS) {
      throw new ChatBusyError("An investigation is already running in this conversation. Please wait for it to finish.");
    }

    const knownServices = await createDeps(this.env).tools.monitoring.listServices();
    // Short-term memory in action: "is it happening again?" reuses the last service.
    const service = detectService(message, knownServices) ?? extractServiceMention(message) ?? this.state.lastService;
    const history = this.state.messages.slice(-HISTORY_TURNS_FOR_LLM).map((m) => ({ role: m.role, content: historyText(m) }));

    const investigationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: message, createdAt: now, investigationId };
    const nextActive: ActiveInvestigation = { id: investigationId, service, startedAt: now, steps: [] };

    // Claim the conversation before any await, so concurrent sends are rejected.
    this.appendMessage(userMessage, { active: nextActive });
    await this.persistMessage(userMessage);
    try {
      await this.repo().create({ id: investigationId, conversationId: this.name, service, userMessage: message, createdAt: now });
    } catch (err) {
      console.error("D1: failed to create investigation record", err);
    }

    const params: InvestigationParams = { conversationId: this.name, investigationId, userMessage: message, service, history };
    try {
      await this.runWorkflow("INVESTIGATION_WORKFLOW", params, {
        id: investigationId,
        metadata: { conversationId: this.name, service: service ?? null }
      });
    } catch (err) {
      await this.finishWithError(investigationId, `Could not start the investigation workflow: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return { investigationId };
  }

  @callable()
  async resetConversation(): Promise<void> {
    this.setState({ messages: [], active: null });
  }

  // ─── Workflow callbacks (invoked by AgentWorkflow via RPC) ──────────────

  async onWorkflowProgress(_workflowName: string, workflowId: string, progress: unknown): Promise<void> {
    const active = this.state.active;
    if (!active || active.id !== workflowId) return;
    const step = progress as ProgressStep;
    // Upsert by key (reports can repeat when a workflow step is replayed) and
    // move the updated line to the end, so the feed reads chronologically.
    const steps = [...active.steps.filter((s) => s.key !== step.key), step];
    this.setState({ ...this.state, active: { ...active, steps } });
    try {
      await this.repo().updateSteps(workflowId, steps);
    } catch {
      // Polling copy only; WebSocket clients already have the update.
    }
  }

  async onWorkflowComplete(_workflowName: string, workflowId: string, result?: unknown): Promise<void> {
    const r = result as InvestigationResult | undefined;
    if (!r || this.state.messages.some((m) => m.role === "assistant" && m.investigationId === workflowId)) return;
    const reply: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: renderResultText(r),
      createdAt: new Date().toISOString(),
      investigationId: workflowId,
      result: r
    };
    this.appendMessage(reply, {
      active: this.state.active?.id === workflowId ? null : this.state.active,
      lastService: r.service ?? this.state.lastService
    });
    await this.persistMessage(reply);
  }

  async onWorkflowError(_workflowName: string, workflowId: string, error: string): Promise<void> {
    await this.finishWithError(workflowId, error);
  }

  private async finishWithError(investigationId: string, error: string) {
    if (this.state.messages.some((m) => m.role === "assistant" && m.investigationId === investigationId)) return;
    const reply: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: `The investigation could not be completed: ${error}`,
      createdAt: new Date().toISOString(),
      investigationId,
      error: true
    };
    this.appendMessage(reply, { active: this.state.active?.id === investigationId ? null : this.state.active });
    await this.persistMessage(reply);
    try {
      await this.repo().fail(investigationId, error);
    } catch {
      // best effort
    }
  }
}

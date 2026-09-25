/**
 * Types shared between the Worker and the React frontend.
 * Everything here must be JSON-serializable: it crosses WebSocket, HTTP,
 * Durable Object RPC and Workflow step boundaries.
 */

export type Confidence = "high" | "medium" | "low" | "unknown";

/** A previous incident retrieved from long-term memory. */
export interface PreviousIncident {
  id: string;
  service: string;
  problem: string;
  cause: string;
  resolution: string;
  symptoms: string[];
  evidence: string[];
  occurrences: number;
  createdAt: string;
  lastSeenAt: string;
  /** Vectorize similarity score (absent when retrieved via the D1 fallback). */
  score?: number;
}

/** Structured output of an investigation (the "report"). */
export interface InvestigationResult {
  /** "conversation" = the message was not an incident (e.g. a greeting); no tools, no memory. */
  kind: "investigation" | "conversation";
  service?: string;
  summary: string;
  likelyCause: string;
  confidence: Confidence;
  evidence: string[];
  previousIncidents: string[];
  recommendation: string;
  nextSteps: string[];
  /** Tools the agent chose to call, in order (computed from the transcript, not by the LLM). */
  toolsUsed: string[];
  /** Data the agent tried and failed to retrieve (tool failures). */
  unavailable: string[];
  memory: { saved: boolean; recurrence: boolean; note: string };
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  investigationId?: string;
  result?: InvestigationResult;
  error?: boolean;
}

export type StepStatus = "running" | "complete" | "error";

/** One line of live progress shown in the UI ("✓ Checked service metrics"). */
export interface ProgressStep {
  key: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface ActiveInvestigation {
  id: string;
  service?: string;
  startedAt: string;
  steps: ProgressStep[];
}

/** Agent state: synced to every connected browser tab over WebSocket. */
export interface AgentState {
  messages: ChatMessage[];
  active: ActiveInvestigation | null;
  /** Last service investigated in this conversation (short-term context). */
  lastService?: string;
}

/** Workflow input. */
export interface InvestigationParams {
  conversationId: string;
  investigationId: string;
  userMessage: string;
  service?: string;
  /** Recent conversation turns (short-term memory) so follow-ups make sense. */
  history: { role: ChatRole; content: string }[];
}

export interface ChatApiRequest {
  conversationId: string;
  message: string;
}

export interface ChatApiResponse {
  conversationId: string;
  investigationId: string;
  status: "running";
  /** Poll this if you are not connected to the agent WebSocket. */
  statusUrl: string;
}

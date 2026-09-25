import type { ChatApiResponse } from "../../shared/types";

export async function postChat(conversationId: string, message: string): Promise<ChatApiResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, message })
  });
  const body = (await res.json().catch(() => ({}))) as Partial<ChatApiResponse> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as ChatApiResponse;
}

export async function getServices(): Promise<{ mode: "cloudflare" | "mock"; services: string[] }> {
  const res = await fetch("/api/services");
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

const STORAGE_KEY = "sre-agent:conversationId";

export function newConversationId(): string {
  return `conv-${crypto.randomUUID().slice(0, 8)}`;
}

/** Conversation id survives reloads, so the Agent's short-term memory does too. */
export function loadConversationId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
  } catch {
    // storage blocked: fall through to a fresh id
  }
  return saveConversationId(newConversationId());
}

export function saveConversationId(id: string): string {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore
  }
  return id;
}

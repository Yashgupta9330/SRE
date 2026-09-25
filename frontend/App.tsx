import { useAgent } from "agents/react";
import { useEffect, useRef, useState } from "react";
import type { AgentState } from "../shared/types";
import { getServices, loadConversationId, newConversationId, postChat, saveConversationId } from "./api/client";
import { Composer } from "./components/Composer";
import { InvestigationProgress } from "./components/InvestigationProgress";
import { MessageBubble } from "./components/MessageBubble";

const MOCK_EXAMPLES = [
  "API latency is high for payment-service. Investigate.",
  "order-service CPU is pegged and searches are timing out.",
  "Notifications are delayed. Check notification-service.",
  "Payment service is slow again. Have we seen this before?"
];

function examplesFor(service: string) {
  return [
    `${service} search is slow. Investigate.`,
    `${service} is throwing errors. What changed?`,
    `Is ${service} healthy right now?`,
    `${service} is slow again. Have we seen this before?`
  ];
}

export function App() {
  const [conversationId, setConversationId] = useState(loadConversationId);
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<{ mode: string; services: string[] } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // WebSocket to this conversation's SreAgent instance (/agents/sre-agent/<id>).
  // `agent.state` is pushed by the server on connect and on every setState().
  const agent = useAgent<AgentState>({
    agent: "SreAgent",
    name: conversationId,
    onOpen: () => setConnected(true),
    onClose: () => setConnected(false)
  });

  useEffect(() => {
    getServices().then(setCatalog).catch(() => setCatalog(null));
  }, []);

  const examples =
    catalog?.mode === "cloudflare" && catalog.services[0] ? examplesFor(catalog.services[0]) : MOCK_EXAMPLES;

  const messages = agent.state?.messages ?? [];
  const active = agent.state?.active ?? null;
  const busy = sending || active !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, active?.steps.length]);

  async function send(text: string) {
    setError(null);
    setSending(true);
    try {
      // HTTP starts the investigation; progress and the result arrive over the WebSocket.
      await postChat(conversationId, text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  function startNewConversation() {
    setError(null);
    setConversationId(saveConversationId(newConversationId()));
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>SRE Investigation Agent</h1>
          <p className="subtitle">
            Workers AI · Agents SDK · Workflows · D1 · Vectorize
            <span className={`status ${connected ? "online" : "offline"}`}>{connected ? "connected" : "connecting…"}</span>
          </p>
        </div>
        <button className="secondary" onClick={startNewConversation} disabled={busy}>
          New conversation
        </button>
      </header>

      <main className="messages">
        {messages.length === 0 && !active && (
          <div className="empty">
            <p>Describe an incident. The agent checks metrics, logs, deploys, database queries, runbooks and past incidents, then reports a likely cause.</p>
            {catalog && (
              <p className="detail">
                {catalog.mode === "cloudflare" ? "Live Cloudflare telemetry for: " : "Simulated services: "}
                {catalog.services.join(", ")}
              </p>
            )}
            <div className="examples">
              {examples.map((e) => (
                <button key={e} className="example" onClick={() => send(e)} disabled={busy || !connected}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {active && <InvestigationProgress investigation={active} />}
        <div ref={bottomRef} />
      </main>

      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}

      <Composer onSend={send} disabled={busy || !connected} busy={busy} />
      <footer className="footer">Conversation {conversationId} · investigation-only: the agent recommends, it never changes infrastructure.</footer>
    </div>
  );
}

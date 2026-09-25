/**
 * Worker entry point: HTTP routing only.
 *
 *   POST /api/chat                          start an investigation (returns an id)
 *   GET  /api/investigations/:id            poll status/progress/result (D1)
 *   GET  /api/conversations/:id/messages    durable transcript (D1)
 *   GET  /api/memories                      long-term incident memories (D1)
 *   GET  /api/services                      monitored services + provider mode
 *   POST /api/admin/seed-runbooks           (re)seed runbooks into D1 + Vectorize
 *   GET  /api/health
 *   /agents/sre-agent/:conversationId       Agents SDK WebSocket (state sync + RPC)
 *
 * Everything else is served from static assets (the React app).
 */
import { getAgentByName, routeAgentRequest } from "agents";
import type { ChatApiRequest, ChatApiResponse } from "../shared/types";
import { ChatBusyError } from "./agents/sre-agent";
import { D1IncidentRepository, D1RunbookRepository } from "./db/repositories";
import { createDeps, providerMode } from "./deps";
import { seedRunbooks } from "./providers/runbook-provider";

// Cloudflare discovers Durable Object and Workflow classes via the entry module's exports.
export { SreAgent } from "./agents/sre-agent";
export { InvestigationWorkflow } from "./workflows/investigation-workflow";

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function errorJson(status: number, error: string) {
  return json({ error }, status);
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: Partial<ChatApiRequest>;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, "Body must be JSON: { conversationId, message }");
  }
  const conversationId = String(body.conversationId ?? "");
  const message = String(body.message ?? "").trim();
  if (!CONVERSATION_ID.test(conversationId)) return errorJson(400, "conversationId must match [A-Za-z0-9_-]{1,64}");
  if (!message) return errorJson(400, "message is required");

  // Durable Object RPC: call a method on the conversation's Agent instance.
  const agent = await getAgentByName(env.SreAgent, conversationId);
  try {
    const { investigationId } = await agent.sendMessage(message);
    const response: ChatApiResponse = {
      conversationId,
      investigationId,
      status: "running",
      statusUrl: `/api/investigations/${investigationId}`
    };
    return json(response, 202);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Errors crossing RPC lose their class, so match on the busy message too.
    if (err instanceof ChatBusyError || msg.includes("already running")) return errorJson(409, msg);
    return errorJson(400, msg);
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health") return json({ ok: true });

  if (pathname === "/api/chat") {
    return method === "POST" ? handleChat(request, env) : errorJson(405, "Use POST");
  }

  const inv = pathname.match(/^\/api\/investigations\/([\w-]+)$/);
  if (inv && method === "GET") {
    const record = await createDeps(env).investigations.get(inv[1]);
    return record ? json(record) : errorJson(404, "Investigation not found");
  }

  const conv = pathname.match(/^\/api\/conversations\/([\w-]+)\/messages$/);
  if (conv && method === "GET") {
    return json({ messages: await createDeps(env).investigations.listMessages(conv[1]) });
  }

  if (pathname === "/api/services" && method === "GET") {
    const services = await createDeps(env).tools.monitoring.listServices();
    return json({ mode: providerMode(env), services });
  }

  if (pathname === "/api/memories" && method === "GET") {
    return json({ memories: await new D1IncidentRepository(env.DB).list(50) });
  }

  if (pathname === "/api/admin/seed-runbooks" && method === "POST") {
    const deps = createDeps(env);
    return json(await seedRunbooks(new D1RunbookRepository(env.DB), env.VECTORIZE, deps.embedder));
  }

  return errorJson(404, "Not found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
      // /agents/:agent/:name → Agent WebSocket / HTTP (handled by the Agents SDK)
      return (await routeAgentRequest(request, env)) ?? errorJson(404, "Not found");
    } catch (err) {
      console.error("Unhandled error", err);
      return errorJson(500, err instanceof Error ? err.message : "Internal error");
    }
  }
} satisfies ExportedHandler<Env>;

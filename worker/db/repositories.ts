/**
 * D1 data access. All SQL lives in this file.
 *
 * Memory and runbook logic depend on the small repository interfaces below
 * (not on D1 directly) so they can be unit-tested with in-memory fakes.
 */
import type { ChatMessage, InvestigationResult, PreviousIncident, ProgressStep } from "../../shared/types";
import type { Runbook } from "../providers/types";

// ─── Incident memory ─────────────────────────────────────────────────────────

export interface NewIncidentRecord {
  id: string;
  investigationId?: string;
  service: string;
  problem: string;
  cause: string;
  resolution: string;
  symptoms: string[];
  evidence: string[];
  createdAt: string;
}

export interface IncidentRepository {
  insert(record: NewIncidentRecord): Promise<void>;
  getByIds(ids: string[]): Promise<PreviousIncident[]>;
  recentForService(service: string, limit: number): Promise<PreviousIncident[]>;
  recordRecurrence(id: string, seenAt: string): Promise<void>;
  list(limit: number): Promise<PreviousIncident[]>;
}

interface IncidentRow {
  id: string;
  service: string;
  problem: string;
  cause: string;
  resolution: string;
  symptoms_json: string;
  evidence_json: string;
  occurrences: number;
  created_at: string;
  last_seen_at: string;
}

function parseJsonArray(text: string | null | undefined): string[] {
  try {
    const v = JSON.parse(text ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toIncident(row: IncidentRow): PreviousIncident {
  return {
    id: row.id,
    service: row.service,
    problem: row.problem,
    cause: row.cause,
    resolution: row.resolution,
    symptoms: parseJsonArray(row.symptoms_json),
    evidence: parseJsonArray(row.evidence_json),
    occurrences: row.occurrences,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at
  };
}

export class D1IncidentRepository implements IncidentRepository {
  constructor(private readonly db: D1Database) {}

  async insert(r: NewIncidentRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO incident_memories
           (id, investigation_id, service, problem, cause, resolution, symptoms_json, evidence_json, occurrences, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO NOTHING` // idempotent: a retried workflow step must not duplicate
      )
      .bind(
        r.id,
        r.investigationId ?? null,
        r.service,
        r.problem,
        r.cause,
        r.resolution,
        JSON.stringify(r.symptoms),
        JSON.stringify(r.evidence),
        r.createdAt,
        r.createdAt
      )
      .run();
  }

  async getByIds(ids: string[]): Promise<PreviousIncident[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT * FROM incident_memories WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<IncidentRow>();
    return results.map(toIncident);
  }

  async recentForService(service: string, limit: number): Promise<PreviousIncident[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM incident_memories WHERE service = ? ORDER BY last_seen_at DESC LIMIT ?`)
      .bind(service, limit)
      .all<IncidentRow>();
    return results.map(toIncident);
  }

  async recordRecurrence(id: string, seenAt: string): Promise<void> {
    await this.db
      .prepare(`UPDATE incident_memories SET occurrences = occurrences + 1, last_seen_at = ? WHERE id = ? AND last_seen_at < ?`)
      .bind(seenAt, id, seenAt)
      .run();
  }

  async list(limit: number): Promise<PreviousIncident[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM incident_memories ORDER BY last_seen_at DESC LIMIT ?`)
      .bind(limit)
      .all<IncidentRow>();
    return results.map(toIncident);
  }
}

// ─── Runbooks ────────────────────────────────────────────────────────────────

export interface RunbookRepository {
  count(): Promise<number>;
  list(): Promise<Runbook[]>;
  getBySlugs(slugs: string[]): Promise<Runbook[]>;
  upsertMany(runbooks: Runbook[]): Promise<void>;
}

export class D1RunbookRepository implements RunbookRepository {
  constructor(private readonly db: D1Database) {}

  async count(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM runbooks`).first<{ n: number }>();
    return row?.n ?? 0;
  }

  async list(): Promise<Runbook[]> {
    const { results } = await this.db.prepare(`SELECT content_json FROM runbooks`).all<{ content_json: string }>();
    return results.map((r) => JSON.parse(r.content_json) as Runbook);
  }

  async getBySlugs(slugs: string[]): Promise<Runbook[]> {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT content_json FROM runbooks WHERE slug IN (${placeholders})`)
      .bind(...slugs)
      .all<{ content_json: string }>();
    return results.map((r) => JSON.parse(r.content_json) as Runbook);
  }

  async upsertMany(runbooks: Runbook[]): Promise<void> {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO runbooks (slug, title, content_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET title = excluded.title, content_json = excluded.content_json, updated_at = excluded.updated_at`
    );
    await this.db.batch(runbooks.map((r) => stmt.bind(r.slug, r.title, JSON.stringify(r), now)));
  }
}

// ─── Investigations & conversation transcript ───────────────────────────────

export interface InvestigationRecord {
  id: string;
  conversationId: string;
  service: string | null;
  userMessage: string;
  status: "running" | "complete" | "failed";
  steps: ProgressStep[];
  result: InvestigationResult | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface InvestigationRow {
  id: string;
  conversation_id: string;
  service: string | null;
  user_message: string;
  status: InvestigationRecord["status"];
  steps_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export class InvestigationRepository {
  constructor(private readonly db: D1Database) {}

  async create(r: { id: string; conversationId: string; service?: string; userMessage: string; createdAt: string }) {
    await this.db
      .prepare(
        `INSERT INTO investigations (id, conversation_id, service, user_message, status, created_at)
         VALUES (?, ?, ?, ?, 'running', ?) ON CONFLICT(id) DO NOTHING`
      )
      .bind(r.id, r.conversationId, r.service ?? null, r.userMessage, r.createdAt)
      .run();
  }

  async updateSteps(id: string, steps: ProgressStep[]) {
    await this.db.prepare(`UPDATE investigations SET steps_json = ? WHERE id = ?`).bind(JSON.stringify(steps), id).run();
  }

  async complete(id: string, result: InvestigationResult) {
    await this.db
      .prepare(`UPDATE investigations SET status = 'complete', result_json = ?, completed_at = ? WHERE id = ?`)
      .bind(JSON.stringify(result), new Date().toISOString(), id)
      .run();
  }

  async fail(id: string, error: string) {
    await this.db
      .prepare(`UPDATE investigations SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`)
      .bind(error, new Date().toISOString(), id)
      .run();
  }

  async get(id: string): Promise<InvestigationRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM investigations WHERE id = ?`).bind(id).first<InvestigationRow>();
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      service: row.service,
      userMessage: row.user_message,
      status: row.status,
      steps: JSON.parse(row.steps_json || "[]") as ProgressStep[],
      result: row.result_json ? (JSON.parse(row.result_json) as InvestigationResult) : null,
      error: row.error,
      createdAt: row.created_at,
      completedAt: row.completed_at
    };
  }

  async saveMessage(conversationId: string, m: ChatMessage) {
    await this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, role, content, investigation_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
      )
      .bind(m.id, conversationId, m.role, m.content, m.investigationId ?? null, m.createdAt)
      .run();
  }

  async listMessages(conversationId: string, limit = 100) {
    const { results } = await this.db
      .prepare(
        `SELECT id, role, content, investigation_id AS investigationId, created_at AS createdAt
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`
      )
      .bind(conversationId, limit)
      .all();
    return results;
  }
}

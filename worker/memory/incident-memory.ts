/**
 * Long-term semantic memory of past incidents.
 *
 *   D1        → the structured record (service, problem, cause, resolution, ...)
 *   Vectorize → an embedding of that record, id = D1 row id, namespace "incidents"
 *
 * Retrieval is semantic: "payment service is slow again" finds a memory about
 * "high API latency ... DB connection pool exhaustion" with no shared keywords.
 */
import type { PreviousIncident } from "../../shared/types";
import type { IncidentRepository } from "../db/repositories";
import { NAMESPACE, type Embedder, type VectorIndex } from "./vectors";

/** The distilled, reusable facts extracted from one investigation. */
export interface IncidentMemory {
  service: string;
  problem: string;
  cause: string;
  resolution: string;
  symptoms: string[];
  evidence: string[];
}

export interface MemorySearchResult {
  incidents: PreviousIncident[];
  source: "vectorize" | "d1-fallback" | "none";
  warning?: string;
}

export interface MemoryStoreOptions {
  /** Minimum cosine similarity for a memory of the same service to count as relevant. */
  minScore: number;
  /** Stricter bar for memories of other services (prevents anchoring on unrelated incidents). */
  crossServiceMinScore: number;
  topK: number;
  /** Similarity above which a new memory is treated as a recurrence of an existing one. */
  recurrenceScore: number;
}

const DEFAULTS: MemoryStoreOptions = { minScore: 0.65, crossServiceMinScore: 0.8, topK: 3, recurrenceScore: 0.9 };

/** What we embed: the semantic gist of the incident. */
export function memoryEmbeddingText(m: IncidentMemory): string {
  return [
    `Service: ${m.service}.`,
    `Problem: ${m.problem}.`,
    m.symptoms.length ? `Symptoms: ${m.symptoms.join("; ")}.` : "",
    `Cause: ${m.cause}.`,
    `Resolution: ${m.resolution}.`
  ]
    .filter(Boolean)
    .join(" ");
}

export class IncidentMemoryStore {
  private readonly opts: MemoryStoreOptions;

  constructor(
    private readonly repo: IncidentRepository,
    private readonly vectors: VectorIndex | undefined,
    private readonly embedder: Embedder | undefined,
    opts: Partial<MemoryStoreOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Find previous incidents relevant to a new request. Never throws. */
  async search(query: string, service?: string): Promise<MemorySearchResult> {
    try {
      if (!this.vectors || !this.embedder) throw new Error("Vectorize binding not configured");
      const text = service ? `${service}: ${query}` : query;
      const [vector] = await this.embedder.embed([text]);
      const { matches } = await this.vectors.query(vector, {
        topK: this.opts.topK,
        namespace: NAMESPACE.incidents,
        returnMetadata: "all"
      });
      const relevant = matches.filter((m) =>
        m.score >= (service && m.metadata?.service === service ? this.opts.minScore : this.opts.crossServiceMinScore)
      );
      if (relevant.length === 0) return { incidents: [], source: "vectorize" };

      const rows = await this.repo.getByIds(relevant.map((m) => m.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      // Keep Vectorize's ranking; drop vectors whose D1 row no longer exists.
      const incidents = relevant.flatMap((m) => {
        const row = byId.get(m.id);
        return row ? [{ ...row, score: Math.round(m.score * 1000) / 1000 }] : [];
      });
      return { incidents, source: "vectorize" };
    } catch (err) {
      return this.fallbackSearch(service, err);
    }
  }

  /** Vectorize unavailable → at least recall recent incidents for the same service from D1. */
  private async fallbackSearch(service: string | undefined, cause: unknown): Promise<MemorySearchResult> {
    const reason = cause instanceof Error ? cause.message : String(cause);
    if (!service) {
      return { incidents: [], source: "none", warning: `Semantic memory unavailable (${reason})` };
    }
    try {
      const incidents = await this.repo.recentForService(service, this.opts.topK);
      return { incidents, source: "d1-fallback", warning: `Semantic memory unavailable (${reason}); used recent ${service} incidents` };
    } catch (dbErr) {
      const dbReason = dbErr instanceof Error ? dbErr.message : String(dbErr);
      return { incidents: [], source: "none", warning: `Memory unavailable (vectorize: ${reason}; d1: ${dbReason})` };
    }
  }

  /** Is this memory essentially the same incident we already stored? Returns that memory's id. */
  async findRecurrence(memory: IncidentMemory): Promise<string | null> {
    if (!this.vectors || !this.embedder) return null;
    const [vector] = await this.embedder.embed([memoryEmbeddingText(memory)]);
    const { matches } = await this.vectors.query(vector, {
      topK: 3,
      namespace: NAMESPACE.incidents,
      returnMetadata: "all"
    });
    const candidates = matches.filter(
      (m) => m.score >= this.opts.recurrenceScore && m.metadata?.service === memory.service
    );
    if (candidates.length === 0) return null;
    // Vectorize is eventually consistent: a vector can outlive its D1 row. Only
    // count a recurrence against a memory that still exists.
    const existing = new Set((await this.repo.getByIds(candidates.map((c) => c.id))).map((r) => r.id));
    return candidates.find((c) => existing.has(c.id))?.id ?? null;
  }

  async insert(id: string, memory: IncidentMemory, investigationId: string, createdAt: string): Promise<void> {
    await this.repo.insert({ id, investigationId, createdAt, ...memory });
  }

  async index(id: string, memory: IncidentMemory): Promise<void> {
    if (!this.vectors || !this.embedder) throw new Error("Vectorize binding not configured");
    const [values] = await this.embedder.embed([memoryEmbeddingText(memory)]);
    await this.vectors.upsert([
      { id, values, namespace: NAMESPACE.incidents, metadata: { service: memory.service } }
    ]);
  }

  async recordRecurrence(id: string, seenAt: string): Promise<void> {
    await this.repo.recordRecurrence(id, seenAt);
  }
}

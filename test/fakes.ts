import type { PreviousIncident } from "../shared/types";
import type { IncidentRepository, NewIncidentRecord, RunbookRepository } from "../worker/db/repositories";
import type { ChatRequest, JsonRequest, LlmClient, LlmResponse } from "../worker/llm/types";
import type { Embedder, VectorIndex, VectorMatch, VectorRecord } from "../worker/memory/vectors";
import { MockLogProvider } from "../worker/providers/mock/mock-logs";
import { MockMonitoringProvider } from "../worker/providers/mock/mock-monitoring";
import { MockDatabaseProvider, MockDependencyProvider, MockDeployProvider } from "../worker/providers/mock/mock-platform";
import type { Runbook } from "../worker/providers/types";
import { KnowledgeBaseRunbookProvider } from "../worker/providers/runbook-provider";
import type { ToolContext } from "../worker/tools/types";

export const FIXED_NOW = () => new Date("2026-09-26T10:32:00Z");

/** LLM that replays a script of responses and records every request. */
export class ScriptedLlm implements LlmClient {
  chatRequests: ChatRequest[] = [];
  jsonRequests: JsonRequest[] = [];
  constructor(
    private chatScript: (LlmResponse | Error)[],
    private jsonScript: (unknown | Error)[] = []
  ) {}

  async chat(req: ChatRequest): Promise<LlmResponse> {
    this.chatRequests.push(structuredClone(req));
    const next = this.chatScript.shift();
    if (!next) throw new Error("ScriptedLlm: chat script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }

  async json<T>(req: JsonRequest): Promise<T> {
    this.jsonRequests.push(structuredClone(req));
    const next = this.jsonScript.shift();
    if (next === undefined) throw new Error("ScriptedLlm: json script exhausted");
    if (next instanceof Error) throw next;
    return next as T;
  }
}

/**
 * Deterministic "embedding": bag of words hashed into 64 dims, L2-normalized.
 * Not semantic, but enough to exercise ranking/threshold plumbing.
 */
export class HashEmbedder implements Embedder {
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const w of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        v[h % 64] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export class InMemoryVectorIndex implements VectorIndex {
  records = new Map<string, VectorRecord>();
  failing = false;

  async upsert(vectors: VectorRecord[]) {
    if (this.failing) throw new Error("Vectorize unavailable");
    for (const v of vectors) this.records.set(`${v.namespace}:${v.id}`, v);
    return { count: vectors.length };
  }

  async query(vector: number[], options: { topK: number; namespace?: string }): Promise<{ matches: VectorMatch[] }> {
    if (this.failing) throw new Error("Vectorize unavailable");
    const matches = [...this.records.values()]
      .filter((r) => r.namespace === options.namespace)
      .map((r) => ({ id: r.id, score: r.values.reduce((s, x, i) => s + x * vector[i], 0), metadata: r.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
    return { matches };
  }
}

export class InMemoryIncidentRepo implements IncidentRepository {
  rows = new Map<string, PreviousIncident & { investigationId?: string }>();
  failing = false;

  private check() {
    if (this.failing) throw new Error("D1 unavailable");
  }
  async insert(r: NewIncidentRecord) {
    this.check();
    if (this.rows.has(r.id)) return;
    this.rows.set(r.id, { ...r, occurrences: 1, lastSeenAt: r.createdAt });
  }
  async getByIds(ids: string[]) {
    this.check();
    return ids.flatMap((id) => (this.rows.has(id) ? [this.rows.get(id)!] : []));
  }
  async recentForService(service: string, limit: number) {
    this.check();
    return [...this.rows.values()].filter((r) => r.service === service).slice(0, limit);
  }
  async recordRecurrence(id: string, seenAt: string) {
    this.check();
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, occurrences: r.occurrences + 1, lastSeenAt: seenAt });
  }
  async list(limit: number) {
    return [...this.rows.values()].slice(0, limit);
  }
}

export class InMemoryRunbookRepo implements RunbookRepository {
  rows = new Map<string, Runbook>();
  async count() {
    return this.rows.size;
  }
  async list() {
    return [...this.rows.values()];
  }
  async getBySlugs(slugs: string[]) {
    return slugs.flatMap((s) => (this.rows.has(s) ? [this.rows.get(s)!] : []));
  }
  async upsertMany(runbooks: Runbook[]) {
    for (const r of runbooks) this.rows.set(r.slug, r);
  }
}

export function mockToolContext(): ToolContext {
  return {
    monitoring: new MockMonitoringProvider(undefined, FIXED_NOW),
    logs: new MockLogProvider(undefined, FIXED_NOW),
    deploys: new MockDeployProvider(undefined, FIXED_NOW),
    dependencies: new MockDependencyProvider(undefined, FIXED_NOW),
    database: new MockDatabaseProvider(undefined, FIXED_NOW),
    runbooks: new KnowledgeBaseRunbookProvider(new InMemoryRunbookRepo(), undefined, undefined)
  };
}

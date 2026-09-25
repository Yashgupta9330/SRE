import type { RunbookRepository } from "../db/repositories";
import { NAMESPACE, type Embedder, type VectorIndex } from "../memory/vectors";
import { RUNBOOKS, runbookEmbeddingText } from "../runbooks";
import type { Runbook, RunbookMatch, RunbookProvider } from "./types";

/** Cosine similarity below this is treated as "not relevant" for bge-base-en-v1.5. */
const MIN_SEMANTIC_SCORE = 0.55;

/**
 * Runbook retrieval = RAG over the knowledge base.
 *   1. Embed the query (Workers AI) and search Vectorize namespace "runbooks".
 *   2. Load the full runbook content for the matching slugs from D1.
 *   3. If Vectorize is unavailable or returns nothing (e.g. vectors not yet
 *      indexed right after seeding), fall back to keyword scoring over D1.
 *   4. If D1 itself fails, fall back to the runbooks bundled with the Worker.
 */
export class KnowledgeBaseRunbookProvider implements RunbookProvider {
  readonly name = "knowledge-base-runbooks";
  private seeded = false;

  constructor(
    private readonly repo: RunbookRepository,
    private readonly vectors: VectorIndex | undefined,
    private readonly embedder: Embedder | undefined
  ) {}

  async searchRunbooks(query: string, limit = 2): Promise<RunbookMatch[]> {
    let catalog: Runbook[];
    try {
      await this.ensureSeeded();
      catalog = await this.repo.list();
    } catch (err) {
      console.warn("runbooks: D1 unavailable, using bundled runbooks", err);
      catalog = RUNBOOKS;
    }

    const semantic = await this.semanticSearch(query, limit, catalog);
    if (semantic.length > 0) return semantic;
    return keywordSearch(query, catalog, limit);
  }

  private async semanticSearch(query: string, limit: number, catalog: Runbook[]): Promise<RunbookMatch[]> {
    if (!this.vectors || !this.embedder) return [];
    try {
      const [vector] = await this.embedder.embed([query]);
      const { matches } = await this.vectors.query(vector, { topK: limit, namespace: NAMESPACE.runbooks });
      const bySlug = new Map(catalog.map((r) => [r.slug, r]));
      return matches
        .filter((m) => m.score >= MIN_SEMANTIC_SCORE && bySlug.has(m.id))
        .map((m) => ({ ...bySlug.get(m.id)!, score: round(m.score), matchedBy: "semantic" as const }));
    } catch (err) {
      console.warn("runbooks: semantic search unavailable, falling back to keyword search", err);
      return [];
    }
  }

  /** Lazily seed D1 + Vectorize on first use, so a fresh deploy works without a manual step. */
  private async ensureSeeded() {
    if (this.seeded) return;
    if ((await this.repo.count()) === 0) {
      await seedRunbooks(this.repo, this.vectors, this.embedder);
    }
    this.seeded = true;
  }
}

/** Writes the bundled runbooks to D1 and (re)indexes them in Vectorize. Idempotent. */
export async function seedRunbooks(
  repo: RunbookRepository,
  vectors: VectorIndex | undefined,
  embedder: Embedder | undefined,
  runbooks: Runbook[] = RUNBOOKS
): Promise<{ stored: number; indexed: number }> {
  await repo.upsertMany(runbooks);
  if (!vectors || !embedder) return { stored: runbooks.length, indexed: 0 };
  try {
    const embeddings = await embedder.embed(runbooks.map(runbookEmbeddingText));
    await vectors.upsert(
      runbooks.map((r, i) => ({
        id: r.slug,
        values: embeddings[i],
        namespace: NAMESPACE.runbooks,
        metadata: { title: r.title }
      }))
    );
    return { stored: runbooks.length, indexed: runbooks.length };
  } catch (err) {
    console.warn("runbooks: could not index in Vectorize (keyword search still works)", err);
    return { stored: runbooks.length, indexed: 0 };
  }
}

function keywordSearch(query: string, catalog: Runbook[], limit: number): RunbookMatch[] {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (terms.length === 0) return [];
  return catalog
    .map((r) => {
      const title = `${r.title} ${r.tags.join(" ")}`.toLowerCase();
      const body = [...r.symptoms, ...r.possibleCauses].join(" ").toLowerCase();
      // Title/tag hits weigh more than body hits.
      const score = terms.reduce((s, t) => s + (title.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0), 0);
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ r, score }) => ({ ...r, score, matchedBy: "keyword" as const }));
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

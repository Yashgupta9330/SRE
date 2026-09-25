/**
 * Minimal interfaces over Workers AI embeddings and Vectorize.
 *
 * The real Vectorize binding (`env.VECTORIZE`) satisfies `VectorIndex`
 * structurally, so production code passes it straight in; tests pass an
 * in-memory fake.
 */

export interface Embedder {
  /** Returns one vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
}

export type VectorMetadata = Record<string, string | number | boolean>;

export interface VectorRecord {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: VectorMetadata;
}

export interface VectorMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorIndex {
  upsert(vectors: VectorRecord[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; namespace?: string; returnMetadata?: "all" | "indexed" | "none" }
  ): Promise<{ matches: VectorMatch[] }>;
}

/** Vectorize namespaces: one index, logically partitioned. */
export const NAMESPACE = {
  incidents: "incidents",
  runbooks: "runbooks"
} as const;

/**
 * Workers AI embedding model (bge-base-en-v1.5 → 768-dim vectors).
 * The Vectorize index must be created with the same dimensions (768, cosine).
 */
export class WorkersAiEmbedder implements Embedder {
  constructor(
    private readonly ai: Ai,
    private readonly model: string
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // `model` comes from a wrangler var, so it is a plain string at the type level.
    const out = (await this.ai.run(this.model as "@cf/baai/bge-base-en-v1.5", { text: texts })) as {
      data?: number[][];
    };
    if (!out?.data || out.data.length !== texts.length) {
      throw new Error("Embedding model returned an unexpected response");
    }
    return out.data;
  }
}

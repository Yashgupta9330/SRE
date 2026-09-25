import { describe, expect, it } from "vitest";
import { IncidentMemoryStore, type IncidentMemory } from "../worker/memory/incident-memory";
import { HashEmbedder, InMemoryIncidentRepo, InMemoryVectorIndex } from "./fakes";

const poolIncident: IncidentMemory = {
  service: "payment-service",
  problem: "high API latency",
  cause: "database connection pool exhaustion",
  resolution: "increase DB pool from 20 to 40",
  symptoms: ["p95 latency spike", "connection timeouts"],
  evidence: ["connection pool exhausted"]
};

const kafkaIncident: IncidentMemory = {
  service: "notification-service",
  problem: "delayed notifications",
  cause: "kafka consumer lag with too few consumers",
  resolution: "scale consumers to partition count",
  symptoms: ["consumer lag growing"],
  evidence: ["lag=184000"]
};

function setup(opts = {}) {
  const repo = new InMemoryIncidentRepo();
  const vectors = new InMemoryVectorIndex();
  const store = new IncidentMemoryStore(repo, vectors, new HashEmbedder(), { minScore: 0.3, ...opts });
  return { repo, vectors, store };
}

describe("IncidentMemoryStore", () => {
  it("stores structured data in D1 and the embedding in the incidents namespace", async () => {
    const { repo, vectors, store } = setup();
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    await store.index("mem-1", poolIncident);
    expect(repo.rows.get("mem-1")).toMatchObject({ service: "payment-service", occurrences: 1 });
    expect(vectors.records.get("incidents:mem-1")?.metadata).toEqual({ service: "payment-service" });
  });

  it("retrieves the most relevant incident, joining Vectorize ids to D1 rows", async () => {
    const { store } = setup();
    for (const [id, m] of [["mem-1", poolIncident], ["mem-2", kafkaIncident]] as const) {
      await store.insert(id, m, `inv-${id}`, "2026-09-20T00:00:00Z");
      await store.index(id, m);
    }
    const res = await store.search("API latency high, database connection pool", "payment-service");
    expect(res.source).toBe("vectorize");
    expect(res.incidents[0]).toMatchObject({ id: "mem-1", resolution: "increase DB pool from 20 to 40" });
    expect(res.incidents[0].score).toBeGreaterThan(0);
  });

  it("returns an empty result (not an error) when nothing is relevant", async () => {
    const { store } = setup({ minScore: 0.99 });
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    await store.index("mem-1", poolIncident);
    expect(await store.search("something unrelated", "order-service")).toEqual({ incidents: [], source: "vectorize" });
  });

  it("falls back to recent D1 incidents for the service when Vectorize is down", async () => {
    const { vectors, store } = setup();
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    vectors.failing = true;
    const res = await store.search("slow again", "payment-service");
    expect(res.source).toBe("d1-fallback");
    expect(res.incidents.map((i) => i.id)).toEqual(["mem-1"]);
    expect(res.warning).toContain("Vectorize unavailable");
  });

  it("degrades to no memory when both Vectorize and D1 fail", async () => {
    const { repo, vectors, store } = setup();
    vectors.failing = true;
    repo.failing = true;
    const res = await store.search("slow", "payment-service");
    expect(res).toMatchObject({ incidents: [], source: "none" });
  });

  it("detects a recurrence of the same incident", async () => {
    const { store } = setup();
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    await store.index("mem-1", poolIncident);
    expect(await store.findRecurrence({ ...poolIncident })).toBe("mem-1");
    expect(await store.findRecurrence(kafkaIncident)).toBeNull();
    await store.recordRecurrence("mem-1", "2026-09-26T00:00:00Z");
    const [row] = (await store.search("pool", "payment-service")).incidents;
    expect(row.occurrences).toBe(2);
  });

  it("insert is idempotent (safe under workflow step retries)", async () => {
    const { repo, store } = setup();
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    expect(repo.rows.size).toBe(1);
  });
});

describe("IncidentMemoryStore recurrence and eventual consistency", () => {
  it("ignores a matching vector whose D1 row was deleted", async () => {
    const { repo, store } = setup();
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    await store.index("mem-1", poolIncident);
    repo.rows.delete("mem-1"); // vector still in the index, row gone
    expect(await store.findRecurrence(poolIncident)).toBeNull();
  });
});

describe("IncidentMemoryStore cross-service relevance", () => {
  it("requires a higher score for memories from other services", async () => {
    const { store } = setup({ minScore: 0.3, crossServiceMinScore: 0.99 });
    await store.insert("mem-1", poolIncident, "inv-1", "2026-09-20T00:00:00Z");
    await store.index("mem-1", poolIncident);
    const query = "high API latency database connection pool exhaustion";
    expect((await store.search(query, "payment-service")).incidents).toHaveLength(1);
    expect((await store.search(query, "order-service")).incidents).toHaveLength(0);
  });
});

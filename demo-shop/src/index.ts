/**
 * demo-shop: a tiny product API used as the SRE agent's investigation target.
 *
 *   GET /products/:id              primary-key lookup (fast)
 *   GET /search?category=&q=       product search
 *   GET /health
 *
 * Two switches create real incidents:
 *   FEATURE_FULLTEXT_SEARCH=on  search matches `q` with LIKE '%q%', which
 *                               can't use an index → full table scan per call
 *   FAULT_ERROR_RATE=0.2        20% of requests throw (simulated failing
 *                               inventory backend) → Worker exceptions
 */

interface Env {
  DB: D1Database;
  FEATURE_FULLTEXT_SEARCH: string;
  FAULT_ERROR_RATE: string;
}

interface Result {
  body: unknown;
  status?: number;
  rowsRead: number;
}

async function getProduct(env: Env, id: number): Promise<Result> {
  const r = await env.DB.prepare("SELECT id, name, category, price FROM products WHERE id = ?").bind(id).all();
  const product = r.results[0];
  return { body: product ?? { error: "not found" }, status: product ? 200 : 404, rowsRead: r.meta.rows_read };
}

async function search(env: Env, category: string, q: string): Promise<Result> {
  const r =
    env.FEATURE_FULLTEXT_SEARCH === "on" && q
      ? await env.DB.prepare(
          "SELECT id, name, category, price FROM products WHERE lower(name) LIKE ? OR lower(category) LIKE ? ORDER BY price LIMIT 20"
        )
          .bind(`%${q.toLowerCase()}%`, `%${q.toLowerCase()}%`)
          .all()
      : await env.DB.prepare("SELECT id, name, category, price FROM products WHERE category = ? ORDER BY price LIMIT 20")
          .bind(category)
          .all();
  return { body: { count: r.results.length, results: r.results }, rowsRead: r.meta.rows_read };
}

/** Simulated dependency: fails a fraction of calls when fault injection is on. */
function checkInventoryBackend(env: Env) {
  const rate = Number(env.FAULT_ERROR_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    throw new Error("InventoryClient: upstream connect error (pool=inventory-v2): connection reset by peer");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const started = Date.now();
    const route = url.pathname.startsWith("/products/") ? "/products/:id" : url.pathname;

    if (route === "/health") return Response.json({ ok: true });

    let result: Result;
    try {
      if (route === "/products/:id") {
        checkInventoryBackend(env);
        result = await getProduct(env, Number(url.pathname.split("/")[2]));
      } else if (route === "/search") {
        checkInventoryBackend(env);
        result = await search(env, url.searchParams.get("category") ?? "shoes", url.searchParams.get("q") ?? "");
      } else {
        return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ level: "error", route, message, duration_ms: Date.now() - started }));
      // Re-throw: an uncaught exception is how a Worker failure shows up in
      // Cloudflare analytics (status "scriptThrewException").
      throw err;
    }

    const status = result.status ?? 200;
    // One structured log line per request (searchable in Workers Logs).
    console.log(JSON.stringify({ route, status, duration_ms: Date.now() - started, rows_read: result.rowsRead }));
    return Response.json(result.body, { status });
  }
} satisfies ExportedHandler<Env>;

/**
 * Minimal client for the Cloudflare API (GraphQL Analytics + REST).
 * Auth: an API token stored as the CF_API_TOKEN secret (never in code).
 */

const BASE = "https://api.cloudflare.com/client/v4";

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class CloudflareApi {
  constructor(
    readonly accountId: string,
    private readonly token: string | undefined,
    // Wrapped so `fetch` is never called with the wrong `this` (Workers throws "Illegal invocation").
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init)
  ) {}

  private headers() {
    if (!this.token) throw new Error("CF_API_TOKEN secret is not configured, so Cloudflare telemetry is unavailable");
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${BASE}/graphql`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query, variables: { accountTag: this.accountId, ...variables } })
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] | null };
    if (!res.ok || body.errors?.length) {
      throw new Error(`Cloudflare GraphQL error (${res.status}): ${body.errors?.map((e) => e.message).join("; ") ?? "no body"}`);
    }
    return body.data as T;
  }

  /** `path` is relative to /accounts/{accountId}. Returns the `result` field. */
  async rest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${BASE}/accounts/${this.accountId}${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined && { body: JSON.stringify(body) })
    });
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (!res.ok || json.success === false) {
      throw new Error(`Cloudflare API error (${res.status}) ${path}: ${json.errors?.map((e) => e.message).join("; ") ?? "no body"}`);
    }
    return json.result as T;
  }
}

/** GraphQL `Time` format: 2026-09-26T10:00:00Z */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function minutesAgo(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

export function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

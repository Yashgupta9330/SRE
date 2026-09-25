/**
 * Real logs from Workers Logs, via the Workers Observability telemetry query
 * API. Each query term is searched separately (the API's "needle" is a
 * single substring), then results are merged and ranked by matched terms.
 */
import type { LogEntry, LogLevel, LogProvider, LogSearchOptions } from "../types";
import { CloudflareApi } from "./api";
import { lookup, type ServiceCatalog } from "./catalog";

const WINDOW_MIN = 30;
const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "of", "for", "in", "on", "to", "with", "is", "are", "logs", "log"]);

interface TelemetryEvent {
  timestamp?: number | string;
  $metadata?: { level?: string; message?: string; error?: string; service?: string };
  source?: unknown;
  [key: string]: unknown;
}

function eventsOf(result: unknown): TelemetryEvent[] {
  const r = result as { events?: { events?: TelemetryEvent[] } | TelemetryEvent[] } | undefined;
  if (Array.isArray(r?.events)) return r.events;
  return r?.events?.events ?? [];
}

function level(raw: string | undefined): LogLevel {
  const l = (raw ?? "").toUpperCase();
  if (l.startsWith("ERR")) return "ERROR";
  if (l.startsWith("WARN")) return "WARN";
  if (l.startsWith("DEBUG")) return "DEBUG";
  return "INFO";
}

function messageOf(e: TelemetryEvent): string {
  const m = e.$metadata;
  const text = m?.message ?? m?.error ?? (typeof e.source === "string" ? e.source : JSON.stringify(e.source ?? {}));
  return String(text).slice(0, 500);
}

export class CloudflareLogProvider implements LogProvider {
  readonly name = "cloudflare-workers-logs";

  constructor(
    private readonly api: CloudflareApi,
    private readonly catalog: ServiceCatalog,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async query(script: string, needle: string | undefined, limit: number): Promise<TelemetryEvent[]> {
    const to = this.now().getTime();
    const result = await this.api.rest<unknown>("POST", "/workers/observability/telemetry/query", {
      queryId: "sre-agent-log-search",
      timeframe: { from: to - WINDOW_MIN * 60_000, to },
      view: "events",
      limit,
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: script }],
        ...(needle && { needle: { value: needle, matchCase: false } })
      }
    });
    return eventsOf(result);
  }

  async searchLogs(service: string, query: string, options: LogSearchOptions = {}): Promise<LogEntry[]> {
    const { script } = lookup(this.catalog, service);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9._-]+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
      .slice(0, 3);

    const batches = terms.length === 0 || query.trim() === "*"
      ? [await this.query(script, undefined, limit)]
      : await Promise.all(terms.map((t) => this.query(script, t, 30)));

    // Merge, de-duplicate, rank by how many query terms each line matches.
    const seen = new Map<string, { entry: LogEntry; score: number; ts: number }>();
    for (const events of batches) {
      for (const e of events) {
        const message = messageOf(e);
        const ts = typeof e.timestamp === "number" ? e.timestamp : Date.parse(String(e.timestamp ?? 0));
        const key = `${ts}|${message}`;
        if (seen.has(key)) continue;
        const lower = message.toLowerCase();
        seen.set(key, {
          entry: { timestamp: new Date(ts).toISOString().replace(/\.\d{3}Z$/, "Z"), level: level(e.$metadata?.level), service, message },
          score: terms.length ? terms.filter((t) => lower.includes(t)).length : 1,
          ts
        });
      }
    }
    return [...seen.values()]
      .sort((a, b) => b.score - a.score || b.ts - a.ts)
      .slice(0, limit)
      .map((x) => x.entry);
  }
}


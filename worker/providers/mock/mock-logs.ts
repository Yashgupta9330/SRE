import { ServiceNotFoundError, type LogEntry, type LogProvider, type LogSearchOptions } from "../types";
import { MOCK_SCENARIOS, type MockScenario } from "./scenarios";

const STOP_WORDS = new Set(["the", "a", "an", "and", "or", "of", "for", "in", "on", "to", "with", "is", "are", "logs", "log"]);

/** Tiny synonym table so the mock behaves a bit like a real full-text log search. */
const SYNONYMS: Record<string, string[]> = {
  db: ["database", "jdbc", "postgres", "query"],
  database: ["db", "jdbc", "postgres", "query"],
  timeout: ["timed", "timeout"],
  slow: ["slow", "latency", "exceeded"],
  latency: ["latency", "slow", "exceeded"],
  pool: ["pool", "hikaripool"],
  connection: ["connection", "connections"],
  error: ["error", "failed", "unavailable"],
  errors: ["error", "failed", "unavailable"],
  cpu: ["cpu", "throttling", "throttled"],
  kafka: ["consumer", "partitions", "rebalancing", "lag", "offsets"],
  lag: ["lag"],
  consumer: ["consumer", "rebalancing"],
  deploy: ["deploy", "rolled"],
  query: ["query", "scan"]
};

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
}

/**
 * Stand-in for Loki / Elasticsearch / CloudWatch Logs.
 * Scores each log line by how many query terms (plus synonyms) it contains.
 */
export class MockLogProvider implements LogProvider {
  readonly name = "mock-logs";

  constructor(
    private readonly scenarios: Record<string, MockScenario> = MOCK_SCENARIOS,
    private readonly now: () => Date = () => new Date()
  ) {}

  async searchLogs(service: string, query: string, options: LogSearchOptions = {}): Promise<LogEntry[]> {
    const scenario = this.scenarios[service];
    if (!scenario) throw new ServiceNotFoundError(service, Object.keys(this.scenarios));

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const terms = tokensOf(query).filter((t) => !STOP_WORDS.has(t));
    const nowMs = this.now().getTime();

    const scored = scenario.logs
      .map((line) => {
        const haystack = `${line.level} ${line.message}`.toLowerCase();
        const words = new Set(tokensOf(haystack));
        // Empty query / "*" returns recent lines; otherwise count matching terms.
        const score =
          terms.length === 0 || query.trim() === "*"
            ? 1
            : terms.filter((t) => [t, ...(SYNONYMS[t] ?? [])].some((s) => words.has(s) || haystack.includes(` ${s}`))).length;
        return { line, score };
      })
      .filter((x) => x.score > 0);

    return scored
      .sort((a, b) => a.line.offsetSeconds - b.line.offsetSeconds) // most recent first
      .slice(0, limit)
      .map(({ line }) => ({
        timestamp: new Date(nowMs - line.offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        level: line.level,
        service,
        message: line.message
      }));
  }
}

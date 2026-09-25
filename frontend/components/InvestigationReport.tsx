import type { InvestigationResult } from "../../shared/types";

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h4>{title}</h4>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function InvestigationReport({ result }: { result: InvestigationResult }) {
  if (result.kind === "conversation") return <p className="plain">{result.summary}</p>;

  return (
    <div className="report">
      <div className="report-header">
        <strong>Investigation complete</strong>
        {result.service && <span className="chip">{result.service}</span>}
        <span className={`chip confidence ${result.confidence}`}>confidence: {result.confidence}</span>
      </div>

      <p className="summary">{result.summary}</p>

      <section>
        <h4>Likely cause</h4>
        <p className="cause">{result.likelyCause}</p>
      </section>

      <List title="Evidence" items={result.evidence} />
      <List title="Previous incidents" items={result.previousIncidents} />

      {result.recommendation && (
        <section>
          <h4>Recommendation</h4>
          <p>{result.recommendation}</p>
        </section>
      )}

      <List title="Next steps" items={result.nextSteps} />
      <List title="Could not retrieve" items={result.unavailable} />

      <details className="meta">
        <summary>
          {result.toolsUsed.length} tool call(s) · memory: {result.memory.saved ? (result.memory.recurrence ? "recurrence recorded" : "saved") : "not saved"}
        </summary>
        <ul>
          {result.toolsUsed.map((t, i) => (
            <li key={i}>✓ {t}</li>
          ))}
        </ul>
        {result.memory.note && <p className="detail">{result.memory.note}</p>}
      </details>
    </div>
  );
}

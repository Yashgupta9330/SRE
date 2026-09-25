import type { ActiveInvestigation, ProgressStep } from "../../shared/types";

const ICON: Record<ProgressStep["status"], string> = { running: "◌", complete: "✓", error: "✗" };

/** Live activity feed, driven by workflow progress relayed through Agent state. */
export function InvestigationProgress({ investigation }: { investigation: ActiveInvestigation }) {
  return (
    <div className="bubble assistant progress" aria-live="polite">
      <div className="progress-title">
        <span className="spinner" /> Investigating{investigation.service ? ` ${investigation.service}` : ""}…
      </div>
      <ul className="steps">
        {investigation.steps.length === 0 && <li className="step running">◌ Starting workflow</li>}
        {investigation.steps.map((s) => (
          <li key={s.key} className={`step ${s.status}`}>
            <span className="icon">{ICON[s.status]}</span> {s.label}
            {s.detail && <span className="detail"> — {s.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

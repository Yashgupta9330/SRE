import type { ChatMessage } from "../../shared/types";
import { InvestigationReport } from "./InvestigationReport";

export function MessageBubble({ message }: { message: ChatMessage }) {
  const className = `bubble ${message.role}${message.error ? " error" : ""}`;
  return (
    <div className={className}>
      {message.result ? <InvestigationReport result={message.result} /> : <p className="plain">{message.content}</p>}
    </div>
  );
}

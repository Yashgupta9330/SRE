import { useState, type FormEvent, type KeyboardEvent } from "react";

export function Composer({ onSend, disabled, busy }: { onSend: (text: string) => void; disabled: boolean; busy: boolean }) {
  const [text, setText] = useState("");

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="e.g. API latency is high for payment-service. Investigate."
        rows={2}
        maxLength={2000}
        aria-label="Message"
      />
      <button type="submit" disabled={disabled || !text.trim()}>
        {busy ? "Investigating…" : "Send"}
      </button>
    </form>
  );
}

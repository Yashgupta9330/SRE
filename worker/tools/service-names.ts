/** "Payment Service", "payment_service", "payment" → "payment-service" when it is a known service. */
export function normalizeServiceName(raw: string, known: string[]): string {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (known.includes(s)) return s;
  const withSuffix = s.endsWith("-service") ? s : `${s}-service`;
  if (known.includes(withSuffix)) return withSuffix;
  return s;
}

/**
 * Find a known service mentioned in free text ("Payment API latency is high"
 * → payment-service). Deterministic: used to route the workflow and to scope
 * the memory search; the LLM still chooses tool arguments itself.
 */
export function detectService(text: string, known: string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const service of known) {
    // "demo-shop" also matches "demo shop" / "demo_shop"; "-service" is optional.
    const base = service.replace(/-service$/, "").split("-").join("[\\s_-]?");
    const pattern = new RegExp(`\\b${base}[\\s_-]*(service|svc|api|app)?\\b`);
    if (lower.includes(service) || pattern.test(lower)) return service;
  }
  return undefined;
}

/** A "<name>-service" mentioned in text, even if it is not in the catalog ("billing-service is down"). */
export function extractServiceMention(text: string): string | undefined {
  return text.toLowerCase().match(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+)*-service)\b/)?.[1];
}

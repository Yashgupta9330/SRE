import { ServiceNotFoundError } from "../types";

/**
 * Which Workers the agent may investigate, and their resources.
 * Configured in wrangler.jsonc (`SERVICE_CATALOG`), e.g.
 *   { "demo-shop": { "script": "demo-shop", "d1DatabaseId": "…" } }
 */
export interface CatalogEntry {
  /** Worker script name. */
  script: string;
  /** D1 database the Worker uses, for query insights and query plans. */
  d1DatabaseId?: string;
}

export type ServiceCatalog = Record<string, CatalogEntry>;

export function parseCatalog(raw: unknown): ServiceCatalog {
  const value = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw ?? {});
  const catalog: ServiceCatalog = {};
  for (const [name, entry] of Object.entries(value as Record<string, Partial<CatalogEntry>>)) {
    if (entry && typeof entry.script === "string") catalog[name] = { script: entry.script, d1DatabaseId: entry.d1DatabaseId };
  }
  return catalog;
}

export function lookup(catalog: ServiceCatalog, service: string): CatalogEntry {
  const entry = catalog[service];
  if (!entry) throw new ServiceNotFoundError(service, Object.keys(catalog));
  return entry;
}

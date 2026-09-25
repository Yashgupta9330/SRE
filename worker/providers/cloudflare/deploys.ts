/**
 * Real deploy history from the Workers Deployments + Versions API.
 * Config changes are derived by diffing each version's plain-text vars
 * against the previous deployment's (e.g. FEATURE_FULLTEXT_SEARCH: off → on).
 * The API does not expose code diffs.
 */
import type { DeployProvider, Deployment } from "../types";
import { CloudflareApi } from "./api";
import { lookup, type ServiceCatalog } from "./catalog";

interface ApiDeployment {
  id: string;
  created_on: string;
  source: string;
  author_email?: string;
  annotations?: Record<string, string>;
  versions: { version_id: string; percentage: number }[];
}

interface ApiVersion {
  id: string;
  number?: number;
  resources?: { bindings?: { type: string; name: string; text?: string }[] };
}

const MAX_DEPLOYS = 5;

export class CloudflareDeployProvider implements DeployProvider {
  readonly name = "cloudflare-workers-deployments";

  constructor(
    private readonly api: CloudflareApi,
    private readonly catalog: ServiceCatalog,
    private readonly now: () => Date = () => new Date()
  ) {}

  private async vars(script: string, versionId: string): Promise<{ number?: number; vars: Record<string, string> }> {
    const v = await this.api.rest<ApiVersion>("GET", `/workers/scripts/${script}/versions/${versionId}`);
    const vars: Record<string, string> = {};
    for (const b of v.resources?.bindings ?? []) if (b.type === "plain_text") vars[b.name] = b.text ?? "";
    return { number: v.number, vars };
  }

  async getRecentDeploys(service: string, hours: number): Promise<Deployment[]> {
    const { script } = lookup(this.catalog, service);
    const { deployments } = await this.api.rest<{ deployments: ApiDeployment[] }>("GET", `/workers/scripts/${script}/deployments`);
    const sorted = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
    const cutoff = this.now().getTime() - hours * 3600_000;
    const recent = sorted.filter((d) => Date.parse(d.created_on) >= cutoff).slice(0, MAX_DEPLOYS);
    // One older deployment too, so the oldest recent one has something to diff against.
    const withPrevious = sorted.slice(0, recent.length + 1);

    const primary = (d: ApiDeployment) => [...d.versions].sort((a, b) => b.percentage - a.percentage)[0]?.version_id;
    const details = await Promise.all(withPrevious.map((d) => this.vars(script, primary(d))));

    return recent.map((d, i) => {
      const cur = details[i];
      const prev = details[i + 1];
      const configChanges = prev
        ? [...new Set([...Object.keys(cur.vars), ...Object.keys(prev.vars)])]
            .filter((k) => cur.vars[k] !== prev.vars[k])
            .map((k) => `${k}: ${prev.vars[k] ?? "(unset)"} → ${cur.vars[k] ?? "(unset)"}`)
        : [];
      const versionId = primary(d);
      const split = d.versions.length > 1 ? ` (traffic split: ${d.versions.map((v) => `${v.version_id.slice(0, 8)}=${v.percentage}%`).join(", ")})` : "";
      return {
        service,
        version: `${cur.number !== undefined ? `#${cur.number} ` : ""}${versionId.slice(0, 8)}`,
        deployedAt: d.created_on,
        deployedBy: `${d.author_email ?? "unknown"} via ${d.source}`,
        summary: (d.annotations?.["workers/message"] ?? "(no deploy message)") + split,
        changes: [`triggered by: ${d.annotations?.["workers/triggered_by"] ?? "unknown"}`, "code diff not available from the Workers API"],
        configChanges
      };
    });
  }
}

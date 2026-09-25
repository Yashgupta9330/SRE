import type { ToolContext } from "../../tools/types";
import { CloudflareApi } from "./api";
import { parseCatalog } from "./catalog";
import { CloudflareDatabaseProvider } from "./database";
import { CloudflareDeployProvider } from "./deploys";
import { CloudflareDependencyProvider } from "./dependencies";
import { CloudflareLogProvider } from "./logs";
import { CloudflareMonitoringProvider } from "./monitoring";

export interface CloudflareProviderConfig {
  accountId: string;
  apiToken: string | undefined;
  serviceCatalog: unknown;
}

/** Real telemetry for the Workers listed in the service catalog. */
export function createCloudflareProviders(config: CloudflareProviderConfig): Omit<ToolContext, "runbooks"> {
  const api = new CloudflareApi(config.accountId, config.apiToken);
  const catalog = parseCatalog(config.serviceCatalog);
  return {
    monitoring: new CloudflareMonitoringProvider(api, catalog),
    logs: new CloudflareLogProvider(api, catalog),
    deploys: new CloudflareDeployProvider(api, catalog),
    dependencies: new CloudflareDependencyProvider(api, catalog),
    database: new CloudflareDatabaseProvider(api, catalog)
  };
}

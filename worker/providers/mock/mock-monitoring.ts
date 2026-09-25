import { ServiceNotFoundError, type MonitoringProvider, type ServiceMetrics } from "../types";
import { MOCK_SCENARIOS, type MockScenario } from "./scenarios";

/**
 * Stand-in for Prometheus / Grafana / CloudWatch. Returns the current metrics
 * from the mock scenarios. `now` is injectable so tests are deterministic.
 */
export class MockMonitoringProvider implements MonitoringProvider {
  readonly name = "mock-monitoring";

  constructor(
    private readonly scenarios: Record<string, MockScenario> = MOCK_SCENARIOS,
    private readonly now: () => Date = () => new Date()
  ) {}

  async listServices(): Promise<string[]> {
    return Object.keys(this.scenarios);
  }

  async getServiceMetrics(service: string): Promise<ServiceMetrics> {
    const scenario = this.scenarios[service];
    if (!scenario) throw new ServiceNotFoundError(service, Object.keys(this.scenarios));
    return {
      service,
      timestamp: this.now().toISOString(),
      window: "last 5m",
      ...scenario.metrics,
      extra: { ...scenario.metrics.extra }
    };
  }
}

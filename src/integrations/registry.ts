import type { IngestIntegration, IngestProviderId } from "./contract";

export class IntegrationRegistry {
  private readonly integrations = new Map<IngestProviderId, IngestIntegration>();

  register(integration: IngestIntegration): this {
    if (!/^[a-z][a-z0-9_]*$/.test(integration.id)) {
      throw new Error(`invalid integration identifier: ${integration.id}`);
    }
    if (this.integrations.has(integration.id)) {
      throw new Error(`duplicate integration registration: ${integration.id}`);
    }
    const expectedStatus = `life_os_${integration.id}_status`;
    const expectedIngest = `life_os_ingest_${integration.id}`;
    if (integration.capabilities.providerMutation !== false
      || integration.application.statusTool !== expectedStatus
      || integration.application.ingestTool !== expectedIngest
      || !/^[a-z][a-z0-9-]*$/.test(integration.application.cliCommand)) {
      throw new Error(`unsafe application registration: ${integration.id}`);
    }
    if ([...this.integrations.values()].some((item) =>
      item.application.cliCommand === integration.application.cliCommand
      || item.application.statusTool === integration.application.statusTool
      || item.application.ingestTool === integration.application.ingestTool)) {
      throw new Error(`duplicate application registration: ${integration.id}`);
    }
    this.integrations.set(integration.id, integration);
    return this;
  }

  get(id: IngestProviderId): IngestIntegration {
    const integration = this.integrations.get(id);
    if (!integration) throw new Error(`integration is not registered: ${id}`);
    return integration;
  }

  list(): IngestIntegration[] {
    return [...this.integrations.values()];
  }
}

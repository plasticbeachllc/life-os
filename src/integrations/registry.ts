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

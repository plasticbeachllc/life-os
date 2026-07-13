export type IngestProviderId = string;

export interface IntegrationCapabilities {
  readonly ingestion: true;
  readonly immutableVersions: true;
  readonly transientRefetch: boolean;
  readonly extraction: boolean;
  readonly providerMutation: false;
}

export interface IntegrationCounts {
  discovered: number;
  changed: number;
  unchanged: number;
  failed: number;
  unavailableContent: number;
}

export interface IntegrationStatus<Details = unknown> {
  provider: IngestProviderId;
  sourceId: string;
  enabled: boolean;
  capabilities: IntegrationCapabilities;
  details: Details;
}

export interface IntegrationIngestionResult<Details = unknown> {
  provider: IngestProviderId;
  sourceId: string;
  runId: string;
  counts: IntegrationCounts;
  modelCalls: 0;
  details: Details;
}

export interface IngestionLimit {
  default: number;
  maximum: number;
  description: string;
}

export interface IntegrationApplicationRegistration {
  readonly cliCommand: string;
  readonly statusTool: `life_os_${string}_status`;
  readonly ingestTool: `life_os_ingest_${string}`;
}

export interface IngestIntegration<StatusDetails = unknown, ReportDetails = unknown> {
  id: IngestProviderId;
  application: IntegrationApplicationRegistration;
  capabilities: IntegrationCapabilities;
  statusDescription: string;
  ingestDescription: string;
  limit?: IngestionLimit;
  status(): IntegrationStatus<StatusDetails> | Promise<IntegrationStatus<StatusDetails>>;
  ingest(input: { limit?: number }): Promise<IntegrationIngestionResult<ReportDetails>>;
}

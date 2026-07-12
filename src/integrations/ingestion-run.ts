export interface IngestionRunLifecycle<Report> {
  start(): void;
  execute(): Promise<Report>;
  complete(report: Report): void;
  fail(error: unknown): void;
}

/**
 * Runs a provider ingestion lifecycle and guarantees that a started run reaches
 * a terminal state. Provider stores retain ownership of their narrow SQL.
 */
export async function runIngestion<Report>(lifecycle: IngestionRunLifecycle<Report>): Promise<Report> {
  lifecycle.start();
  try {
    const report = await lifecycle.execute();
    lifecycle.complete(report);
    return report;
  } catch (error) {
    lifecycle.fail(error);
    throw error;
  }
}

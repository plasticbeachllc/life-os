export interface IngestionRunLifecycle<Report> {
  start(): void | Promise<void>;
  execute(): Promise<Report>;
  complete(report: Report): void | Promise<void>;
  fail(error: unknown): void | Promise<void>;
}

/**
 * Runs a provider ingestion lifecycle and guarantees that a started run reaches
 * a terminal state. Provider stores retain ownership of their narrow SQL.
 */
export async function runIngestion<Report>(lifecycle: IngestionRunLifecycle<Report>): Promise<Report> {
  await lifecycle.start();
  let report: Report;
  try {
    report = await lifecycle.execute();
  } catch (error) {
    // Terminal recording is best-effort. A storage failure must never replace
    // the provider/normalization error that caused ingestion to fail.
    try { await lifecycle.fail(error); } catch { /* preserve primary error */ }
    throw error;
  }
  // A completion-write error is itself the primary error. Do not call fail()
  // after complete() may have partially committed a terminal update.
  await lifecycle.complete(report);
  return report;
}

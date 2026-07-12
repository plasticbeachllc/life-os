export type Severity = "ok" | "info" | "warning" | "error";

export interface Finding {
  severity: Severity;
  message: string;
  path?: string;
  detail?: string;
}

export interface HealthReport {
  findings: Finding[];
  errorCount: number;
  warningCount: number;
  healthScore: number;
}

export function createHealthReport(findings: Finding[]): HealthReport {
  const errorCount = findings.filter((finding) => finding.severity === "error").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const healthScore = Math.max(0, 100 - errorCount * 12 - warningCount * 4);
  return { findings, errorCount, warningCount, healthScore };
}


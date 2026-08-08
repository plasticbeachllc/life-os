import { runLiveEvaluation } from "../src/evaluation/live-harness";

const options = parseArgs(process.argv.slice(2));
const result = await runLiveEvaluation(options);
console.log(JSON.stringify({
  runId: result.report.runId,
  mode: result.report.mode,
  status: result.report.utility.failed > 0 ? "partial" : "completed",
  score: result.report.utility.score,
  cases: result.report.utility.cases.length,
  failedCases: result.report.utility.failed,
  dimensions: result.report.utility.dimensions,
  issueCounts: result.report.utility.issueCounts,
  recommendations: result.report.utility.recommendations,
  comparison: result.report.comparison,
  reportPath: result.reportPath,
  databasePath: result.databasePath,
}, null, 2));

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  const allowed = new Set(["--gmail", "--imessage", "--cases", "--model", "--output", "--baseline", "--replay"]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown option: ${flag}`);
  return {
    gmail: integer(values.get("--gmail") ?? "5"),
    imessage: integer(values.get("--imessage") ?? "5"),
    cases: integer(values.get("--cases") ?? "8"),
    model: values.get("--model") ?? "gpt-5.6-sol",
    ...(values.get("--output") ? { outputRoot: values.get("--output")! } : {}),
    ...(values.get("--baseline") ? { baselinePath: values.get("--baseline")! } : {}),
    ...(values.get("--replay") ? { replayDatabasePath: values.get("--replay")! } : {}),
  };
}

function integer(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`expected an integer, received ${value}`);
  return Number(value);
}

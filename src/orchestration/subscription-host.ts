import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function runSubscriptionHost(input: { prompt: string; model: string; cwd: string; outputSchema: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const codex = Bun.which("codex");
  if (!codex) throw new Error("Codex CLI is not installed");
  const directory = mkdtempSync(join(tmpdir(), "life-os-subscription-"));
  const outputPath = join(directory, "result.json");
  const schemaPath = join(directory, "schema.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(input.outputSchema), "utf8");
    const process = Bun.spawn([codex, "exec", "--ephemeral", "--ignore-user-config", "-s", "read-only",
      "-C", input.cwd, "-m", input.model, "--output-schema", schemaPath, "-o", outputPath,
      "-c", "features.shell_tool=false", "-c", "features.multi_agent=false", "-c", "tools.web_search=false", "-"], {
      stdin: "pipe", stdout: "ignore", stderr: "ignore",
    });
    process.stdin.write(input.prompt); process.stdin.end();
    if (await process.exited !== 0) throw new Error("subscription host did not complete");
    const text = await Bun.file(outputPath).text();
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("subscription host returned invalid structured output");
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("subscription host did not return valid structured output");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

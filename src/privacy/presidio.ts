import { resolve } from "node:path";

export interface RedactedText {
  text: string;
  findings: Array<{ entityType: string; score: number }>;
}

export async function redactSensitiveTexts(texts: string[]): Promise<RedactedText[]> {
  const root = resolve(import.meta.dir, "../..");
  const process = Bun.spawn([
    "uv", "run", "--project", root, "python", resolve(root, "python/redact_sensitive.py"),
  ], {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: privacyEnvironment(),
  });
  process.stdin.write(JSON.stringify({ texts }));
  process.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Presidio redaction failed${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`);
  }
  const response = JSON.parse(stdout) as { results?: RedactedText[] };
  if (!Array.isArray(response.results) || response.results.length !== texts.length
    || response.results.some((result) => typeof result.text !== "string" || !Array.isArray(result.findings))) {
    throw new Error("Presidio returned an invalid redaction response");
  }
  return response.results;
}

function privacyEnvironment(): Record<string, string> {
  const allowed = ["HOME", "PATH", "TMPDIR", "UV_CACHE_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  return Object.fromEntries(allowed.flatMap((key) => Bun.env[key] ? [[key, Bun.env[key]!]] : []));
}

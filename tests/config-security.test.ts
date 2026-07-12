import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const configModule = pathToFileURL(resolve(import.meta.dir, "../src/config.ts")).href;

test("secure external environment file loads Gmail client credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "life-os-env-workspace-"));
  const credentialsDirectory = mkdtempSync(join(tmpdir(), "life-os-env-credentials-"));
  const envFile = join(credentialsDirectory, ".env");
  writeFileSync(envFile, "GMAIL_CLIENT_ID=test-id\nGMAIL_CLIENT_SECRET=test-secret\n", { mode: 0o600 });
  const result = runConfig(directory, envFile, `
    import { loadGmailClientConfig } from ${JSON.stringify(configModule)};
    const value = loadGmailClientConfig();
    console.log(value.clientId === "test-id" && value.clientSecret === "test-secret" ? "loaded" : "wrong");
  `);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("loaded");
  expect(result.stdout).not.toContain("test-secret");
});

test("external environment file with group or world permissions is rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "life-os-env-insecure-"));
  const envFile = join(directory, "credentials.env");
  writeFileSync(envFile, "GMAIL_CLIENT_ID=test-id\nGMAIL_CLIENT_SECRET=test-secret\n");
  chmodSync(envFile, 0o644);
  const result = runConfig(directory, envFile, `
    import { loadGmailClientConfig } from ${JSON.stringify(configModule)};
    loadGmailClientConfig();
  `);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("mode 600");
  expect(result.stderr).not.toContain("test-secret");
});

test("workspace-local Gmail credentials are rejected", () => {
  const directory = mkdtempSync(join(tmpdir(), "life-os-workspace-env-"));
  writeFileSync(join(directory, ".env"), "GMAIL_CLIENT_SECRET=workspace-secret\n", { mode: 0o600 });
  const result = runConfig(directory, join(directory, "missing.env"), `
    import { ensureExternalEnvironment } from ${JSON.stringify(configModule)};
    ensureExternalEnvironment();
  `);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("must not be stored in workspace");
  expect(result.stderr).not.toContain("workspace-secret");
});

function runConfig(cwd: string, envFile: string, source: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "-e", source], {
    cwd,
    env: { ...process.env, LIFE_OS_ENV_FILE: envFile },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

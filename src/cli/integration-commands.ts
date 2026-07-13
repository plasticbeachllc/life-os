import type { IntegrationRegistry } from "../integrations/registry";

export async function runRegisteredIntegrationCommand(input: {
  command: string | undefined; rest: string[]; registry: IntegrationRegistry;
  write?: (value: string) => void;
}): Promise<number | undefined> {
  const integration = input.registry.list().find((item) =>
    item.application.cliCommand === input.command);
  if (!integration) return undefined;
  const [subcommand, ...rest] = input.rest;
  if (!new Set(["status", "ingest"]).has(subcommand ?? "")) return undefined;
  const flags = parseFlags(rest);
  rejectUnknownFlags(flags, integration.limit ? ["vault", "limit"] : ["vault"]);
  if (subcommand === "status") {
    (input.write ?? console.log)(JSON.stringify(await integration.status({
      ...(flags.vault ? { vaultPath: flags.vault } : {}),
    }), null, 2));
    return 0;
  }
  const result = await integration.ingest({
    ...(integration.limit ? { limit: parseLimit(flags.limit, integration.limit) } : {}),
    ...(flags.vault ? { vaultPath: flags.vault } : {}),
  });
  (input.write ?? console.log)(JSON.stringify(result, null, 2));
  return result.counts.failed > 0 ? 1 : 0;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected integration argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    flags[flag.slice(2)] = value;
    index += 1;
  }
  return flags;
}

function rejectUnknownFlags(flags: Record<string, string>, allowed: string[]): void {
  const unknown = Object.keys(flags).find((flag) => !allowed.includes(flag));
  if (unknown) throw new Error(`unsupported integration flag: --${unknown}`);
}

function parseLimit(value: string | undefined, limit: { default: number; maximum: number }): number {
  const parsed = Number(value ?? limit.default);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > limit.maximum) {
    throw new Error(`--limit must be an integer between 1 and ${limit.maximum}`);
  }
  return parsed;
}

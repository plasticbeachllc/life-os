import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

export interface Config {
  vaultPath: string;
  databasePath: string;
  backupPath: string;
  timezone: string;
  defaultMode: string;
  gmailEnabled: boolean;
  gmailAccountId: string;
  imessageEnabled: boolean;
  imessageSourceId: string;
  imessageDatabasePath: string;
  imessageSelectionMode: "allowlist" | "all_except";
  imessageConversationIds: string[];
  envFilePath: string;
}

let externalEnvironmentLoaded = false;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

export function loadConfig(options: { vaultPath?: string } = {}): Config {
  const envFilePath = ensureExternalEnvironment();
  const configuredVault = options.vaultPath ?? Bun.env.LIFE_OS_VAULT_PATH;
  if (!configuredVault) {
    throw new Error("vault path is required; pass --vault or set LIFE_OS_VAULT_PATH");
  }

  const dataHome = expandHome(Bun.env.XDG_DATA_HOME ?? "~/.local/share");
  const defaultDataDir = resolve(dataHome, "life-os");

  return {
    vaultPath: resolve(expandHome(configuredVault)),
    databasePath: resolve(
      expandHome(Bun.env.LIFE_OS_DATABASE_PATH ?? `${defaultDataDir}/life-os.db`),
    ),
    backupPath: resolve(
      expandHome(Bun.env.LIFE_OS_BACKUP_PATH ?? `${defaultDataDir}/backups`),
    ),
    timezone: Bun.env.LIFE_OS_TIMEZONE ?? "America/New_York",
    defaultMode: Bun.env.LIFE_OS_DEFAULT_MODE ?? "dry-run",
    gmailEnabled: Bun.env.LIFE_OS_GMAIL_ENABLED === "true",
    gmailAccountId: Bun.env.LIFE_OS_GMAIL_ACCOUNT_ID ?? "me",
    imessageEnabled: Bun.env.LIFE_OS_IMESSAGE_ENABLED === "true",
    imessageSourceId: "local-messages",
    imessageDatabasePath: resolve(homedir(), "Library/Messages/chat.db"),
    imessageSelectionMode: parseIMessageSelectionMode(Bun.env.LIFE_OS_IMESSAGE_SELECTION_MODE),
    imessageConversationIds: parseIMessageConversationIds(
      Bun.env.LIFE_OS_IMESSAGE_SELECTION_MODE === "all_except"
        ? Bun.env.LIFE_OS_IMESSAGE_BLACKLIST_CONVERSATION_IDS ?? ""
        : Bun.env.LIFE_OS_IMESSAGE_CONVERSATION_IDS ?? "",
    ),
    envFilePath,
  };
}

function parseIMessageSelectionMode(value: string | undefined): "allowlist" | "all_except" {
  const mode = value ?? "allowlist";
  if (mode !== "allowlist" && mode !== "all_except") {
    throw new Error("LIFE_OS_IMESSAGE_SELECTION_MODE must be allowlist or all_except");
  }
  return mode;
}

function parseIMessageConversationIds(value: string): string[] {
  const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 100) throw new Error("at most 100 iMessage conversations may be allowlisted");
  if (ids.some((id) => id.length > 512 || /[\u0000-\u001f]/.test(id))) {
    throw new Error("invalid iMessage conversation identifier in allowlist");
  }
  return ids;
}

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function loadGmailClientConfig(): Omit<GmailAuthConfig, "refreshToken"> {
  ensureExternalEnvironment();
  const clientId = Bun.env.GMAIL_CLIENT_ID;
  const clientSecret = Bun.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Gmail OAuth requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET");
  }
  if (clientId.startsWith("op://") || clientSecret.startsWith("op://")) {
    throw new Error("unresolved 1Password references; run Life OS through `op run --env-file ~/.config/life-os/.env -- ...`");
  }
  return { clientId, clientSecret };
}

export function loadGmailAuthConfig(refreshToken: string): GmailAuthConfig {
  return { ...loadGmailClientConfig(), refreshToken };
}

export function ensureExternalEnvironment(): string {
  const envFilePath = resolve(expandHome(Bun.env.LIFE_OS_ENV_FILE ?? "~/.config/life-os/.env"));
  if (externalEnvironmentLoaded) return envFilePath;
  rejectWorkspaceGmailSecrets();
  if (existsSync(envFilePath)) {
    const stats = lstatSync(envFilePath);
    if (stats.isSymbolicLink()) throw new Error(`Life OS environment file must not be a symlink: ${envFilePath}`);
    if (!stats.isFile()) throw new Error(`Life OS environment path is not a regular file: ${envFilePath}`);
    if ((stats.mode & 0o077) !== 0) throw new Error(`Life OS environment file must use mode 600: ${envFilePath}`);
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) throw new Error(`Life OS environment file must be owned by the current user: ${envFilePath}`);
    const result = loadDotenv({ path: envFilePath, override: false, quiet: true });
    if (result.error) throw new Error(`failed to load Life OS environment file: ${envFilePath}`);
  }
  externalEnvironmentLoaded = true;
  return envFilePath;
}

function rejectWorkspaceGmailSecrets(): void {
  const sensitive = /^\s*(GMAIL_CLIENT_ID|GMAIL_CLIENT_SECRET|GMAIL_REFRESH_TOKEN)\s*=/m;
  for (const name of [".env", ".env.local", ".env.development", ".env.production", ".env.test"]) {
    const path = resolve(process.cwd(), name);
    if (existsSync(path) && sensitive.test(readFileSync(path, "utf8"))) {
      throw new Error(`Gmail credentials must not be stored in workspace environment file: ${path}`);
    }
  }
}

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
  calendarEnabled: boolean;
  telegramEnabled: boolean;
  telegramSourceId: string;
  telegramChatIds: string[];
  telegramDatabaseDirectory: string;
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
    calendarEnabled: Bun.env.LIFE_OS_CALENDAR_ENABLED === "true",
    telegramEnabled: Bun.env.LIFE_OS_TELEGRAM_ENABLED === "true",
    telegramSourceId: Bun.env.LIFE_OS_TELEGRAM_SOURCE_ID ?? "primary",
    telegramChatIds: parseTelegramChatIds(Bun.env.LIFE_OS_TELEGRAM_CHAT_IDS ?? ""),
    telegramDatabaseDirectory: resolve(expandHome(
      Bun.env.LIFE_OS_TELEGRAM_DATABASE_PATH ?? `${defaultDataDir}/tdlib`,
    )),
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

export interface TelegramTdLibConfig {
  apiId: number; apiHash: string; databaseEncryptionKey: string; libraryPath?: string;
}

export function loadTelegramTdLibConfig(): TelegramTdLibConfig {
  ensureExternalEnvironment();
  const apiId = Number(Bun.env.TELEGRAM_API_ID);
  const apiHash = Bun.env.TELEGRAM_API_HASH;
  const databaseEncryptionKey = Bun.env.TELEGRAM_DATABASE_ENCRYPTION_KEY;
  if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash || !databaseEncryptionKey) {
    throw new Error("TDLib requires TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_DATABASE_ENCRYPTION_KEY");
  }
  for (const value of [apiHash, databaseEncryptionKey]) {
    if (value.startsWith("op://")) throw new Error("unresolved 1Password reference; run Life OS through op run");
  }
  const libraryPath = Bun.env.LIFE_OS_TDLIB_LIBRARY_PATH;
  return { apiId, apiHash, databaseEncryptionKey,
    ...(libraryPath ? { libraryPath: validateNativeLibraryPath(libraryPath) } : {}) };
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
  rejectWorkspaceProviderSecrets();
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

function rejectWorkspaceProviderSecrets(): void {
  const sensitive = /^\s*(GMAIL_CLIENT_ID|GMAIL_CLIENT_SECRET|GMAIL_REFRESH_TOKEN|TELEGRAM_API_ID|TELEGRAM_API_HASH|TELEGRAM_DATABASE_ENCRYPTION_KEY)\s*=/m;
  for (const name of [".env", ".env.local", ".env.development", ".env.production", ".env.test"]) {
    const path = resolve(process.cwd(), name);
    if (existsSync(path) && sensitive.test(readFileSync(path, "utf8"))) {
      throw new Error(`Provider credentials must not be stored in workspace environment file: ${path}`);
    }
  }
}

function parseTelegramChatIds(value: string): string[] {
  const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 100 || ids.some((id) => !/^-?[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("LIFE_OS_TELEGRAM_CHAT_IDS must be at most 100 comma-separated TDLib chat identifiers");
  }
  return ids;
}

function validateNativeLibraryPath(value: string): string {
  const path = resolve(expandHome(value));
  if (!existsSync(path)) throw new Error(`TDLib library does not exist: ${path}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`TDLib library must not be a symbolic link: ${path}`);
  if (!stats.isFile()) throw new Error(`TDLib library path must be a regular file: ${path}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) {
    throw new Error(`TDLib library must be owned by the current user or root: ${path}`);
  }
  return path;
}

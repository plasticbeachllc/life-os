import { dlopen, FFIType, suffix } from "bun:ffi";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import type { TdLibJsonClient } from "../adapters/telegram";

export interface TdJsonClientConfig {
  apiId: number;
  apiHash: string;
  databaseDirectory: string;
  databaseEncryptionKey: string;
  libraryPath?: string;
}

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: Error): void };

/**
 * Thin owner of TDLib's ordered JSON stream. It deliberately exposes no generic
 * request surface outside the provider adapter.
 */
export class NativeTdJsonClient implements TdLibJsonClient {
  private readonly library;
  private readonly clientId: number;
  private readonly pending = new Map<string, Pending>();
  private authorization = "authorizationStateUnknown";
  private sequence = 0;
  private pumping = false;

  constructor(private readonly config: TdJsonClientConfig) {
    if (existsSync(config.databaseDirectory) && lstatSync(config.databaseDirectory).isSymbolicLink()) {
      throw new Error("TDLib database directory must not be a symbolic link");
    }
    mkdirSync(config.databaseDirectory, { recursive: true, mode: 0o700 });
    const libraryPath = config.libraryPath ?? `libtdjson.${suffix}`;
    this.library = dlopen(libraryPath, {
      td_create_client_id: { args: [], returns: FFIType.i32 },
      td_send: { args: [FFIType.i32, FFIType.buffer], returns: FFIType.void },
      td_receive: { args: [FFIType.f64], returns: FFIType.cstring },
    });
    this.clientId = this.library.symbols.td_create_client_id();
    this.startPump();
  }

  async authorizationState(): Promise<string> {
    if (this.authorization === "authorizationStateUnknown") {
      await this.request({ "@type": "getAuthorizationState" }).catch(() => undefined);
    }
    return this.authorization;
  }

  request<T extends Record<string, unknown>>(request: Record<string, unknown>): Promise<T> {
    const extra = `life-os-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(extra);
        reject(new Error(`TDLib request timed out: ${String(request["@type"] ?? "unknown")}`));
      }, 30_000);
      this.pending.set(extra, {
        resolve: (value) => { clearTimeout(timeout); resolve(value as T); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.send({ ...request, "@extra": extra });
    });
  }

  close(): void {
    this.pumping = false;
    this.send({ "@type": "close" });
    this.library.close();
  }

  private startPump(): void {
    this.pumping = true;
    const pump = () => {
      if (!this.pumping) return;
      try {
        const raw = this.library.symbols.td_receive(0.01);
        if (raw) this.handle(JSON.parse(String(raw)) as Record<string, unknown>);
      } finally {
        if (this.pumping) setTimeout(pump, 5);
      }
    };
    pump();
  }

  private handle(value: Record<string, unknown>): void {
    if (typeof value["@type"] === "string" && String(value["@type"]).startsWith("authorizationState")) {
      this.authorization = String(value["@type"]);
    }
    if (value["@type"] === "updateAuthorizationState") {
      const state = value.authorization_state as Record<string, unknown> | undefined;
      this.authorization = String(state?.["@type"] ?? "authorizationStateUnknown");
      if (this.authorization === "authorizationStateWaitTdlibParameters") {
        void this.request({
          "@type": "setTdlibParameters", use_test_dc: false,
          database_directory: this.config.databaseDirectory, files_directory: "",
          database_encryption_key: this.config.databaseEncryptionKey,
          use_file_database: false, use_chat_info_database: true, use_message_database: true,
          use_secret_chats: false, api_id: this.config.apiId, api_hash: this.config.apiHash,
          system_language_code: "en-US", device_model: "Life OS",
          system_version: process.platform, application_version: "0.1.0",
        }).catch(() => undefined);
      } else if (this.authorization === "authorizationStateWaitEncryptionKey") {
        void this.request({ "@type": "checkDatabaseEncryptionKey",
          encryption_key: this.config.databaseEncryptionKey }).catch(() => undefined);
      }
    }
    const extra = typeof value["@extra"] === "string" ? value["@extra"] : undefined;
    if (!extra) return;
    const pending = this.pending.get(extra);
    if (!pending) return;
    this.pending.delete(extra);
    if (value["@type"] === "error") {
      pending.reject(new Error(`TDLib error ${String(value.code ?? "")}: ${String(value.message ?? "unknown")}`));
    } else pending.resolve(value);
  }

  private send(request: Record<string, unknown>): void {
    const encoded = Buffer.from(`${JSON.stringify(request)}\0`, "utf8");
    this.library.symbols.td_send(this.clientId, encoded);
  }
}

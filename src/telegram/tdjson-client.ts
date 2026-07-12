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

type Pending = {
  requestType: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
};

export interface TdJsonNativeLibrary {
  symbols: {
    td_create_client_id(): number;
    td_send(clientId: number, request: Uint8Array): void;
    td_receive(timeout: number): string | null;
  };
  close(): void;
}

/**
 * Thin owner of TDLib's ordered JSON stream. It deliberately exposes no generic
 * request surface outside the provider adapter.
 */
export class NativeTdJsonClient implements TdLibJsonClient {
  private readonly library: TdJsonNativeLibrary;
  private readonly clientId: number;
  private readonly pending = new Map<string, Pending>();
  private authorization = "authorizationStateUnknown";
  private sequence = 0;
  private pumping = false;
  private closed = false;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly config: TdJsonClientConfig, nativeLibrary?: TdJsonNativeLibrary) {
    if (existsSync(config.databaseDirectory) && lstatSync(config.databaseDirectory).isSymbolicLink()) {
      throw new Error("TDLib database directory must not be a symbolic link");
    }
    mkdirSync(config.databaseDirectory, { recursive: true, mode: 0o700 });
    const libraryPath = config.libraryPath ?? `libtdjson.${suffix}`;
    this.library = nativeLibrary ?? dlopen(libraryPath, {
      td_create_client_id: { args: [], returns: FFIType.i32 },
      td_send: { args: [FFIType.i32, FFIType.buffer], returns: FFIType.void },
      td_receive: { args: [FFIType.f64], returns: FFIType.cstring },
    }) as unknown as TdJsonNativeLibrary;
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
    if (this.closed) return Promise.reject(new Error("TDLib client is closed"));
    const extra = `life-os-${++this.sequence}`;
    const requestType = String(request["@type"] ?? "unknown");
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(extra);
        reject(new Error(`TDLib request timed out: ${requestType}`));
      }, 30_000);
      this.pending.set(extra, {
        requestType, timeout,
        resolve: (value) => { clearTimeout(timeout); resolve(value as T); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      this.send({ ...request, "@extra": extra });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pumping = false;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("TDLib client closed before request completed"));
    }
    this.pending.clear();
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
      } catch {
        // Native receive/JSON failures are contained; requests retain their
        // bounded timeout and shutdown will reject them deterministically.
      } finally {
        if (this.pumping) this.pumpTimer = setTimeout(pump, 5);
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
      pending.reject(sanitizedTdLibError(value.code, pending.requestType));
    } else pending.resolve(value);
  }

  private send(request: Record<string, unknown>): void {
    const encoded = Buffer.from(`${JSON.stringify(request)}\0`, "utf8");
    this.library.symbols.td_send(this.clientId, encoded);
  }
}

function sanitizedTdLibError(code: unknown, requestType: string): Error {
  const numericCode = typeof code === "number" ? code : Number(code);
  const classification = numericCode === 400 ? "invalid_request"
    : numericCode === 401 ? "authorization_required"
      : numericCode === 404 ? "not_found"
        : numericCode === 429 ? "rate_limited"
          : numericCode >= 500 ? "provider_unavailable" : "provider_error";
  return new Error(`TDLib ${requestType} failed: ${classification}`);
}

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTdJsonClient, type TdJsonNativeLibrary } from "../src/telegram/tdjson-client";

function config() {
  return { apiId: 1, apiHash: "secret", databaseEncryptionKey: "key",
    databaseDirectory: mkdtempSync(join(tmpdir(), "life-os-tdjson-")) };
}

test("TDLib shutdown rejects pending work, clears timers, and stops native receives", async () => {
  let receives = 0; let libraryClosed = false;
  const native: TdJsonNativeLibrary = { symbols: {
    td_create_client_id: () => 1,
    td_send: () => {},
    td_receive: () => { receives += 1; return null; },
  }, close: () => { libraryClosed = true; } };
  const settings = config();
  const client = new NativeTdJsonClient(settings, native);
  const pending = client.request({ "@type": "getChatHistory" });
  client.close();
  await expect(pending).rejects.toThrow("closed before request completed");
  const receiveCountAtClose = receives;
  await Bun.sleep(20);
  expect(receives).toBe(receiveCountAtClose);
  expect(libraryClosed).toBeTrue();
  rmSync(settings.databaseDirectory, { recursive: true, force: true });
});

test("TDLib errors discard raw provider messages and retain a safe classification", async () => {
  const sent: Record<string, unknown>[] = [];
  const queue: string[] = [];
  const native: TdJsonNativeLibrary = { symbols: {
    td_create_client_id: () => 1,
    td_send: (_clientId, request) => {
      const value = JSON.parse(new TextDecoder().decode(request).replace(/\0$/, "")) as Record<string, unknown>;
      sent.push(value);
      queue.push(JSON.stringify({ "@type": "error", code: 401,
        message: "database at /Users/private/tdlib rejected secret", "@extra": value["@extra"] }));
    },
    td_receive: () => queue.shift() ?? null,
  }, close: () => {} };
  const settings = config();
  const client = new NativeTdJsonClient(settings, native);
  const request = client.request({ "@type": "getChatHistory" });
  await expect(request).rejects.toThrow("TDLib getChatHistory failed: authorization_required");
  await expect(request).rejects.not.toThrow("/Users/private");
  client.close();
  expect(sent.length).toBeGreaterThan(0);
  rmSync(settings.databaseDirectory, { recursive: true, force: true });
});

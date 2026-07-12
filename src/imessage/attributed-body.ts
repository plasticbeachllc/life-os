export interface AttributedBodyDecoder {
  decode(bodies: Uint8Array[]): Promise<Array<string | null>>;
}

const maxBodyBytes = 1_000_000;
const maxBatchBytes = 8_000_000;
const maxDecodedCharacters = 200_000;

const decoderScript = String.raw`
ObjC.import("Foundation");
const stdin = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const input = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(stdin, $.NSUTF8StringEncoding).js));
const output = input.map((encoded) => {
  try {
    const data = $.NSData.alloc.initWithBase64EncodedStringOptions(encoded, 0);
    const value = $.NSUnarchiver.unarchiveObjectWithData(data);
    if (!value || !value.string) return null;
    return ObjC.unwrap(value.string);
  } catch (_) {
    return null;
  }
});
JSON.stringify(output);
`;

export class MacOsAttributedBodyDecoder implements AttributedBodyDecoder {
  async decode(bodies: Uint8Array[]): Promise<Array<string | null>> {
    if (bodies.length === 0) return [];
    const totalBytes = bodies.reduce((total, body) => total + body.byteLength, 0);
    if (bodies.some((body) => body.byteLength > maxBodyBytes) || totalBytes > maxBatchBytes) {
      throw new Error("Messages attributed-body decode batch exceeds safety bounds");
    }
    const input = JSON.stringify(bodies.map((body) => Buffer.from(body).toString("base64")));
    const process = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", decoderScript], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    process.stdin.write(input);
    process.stdin.end();
    const timeout = setTimeout(() => process.kill(), 10_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`Messages attributed-body decoder failed${stderr.trim() ? ` (${stderr.trim().split("\n").at(-1)})` : ""}`);
      }
      const parsed = JSON.parse(stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== bodies.length
        || parsed.some((value) => value !== null && typeof value !== "string")) {
        throw new Error("Messages attributed-body decoder returned an invalid result");
      }
      return parsed.map((value) => {
        if (typeof value !== "string") return null;
        if (value.length > maxDecodedCharacters) throw new Error("decoded Messages text exceeds safety bounds");
        return value;
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

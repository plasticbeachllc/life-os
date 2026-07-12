import { createHash } from "node:crypto";

export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function sha256Value(value: unknown): string {
  return sha256Text(stableJson(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return `sha256:${createHash("sha256").update(Buffer.from(bytes)).digest("hex")}`;
}

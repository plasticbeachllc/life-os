export interface FrontmatterParseResult {
  metadata: Record<string, unknown>;
  body: string;
  errors: string[];
}

export function parseFrontmatter(markdown: string): FrontmatterParseResult {
  if (!markdown.startsWith("---\n")) {
    return { metadata: {}, body: markdown, errors: [] };
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    return {
      metadata: {},
      body: markdown,
      errors: ["frontmatter start marker has no closing marker"],
    };
  }

  const raw = markdown.slice(4, end);
  const body = markdown.slice(end + "\n---".length).replace(/^\n/, "");
  const metadata: Record<string, unknown> = {};
  const errors: string[] = [];

  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const separator = line.indexOf(":");
    const lineNumber = index + 2;
    if (separator === -1) {
      errors.push(`line ${lineNumber}: expected key: value`);
      return;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      errors.push(`line ${lineNumber}: empty key`);
      return;
    }
    metadata[key] = parseScalar(value);
  });

  return { metadata, body, errors };
}

function parseScalar(value: string): unknown {
  if (value === "") return null;
  if (value === "[]") return [];
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}


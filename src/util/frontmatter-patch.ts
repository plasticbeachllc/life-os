import { parseDocument } from "yaml";

export interface FrontmatterPatch {
  additions: Record<string, string>;
}

export function applyFrontmatterPatch(markdown: string, patch: FrontmatterPatch): string {
  const parsed = splitFrontmatter(markdown);
  const document = parseDocument(parsed.yaml);
  if (document.errors.length > 0) throw new Error(`invalid YAML frontmatter: ${document.errors[0]!.message}`);
  const existing = document.toJS() as Record<string, unknown> | null;
  if (existing !== null && (typeof existing !== "object" || Array.isArray(existing))) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  const missing = Object.entries(patch.additions).filter(([key]) => !(key in (existing ?? {})));
  if (missing.length === 0) return markdown;
  const separator = parsed.yaml.length > 0 && !parsed.yaml.endsWith("\n") ? "\n" : "";
  const inserted = missing.map(([key, value]) => `${key}: ${yamlScalar(value)}`).join("\n");
  const next = `---\n${parsed.yaml}${separator}${inserted}\n---${parsed.body}`;
  const validation = parseDocument(splitFrontmatter(next).yaml);
  if (validation.errors.length > 0) throw new Error(`patched frontmatter is invalid: ${validation.errors[0]!.message}`);
  return next;
}

export function frontmatterPatchPreview(patch: FrontmatterPatch): string {
  return Object.entries(patch.additions).map(([key, value]) => `+${key}: ${yamlScalar(value)}`).join("\n");
}

function splitFrontmatter(markdown: string): { yaml: string; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match) throw new Error("note must have valid frontmatter delimiters");
  return { yaml: match[1] ?? "", body: markdown.slice(match[0].length) };
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
}

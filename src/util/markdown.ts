const headingPattern = /^(#{1,6})\s+(.+?)\s*$/gm;
const wikiLinkPattern = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const fencedCodePattern = /^```[\s\S]*?^```/gm;

export function stripFencedCode(markdown: string): string {
  return markdown.replace(fencedCodePattern, (block) => block.replace(/[^\r\n]/g, " "));
}

export function sectionBody(markdown: string, heading: string): string | undefined {
  const target = heading.toLocaleLowerCase();
  const matches = Array.from(markdown.matchAll(headingPattern));

  for (const [index, match] of matches.entries()) {
    const level = match[1]?.length ?? 0;
    const title = match[2]?.trim().toLocaleLowerCase();
    if (title !== target) continue;

    const start = match.index! + match[0].length;
    let end = markdown.length;
    for (const next of matches.slice(index + 1)) {
      const nextLevel = next[1]?.length ?? 0;
      if (nextLevel <= level) {
        end = next.index!;
        break;
      }
    }
    return markdown.slice(start, end).trim();
  }

  return undefined;
}

export function hasNonemptySection(markdown: string, heading: string): boolean {
  const body = sectionBody(markdown, heading);
  if (body === undefined) return false;
  return body
    .split(/\r?\n/)
    .some((line) => line.trim() && !line.trim().startsWith("*"));
}

export function wikiLinks(markdown: string): string[] {
  const stripped = stripFencedCode(markdown);
  return Array.from(stripped.matchAll(wikiLinkPattern), (match) => match[1]!.trim());
}

export interface MarkdownTask {
  state: string;
  text: string;
  line: number;
  taskId?: string;
  source?: string;
}

export function markdownTasks(markdown: string): MarkdownTask[] {
  const stripped = stripFencedCode(markdown);
  const lines = stripped.split(/\r?\n/);
  const tasks: MarkdownTask[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+(.+)$/);
    if (!match) continue;
    const supporting: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]!;
      if (/^\s*-\s+\[[ xX]\]\s+/.test(candidate) || /^#{1,6}\s+/.test(candidate)) break;
      if (candidate.trim() && !/^\s+/.test(candidate) && !candidate.trim().startsWith("<!--")) break;
      supporting.push(candidate);
    }
    const supportText = supporting.join("\n");
    const annotation = supportText.match(/<!--\s*life-os:task_id=(task_[A-Za-z0-9]+)(?:\s+source=([^\s]+))?\s*-->/);
    const taskId = annotation?.[1];
    const source = annotation?.[2] ?? supportText.match(/^\s*-\s*Source:\s*(.+?)\s*$/m)?.[1];
    tasks.push({
      state: match[1]!, text: match[2]!.trim(), line: index + 1,
      ...(taskId ? { taskId } : {}), ...(source ? { source } : {}),
    });
  }
  return tasks;
}

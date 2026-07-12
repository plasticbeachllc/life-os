import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parseFrontmatter } from "../util/frontmatter";

export interface VaultNote {
  path: string;
  relativePath: string;
  metadata: Record<string, unknown>;
  body: string;
  raw: string;
  frontmatterErrors: string[];
  title: string;
}

export class ObsidianVault {
  constructor(readonly root: string) {}

  requireExists(): void {
    if (!existsSync(this.root)) throw new Error(`vault path does not exist: ${this.root}`);
    if (!statSync(this.root).isDirectory()) throw new Error(`vault path is not a directory: ${this.root}`);
  }

  path(relativePath: string): string {
    return join(this.root, relativePath);
  }

  markdownFiles(): string[] {
    this.requireExists();
    return walk(this.root)
      .filter((path) => path.endsWith(".md"))
      .filter((path) => !relative(this.root, path).split(/[\\/]/).includes(".obsidian"))
      .sort();
  }

  async notes(): Promise<VaultNote[]> {
    return Promise.all(this.markdownFiles().map((path) => this.readNote(path)));
  }

  async readNote(path: string): Promise<VaultNote> {
    const raw = await Bun.file(path).text();
    const parsed = parseFrontmatter(raw);
    const relativePath = relative(this.root, path);
    return {
      path,
      relativePath,
      metadata: parsed.metadata,
      body: parsed.body,
      raw,
      frontmatterErrors: parsed.errors,
      title: relativePath.replace(/\.md$/, "").split(/[\\/]/).at(-1) ?? relativePath,
    };
  }

  noteExistsForLink(linkTarget: string): boolean {
    const candidate = linkTarget.endsWith(".md") ? linkTarget : `${linkTarget}.md`;
    if (existsSync(this.path(candidate))) return true;
    return this.markdownFiles().some((path) => {
      const stem = path.split(/[\\/]/).at(-1)?.replace(/\.md$/, "");
      return stem === linkTarget;
    });
  }
}

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      paths.push(...walk(path));
    } else if (stats.isFile()) {
      paths.push(path);
    }
  }
  return paths;
}


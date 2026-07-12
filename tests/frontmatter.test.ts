import { expect, test } from "bun:test";

import { parseFrontmatter } from "../src/util/frontmatter";

test("parses flat frontmatter", () => {
  const parsed = parseFrontmatter(`---
type: project
status: active
aliases: []
empty:
---
# Project
`);

  expect(parsed.errors).toEqual([]);
  expect(parsed.metadata.type).toBe("project");
  expect(parsed.metadata.status).toBe("active");
  expect(parsed.metadata.aliases).toEqual([]);
  expect(parsed.metadata.empty).toBeNull();
  expect(parsed.body).toBe("# Project\n");
});

test("reports unclosed frontmatter", () => {
  const parsed = parseFrontmatter("---\ntype: daily\n# Missing close\n");

  expect(parsed.metadata).toEqual({});
  expect(parsed.errors).toEqual(["frontmatter start marker has no closing marker"]);
});


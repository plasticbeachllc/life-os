import { expect, test } from "bun:test";

import { markdownTasks, wikiLinks } from "../src/util/markdown";

test("task scanner ignores fenced code blocks", () => {
  const tasks = markdownTasks(`# Note

\`\`\`md
- [ ] Example task
\`\`\`

- [ ] Real task
`);

  expect(tasks).toEqual([{ state: " ", text: "Real task", line: 7 }]);
});

test("task scanner captures stable ID and source annotations", () => {
  const tasks = markdownTasks(`- [ ] Send the checklist 📅 2026-07-18 #waiting
  - Source: gmail:message_1
  <!-- life-os:task_id=task_a81f92c4d33e -->
`);
  expect(tasks[0]).toMatchObject({
    state: " ", line: 1, taskId: "task_a81f92c4d33e", source: "gmail:message_1",
  });
});

test("wiki link scanner ignores fenced code blocks", () => {
  const links = wikiLinks(`\`\`\`md
[[Example Person]]
\`\`\`

[[Real Person]]
`);

  expect(links).toEqual(["Real Person"]);
});

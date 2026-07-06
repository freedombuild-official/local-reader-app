import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../server/markdown";

describe("renderMarkdown", () => {
  it("adds table scroll wrappers and code block toolbar controls without app-specific data names", () => {
    const source = ["# Doc", "", "- [x] Done", "- [ ] Todo", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "> Quote", "", "```ts", "console.log(1)", "```"].join("\n");
    const { html } = renderMarkdown(source, { repoId: "docs", currentPath: "README.md" });

    expect(html).toContain('class="markdown-table-scroll"');
    expect(html).toContain('data-reader-wiki-table-scroll="true"');
    expect(html).toContain('class="task-list-checkbox"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('class="markdown-code-block"');
    expect(html).toContain('data-reader-wiki-code-block="true"');
    expect(html).toContain("markdown-code-copy-button");
    expect(html).toContain("markdown-code-wrap-button");
    const appSpecificDataName = "data-" + "kin" + "kaku";
    expect(html).not.toContain(appSpecificDataName);
  });
});

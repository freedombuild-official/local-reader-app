import type MarkdownIt from "markdown-it";

const TASK_ITEM_PATTERN = /^(\s*)\[([ xX])\]\s+/;

export function installTaskListRule(markdown: MarkdownIt): void {
  markdown.core.ruler.after("inline", "reader_wiki_task_lists", (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const listItem = state.tokens[index];
      if (listItem.type !== "list_item_open") continue;

      const paragraphOpen = state.tokens[index + 1];
      const inlineToken = state.tokens[index + 2];
      if (paragraphOpen?.type !== "paragraph_open" || inlineToken?.type !== "inline") continue;

      const match = inlineToken.content.match(TASK_ITEM_PATTERN);
      if (!match) continue;

      const checked = match[2].toLowerCase() === "x";
      listItem.attrJoin("class", "task-list-item");
      inlineToken.content = inlineToken.content.slice(match[0].length);
      inlineToken.children = rewriteTaskListChildren(inlineToken.children || [], match[0], checked, state.Token);
    }
  });
}

type MarkdownToken = Parameters<NonNullable<MarkdownIt["renderer"]["rules"]["text"]>>[0][number];
type MarkdownTokenConstructor = new (type: string, tag: string, nesting: -1 | 0 | 1) => MarkdownToken;

function rewriteTaskListChildren(children: MarkdownToken[], marker: string, checked: boolean, Token: MarkdownTokenConstructor): MarkdownToken[] {
  const nextChildren = [...children];
  const firstTextIndex = nextChildren.findIndex((child) => child.type === "text" && child.content.startsWith(marker));
  if (firstTextIndex === -1) return [createCheckboxToken(checked, Token), ...nextChildren];

  const firstText = nextChildren[firstTextIndex];
  firstText.content = firstText.content.slice(marker.length);
  if (!firstText.content) nextChildren.splice(firstTextIndex, 1);
  nextChildren.splice(firstTextIndex, 0, createCheckboxToken(checked, Token));
  return nextChildren;
}

function createCheckboxToken(checked: boolean, Token: MarkdownTokenConstructor): MarkdownToken {
  const checkboxInput = new Token("html_inline", "", 0);
  checkboxInput.content = `<input class="task-list-checkbox" type="checkbox" disabled${checked ? " checked" : ""} aria-label="${checked ? "completed task" : "open task"}">`;
  return checkboxInput;
}

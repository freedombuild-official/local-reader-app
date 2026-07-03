import type MarkdownIt from "markdown-it";

export const MARKDOWN_TABLE_SCROLL_CLASS = "markdown-table-scroll";
export const MARKDOWN_TABLE_SCROLL_DATA_ATTR = "data-reader-wiki-table-scroll";

export function installTableScrollRule(markdown: MarkdownIt): void {
  const defaultTableOpen = markdown.renderer.rules.table_open;
  const defaultTableClose = markdown.renderer.rules.table_close;

  markdown.renderer.rules.table_open = (tokens, idx, options, env, slf) => {
    const tableHtml = defaultTableOpen ? defaultTableOpen(tokens, idx, options, env, slf) : slf.renderToken(tokens, idx, options);
    return `<div class="${MARKDOWN_TABLE_SCROLL_CLASS}" ${MARKDOWN_TABLE_SCROLL_DATA_ATTR}="true">${tableHtml}`;
  };

  markdown.renderer.rules.table_close = (tokens, idx, options, env, slf) => {
    const tableHtml = defaultTableClose ? defaultTableClose(tokens, idx, options, env, slf) : slf.renderToken(tokens, idx, options);
    return `${tableHtml}</div>`;
  };
}

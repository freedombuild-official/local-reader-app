import type MarkdownIt from "markdown-it";

export const MARKDOWN_TABLE_SCROLL_CLASS = "markdown-table-scroll";
export const MARKDOWN_TABLE_SCROLL_DATA_ATTR = "data-reader-wiki-table-scroll";

export function installTableScrollRule(markdown: MarkdownIt): void {
  const defaultTableOpen = markdown.renderer.rules.table_open;
  const defaultTableClose = markdown.renderer.rules.table_close;

  markdown.renderer.rules.table_open = (items, idx, options, env, slf) => {
    const tableHtml = defaultTableOpen ? defaultTableOpen(items, idx, options, env, slf) : slf.renderToken(items, idx, options);
    return `<div class="${MARKDOWN_TABLE_SCROLL_CLASS}" ${MARKDOWN_TABLE_SCROLL_DATA_ATTR}="true">${tableHtml}`;
  };

  markdown.renderer.rules.table_close = (items, idx, options, env, slf) => {
    const tableHtml = defaultTableClose ? defaultTableClose(items, idx, options, env, slf) : slf.renderToken(items, idx, options);
    return `${tableHtml}</div>`;
  };
}

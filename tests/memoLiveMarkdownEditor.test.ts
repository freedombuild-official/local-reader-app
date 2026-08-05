import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoLiveMarkdownEditor,
  safeNavigableMarkdownHref,
  type MemoLiveMarkdownEditor,
} from "../src/memoLiveMarkdownEditor";

interface Fixture {
  host: HTMLElement;
  editor: MemoLiveMarkdownEditor;
  view: EditorView;
}

const activeEditors: MemoLiveMarkdownEditor[] = [];
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function cssRule(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

function fixture(
  markdown: string,
  options: Omit<
    Parameters<typeof createMemoLiveMarkdownEditor>[0],
    "parent" | "markdown"
  > = {},
): Fixture {
  const host = document.createElement("div");
  host.setAttribute("aria-label", "Session memo");
  document.body.append(host);
  const editor = createMemoLiveMarkdownEditor({
    parent: host,
    markdown,
    ...options,
  });
  activeEditors.push(editor);
  const editorElement = host.querySelector<HTMLElement>(".cm-editor");
  const view = editorElement === null ? null : EditorView.findFromDOM(editorElement);
  if (view === null) throw new Error("Memo EditorView was not created");
  return { host, editor, view };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function dataTransferEvent(
  type: "dragover" | "drop",
  dataTransfer: Partial<DataTransfer>,
): DragEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: dataTransfer,
  });
  return event;
}

function pressKey(
  target: Element,
  key: string,
  options: {
    code?: string;
    isComposing?: boolean;
    keyCode?: number;
    shiftKey?: boolean;
  } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code: options.code,
    key,
    shiftKey: options.shiftKey,
  });
  if (options.isComposing !== undefined) {
    Object.defineProperty(event, "isComposing", {
      configurable: true,
      value: options.isComposing,
    });
  }
  if (options.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", {
      configurable: true,
      value: options.keyCode,
    });
  }
  target.dispatchEvent(event);
  return event;
}

function pressShiftEnter(target: Element): KeyboardEvent {
  return pressKey(target, "Enter", { shiftKey: true });
}

function insertAtSelection(view: EditorView, source: string): void {
  const selection = view.state.selection.main;
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: source },
    selection: { anchor: selection.from + source.length },
    userEvent: "input.type",
  });
}

function typeTextThroughInputHandlers(
  view: EditorView,
  text: string,
  domFrom = view.state.selection.main.from,
  domTo = view.state.selection.main.to,
): boolean {
  const defaultInsert = () =>
    view.state.update({
      changes: { from: domFrom, to: domTo, insert: text },
      selection: { anchor: domFrom + text.length },
      userEvent: "input.type",
    });
  const handled = view.state
    .facet(EditorView.inputHandler)
    .some((handler) => handler(view, domFrom, domTo, text, defaultInsert));
  if (!handled) {
    view.dispatch(defaultInsert());
  }
  return handled;
}

function renderedListMarkers(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".memo-live-markdown-list-marker")].map(
    (marker) => marker.textContent ?? "",
  );
}

function renderedListMarkerElements(host: HTMLElement): HTMLElement[] {
  return [
    ...host.querySelectorAll<HTMLElement>(".memo-live-markdown-list-marker"),
  ];
}

function renderedListMarkerLines(host: HTMLElement): HTMLElement[] {
  return [
    ...host.querySelectorAll<HTMLElement>(
      ".cm-line.memo-live-markdown-list-marker-line",
    ),
  ];
}

function beginTableCellEdit(
  host: HTMLElement,
  inputIndex: number,
): HTMLInputElement {
  const input = host.querySelectorAll<HTMLInputElement>(
    ".memo-live-markdown-table-cell-input",
  )[inputIndex];
  if (input === undefined) throw new Error("Table input was not created");
  const cell = input.closest<HTMLTableCellElement>("th, td");
  if (cell === null) throw new Error("Table cell was not created");
  cell.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true }),
  );
  return input;
}

afterEach(() => {
  for (const editor of activeEditors.splice(0)) editor.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("createMemoLiveMarkdownEditor", () => {
  it("keeps ordinary text as a normal editable memo", () => {
    const markdown = "買い物メモ\n牛乳とパン";
    const { host, editor } = fixture(markdown);

    expect(host.querySelector(".cm-content")?.textContent).toContain("買い物メモ");
    expect(host.querySelector(".memo-live-markdown-heading")).toBeNull();
    expect(host.querySelector(".memo-live-markdown-strong")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("renders completed Markdown immediately in the same editable surface without a source mode", () => {
    const markdown = [
      "# Heading",
      "",
      "**bold** *emphasis* ~~removed~~ `code`",
      "",
      "> quote",
    ].join("\n");
    const { host, editor } = fixture(markdown);

    expect(host.querySelector(".memo-live-markdown-heading-1")?.textContent).toContain("Heading");
    expect(host.querySelector(".memo-live-markdown-strong")?.textContent).toBe("bold");
    expect(host.querySelector(".memo-live-markdown-emphasis")?.textContent).toBe("emphasis");
    expect(host.querySelector(".memo-live-markdown-strikethrough")?.textContent).toBe("removed");
    expect(host.querySelector(".memo-live-markdown-inline-code")?.textContent).toBe("code");
    expect(host.querySelector(".memo-live-markdown-blockquote")?.textContent).toBe("quote");
    expect(host.textContent).not.toContain("**bold**");
    expect(editor.getMarkdown()).toBe(markdown);
    expect(editor).not.toHaveProperty("setMode");
    expect(editor).not.toHaveProperty("getMode");
    expect(host.querySelector("[data-markdown-mode]")).toBeNull();
  });

  it.each([
    ["a root quote", "> quote", "quote"],
    ["one additional content space", ">  quote", " quote"],
    ["a nested quote", "> > quote", "quote"],
  ])(
    "hides each completed blockquote start token while preserving %s",
    (_name, markdown, visibleText) => {
      const { host, editor, view } = fixture(markdown);
      view.dispatch({ selection: { anchor: markdown.length } });

      expect(
        host.querySelector(".memo-live-markdown-blockquote")?.textContent,
      ).toBe(visibleText);
      expect(editor.getMarkdown()).toBe(markdown);
      expect(view.state.selection.main.head).toBe(markdown.length);
    },
  );

  it("keeps a bare quote marker literal and deactivates when its start space is removed", async () => {
    const { host, editor, view } = fixture(">");
    view.dispatch({ selection: { anchor: 1 } });

    expect(host.querySelector(".memo-live-markdown-blockquote")).toBeNull();
    expect(host.querySelector(".cm-content")?.textContent).toContain(">");

    insertAtSelection(view, " ");
    await flushMicrotasks();
    expect(editor.getMarkdown()).toBe("> ");
    expect(
      host.querySelector(".memo-live-markdown-blockquote")?.textContent,
    ).toBe("");
    expect(view.state.selection.main.head).toBe(2);

    view.dispatch({
      changes: { from: 1, to: 2 },
      selection: { anchor: 1 },
      userEvent: "delete.backward",
    });
    await flushMicrotasks();
    expect(editor.getMarkdown()).toBe(">");
    expect(host.querySelector(".memo-live-markdown-blockquote")).toBeNull();
    expect(host.querySelector(".cm-content")?.textContent).toContain(">");
    expect(view.state.selection.main.head).toBe(1);
  });

  it("updates source and decorations through one normal document transaction", async () => {
    const changes: string[] = [];
    const { host, editor, view } = fixture("plain", {
      onChange: (markdown) => changes.push(markdown),
    });

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "# Live" },
      userEvent: "input",
    });
    await flushMicrotasks();

    expect(editor.getMarkdown()).toBe("# Live");
    expect(changes).toEqual(["# Live"]);
    expect(host.querySelector(".memo-live-markdown-heading-1")?.textContent).toContain("Live");
  });

  it("preserves selection and history while editing rendered text", async () => {
    const markdown = "**bold** after";
    const { editor, view } = fixture(markdown);
    const insertionPoint = markdown.indexOf("bold") + "bold".length;
    view.dispatch({ selection: { anchor: insertionPoint } });

    view.dispatch({
      changes: { from: insertionPoint, insert: "!" },
      selection: { anchor: insertionPoint + 1 },
      userEvent: "input.type",
    });
    await flushMicrotasks();

    expect(editor.getMarkdown()).toBe("**bold!** after");
    expect(view.state.selection.main.head).toBe(insertionPoint + 1);
    expect(undo(view)).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
    expect(redo(view)).toBe(true);
    expect(editor.getMarkdown()).toBe("**bold!** after");
  });

  it("waits for IME composition to finish before emitting the controlled value", async () => {
    const changes: string[] = [];
    const { editor, view } = fixture("日本", {
      onChange: (value) => changes.push(value),
    });

    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    const inputState = (view as unknown as {
      inputState: { composing: number };
    }).inputState;
    inputState.composing = 1;
    view.dispatch({
      changes: { from: 2, insert: "語" },
      userEvent: "input.type.compose",
    });
    expect(editor.getMarkdown()).toBe("日本語");
    expect(changes).toEqual([]);

    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await flushMicrotasks();
    expect(changes).toEqual(["日本語"]);
  });

  it("rejects local file drops without changing the memo", () => {
    const markdown = "keep";
    const { editor, view } = fixture(markdown);
    const filePayload = {
      files: [{ name: "secret.txt" }],
      items: [{ kind: "file" }],
      dropEffect: "copy",
    } as unknown as DataTransfer;
    const dragover = dataTransferEvent("dragover", filePayload);
    const drop = dataTransferEvent("drop", filePayload);

    expect(view.contentDOM.dispatchEvent(dragover)).toBe(false);
    expect(dragover.defaultPrevented).toBe(true);
    expect(filePayload.dropEffect).toBe("none");
    expect(view.contentDOM.dispatchEvent(drop)).toBe(false);
    expect(drop.defaultPrevented).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("leaves incomplete Markdown syntax literal while the user is typing", () => {
    const markdown = "**unfinished ~~unfinished ![image";
    const { host, editor } = fixture(markdown);

    expect(host.querySelector(".cm-content")?.textContent).toContain(markdown);
    expect(host.querySelector(".memo-live-markdown-image-placeholder")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("renders task lists and semantic tables without rewriting their Markdown", () => {
    const markdown = [
      "- [ ] task",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| **one** | ~~two~~ |",
      "| \\*literal\\* &amp; &#35; | safe |",
    ].join("\n");
    const { host, editor } = fixture(markdown);
    const checkbox = host.querySelector<HTMLInputElement>(".memo-live-markdown-task-checkbox");
    const scroll = host.querySelector<HTMLElement>(".memo-live-markdown-table-scroll");
    const table = scroll?.querySelector("table.memo-live-markdown-table");

    expect(checkbox?.checked).toBe(false);
    expect(checkbox?.getAttribute("aria-label")).toBe("Mark task complete");
    expect(scroll?.getAttribute("role")).toBe("region");
    expect(scroll?.tabIndex).toBe(0);
    expect(table?.querySelectorAll("thead th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table?.querySelector("strong")?.textContent).toBe("one");
    expect(table?.querySelector("s")?.textContent).toBe("two");
    expect(table?.querySelector("tbody tr:last-child td")?.textContent).toBe("*literal* & #");
    expect(scroll?.querySelector(".memo-live-markdown-table-instructions")).toBeNull();
    expect(host.textContent).not.toContain("表のセルはEnterで編集できます");
    expect(table?.querySelector("[aria-describedby]")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("nests unordered list items after two spaces and supports deeper levels", () => {
    const { editor, view } = fixture("- parent");
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressShiftEnter(view.contentDOM);
    expect(editor.getMarkdown()).toBe("- parent\n- ");
    pressKey(view.contentDOM, " ");
    expect(editor.getMarkdown()).toBe("- parent\n-  ");
    pressKey(view.contentDOM, "Backspace");
    expect(editor.getMarkdown()).toBe("- parent\n- ");
    pressKey(view.contentDOM, " ");
    pressKey(view.contentDOM, " ");
    expect(editor.getMarkdown()).toBe("- parent\n  - ");

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "child" },
      selection: { anchor: view.state.doc.length + "child".length },
      userEvent: "input.type",
    });
    pressShiftEnter(view.contentDOM);
    pressKey(view.contentDOM, " ");
    pressKey(view.contentDOM, " ");
    expect(editor.getMarkdown()).toBe(
      "- parent\n  - child\n    - ",
    );
  });

  it("nests ordered list items after three spaces and restarts child numbering", () => {
    const { editor, view } = fixture("1. parent");
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressShiftEnter(view.contentDOM);
    expect(editor.getMarkdown()).toBe("1. parent\n2. ");
    pressKey(view.contentDOM, " ");
    pressKey(view.contentDOM, " ");
    expect(editor.getMarkdown()).toBe("1. parent\n2.   ");
    pressKey(view.contentDOM, " ");
    expect(editor.getMarkdown()).toBe("1. parent\n   1. ");

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "child" },
      selection: { anchor: view.state.doc.length + "child".length },
      userEvent: "input.type",
    });
    pressShiftEnter(view.contentDOM);
    pressKey(view.contentDOM, " ");
    pressKey(view.contentDOM, " ");
    pressKey(view.contentDOM, " ");
    expect(editor.getMarkdown()).toBe(
      "1. parent\n   1. child\n      1. ",
    );
  });

  it.each([
    ["unordered child", "- parent", "- parent\n  - "],
    ["ordered child", "1. parent", "1. parent\n   1. "],
    ["two-digit ordered child", "10. parent", "10. parent\n    1. "],
    ["parenthesized ordered child", "9) parent", "9) parent\n   1) "],
    [
      "nested unordered child",
      "- parent\n  - child",
      "- parent\n  - child\n    - ",
    ],
    ["blockquote child", "> - parent", "> - parent\n>   - "],
    ["task child", "- [x] parent", "- [x] parent\n  - [ ] "],
  ])("nests an empty %s with Enter", (_name, markdown, nested) => {
    const { editor, view } = fixture(markdown);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    const enter = pressKey(view.contentDOM, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.getMarkdown()).toBe(nested);
  });

  it.each([
    ["unordered sibling", "- parent", "- parent\n- "],
    ["ordered sibling", "1. parent", "1. parent\n2. "],
    ["two-digit ordered sibling", "10. parent", "10. parent\n11. "],
    ["parenthesized ordered sibling", "9) parent", "9) parent\n10) "],
    [
      "nested unordered sibling",
      "- parent\n  - child",
      "- parent\n  - child\n  - ",
    ],
    ["blockquote sibling", "> - parent", "> - parent\n> - "],
    ["task sibling", "- [x] parent", "- [x] parent\n- [ ] "],
  ])("continues an empty %s with Shift+Enter", (_name, markdown, continued) => {
    const { editor, view } = fixture(markdown);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    const enter = pressShiftEnter(view.contentDOM);
    expect(enter.defaultPrevented).toBe(true);
    expect(editor.getMarkdown()).toBe(continued);
  });

  it("leaves Shift+Enter alone outside a contentful list item", () => {
    const paragraph = fixture("plain");
    paragraph.view.dispatch({
      selection: { anchor: paragraph.view.state.doc.length },
    });
    const paragraphEnter = pressShiftEnter(paragraph.view.contentDOM);
    expect(paragraphEnter.defaultPrevented).toBe(true);
    expect(paragraph.editor.getMarkdown()).toBe("plain\n");

    const selection = fixture("- parent");
    selection.view.dispatch({ selection: { anchor: 2, head: 8 } });
    const selectionEnter = pressShiftEnter(selection.view.contentDOM);
    expect(selectionEnter.defaultPrevented).toBe(true);
    expect(selection.editor.getMarkdown()).toBe("- \n");

    const composing = fixture("- parent");
    composing.view.dispatch({
      selection: { anchor: composing.view.state.doc.length },
    });
    const inputState = (composing.view as unknown as {
      inputState: { composing: number };
    }).inputState;
    inputState.composing = 1;
    const composingEnter = pressKey(composing.view.contentDOM, "Enter", {
      isComposing: true,
      keyCode: 229,
      shiftKey: true,
    });
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(composing.editor.getMarkdown()).toBe("- parent");
    inputState.composing = 0;
  });

  it.each([
    ["nested unordered item", "- parent", "- parent\n  - "],
    ["same-level unordered item", "- parent", "- parent\n- ", true],
    ["nested ordered item", "1. parent", "1. parent\n   1. "],
    ["same-level ordered item", "1. parent", "1. parent\n2. ", true],
    ["nested blockquote item", "> - parent", "> - parent\n>   - "],
    ["nested task item", "- [x] parent", "- [x] parent\n  - [ ] "],
  ])(
    "exits an empty %s with Enter and restores it with Backspace",
    (_name, markdown, emptyItem, sameLevel = false) => {
      const { editor, view } = fixture(markdown);
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      if (sameLevel) {
        pressShiftEnter(view.contentDOM);
      } else {
        pressKey(view.contentDOM, "Enter");
      }
      expect(editor.getMarkdown()).toBe(emptyItem);

      pressKey(view.contentDOM, "Enter");
      expect(editor.getMarkdown()).toBe(`${markdown}\n`);
      pressKey(view.contentDOM, "Backspace");
      expect(editor.getMarkdown()).toBe(emptyItem);
    },
  );

  it("forgets an exited list item after another paragraph change", () => {
    const { editor, host, view } = fixture("1. parent");
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressKey(view.contentDOM, "Enter");
    pressKey(view.contentDOM, "Enter");
    expect(editor.getMarkdown()).toBe("1. parent\n");

    pressKey(view.contentDOM, "Enter");
    insertAtSelection(view, "1. next");
    expect(editor.getMarkdown()).toBe("1. parent\n\n1. next");
    expect(renderedListMarkers(host)).toEqual(["1.", "1."]);

    pressKey(view.contentDOM, "Backspace");
    expect(editor.getMarkdown()).toBe("1. parent\n\n1. nex");
  });

  it.each([
    {
      name: "unordered under unordered",
      parent: "- parent",
      continued: "- parent\n- ",
      childPosition: "- parent\n  ",
      marker: "- ",
      expected: "- parent\n  - ",
    },
    {
      name: "ordered under unordered",
      parent: "- parent",
      continued: "- parent\n- ",
      childPosition: "- parent\n  ",
      marker: "1. ",
      expected: "- parent\n  1. ",
    },
    {
      name: "ordered under ordered",
      parent: "1. parent",
      continued: "1. parent\n2. ",
      childPosition: "1. parent\n   ",
      marker: "1. ",
      expected: "1. parent\n   1. ",
    },
    {
      name: "unordered under ordered",
      parent: "1. parent",
      continued: "1. parent\n2. ",
      childPosition: "1. parent\n   ",
      marker: "- ",
      expected: "1. parent\n   - ",
    },
  ])("selects $name after removing the continued marker", ({
    parent,
    continued,
    childPosition,
    marker,
    expected,
  }) => {
    const { editor, view } = fixture(parent);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressShiftEnter(view.contentDOM);
    expect(editor.getMarkdown()).toBe(continued);
    pressKey(view.contentDOM, "Backspace");
    expect(editor.getMarkdown()).toBe(childPosition);
    insertAtSelection(view, marker);
    expect(editor.getMarkdown()).toBe(expected);
  });

  it.each([
    ["-", "- "],
    ["+", "+ "],
    ["*", "* "],
    ["1", "1. "],
  ])(
    "accepts the physical %s key at an ordered child position",
    (markerStart, marker) => {
      const { editor, view } = fixture("1. parent");
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      pressShiftEnter(view.contentDOM);
      pressKey(view.contentDOM, "Backspace");
      const markerKey = pressKey(view.contentDOM, markerStart);
      expect(markerKey.defaultPrevented).toBe(true);
      insertAtSelection(view, marker.slice(markerStart.length));
      expect(editor.getMarkdown()).toBe(`1. parent\n   ${marker}`);
    },
  );

  it.each([
    {
      name: "unordered to ordered",
      parent: "- parent",
      unmarked: "- parent\n  ",
      markerKeys: ["1", ".", " "],
      markerOnly: "- parent\n  1. ",
      markers: ["•", "1."],
      wrongDomCaretAfter: null,
    },
    {
      name: "ordered to unordered",
      parent: "10) parent",
      unmarked: "10) parent\n    ",
      markerKeys: ["-", " "],
      markerOnly: "10) parent\n    - ",
      markers: ["10.", "•"],
      wrongDomCaretAfter: "-",
    },
  ])(
    "keeps an Enter-created child indent and renders its empty mixed marker immediately: $name",
    async ({
      parent,
      unmarked,
      markerKeys,
      markerOnly,
      markers,
      wrongDomCaretAfter,
    }) => {
      const { host, editor, view } = fixture(parent);
      view.dispatch({ selection: { anchor: view.state.doc.length } });

      pressKey(view.contentDOM, "Enter");
      pressKey(view.contentDOM, "Backspace");
      expect(editor.getMarkdown()).toBe(unmarked);
      expect(view.state.selection.main.head).toBe(view.state.doc.length);

      for (const [index, key] of markerKeys.entries()) {
        const useWrongDomCaret =
          wrongDomCaretAfter !== null &&
          markerKeys[index - 1] === wrongDomCaretAfter;
        typeTextThroughInputHandlers(
          view,
          key,
          useWrongDomCaret ? parent.length : view.state.selection.main.from,
          useWrongDomCaret ? parent.length : view.state.selection.main.to,
        );
      }
      await flushMicrotasks();

      expect(editor.getMarkdown()).toBe(markerOnly);
      expect(renderedListMarkers(host)).toEqual(markers);
      expect(view.state.selection.main.head).toBe(view.state.doc.length);

      typeTextThroughInputHandlers(view, "child");
      await flushMicrotasks();
      expect(editor.getMarkdown()).toBe(`${markerOnly}child`);
      expect(renderedListMarkers(host)).toEqual(markers);
    },
  );

  it("keeps an incomplete nested hyphen literal without reinterpreting its ordered parent as a heading", async () => {
    const parent = "10) parent";
    const { host, editor, view } = fixture(parent);
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressKey(view.contentDOM, "Enter");
    pressKey(view.contentDOM, "Backspace");
    typeTextThroughInputHandlers(view, "-");
    await flushMicrotasks();

    expect(editor.getMarkdown()).toBe("10) parent\n    -");
    expect(
      host.querySelector(".memo-live-markdown-setext-heading"),
    ).toBeNull();
    expect(
      host.querySelector(".memo-live-markdown-source-line-hidden"),
    ).toBeNull();
    expect(renderedListMarkers(host)).toEqual(["10."]);

    typeTextThroughInputHandlers(view, " ", parent.length, parent.length);
    await flushMicrotasks();
    expect(editor.getMarkdown()).toBe("10) parent\n    - ");
    expect(renderedListMarkers(host)).toEqual(["10.", "•"]);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it.each([
    ["unordered to ordered", "- parent\n  1. ", ["•", "1."]],
    ["ordered to unordered", "10) parent\n    - ", ["10.", "•"]],
    [
      "blockquote unordered to ordered",
      "> - parent\n>   1. ",
      ["•", "1."],
    ],
  ])(
    "renders a persisted empty mixed child marker: %s",
    (_name, markdown, markers) => {
      const { editor, host } = fixture(markdown as string);

      expect(renderedListMarkers(host)).toEqual(markers);
      expect(editor.getMarkdown()).toBe(markdown);
    },
  );

  it.each([
    ["empty nested ordered", "- parent\n  1. ", true],
    ["populated nested ordered", "- parent\n  1. child", true],
    [
      "two-digit nested ordered",
      [
        "- parent",
        ...Array.from(
          { length: 10 },
          (_, index) => `  ${index + 1}. child ${index + 1}`,
        ),
      ].join("\n"),
      true,
    ],
    ["blockquote nested ordered", "> - parent\n>   1. child", true],
    ["root ordered", "1. root", false],
    ["nested unordered", "- parent\n  - child", false],
  ])(
    "marks only a %s marker for visual nested ordered alignment",
    (_name, markdown, expected) => {
      const { host, editor } = fixture(markdown as string);
      const marker = renderedListMarkerElements(host).at(-1);

      expect(marker).toBeDefined();
      expect(
        marker?.classList.contains(
          "memo-live-markdown-list-marker-nested-ordered",
        ),
      ).toBe(expected);
      expect(editor.getMarkdown()).toBe(markdown);
    },
  );

  it("keeps the nested ordered visual offset in the stylesheet contract", () => {
    expect(
      cssRule(".memo-live-markdown-list-marker-nested-ordered"),
    ).toContain("margin-left: 0.45em;");
  });

  it.each([
    ["root unordered", "- root", ["2"]],
    ["nested unordered", "- parent\n  - child", ["2", "4"]],
    ["root ordered", "1. root", ["3"]],
    ["nested ordered", "1. parent\n   1. child", ["3", "6"]],
    ["blockquote unordered", "> - quoted", ["4"]],
    ["task item", "- [ ] task", ["6"]],
  ])(
    "marks each %s marker line with its source content offset",
    (_name, markdown, expectedOffsets) => {
      const { host, editor } = fixture(markdown as string);

      expect(
        renderedListMarkerLines(host).map((line) =>
          line.getAttribute("data-memo-list-content-offset"),
        ),
      ).toEqual(expectedOffsets);
      expect(editor.getMarkdown()).toBe(markdown);
    },
  );

  it("tracks the wider source prefix for a two-digit ordered marker", () => {
    const markdown = Array.from(
      { length: 10 },
      (_, index) => `${index + 1}. item ${index + 1}`,
    ).join("\n");
    const { host, editor } = fixture(markdown);

    expect(
      renderedListMarkerLines(host).map((line) =>
        line.getAttribute("data-memo-list-content-offset"),
      ),
    ).toEqual([...Array.from({ length: 9 }, () => "3"), "4"]);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("does not add marker-line hanging indent to a continuation source line", () => {
    const markdown = "- first line\n  continuation";
    const { host, editor } = fixture(markdown);

    expect(
      host.querySelectorAll(".cm-line.memo-live-markdown-list-item"),
    ).toHaveLength(2);
    expect(renderedListMarkerLines(host)).toHaveLength(1);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("keeps list source and selection unchanged when hanging indent is remeasured", () => {
    const markdown = "- parent text that can wrap\n  1. nested child text";
    const { editor, view } = fixture(markdown);
    const anchor = markdown.indexOf("nested") + 3;
    view.dispatch({ selection: { anchor } });

    editor.requestMeasure();

    expect(editor.getMarkdown()).toBe(markdown);
    expect(view.state.selection.main.anchor).toBe(anchor);
  });

  it("preserves hanging indent during composition and remeasures after it ends", async () => {
    const markdown = "- parent text that can wrap\n  1. nested child text";
    const { editor, host, view } = fixture(markdown);
    const hangingIndentProperty = "--memo-live-markdown-list-hanging-indent";
    const currentIndents = () =>
      renderedListMarkerLines(host).map((line) =>
        line.style.getPropertyValue(hangingIndentProperty),
      );
    const coordinateAtPosition = (
      position: number,
      indents: readonly number[],
    ): { left: number } | null => {
      const lines = renderedListMarkerLines(host);
      expect(lines).toHaveLength(indents.length);
      for (const [index, line] of lines.entries()) {
        const lineFrom = Number(
          line.getAttribute("data-memo-list-line-from"),
        );
        const contentOffset = Number(
          line.getAttribute("data-memo-list-content-offset"),
        );
        if (position === lineFrom) {
          return { left: 10 };
        }
        if (position === lineFrom + contentOffset) {
          return { left: 10 + (indents[index] ?? 0) };
        }
      }
      return null;
    };
    const anchor = markdown.indexOf("nested") + 3;
    const insertionPoint = markdown.indexOf("\n");
    view.dispatch({ selection: { anchor } });
    const createRangeSpy = vi.spyOn(document, "createRange").mockReturnValue({
      getClientRects: () => [],
    } as unknown as Range);
    const requestMeasureSpy = vi
      .spyOn(view, "requestMeasure")
      .mockImplementation((spec?: unknown) => {
        if (
          spec !== undefined &&
          typeof spec === "object" &&
          spec !== null &&
          "read" in spec &&
          "write" in spec
        ) {
          const typedSpec = spec as {
            read: (currentView: EditorView) => unknown;
            write: (value: unknown) => void;
          };
          typedSpec.write(typedSpec.read(view));
        }
      });
    let measuredIndents: readonly number[] = [12, 18];
    const coordsAtPosSpy = vi
      .spyOn(view, "coordsAtPos")
      .mockImplementation(
        (pos) =>
          coordinateAtPosition(pos, measuredIndents) as ReturnType<
            EditorView["coordsAtPos"]
          >,
      );

    editor.requestMeasure();
    expect(currentIndents()).toEqual(["12px", "18px"]);

    const inputState = (view as unknown as {
      inputState: { composing: number };
    }).inputState;
    inputState.composing = 1;
    view.dispatch({
      changes: { from: insertionPoint, insert: "語" },
      userEvent: "input.type.compose",
    });
    coordsAtPosSpy.mockReturnValue(null as ReturnType<EditorView["coordsAtPos"]>);

    editor.requestMeasure();

    expect(currentIndents()).toEqual(["12px", "18px"]);
    measuredIndents = [14, 20];
    coordsAtPosSpy.mockImplementation(
      (pos) =>
        coordinateAtPosition(pos, measuredIndents) as ReturnType<
          EditorView["coordsAtPos"]
        >,
    );
    inputState.composing = 0;
    view.contentDOM.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await flushMicrotasks();

    expect(currentIndents()).toEqual(["14px", "20px"]);
    expect(editor.getMarkdown()).toBe(
      `${markdown.slice(0, insertionPoint)}語${markdown.slice(insertionPoint)}`,
    );
    expect(view.state.selection.main.anchor).toBe(anchor + 1);
    createRangeSpy.mockRestore();
    requestMeasureSpy.mockRestore();
    coordsAtPosSpy.mockRestore();
  });

  it("keeps the list hanging-indent stylesheet contract", () => {
    const rule = cssRule(".cm-line.memo-live-markdown-list-marker-line");

    expect(rule).toContain(
      "--memo-live-markdown-list-hanging-indent: 0px;",
    );
    expect(rule).toContain("padding-inline-start: calc(");
    expect(rule).toContain(
      "0.1em + var(--memo-live-markdown-list-hanging-indent)",
    );
    expect(rule).toContain("text-indent: calc(");
    expect(rule).toContain(
      "0px - var(--memo-live-markdown-list-hanging-indent)",
    );
  });

  it("renders a setext-like unordered child as soon as its trailing space arrives", () => {
    const { editor, host, view } = fixture("1. parent");
    view.dispatch({
      selection: { anchor: view.state.doc.length },
    });
    pressShiftEnter(view.contentDOM);
    pressKey(view.contentDOM, "Backspace");
    pressKey(view.contentDOM, "-");

    expect(editor.getMarkdown()).toBe("1. parent\n   -");
    expect(
      host.querySelector(".memo-live-markdown-setext-heading"),
    ).toBeNull();
    expect(
      host.querySelector(".memo-live-markdown-source-line-hidden"),
    ).toBeNull();

    const trailingSpace = pressKey(view.contentDOM, " ");
    expect(trailingSpace.defaultPrevented).toBe(false);
    insertAtSelection(view, " ");
    expect(editor.getMarkdown()).toBe("1. parent\n   - ");
    expect(
      host.querySelector(".memo-live-markdown-setext-heading"),
    ).toBeNull();
    expect(renderedListMarkers(host)).toEqual(["1.", "•"]);

    insertAtSelection(view, "child");
    expect(editor.getMarkdown()).toBe("1. parent\n   - child");
    expect(renderedListMarkers(host)).toEqual(["1.", "•"]);
  });

  it("renders an empty unordered child after three additional nesting spaces", () => {
    const { editor, host, view } = fixture("1. parent");
    view.dispatch({
      selection: { anchor: view.state.doc.length },
    });

    pressShiftEnter(view.contentDOM);
    pressKey(view.contentDOM, "Backspace");
    expect(editor.getMarkdown()).toBe("1. parent\n   ");

    for (let index = 0; index < 3; index += 1) {
      const additionalSpace = pressKey(view.contentDOM, " ");
      expect(additionalSpace.defaultPrevented).toBe(false);
      insertAtSelection(view, " ");
    }
    const marker = pressKey(view.contentDOM, "-");
    expect(marker.defaultPrevented).toBe(false);
    insertAtSelection(view, "-");
    expect(editor.getMarkdown()).toBe("1. parent\n      -");

    const trailingSpace = pressKey(view.contentDOM, " ");
    expect(trailingSpace.defaultPrevented).toBe(false);
    insertAtSelection(view, " ");
    expect(editor.getMarkdown()).toBe("1. parent\n      - ");
    expect(renderedListMarkers(host)).toEqual(["1.", "•"]);

    insertAtSelection(view, "child");
    expect(editor.getMarkdown()).toBe("1. parent\n      - child");
    expect(renderedListMarkers(host)).toEqual(["1.", "•"]);
  });

  it.each([
    ["hyphen", "1. parent\n   - ", ["1.", "•"]],
    ["asterisk", "1. parent\n   * ", ["1.", "•"]],
    ["plus", "1. parent\n   + ", ["1.", "•"]],
    ["one extra space", "1. parent\n    - ", ["1.", "•"]],
    ["two extra spaces", "1. parent\n     - ", ["1.", "•"]],
    ["three extra spaces", "1. parent\n      - ", ["1.", "•"]],
    ["three extra spaces with an asterisk", "1. parent\n      * ", ["1.", "•"]],
    ["three extra spaces with a plus", "1. parent\n      + ", ["1.", "•"]],
    ["two-digit parent", "10. parent\n    - ", ["10.", "•"]],
    ["two-digit parent with three extra spaces", "10. parent\n       - ", ["10.", "•"]],
    ["blockquote parent", "> 1. parent\n>    - ", ["1.", "•"]],
    ["blockquote parent with three extra spaces", "> 1. parent\n>       - ", ["1.", "•"]],
  ])("renders an empty %s unordered child from source", (_name, markdown, markers) => {
    const { editor, host } = fixture(markdown as string);

    expect(editor.getMarkdown()).toBe(markdown);
    expect(renderedListMarkers(host)).toEqual(markers);
    expect(
      host.querySelector(".memo-live-markdown-setext-heading"),
    ).toBeNull();
  });

  it("does not render a pending unordered child beyond three extra spaces", () => {
    const { editor, host } = fixture("1. parent\n       - ");

    expect(editor.getMarkdown()).toBe("1. parent\n       - ");
    expect(renderedListMarkers(host)).toEqual(["1."]);
  });

  it.each([
    ["top-level list", "- ", ["•"]],
    ["top-level ordered list", "1. ", ["1."]],
    ["top-level indented code", "      - ", []],
    ["unordered parent child", "- parent\n     - ", ["•", "•"]],
  ])("leaves the %s to the standard parser", (_name, markdown, markers) => {
    const { editor, host } = fixture(markdown as string);

    expect(editor.getMarkdown()).toBe(markdown);
    expect(renderedListMarkers(host)).toEqual(markers);
  });

  it("restarts semantic ordered numbering after a blank source line", () => {
    const grouped = fixture([
      "1. first",
      "1. second",
      "",
      "1. third",
      "1. fourth",
    ].join("\n"));
    expect(renderedListMarkers(grouped.host)).toEqual([
      "1.",
      "2.",
      "1.",
      "2.",
    ]);

    const explicitStarts = fixture([
      "3. first",
      "4. second",
      "  ",
      "7. third",
      "8. fourth",
    ].join("\n"));
    expect(renderedListMarkers(explicitStarts.host)).toEqual([
      "3.",
      "4.",
      "7.",
      "8.",
    ]);

    const crlf = fixture("1. first\r\n\r\n1. second");
    expect(renderedListMarkers(crlf.host)).toEqual(["1.", "1."]);
  });

  it("does not reset ordered numbering for a continuation paragraph inside an item", () => {
    const { host } = fixture([
      "1. first",
      "",
      "   continuation",
      "2. second",
    ].join("\n"));

    expect(renderedListMarkers(host)).toEqual(["1.", "2."]);
  });

  it("keeps ordered numbering groups independent at each nested depth", () => {
    const { host } = fixture([
      "1. parent",
      "   1. first child",
      "",
      "   1. second child",
      "2. next parent",
    ].join("\n"));

    expect(renderedListMarkers(host)).toEqual([
      "1.",
      "1.",
      "1.",
      "2.",
    ]);
  });

  it("continues to render ordinary setext headings", () => {
    const { host } = fixture("ordinary heading\n---");

    expect(host.querySelector(".memo-live-markdown-setext-heading")).not.toBeNull();
    expect(
      host.querySelector(".memo-live-markdown-source-line-hidden"),
    ).not.toBeNull();
  });

  it("does not reinterpret a root Setext underline as a nested list marker", () => {
    const { host, editor } = fixture("Heading\n- ");

    expect(
      host.querySelector(".memo-live-markdown-setext-heading"),
    ).not.toBeNull();
    expect(renderedListMarkers(host)).toEqual([]);
    expect(renderedListMarkerLines(host)).toEqual([]);
    expect(editor.getMarkdown()).toBe("Heading\n- ");
  });

  it("leaves IME keyCode 229 alone and keeps the DOM input fallback", () => {
    const imeInput = fixture("1. parent");
    imeInput.view.dispatch({
      selection: { anchor: imeInput.view.state.doc.length },
    });
    pressShiftEnter(imeInput.view.contentDOM);
    pressKey(imeInput.view.contentDOM, "Backspace");
    const imeMinusKey = pressKey(imeInput.view.contentDOM, "Unidentified", {
      code: "Minus",
      keyCode: 229,
    });
    expect(imeMinusKey.defaultPrevented).toBe(false);
    expect(imeInput.editor.getMarkdown()).toBe("1. parent\n   ");

    const domInput = fixture("1. parent");
    domInput.view.dispatch({
      selection: { anchor: domInput.view.state.doc.length },
    });
    pressShiftEnter(domInput.view.contentDOM);
    pressKey(domInput.view.contentDOM, "Backspace");
    const handled = domInput.view.state
      .facet(EditorView.inputHandler)
      .some((handler) =>
        handler(
          domInput.view,
          0,
          domInput.view.state.doc.length,
          "- child",
          () => domInput.view.state.update({}),
        ),
      );
    expect(handled).toBe(true);
    expect(domInput.editor.getMarkdown()).toBe("1. parent\n   - child");
  });

  it("continues a mixed child type and supports a deeper marker choice", () => {
    const { editor, view } = fixture("- parent");
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressShiftEnter(view.contentDOM);
    pressKey(view.contentDOM, "Backspace");
    insertAtSelection(view, "1. child");
    pressShiftEnter(view.contentDOM);
    expect(editor.getMarkdown()).toBe(
      "- parent\n  1. child\n  2. ",
    );

    pressKey(view.contentDOM, "Backspace");
    expect(editor.getMarkdown()).toBe(
      "- parent\n  1. child\n     ",
    );
    insertAtSelection(view, "- grandchild");
    expect(editor.getMarkdown()).toBe(
      "- parent\n  1. child\n     - grandchild",
    );
  });

  it("preserves a blockquote container while selecting a mixed child type", () => {
    const { editor, view } = fixture("> - parent");
    view.dispatch({ selection: { anchor: view.state.doc.length } });

    pressShiftEnter(view.contentDOM);
    expect(editor.getMarkdown()).toBe("> - parent\n> - ");
    pressKey(view.contentDOM, "Backspace");
    expect(editor.getMarkdown()).toBe("> - parent\n>   ");
    insertAtSelection(view, "1. child");
    expect(editor.getMarkdown()).toBe("> - parent\n>   1. child");
  });

  it("supports task child markers and task parents without forcing task children", () => {
    const taskChild = fixture("- parent");
    taskChild.view.dispatch({
      selection: { anchor: taskChild.view.state.doc.length },
    });
    pressShiftEnter(taskChild.view.contentDOM);
    pressKey(taskChild.view.contentDOM, "Backspace");
    insertAtSelection(taskChild.view, "- [ ] task");
    expect(taskChild.editor.getMarkdown()).toBe(
      "- parent\n  - [ ] task",
    );

    const taskParent = fixture("- [ ] parent");
    taskParent.view.dispatch({
      selection: { anchor: taskParent.view.state.doc.length },
    });
    pressShiftEnter(taskParent.view.contentDOM);
    expect(taskParent.editor.getMarkdown()).toBe(
      "- [ ] parent\n- [ ] ",
    );
    pressKey(taskParent.view.contentDOM, "Backspace");
    insertAtSelection(taskParent.view, "1. child");
    expect(taskParent.editor.getMarkdown()).toBe(
      "- [ ] parent\n  1. child",
    );
  });

  it("uses the actual ordered parent marker width for nesting", () => {
    const markerChoice = fixture("10. parent");
    markerChoice.view.dispatch({
      selection: { anchor: markerChoice.view.state.doc.length },
    });
    pressShiftEnter(markerChoice.view.contentDOM);
    expect(markerChoice.editor.getMarkdown()).toBe(
      "10. parent\n11. ",
    );
    pressKey(markerChoice.view.contentDOM, "Backspace");
    expect(markerChoice.editor.getMarkdown()).toBe(
      "10. parent\n    ",
    );
    insertAtSelection(markerChoice.view, "- child");
    expect(markerChoice.editor.getMarkdown()).toBe(
      "10. parent\n    - child",
    );

    const sameTypeShortcut = fixture("10. parent");
    sameTypeShortcut.view.dispatch({
      selection: { anchor: sameTypeShortcut.view.state.doc.length },
    });
    pressShiftEnter(sameTypeShortcut.view.contentDOM);
    pressKey(sameTypeShortcut.view.contentDOM, " ");
    pressKey(sameTypeShortcut.view.contentDOM, " ");
    pressKey(sameTypeShortcut.view.contentDOM, " ");
    expect(sameTypeShortcut.editor.getMarkdown()).toBe(
      "10. parent\n11.    ",
    );
    pressKey(sameTypeShortcut.view.contentDOM, " ");
    expect(sameTypeShortcut.editor.getMarkdown()).toBe(
      "10. parent\n    1. ",
    );

    const widthBoundary = fixture("9. parent");
    widthBoundary.view.dispatch({
      selection: { anchor: widthBoundary.view.state.doc.length },
    });
    pressShiftEnter(widthBoundary.view.contentDOM);
    expect(widthBoundary.editor.getMarkdown()).toBe("9. parent\n10. ");
    pressKey(widthBoundary.view.contentDOM, "Backspace");
    expect(widthBoundary.editor.getMarkdown()).toBe("9. parent\n   ");
  });

  it("does not treat content, selection, a paragraph, or the first item as a child choice", () => {
    const content = fixture("- parent");
    content.view.dispatch({
      selection: { anchor: content.view.state.doc.length },
    });
    pressKey(content.view.contentDOM, "Backspace");
    expect(content.editor.getMarkdown()).toBe("- paren");

    const selection = fixture("- parent");
    selection.view.dispatch({ selection: { anchor: 2, head: 8 } });
    pressKey(selection.view.contentDOM, "Backspace");
    expect(selection.editor.getMarkdown()).toBe("- ");

    const paragraph = fixture("plain");
    paragraph.view.dispatch({
      selection: { anchor: paragraph.view.state.doc.length },
    });
    pressKey(paragraph.view.contentDOM, "Backspace");
    expect(paragraph.editor.getMarkdown()).toBe("plai");

    const firstItem = fixture("- ");
    firstItem.view.dispatch({
      selection: { anchor: firstItem.view.state.doc.length },
    });
    pressKey(firstItem.view.contentDOM, "Backspace");
    expect(firstItem.editor.getMarkdown()).toBe("");
  });

  it("keeps list exit, forward Delete, composition, and history behavior", () => {
    const listExit = fixture("- parent");
    listExit.view.dispatch({
      selection: { anchor: listExit.view.state.doc.length },
    });
    pressKey(listExit.view.contentDOM, "Enter");
    pressKey(listExit.view.contentDOM, "Enter");
    expect(listExit.editor.getMarkdown()).toBe("- parent\n");

    const forwardDelete = fixture("- parent");
    forwardDelete.view.dispatch({
      selection: { anchor: forwardDelete.view.state.doc.length },
    });
    pressKey(forwardDelete.view.contentDOM, "Enter");
    pressKey(forwardDelete.view.contentDOM, "Delete");
    expect(forwardDelete.editor.getMarkdown()).toBe("- parent\n  - ");

    const markerChoice = fixture("- parent");
    markerChoice.view.dispatch({
      selection: { anchor: markerChoice.view.state.doc.length },
    });
    pressShiftEnter(markerChoice.view.contentDOM);
    pressKey(markerChoice.view.contentDOM, "Backspace");
    expect(markerChoice.editor.getMarkdown()).toBe("- parent\n  ");
    expect(undo(markerChoice.view)).toBe(true);
    expect(markerChoice.editor.getMarkdown()).toBe("- parent");
    expect(redo(markerChoice.view)).toBe(true);
    expect(markerChoice.editor.getMarkdown()).toBe("- parent\n  ");

    const composing = fixture("- parent\n- ");
    composing.view.dispatch({
      selection: { anchor: composing.view.state.doc.length },
    });
    const inputState = (composing.view as unknown as {
      inputState: { composing: number };
    }).inputState;
    inputState.composing = 1;
    pressKey(composing.view.contentDOM, "Backspace");
    expect(composing.editor.getMarkdown()).toBe("- parent\n- ");
    inputState.composing = 0;
  });

  it("adds a table row, ignores the composition-confirming Enter, then exits to a paragraph", async () => {
    const markdown = [
      "| Name | Value |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n");
    const { host, editor, view } = fixture(markdown);
    const lastInput = beginTableCellEdit(host, 3);

    lastInput.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    lastInput.value = "日本語";
    const composingEnter = pressKey(lastInput, "Enter", {
      isComposing: true,
      keyCode: 229,
    });
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(editor.getMarkdown()).toBe(markdown);

    lastInput.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    const composedMarkdown = markdown.replace("two", "日本語");
    expect(editor.getMarkdown()).toBe(composedMarkdown);
    pressKey(lastInput, "Enter");
    await flushMicrotasks();
    expect(editor.getMarkdown()).toBe(`${composedMarkdown}\n|  |  |`);

    const trailingInput = host.querySelectorAll<HTMLInputElement>(
      ".memo-live-markdown-table-cell-input",
    )[4];
    expect(document.activeElement).toBe(trailingInput);
    pressKey(trailingInput!, "Enter");
    expect(editor.getMarkdown()).toBe(`${composedMarkdown}\n\n`);
    expect(view.state.selection.main.head).toBe(composedMarkdown.length + 1);
    expect(view.hasFocus).toBe(true);
  });

  it.each(["Backspace", "Delete"])(
    "deletes a fully empty table row with %s and focuses the adjacent row",
    async (key) => {
      const markdown = [
        "| Name | Value |",
        "| --- | --- |",
        "| keep | row |",
        "|  |  |",
        "| after | row |",
      ].join("\n");
      const expected = [
        "| Name | Value |",
        "| --- | --- |",
        "| keep | row |",
        "| after | row |",
      ].join("\n");
      const { host, editor } = fixture(markdown);
      const emptyRowInput = beginTableCellEdit(host, 4);

      const event = pressKey(emptyRowInput, key);
      expect(event.defaultPrevented).toBe(true);
      await flushMicrotasks();
      expect(editor.getMarkdown()).toBe(expected);
      expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(
        document.activeElement?.getAttribute("aria-label"),
      ).toBe("Edit Markdown for Table row 2 column 1");
    },
  );

  it("does not delete a non-empty row or the table's only body row", () => {
    const nonEmptyMarkdown = [
      "| Name | Value |",
      "| --- | --- |",
      "| keep | row |",
      "|  |  |",
    ].join("\n");
    const nonEmptyFixture = fixture(nonEmptyMarkdown);
    const nonEmptyInput = beginTableCellEdit(nonEmptyFixture.host, 2);
    expect(pressKey(nonEmptyInput, "Delete").defaultPrevented).toBe(false);
    expect(nonEmptyFixture.editor.getMarkdown()).toBe(nonEmptyMarkdown);

    const soleEmptyMarkdown = [
      "| Name | Value |",
      "| --- | --- |",
      "|  |  |",
    ].join("\n");
    const soleEmptyFixture = fixture(soleEmptyMarkdown);
    const soleEmptyInput = beginTableCellEdit(soleEmptyFixture.host, 2);
    expect(pressKey(soleEmptyInput, "Backspace").defaultPrevented).toBe(false);
    expect(soleEmptyFixture.editor.getMarkdown()).toBe(soleEmptyMarkdown);
  });

  it("preserves CRLF source when a rendered task is toggled and supports undo", () => {
    const markdown = "title\r\n- [ ] task";
    const changes: string[] = [];
    const { host, editor, view } = fixture(markdown, {
      onChange: (value) => changes.push(value),
    });

    host.querySelector<HTMLInputElement>(".memo-live-markdown-task-checkbox")?.click();
    expect(editor.getMarkdown()).toBe("title\r\n- [x] task");
    expect(changes.at(-1)).toBe("title\r\n- [x] task");
    expect(undo(view)).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("keeps raw HTML and frontmatter literal instead of creating active DOM", () => {
    const markdown = [
      "---",
      "title: ordinary text",
      "---",
      "",
      "<script src=\"https://remote.example/x.js\">alert(1)</script>",
    ].join("\n");
    const { host, editor } = fixture(markdown);

    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("[src]")).toBeNull();
    expect(host.textContent?.match(/---/g)).toHaveLength(2);
    expect(host.textContent).toContain("title: ordinary text");
    expect(host.textContent).toContain("<script");
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("uses a text-only image placeholder and never creates a remote image", () => {
    const markdown = "![diagram](https://remote.example/image.png)";
    const { host, editor } = fixture(markdown);
    const placeholder = host.querySelector(".memo-live-markdown-image-placeholder");

    expect(placeholder?.textContent).toContain("diagram");
    expect(placeholder?.textContent).toContain("https://remote.example/image.png");
    expect(placeholder?.querySelector("img")).toBeNull();
    expect(host.querySelector("[src]")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("allows only credential-free absolute HTTPS links", () => {
    expect(safeNavigableMarkdownHref("https://example.test/path?q=1#part")).toBe(
      "https://example.test/path?q=1#part",
    );
    for (const target of [
      "http://example.test",
      "javascript:alert(1)",
      "file:///tmp/note.md",
      "/relative",
      "#fragment",
      "https://user@example.test",
      "not a url",
    ]) {
      expect(safeNavigableMarkdownHref(target)).toBeNull();
    }

    const { host } = fixture(
      "[safe](https://example.test) [blocked](javascript:alert(1))",
    );
    const safe = host.querySelector<HTMLAnchorElement>("a.memo-live-markdown-link");
    const blocked = host.querySelector<HTMLElement>(
      ".memo-live-markdown-link-disabled[data-markdown-link-blocked='true']",
    );
    expect(safe?.target).toBe("_blank");
    expect(safe?.rel).toContain("noopener");
    expect(safe?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(blocked?.textContent).toBe("blocked");
    expect(blocked?.hasAttribute("href")).toBe(false);
  });

  it("suspends only live decoration when pathological input crosses the parse budget", () => {
    const markdown = "[link](https://example.test)\n".repeat(4_097);
    const { host, editor } = fixture(markdown);
    const editorElement = host.querySelector<HTMLElement>(".cm-editor");
    const notice = host.querySelector<HTMLElement>(
      ".memo-live-markdown-fallback-notice",
    );

    expect(editorElement?.dataset.liveDecorationSuspended).toBe("true");
    expect(editorElement?.dataset.liveMarkdown).toBe("true");
    expect(notice?.hidden).toBe(false);
    expect(notice?.getAttribute("role")).toBe("status");
    expect(host.querySelector(".memo-live-markdown-link")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
    expect(editor).not.toHaveProperty("setMode");
  });

  it("reconfigures placeholder and read-only state on the real textbox", () => {
    const { host, editor } = fixture("", { placeholder: "ここから書く" });
    expect(host.querySelector(".cm-placeholder")?.textContent).toBe("ここから書く");

    editor.setPlaceholder("メモを入力");
    expect(host.querySelector(".cm-placeholder")?.textContent).toBe("メモを入力");

    editor.setMarkdown("- [ ] locked");
    editor.setReadOnly(true);
    expect(host.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false");
    expect(host.querySelector(".cm-content")?.getAttribute("aria-readonly")).toBe("true");
    expect(host.querySelector<HTMLInputElement>(".memo-live-markdown-task-checkbox")?.disabled).toBe(true);
    expect(editor.getMarkdown()).toBe("- [ ] locked");
  });
});

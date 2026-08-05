import {
  defaultKeymap,
  history,
  historyKeymap,
  invertedEffects,
  redo,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  type Annotation,
  ChangeSet,
  Compartment,
  EditorState,
  type Extension,
  MapMode,
  Prec,
  type Range,
  StateEffect,
  StateField,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type Command,
  EditorView,
  keymap,
  placeholder as codeMirrorPlaceholder,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import {
  isWithinLiveMarkdownParseBudget,
  memoMarkdownParser,
  memoMarkdownSupport,
} from "./memoMarkdownProfile";

export interface MemoLiveMarkdownEditorOptions {
  parent: HTMLElement;
  markdown?: string;
  readOnly?: boolean;
  placeholder?: string;
  cspNonce?: string;
  onChange?: (markdown: string) => void;
  onBlur?: () => void;
}

export interface MemoLiveMarkdownEditor {
  getMarkdown(): string;
  setMarkdown(markdown: string): void;
  setReadOnly(value: boolean): void;
  setPlaceholder(value: string): void;
  focus(): void;
  requestMeasure(): void;
  destroy(): void;
}

interface SourceRange {
  from: number;
  to: number;
}

interface ListHangingIndentMeasurement {
  line: HTMLElement;
  cacheKey: string;
  indent: number;
}

interface ListHangingIndentMeasurementBatch {
  measurements: readonly ListHangingIndentMeasurement[];
  refreshCache: boolean;
}

interface TableCellModel {
  from: number;
  to: number;
  source: string;
  rowIndex: number;
  columnIndex: number;
  header: boolean;
}

interface TableRowModel {
  cells: readonly TableCellModel[];
}

interface TableModel {
  from: number;
  to: number;
  columnCount: number;
  headers: readonly TableCellModel[];
  rows: readonly (readonly TableCellModel[])[];
}

interface LinkDescription {
  identity: string;
  labelSource: string;
  target: string;
}

interface DecorationBuild {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
}

interface LiveDecorationState extends DecorationBuild {
  requestedRanges: readonly SourceRange[];
}

interface ReferenceDefinition {
  target: string;
}

type ReferenceDefinitions = ReadonlyMap<string, ReferenceDefinition>;
const emptyReferenceDefinitions: ReferenceDefinitions = new Map();
const listMarkerLineClassName = "memo-live-markdown-list-marker-line";
const listLineFromAttribute = "data-memo-list-line-from";
const listContentOffsetAttribute = "data-memo-list-content-offset";
const listIndentCacheKeyAttribute = "data-memo-list-indent-key";
const listHangingIndentProperty =
  "--memo-live-markdown-list-hanging-indent";

interface TableDOMState {
  referenceSignature: string;
}

interface RenderedTableCellState {
  markdownSource: string;
}

const referenceDefinitionSignatureCache = new WeakMap<
  ReferenceDefinitions,
  string
>();
const tableDOMState = new WeakMap<HTMLElement, TableDOMState>();
const renderedTableCellState = new WeakMap<HTMLElement, RenderedTableCellState>();
const tableFocusGeneration = new WeakMap<EditorView, number>();

function referenceDefinitionsSignature(
  references: ReferenceDefinitions,
): string {
  const cached = referenceDefinitionSignatureCache.get(references);
  if (cached !== undefined) {
    return cached;
  }
  const signature = JSON.stringify([...references]);
  referenceDefinitionSignatureCache.set(references, signature);
  return signature;
}

interface MarkdownSyntaxNode {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly firstChild: MarkdownSyntaxNode | null;
  readonly nextSibling: MarkdownSyntaxNode | null;
  readonly parent: MarkdownSyntaxNode | null;
}

function inlineCodeContentBounds(node: MarkdownSyntaxNode): SourceRange {
  let from = node.from;
  let to = node.to;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name !== "CodeMark") {
      continue;
    }
    if (child.from === node.from) {
      from = child.to;
    } else {
      to = child.from;
    }
  }
  return { from, to };
}

function normalizeInlineCodeText(value: string): string {
  const normalized = value.replace(/\n/g, " ");
  return normalized.startsWith(" ") &&
    normalized.endsWith(" ") &&
    /[^ ]/.test(normalized)
    ? normalized.slice(1, -1)
    : normalized;
}

const setLiveParsingEnabled = StateEffect.define<boolean>();
const refreshLiveDecorations = StateEffect.define<void>();
const setLiveDecorationRanges = StateEffect.define<readonly SourceRange[]>();
let memoLiveEditorInstanceCounter = 0;

interface ParsedMarkdownLines {
  normalized: string;
  separators: readonly string[];
  preferredSeparator: string;
}

function parseMarkdownLines(markdown: string): ParsedMarkdownLines {
  const lines: string[] = [];
  const separators: string[] = [];
  const separatorPattern = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = separatorPattern.exec(markdown); match !== null; match = separatorPattern.exec(markdown)) {
    lines.push(markdown.slice(start, match.index));
    separators.push(match[0]);
    start = match.index + match[0].length;
  }
  lines.push(markdown.slice(start));
  return {
    normalized: lines.join("\n"),
    separators,
    preferredSeparator: separators[0] ?? "\n",
  };
}

function serializeMarkdownLines(
  state: EditorState,
  separators: readonly string[],
): string {
  let markdown = "";
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    markdown += state.doc.line(lineNumber).text;
    if (lineNumber < state.doc.lines) {
      markdown += separators[lineNumber - 1] ?? "\n";
    }
  }
  return markdown;
}

function rawOffsetAt(
  state: EditorState,
  separators: readonly string[],
  position: number,
): number {
  const line = state.doc.lineAt(position);
  let offset = position;
  for (let index = 0; index < line.number - 1; index += 1) {
    offset += (separators[index]?.length ?? 1) - 1;
  }
  return offset;
}

function lineBreakCorrectionChanges(
  actual: string,
  expected: string,
): ChangeSet {
  if (actual === expected) {
    return ChangeSet.empty(actual.length);
  }

  const changes: { from: number; to: number; insert?: string }[] = [];
  let actualIndex = 0;
  let expectedIndex = 0;
  while (actualIndex < actual.length || expectedIndex < expected.length) {
    if (actual[actualIndex] === expected[expectedIndex]) {
      actualIndex += 1;
      expectedIndex += 1;
      continue;
    }
    if (
      actual[actualIndex] === "\r" &&
      actual[actualIndex + 1] === "\n" &&
      expected[expectedIndex] === "\n"
    ) {
      changes.push({ from: actualIndex, to: actualIndex + 1 });
      actualIndex += 1;
      continue;
    }
    if (
      actual[actualIndex] === "\r" &&
      expected[expectedIndex] === "\n"
    ) {
      changes.push({
        from: actualIndex,
        to: actualIndex + 1,
        insert: "\n",
      });
      actualIndex += 1;
      expectedIndex += 1;
      continue;
    }
    if (actual[actualIndex] === "\n") {
      changes.push({ from: actualIndex, to: actualIndex + 1 });
      actualIndex += 1;
      continue;
    }
    if (expected[expectedIndex] === "\n") {
      changes.push({
        from: actualIndex,
        to: actualIndex,
        insert: "\n",
      });
      expectedIndex += 1;
      continue;
    }

    let prefix = 0;
    const sharedLength = Math.min(actual.length, expected.length);
    while (prefix < sharedLength && actual[prefix] === expected[prefix]) {
      prefix += 1;
    }
    let actualSuffix = actual.length;
    let expectedSuffix = expected.length;
    while (
      actualSuffix > prefix &&
      expectedSuffix > prefix &&
      actual[actualSuffix - 1] === expected[expectedSuffix - 1]
    ) {
      actualSuffix -= 1;
      expectedSuffix -= 1;
    }
    return ChangeSet.of(
      {
        from: prefix,
        to: actualSuffix,
        insert: expected.slice(prefix, expectedSuffix),
      },
      actual.length,
      "\n",
    );
  }
  return ChangeSet.of(changes, actual.length, "\n");
}

function containsFilePayload(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) {
    return false;
  }
  if (dataTransfer.files.length > 0) {
    return true;
  }
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

const localFileDropGuard = Prec.highest(
  EditorView.domEventHandlers({
    dragover(event) {
      if (!containsFilePayload(event.dataTransfer)) {
        return false;
      }
      event.preventDefault();
      if (event.dataTransfer !== null) {
        event.dataTransfer.dropEffect = "none";
      }
      return true;
    },
    drop(event) {
      if (!containsFilePayload(event.dataTransfer)) {
        return false;
      }
      event.preventDefault();
      return true;
    },
  }),
);

const markdownListPrefix =
  /^([ \t]*(?:>[ \t]?)*[ \t]*)([-+*]|(\d+)([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;
const emptyMarkdownListIndentPrefix =
  /^([ \t]*(?:>[ \t]?)*[ \t]*)([-+*]|(\d+)([.)]))[ \t](\[[ xX]\][ \t])?( *)$/;
const markdownQuotePrefix = /^([ \t]*(?:>[ \t]?)+)/;
const maximumAdditionalListMarkerIndentSpaces = 3;

interface MarkdownListPrefixMatch {
  source: string;
  container: string;
  marker: string;
  orderedNumber: string | undefined;
  delimiter: string;
  spacing: string;
  task: string | undefined;
}

interface EmptyMarkdownListPrefixMatch extends MarkdownListPrefixMatch {
  pendingSpaces: string;
}

interface PendingChildListMarker {
  from: number;
  to: number;
  displayMarker: string;
  ordered: boolean;
}

interface ExitedMarkdownListItem {
  position: number;
  prefix: string;
}

interface StrippedMarkdownListMarker {
  position: number;
  lineText: string;
  outdentedLineText: string;
}

function isPartialMarkdownListMarker(source: string): boolean {
  return (
    source.length === 0 ||
    /^[-+*]$/.test(source) ||
    /^\d+(?:[.)])?$/.test(source)
  );
}

function isCompletedMarkdownListMarker(source: string): boolean {
  return /^(?:[-+*]|\d+[.)]) $/.test(source);
}

function isTrackedMarkdownListMarker(source: string): boolean {
  return (
    isPartialMarkdownListMarker(source) ||
    isCompletedMarkdownListMarker(source)
  );
}

const setExitedMarkdownListItem = StateEffect.define<
  ExitedMarkdownListItem | null
>();
const exitedMarkdownListItemField = StateField.define<
  ExitedMarkdownListItem | null
>({
  create: () => null,
  update(current, transaction) {
    for (let index = transaction.effects.length - 1; index >= 0; index -= 1) {
      const effect = transaction.effects[index];
      if (effect?.is(setExitedMarkdownListItem)) {
        return effect.value;
      }
    }
    if (current === null || transaction.docChanged) {
      return null;
    }
    const selection = transaction.state.selection.main;
    return selection.empty && selection.head === current.position
      ? current
      : null;
  },
});

const setStrippedMarkdownListMarker = StateEffect.define<
  StrippedMarkdownListMarker | null
>();
const strippedMarkdownListMarkerField = StateField.define<
  StrippedMarkdownListMarker | null
>({
  create: () => null,
  update(current, transaction) {
    for (let index = transaction.effects.length - 1; index >= 0; index -= 1) {
      const effect = transaction.effects[index];
      if (effect?.is(setStrippedMarkdownListMarker)) {
        return effect.value;
      }
    }
    if (current === null) {
      return null;
    }
    if (transaction.docChanged) {
      if (transaction.isUserEvent("input.type.compose")) {
        return null;
      }
      const position = transaction.changes.mapPos(current.position, -1);
      const line = transaction.state.doc.lineAt(position);
      const selection = transaction.state.selection.main;
      const markerSource = line.text.slice(current.lineText.length);
      return position === line.from + current.lineText.length &&
        line.text.startsWith(current.lineText) &&
        isTrackedMarkdownListMarker(markerSource) &&
        selection.empty &&
        selection.head === line.to
        ? { ...current, position }
        : null;
    }
    const selection = transaction.state.selection.main;
    const line = transaction.state.doc.lineAt(current.position);
    const markerSource = line.text.slice(current.lineText.length);
    return current.position === line.from + current.lineText.length &&
      line.text.startsWith(current.lineText) &&
      isTrackedMarkdownListMarker(markerSource) &&
      selection.empty &&
      selection.head === line.to
      ? current
      : null;
  },
});

function matchMarkdownListPrefix(
  source: string,
): MarkdownListPrefixMatch | null {
  const match = markdownListPrefix.exec(source);
  if (match === null) {
    return null;
  }
  return {
    source: match[0],
    container: match[1] ?? "",
    marker: match[2] ?? "-",
    orderedNumber: match[3],
    delimiter: match[4] ?? ".",
    spacing: match[5] ?? " ",
    task: match[6],
  };
}

function markdownQuoteContainer(container: string): string {
  return markdownQuotePrefix.exec(container)?.[1] ?? "";
}

function markdownIndentWidth(container: string): number {
  const quote = markdownQuoteContainer(container);
  let width = 0;
  for (const character of container.slice(quote.length)) {
    width = character === "\t" ? width + (4 - (width % 4)) : width + 1;
  }
  return width;
}

function isShallowerListPrefix(
  current: MarkdownListPrefixMatch,
  candidate: MarkdownListPrefixMatch,
): boolean {
  return (
    markdownQuoteContainer(candidate.container) ===
      markdownQuoteContainer(current.container) &&
    markdownIndentWidth(candidate.container) <
      markdownIndentWidth(current.container)
  );
}

function parentMarkdownListPrefix(
  state: EditorState,
  position: number,
  current: MarkdownListPrefixMatch,
): MarkdownListPrefixMatch | null {
  let node = syntaxTree(state).resolveInner(Math.max(0, position - 1), -1);
  while (node.name !== "ListItem") {
    const parent = node.parent;
    if (parent === null) {
      return null;
    }
    node = parent;
  }

  let ancestor = node.parent?.parent ?? null;
  while (ancestor !== null && ancestor.name !== "ListItem") {
    ancestor = ancestor.parent;
  }
  if (ancestor === null) {
    const line = state.doc.lineAt(position);
    for (let lineNumber = line.number - 1; lineNumber >= 1; lineNumber -= 1) {
      const candidateLine = state.doc.line(lineNumber);
      if (candidateLine.text.trim().length === 0) {
        break;
      }
      const candidate = matchMarkdownListPrefix(candidateLine.text);
      if (candidate !== null && isShallowerListPrefix(current, candidate)) {
        return candidate;
      }
    }
    return null;
  }
  const candidate = matchMarkdownListPrefix(state.doc.lineAt(ancestor.from).text);
  return candidate !== null && isShallowerListPrefix(current, candidate)
    ? candidate
    : null;
}

function matchEmptyMarkdownListPrefix(
  source: string,
): EmptyMarkdownListPrefixMatch | null {
  const match = emptyMarkdownListIndentPrefix.exec(source);
  if (match === null) {
    return null;
  }
  return {
    source: match[0],
    container: match[1] ?? "",
    marker: match[2] ?? "-",
    orderedNumber: match[3],
    delimiter: match[4] ?? ".",
    spacing: " ",
    task: match[5],
    pendingSpaces: match[6] ?? "",
  };
}

function listContentIndentWidth(list: MarkdownListPrefixMatch): number {
  return list.marker.length + list.spacing.length;
}

function nestedMarkdownListPrefix(
  list: MarkdownListPrefixMatch,
  indentWidth: number,
): string {
  const nestedMarker =
    list.orderedNumber === undefined ? list.marker : `1${list.delimiter}`;
  const nestedTask =
    list.task === undefined ? "" : `[ ]${list.task.slice(3)}`;
  return `${list.container}${" ".repeat(indentWidth)}${nestedMarker} ${nestedTask}`;
}

function continuedMarkdownListPrefix(list: MarkdownListPrefixMatch): string {
  const nextMarker =
    list.orderedNumber === undefined
      ? list.marker
      : `${Number(list.orderedNumber) + 1}${list.delimiter}`;
  const nextTask =
    list.task === undefined ? "" : `[ ]${list.task.slice(3)}`;
  return `${list.container}${nextMarker}${list.spacing}${nextTask}`;
}

function previousContinuedListItem(
  state: EditorState,
  lineNumber: number,
  current: EmptyMarkdownListPrefixMatch,
): MarkdownListPrefixMatch | null {
  if (lineNumber <= 1) {
    return null;
  }
  const previousLine = state.doc.line(lineNumber - 1);
  const previous = matchMarkdownListPrefix(previousLine.text);
  if (
    previous === null ||
    previousLine.text.slice(previous.source.length).trim().length === 0 ||
    previous.container !== current.container ||
    (previous.task === undefined) !== (current.task === undefined)
  ) {
    return null;
  }
  if (previous.orderedNumber === undefined) {
    return current.orderedNumber === undefined &&
      previous.marker === current.marker
      ? previous
      : null;
  }
  if (
    current.orderedNumber === undefined ||
    previous.delimiter !== current.delimiter
  ) {
    return null;
  }
  const previousNumber = Number(previous.orderedNumber);
  return Number.isSafeInteger(previousNumber) &&
    String(previousNumber + 1) === current.orderedNumber
    ? previous
    : null;
}

function previousListItemAtChildPosition(
  state: EditorState,
  lineNumber: number,
  source: string,
): MarkdownListPrefixMatch | null {
  if (lineNumber <= 1) {
    return null;
  }
  const previousLine = state.doc.line(lineNumber - 1);
  const previous = matchMarkdownListPrefix(previousLine.text);
  if (
    previous === null ||
    previousLine.text.slice(previous.source.length).trim().length === 0
  ) {
    return null;
  }
  const childPosition = `${previous.container}${" ".repeat(
    listContentIndentWidth(previous),
  )}`;
  return source === childPosition ? previous : null;
}

function previousListItemAtPendingChildPosition(
  state: EditorState,
  lineNumber: number,
  source: string,
): MarkdownListPrefixMatch | null {
  for (
    let additionalSpaces = 0;
    additionalSpaces <= maximumAdditionalListMarkerIndentSpaces;
    additionalSpaces += 1
  ) {
    if (additionalSpaces > source.length) {
      break;
    }
    const baseSource = source.slice(0, source.length - additionalSpaces);
    if (source !== `${baseSource}${" ".repeat(additionalSpaces)}`) {
      continue;
    }
    const parent = previousListItemAtChildPosition(
      state,
      lineNumber,
      baseSource,
    );
    if (parent !== null) {
      return parent;
    }
  }
  return null;
}

function pendingChildListMarkerOnLine(
  state: EditorState,
  lineNumber: number,
): PendingChildListMarker | null {
  if (lineNumber <= 1 || lineNumber > state.doc.lines) {
    return null;
  }
  const line = state.doc.line(lineNumber);
  const markerMatch = /([-+*]|\d+[.)])[ \t]+$/.exec(line.text);
  if (markerMatch === null) {
    return null;
  }
  const markerOffset = markerMatch.index;
  const childPosition = line.text.slice(0, markerOffset);
  const parent = previousListItemAtPendingChildPosition(
    state,
    line.number,
    childPosition,
  );
  if (parent === null) {
    return null;
  }
  const markerSource = markerMatch[1] ?? "-";
  const ordered = /^\d+[.)]$/.test(markerSource);
  return {
    from: line.from + markerOffset,
    to: line.from + markerOffset + markerSource.length,
    ordered,
    displayMarker: /^[-+*]$/.test(markerSource)
      ? "•"
      : markerSource.replace(/[.)]$/, "."),
  };
}

function pendingChildListMarkersInRanges(
  state: EditorState,
  ranges: readonly SourceRange[],
): readonly PendingChildListMarker[] {
  const markers = new Map<number, PendingChildListMarker>();
  for (const range of ranges) {
    const firstLine = state.doc.lineAt(range.from).number;
    const lastLine = state.doc.lineAt(range.to).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
      const marker = pendingChildListMarkerOnLine(state, lineNumber);
      if (
        marker !== null &&
        marker.from < range.to &&
        marker.to > range.from
      ) {
        markers.set(marker.from, marker);
      }
    }
  }
  return [...markers.values()].sort((left, right) => left.from - right.from);
}

function insertAtMarkdownChildPosition(
  view: EditorView,
  source: string,
): boolean {
  if (
    source.length === 0 ||
    view.state.readOnly ||
    view.composing ||
    !view.state.selection.main.empty
  ) {
    return false;
  }
  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  if (
    position !== line.to ||
    previousListItemAtChildPosition(
      view.state,
      line.number,
      line.text,
    ) === null
  ) {
    return false;
  }
  view.dispatch({
    changes: { from: position, insert: source },
    selection: { anchor: position + source.length },
    userEvent: "input.type",
  });
  return true;
}

function insertMarkdownChildMarkerStart(markerStart: string): Command {
  return (view) => insertAtMarkdownChildPosition(view, markerStart);
}

const markdownChildMarkerStartKeymap = [
  "-",
  "+",
  "*",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
].map((markerStart) => ({
  key: markerStart,
  run: insertMarkdownChildMarkerStart(markerStart),
}));

const markdownChildMinusKeyCodeGuard = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (
        (event.code !== "Minus" && event.code !== "NumpadSubtract") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return false;
      }
      if (!insertAtMarkdownChildPosition(view, "-")) {
        return false;
      }
      event.preventDefault();
      return true;
    },
  }),
);

const markdownChildPositionInputHandler = Prec.highest(
  EditorView.inputHandler.of((view, _from, _to, text) =>
    /[\r\n]/.test(text)
      ? false
      : insertAtMarkdownChildPosition(view, text),
  ),
);

const indentEmptyMarkdownListItem: Command = (view) => {
  if (view.state.readOnly || view.composing || !view.state.selection.main.empty) {
    return false;
  }

  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  if (position !== line.to) {
    return false;
  }
  const list = matchEmptyMarkdownListPrefix(line.text);
  if (list === null) {
    return false;
  }

  const parent = previousContinuedListItem(view.state, line.number, list);
  const indentWidth = listContentIndentWidth(parent ?? list);
  const pendingSpaces = list.pendingSpaces;
  if (pendingSpaces.length + 1 < indentWidth) {
    view.dispatch({
      changes: { from: position, insert: " " },
      selection: { anchor: position + 1 },
      userEvent: "input.type",
    });
    return true;
  }

  const nestedPrefix = nestedMarkdownListPrefix(list, indentWidth);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: nestedPrefix },
    selection: { anchor: line.from + nestedPrefix.length },
    userEvent: "input.type",
  });
  return true;
};

function enterMarkdownMarkup(
  view: EditorView,
  listAction: "nest" | "continue",
): boolean {
  if (view.state.readOnly || view.composing || !view.state.selection.main.empty) {
    return false;
  }

  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  const beforeCursor = line.text.slice(0, position - line.from);
  const list = matchMarkdownListPrefix(beforeCursor);
  if (list !== null) {
    const content = line.text.slice(list.source.length);
    if (content.trim().length === 0) {
      view.dispatch({
        changes: { from: line.from, to: line.from + list.source.length },
        selection: { anchor: line.from },
        effects: setExitedMarkdownListItem.of({
          position: line.from,
          prefix: list.source,
        }),
        userEvent: "input",
      });
      return true;
    }

    const nextPrefix =
      listAction === "nest"
        ? nestedMarkdownListPrefix(list, listContentIndentWidth(list))
        : continuedMarkdownListPrefix(list);
    const insertion = `${view.state.lineBreak}${nextPrefix}`;
    view.dispatch({
      changes: { from: position, insert: insertion },
      selection: { anchor: position + insertion.length },
      userEvent: "input",
    });
    return true;
  }

  const quote = markdownQuotePrefix.exec(beforeCursor);
  if (quote === null) {
    return false;
  }
  const prefix = quote[1] ?? "";
  const content = line.text.slice(prefix.length);
  if (content.trim().length === 0) {
    view.dispatch({
      changes: { from: line.from, to: line.from + prefix.length },
      selection: { anchor: line.from },
      userEvent: "input",
    });
    return true;
  }

  const insertion = `${view.state.lineBreak}${prefix}`;
  view.dispatch({
    changes: { from: position, insert: insertion },
    selection: { anchor: position + insertion.length },
    userEvent: "input",
  });
  return true;
}

const nestMarkdownMarkup: Command = (view) =>
  enterMarkdownMarkup(view, "nest");
const continueMarkdownMarkupAtSameLevel: Command = (view) =>
  enterMarkdownMarkup(view, "continue");

const deleteMarkdownMarkupBackward: Command = (view) => {
  if (view.state.readOnly || view.composing || !view.state.selection.main.empty) {
    return false;
  }

  const position = view.state.selection.main.head;
  const line = view.state.doc.lineAt(position);
  const exitedListItem = view.state.field(exitedMarkdownListItemField);
  if (
    exitedListItem !== null &&
    position === exitedListItem.position &&
    position === line.from &&
    line.text.length === 0
  ) {
    view.dispatch({
      changes: { from: position, insert: exitedListItem.prefix },
      selection: { anchor: position + exitedListItem.prefix.length },
      effects: setExitedMarkdownListItem.of(null),
      userEvent: "delete.backward",
    });
    return true;
  }
  const strippedListMarker = view.state.field(
    strippedMarkdownListMarkerField,
  );
  if (
    strippedListMarker !== null &&
    position === strippedListMarker.position &&
    position === line.from + strippedListMarker.lineText.length &&
    line.text === strippedListMarker.lineText
  ) {
    view.dispatch({
      changes: {
        from: line.from,
        to: position,
        insert: strippedListMarker.outdentedLineText,
      },
      selection: {
        anchor: line.from + strippedListMarker.outdentedLineText.length,
      },
      effects: setStrippedMarkdownListMarker.of(null),
      userEvent: "delete.backward",
    });
    return true;
  }
  const beforeCursor = line.text.slice(0, position - line.from);
  const emptyList =
    position === line.to
      ? matchEmptyMarkdownListPrefix(beforeCursor)
      : null;
  const pendingSpaces = emptyList?.pendingSpaces ?? "";
  if (pendingSpaces.length > 0) {
    view.dispatch({
      changes: { from: position - 1, to: position },
      selection: { anchor: position - 1 },
      userEvent: "delete.backward",
    });
    return true;
  }
  if (emptyList !== null) {
    const continuedParent = previousContinuedListItem(
      view.state,
      line.number,
      emptyList,
    );
    if (continuedParent !== null) {
      const childPosition = `${emptyList.container}${" ".repeat(
        listContentIndentWidth(continuedParent),
      )}`;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: childPosition },
        selection: { anchor: line.from + childPosition.length },
        effects: setStrippedMarkdownListMarker.of({
          position: line.from + childPosition.length,
          lineText: childPosition,
          outdentedLineText: emptyList.container,
        }),
        userEvent: "delete.backward",
      });
      return true;
    }
  }
  if (emptyList !== null && emptyList.task === undefined) {
    const parent = parentMarkdownListPrefix(
      view.state,
      position,
      emptyList,
    );
    if (parent !== null && parent.container !== emptyList.container) {
      const markerFrom = line.from + emptyList.container.length;
      view.dispatch({
        changes: { from: markerFrom, to: position },
        selection: { anchor: markerFrom },
        effects: [
          setExitedMarkdownListItem.of(null),
          setStrippedMarkdownListMarker.of({
            position: markerFrom,
            lineText: emptyList.container,
            outdentedLineText: parent.container,
          }),
        ],
        userEvent: "delete.backward",
      });
      return true;
    }
  }
  const prefix =
    matchMarkdownListPrefix(beforeCursor)?.source ??
    markdownQuotePrefix.exec(beforeCursor)?.[0];
  if (prefix === undefined || position !== line.from + prefix.length) {
    return false;
  }

  view.dispatch({
    changes: { from: line.from, to: position },
    selection: { anchor: line.from },
    userEvent: "delete.backward",
  });
  return true;
};

const preserveStrippedMarkdownListMarkerInput = Prec.highest(
  EditorView.inputHandler.of((view, _from, _to, text) => {
    if (
      view.state.readOnly ||
      view.composing ||
      text.length === 0 ||
      /[\r\n]/.test(text) ||
      !view.state.selection.main.empty
    ) {
      return false;
    }

    const strippedMarker = view.state.field(strippedMarkdownListMarkerField);
    if (strippedMarker === null) {
      return false;
    }
    const selection = view.state.selection.main;
    const line = view.state.doc.lineAt(strippedMarker.position);
    if (
      strippedMarker.position !== line.from + strippedMarker.lineText.length ||
      !line.text.startsWith(strippedMarker.lineText) ||
      selection.head !== line.to
    ) {
      return false;
    }

    const currentMarkerSource = line.text.slice(strippedMarker.lineText.length);
    if (!isTrackedMarkdownListMarker(currentMarkerSource)) {
      return false;
    }
    const nextMarkerSource = `${currentMarkerSource}${text}`;
    const markerStillTracked = isTrackedMarkdownListMarker(nextMarkerSource);
    const anchor = selection.head + text.length;
    view.dispatch({
      changes: { from: selection.head, insert: text },
      selection: { anchor },
      effects: markerStillTracked
        ? []
        : [setStrippedMarkdownListMarker.of(null)],
      userEvent: "input.type",
    });
    return true;
  }),
);

class TextWidget extends WidgetType {
  readonly text: string;
  readonly className: string;

  constructor(text: string, className: string) {
    super();
    this.text = text;
    this.className = className;
  }

  override eq(other: TextWidget): boolean {
    return other.text === this.text && other.className === this.className;
  }

  override toDOM(): HTMLElement {
    const element = document.createElement("span");
    element.className = this.className;
    element.textContent = this.text;
    return element;
  }
}

function markdownListMarkerClassName(
  task: boolean,
  ordered: boolean,
  nested: boolean,
): string {
  if (task) {
    return "memo-live-markdown-list-marker memo-live-markdown-list-marker-task";
  }
  return ordered && nested
    ? "memo-live-markdown-list-marker memo-live-markdown-list-marker-nested-ordered"
    : "memo-live-markdown-list-marker";
}

function isNestedMarkdownListMarker(node: MarkdownSyntaxNode): boolean {
  let listItemCount = 0;
  let current = node.parent;
  while (current !== null) {
    if (current.name === "ListItem") {
      listItemCount += 1;
      if (listItemCount > 1) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

class HorizontalRuleWidget extends WidgetType {
  override eq(other: HorizontalRuleWidget): boolean {
    return other instanceof HorizontalRuleWidget;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "memo-live-markdown-horizontal-rule";
    const rule = document.createElement("hr");
    wrapper.append(rule);
    return wrapper;
  }
}

class ImagePlaceholderWidget extends WidgetType {
  readonly identity: string;
  readonly alt: string;
  readonly target: string;

  constructor(identity: string, alt: string, target: string) {
    super();
    this.identity = identity;
    this.alt = alt;
    this.target = target;
  }

  override eq(other: ImagePlaceholderWidget): boolean {
    return other.identity === this.identity;
  }

  override toDOM(): HTMLElement {
    const placeholder = document.createElement("span");
    placeholder.className = "memo-live-markdown-image-placeholder";
    placeholder.setAttribute("role", "img");
    placeholder.setAttribute(
      "aria-label",
      this.alt.length > 0 ? `Image: ${this.alt}` : "Image placeholder",
    );

    const icon = document.createElement("span");
    icon.className = "memo-live-markdown-image-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▧";

    const alt = document.createElement("span");
    alt.className = "memo-live-markdown-image-alt";
    alt.textContent = this.alt.length > 0 ? this.alt : "Image";

    placeholder.append(icon, alt);

    if (this.target.length > 0) {
      const target = document.createElement("span");
      target.className = "memo-live-markdown-image-target";
      target.textContent = this.target;
      placeholder.append(target);
    }

    return placeholder;
  }
}

class LinkWidget extends WidgetType {
  readonly description: LinkDescription;
  readonly references: ReferenceDefinitions;
  readonly referenceSignature: string;

  constructor(
    description: LinkDescription,
    references: ReferenceDefinitions,
  ) {
    super();
    this.description = description;
    this.references = references;
    this.referenceSignature = referenceDefinitionsSignature(references);
  }

  override eq(other: LinkWidget): boolean {
    return (
      other.description.identity === this.description.identity &&
      other.referenceSignature === this.referenceSignature
    );
  }

  override toDOM(): HTMLElement {
    return createRenderedLink(this.description, this.references);
  }

  override ignoreEvent(event: Event): boolean {
    if (event.type !== "keydown") {
      return true;
    }
    const keyboardEvent = event as KeyboardEvent;
    const historyModifier = keyboardEvent.metaKey || keyboardEvent.ctrlKey;
    const historyKey = keyboardEvent.key.toLowerCase();
    return !(
      historyModifier &&
      !keyboardEvent.altKey &&
      (historyKey === "z" || historyKey === "y")
    );
  }
}

class TaskWidget extends WidgetType {
  readonly markerFrom: number;
  readonly checked: boolean;
  readonly readOnly: boolean;

  constructor(markerFrom: number, checked: boolean, readOnly: boolean) {
    super();
    this.markerFrom = markerFrom;
    this.checked = checked;
    this.readOnly = readOnly;
  }

  override eq(other: TaskWidget): boolean {
    return (
      other.markerFrom === this.markerFrom &&
      other.checked === this.checked &&
      other.readOnly === this.readOnly
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "memo-live-markdown-task";

    const checkbox = document.createElement("input");
    checkbox.className = "memo-live-markdown-task-checkbox";
    checkbox.type = "checkbox";
    this.updateCheckbox(checkbox);
    checkbox.addEventListener("change", () => {
      const markerFrom = Number(checkbox.dataset.markerFrom);
      if (!Number.isSafeInteger(markerFrom)) {
        return;
      }
      const marker = view.state.doc.sliceString(markerFrom, markerFrom + 3);
      if (view.state.readOnly) {
        checkbox.checked = /^\[[xX]\]$/.test(marker);
        return;
      }

      if (!/^\[[ xX]\]$/.test(marker)) {
        checkbox.checked = false;
        return;
      }

      view.dispatch({
        changes: {
          from: markerFrom + 1,
          to: markerFrom + 2,
          insert: checkbox.checked ? "x" : " ",
        },
        annotations: Transaction.userEvent.of("input"),
      });
    });

    wrapper.append(checkbox);
    return wrapper;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const checkbox = dom.querySelector<HTMLInputElement>(
      ".memo-live-markdown-task-checkbox",
    );
    if (checkbox === null) {
      return false;
    }
    this.updateCheckbox(checkbox);
    return true;
  }

  override ignoreEvent(event: Event): boolean {
    if (event.type !== "keydown") {
      return true;
    }
    const keyboardEvent = event as KeyboardEvent;
    const historyModifier = keyboardEvent.metaKey || keyboardEvent.ctrlKey;
    const historyKey = keyboardEvent.key.toLowerCase();
    return !(
      historyModifier &&
      !keyboardEvent.altKey &&
      (historyKey === "z" || historyKey === "y")
    );
  }

  private updateCheckbox(checkbox: HTMLInputElement): void {
    checkbox.dataset.markerFrom = String(this.markerFrom);
    checkbox.checked = this.checked;
    checkbox.disabled = this.readOnly;
    checkbox.setAttribute(
      "aria-label",
      this.checked ? "Mark task incomplete" : "Mark task complete",
    );
  }
}

function flatTableCells(model: TableModel): readonly TableCellModel[] {
  return [model.headers, ...model.rows].flat();
}

function tableCellAccessibleLabel(cell: TableCellModel): string {
  return cell.header
    ? `Table header column ${cell.columnIndex + 1}`
    : `Table row ${cell.rowIndex + 1} column ${cell.columnIndex + 1}`;
}

function beginTableCellEdit(input: HTMLInputElement): void {
  if (input.disabled) {
    return;
  }
  const cell = input.closest<HTMLTableCellElement>("th, td");
  const rendered = cell?.querySelector<HTMLElement>(
    ".memo-live-markdown-table-cell-rendered",
  );
  if (cell === null || rendered === null || rendered === undefined) {
    return;
  }
  cell.classList.add("memo-live-markdown-table-cell-editing");
  rendered.hidden = true;
  input.hidden = false;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

function endTableCellEdit(input: HTMLInputElement): void {
  const cell = input.closest<HTMLTableCellElement>("th, td");
  const rendered = cell?.querySelector<HTMLElement>(
    ".memo-live-markdown-table-cell-rendered",
  );
  if (cell === null || rendered === null || rendered === undefined) {
    return;
  }
  cell.classList.remove("memo-live-markdown-table-cell-editing");
  rendered.hidden = false;
  input.hidden = true;
}

function commitTableCellInput(
  view: EditorView,
  input: HTMLInputElement,
): boolean {
  if (view.state.readOnly || input.disabled) {
    return false;
  }
  const from = Number(input.dataset.cellFrom);
  const to = Number(input.dataset.cellTo);
  const expectedSource = input.dataset.cellSource;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > view.state.doc.length ||
    expectedSource === undefined
  ) {
    return false;
  }
  const currentSource = view.state.doc.sliceString(from, to);
  if (currentSource !== expectedSource) {
    input.value = currentSource;
    input.dataset.cellSource = currentSource;
    return false;
  }
  if (currentSource === input.value) {
    return false;
  }
  view.dispatch({
    changes: { from, to, insert: input.value },
    annotations: Transaction.userEvent.of("input.type"),
  });
  return true;
}

function emptyTableRowSource(columnCount: number): string {
  const cells = Array.from({ length: columnCount }, () => "").join(" | ");
  return `| ${cells} |`;
}

function focusTableCellAfterUpdate(
  view: EditorView,
  tableFrom: number,
  cellIndex: number,
  expectedDocument: EditorState["doc"],
  expectedGeneration: number,
): void {
  queueMicrotask(() => {
    if (
      view.state.doc !== expectedDocument ||
      (tableFocusGeneration.get(view) ?? 0) !== expectedGeneration
    ) {
      return;
    }
    const scrolls = view.dom.querySelectorAll<HTMLElement>(
      ".memo-live-markdown-table-scroll",
    );
    const scroll = [...scrolls].find(
      (candidate) => Number(candidate.dataset.tableFrom) === tableFrom,
    );
    const input = scroll?.querySelectorAll<HTMLInputElement>(
      ".memo-live-markdown-table-cell-input",
    )[cellIndex];
    if (input !== undefined) {
      beginTableCellEdit(input);
    }
  });
}

function moveToNextTableCell(
  view: EditorView,
  input: HTMLInputElement,
): void {
  commitTableCellInput(view, input);
  if (exitTableFromEmptyTrailingRow(view, input)) {
    return;
  }
  const scroll = input.closest<HTMLElement>(".memo-live-markdown-table-scroll");
  if (scroll === null) {
    return;
  }
  const inputs = [
    ...scroll.querySelectorAll<HTMLInputElement>(
      ".memo-live-markdown-table-cell-input",
    ),
  ];
  const currentIndex = Number(input.dataset.cellIndex);
  const next = inputs[currentIndex + 1];
  if (next !== undefined) {
    beginTableCellEdit(next);
    return;
  }

  const tableFrom = Number(scroll.dataset.tableFrom);
  const tableTo = Number(scroll.dataset.tableTo);
  const columnCount = Number(scroll.dataset.columnCount);
  if (
    !Number.isSafeInteger(tableFrom) ||
    !Number.isSafeInteger(tableTo) ||
    !Number.isSafeInteger(columnCount) ||
    columnCount < 1 ||
    tableTo < tableFrom ||
    tableTo > view.state.doc.length
  ) {
    return;
  }
  const row = emptyTableRowSource(columnCount);
  view.dispatch({
    changes: {
      from: tableTo,
      insert: `${view.state.lineBreak}${row}`,
    },
    annotations: Transaction.userEvent.of("input.type"),
  });
  focusTableCellAfterUpdate(
    view,
    tableFrom,
    inputs.length,
    view.state.doc,
    tableFocusGeneration.get(view) ?? 0,
  );
}

function invalidatePendingTableCellFocus(view: EditorView): void {
  tableFocusGeneration.set(view, (tableFocusGeneration.get(view) ?? 0) + 1);
}

function tableInputFromEvent(event: Event): HTMLInputElement | null {
  const target = event.target;
  return target instanceof HTMLInputElement &&
    target.classList.contains("memo-live-markdown-table-cell-input")
    ? target
    : null;
}

function tableBodyRowContext(input: HTMLInputElement): {
  row: HTMLTableRowElement;
  rows: readonly HTMLTableRowElement[];
} | null {
  const row = input.closest<HTMLTableRowElement>("tbody tr");
  const body = row?.parentElement;
  if (
    row === null ||
    row === undefined ||
    body === null ||
    body === undefined ||
    body.tagName !== "TBODY"
  ) {
    return null;
  }
  return {
    row,
    rows: [...(body as HTMLTableSectionElement).rows],
  };
}

function tableBodyRowIsEmpty(row: HTMLTableRowElement): boolean {
  const inputs = row.querySelectorAll<HTMLInputElement>(
    ".memo-live-markdown-table-cell-input",
  );
  return (
    inputs.length > 0 &&
    [...inputs].every((candidate) => candidate.value.trim().length === 0)
  );
}

function tableSourceLineForInput(
  view: EditorView,
  input: HTMLInputElement,
) {
  const cellFrom = Number(input.dataset.cellFrom);
  if (
    !Number.isSafeInteger(cellFrom) ||
    cellFrom < 0 ||
    cellFrom > view.state.doc.length
  ) {
    return null;
  }
  return view.state.doc.lineAt(cellFrom);
}

function exitTableFromEmptyTrailingRow(
  view: EditorView,
  input: HTMLInputElement,
): boolean {
  const context = tableBodyRowContext(input);
  if (
    context === null ||
    context.rows.length < 2 ||
    context.rows.at(-1) !== context.row ||
    !tableBodyRowIsEmpty(context.row)
  ) {
    return false;
  }
  const line = tableSourceLineForInput(view, input);
  if (line === null) {
    return false;
  }

  invalidatePendingTableCellFocus(view);
  const insert =
    line.to === view.state.doc.length ? view.state.lineBreak : "";
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from },
    annotations: Transaction.userEvent.of("input.type"),
  });
  view.focus();
  return true;
}

function deleteEmptyTableBodyRow(
  view: EditorView,
  input: HTMLInputElement,
  userEvent: "delete.backward" | "delete.forward",
): boolean {
  const context = tableBodyRowContext(input);
  if (
    context === null ||
    context.rows.length < 2 ||
    !tableBodyRowIsEmpty(context.row)
  ) {
    return false;
  }
  const line = tableSourceLineForInput(view, input);
  const scroll = input.closest<HTMLElement>(".memo-live-markdown-table-scroll");
  const cell = input.closest<HTMLTableCellElement>("td");
  if (line === null || scroll === null || cell === null) {
    return false;
  }
  const tableFrom = Number(scroll.dataset.tableFrom);
  const columnCount = Number(scroll.dataset.columnCount);
  const rowIndex = context.rows.indexOf(context.row);
  if (
    !Number.isSafeInteger(tableFrom) ||
    !Number.isSafeInteger(columnCount) ||
    columnCount < 1 ||
    rowIndex < 0
  ) {
    return false;
  }

  const deletingFinalRow = rowIndex === context.rows.length - 1;
  const targetRowIndex = deletingFinalRow ? rowIndex - 1 : rowIndex;
  const targetCellIndex =
    columnCount + targetRowIndex * columnCount + cell.cellIndex;
  const change =
    line.to < view.state.doc.length
      ? {
          from: line.from,
          to: view.state.doc.line(line.number + 1).from,
        }
      : {
          from: view.state.doc.line(line.number - 1).to,
          to: line.to,
        };
  view.dispatch({
    changes: change,
    annotations: Transaction.userEvent.of(userEvent),
  });
  focusTableCellAfterUpdate(
    view,
    tableFrom,
    targetCellIndex,
    view.state.doc,
    tableFocusGeneration.get(view) ?? 0,
  );
  return true;
}

function bindTableWidgetEvents(scroll: HTMLElement, view: EditorView): void {
  scroll.addEventListener("compositionstart", (event) => {
    const input = tableInputFromEvent(event);
    if (input !== null) {
      input.dataset.composing = "true";
    }
  });
  scroll.addEventListener("compositionend", (event) => {
    const input = tableInputFromEvent(event);
    if (input !== null) {
      input.dataset.composing = "false";
      commitTableCellInput(view, input);
    }
  });
  scroll.addEventListener("input", (event) => {
    const input = tableInputFromEvent(event);
    if (
      input === null ||
      (event as InputEvent).isComposing ||
      input.dataset.composing === "true"
    ) {
      return;
    }
    commitTableCellInput(view, input);
  });
  scroll.addEventListener("keydown", (event) => {
    const input = tableInputFromEvent(event);
    if (input !== null) {
      const hasModifier =
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
      const isComposing =
        input.dataset.composing === "true" ||
        event.isComposing ||
        event.keyCode === 229;
      if (isComposing) {
        return;
      }
      if (
        !hasModifier &&
        (event.key === "Backspace" || event.key === "Delete")
      ) {
        if (
          deleteEmptyTableBodyRow(
            view,
            input,
            event.key === "Backspace" ? "delete.backward" : "delete.forward",
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (
        event.key !== "Enter" ||
        hasModifier
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      moveToNextTableCell(view, input);
      return;
    }
    const target = event.target;
    const cell =
      target instanceof Element
        ? target.closest<HTMLTableCellElement>("th, td")
        : null;
    if (
      cell === null ||
      target !== cell ||
      event.key !== "Enter" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    ) {
      return;
    }
    const cellInput = cell.querySelector<HTMLInputElement>(
      ".memo-live-markdown-table-cell-input",
    );
    if (cellInput !== null) {
      event.preventDefault();
      beginTableCellEdit(cellInput);
    }
  });
  scroll.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const cell = target.closest<HTMLTableCellElement>("th, td");
    const input = cell?.querySelector<HTMLInputElement>(
      ".memo-live-markdown-table-cell-input",
    );
    if (
      cell === null ||
      cell === undefined ||
      input === null ||
      input === undefined ||
      input.disabled ||
      target === input ||
      target.closest("a") !== null
    ) {
      return;
    }
    event.preventDefault();
    beginTableCellEdit(input);
  });
  scroll.addEventListener("focusout", (event) => {
    const input = tableInputFromEvent(event);
    if (input === null) {
      return;
    }
    queueMicrotask(() => {
      if (document.activeElement !== input) {
        endTableCellEdit(input);
      }
    });
  });
}

function createTableCellDOM(
  cellModel: TableCellModel,
  cellIndex: number,
  references: ReferenceDefinitions,
  readOnly: boolean,
): HTMLTableCellElement {
  const cell = document.createElement(cellModel.header ? "th" : "td");
  if (cellModel.header) {
    (cell as HTMLTableCellElement).scope = "col";
  }

  const rendered = document.createElement("span");
  rendered.className = "memo-live-markdown-table-cell-rendered";

  const input = document.createElement("input");
  input.className = "memo-live-markdown-table-cell-input";
  input.type = "text";
  input.hidden = true;
  input.autocomplete = "off";
  input.spellcheck = true;

  cell.append(rendered, input);
  syncTableCellDOM(
    cell,
    cellModel,
    cellIndex,
    references,
    true,
    readOnly,
  );
  return cell;
}

function syncTableCellDOM(
  cell: HTMLTableCellElement,
  cellModel: TableCellModel,
  cellIndex: number,
  references: ReferenceDefinitions,
  referencesChanged: boolean,
  readOnly: boolean,
): void {
  const rendered = cell.querySelector<HTMLElement>(
    ".memo-live-markdown-table-cell-rendered",
  );
  const input = cell.querySelector<HTMLInputElement>(
    ".memo-live-markdown-table-cell-input",
  );
  if (rendered === null || input === null) {
    return;
  }
  const renderedState = renderedTableCellState.get(rendered);
  if (renderedState?.markdownSource !== cellModel.source || referencesChanged) {
    rendered.replaceChildren();
    appendRenderedInline(rendered, cellModel.source, references);
    renderedTableCellState.set(rendered, {
      markdownSource: cellModel.source,
    });
  }

  const wasActive = document.activeElement === input;
  const selectionStart = input.selectionStart ?? input.value.length;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  if (input.value !== cellModel.source) {
    input.value = cellModel.source;
    if (wasActive) {
      input.setSelectionRange(
        Math.min(selectionStart, input.value.length),
        Math.min(selectionEnd, input.value.length),
      );
    }
  }
  input.dataset.cellFrom = String(cellModel.from);
  input.dataset.cellTo = String(cellModel.to);
  input.dataset.cellSource = cellModel.source;
  input.dataset.cellIndex = String(cellIndex);
  input.disabled = readOnly;
  input.setAttribute(
    "aria-label",
    `Edit Markdown for ${tableCellAccessibleLabel(cellModel)}`,
  );
  cell.tabIndex = readOnly ? -1 : 0;
  cell.removeAttribute("aria-label");
  cell.removeAttribute("aria-describedby");
  if (readOnly) {
    cell.removeAttribute("aria-keyshortcuts");
  } else {
    cell.setAttribute("aria-keyshortcuts", "Enter");
  }
  if (readOnly && wasActive) {
    endTableCellEdit(input);
  }
}

function syncTableWidgetDOM(
  scroll: HTMLElement,
  model: TableModel,
  references: ReferenceDefinitions,
  referenceSignature: string,
  readOnly: boolean,
): boolean {
  const previousState = tableDOMState.get(scroll);
  const referencesChanged =
    previousState?.referenceSignature !== referenceSignature;
  const cells = [
    ...scroll.querySelectorAll<HTMLTableCellElement>("th, td"),
  ];
  const cellModels = flatTableCells(model);
  if (cells.length !== cellModels.length) {
    return false;
  }
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    const cellModel = cellModels[index];
    if (
      cell === undefined ||
      cellModel === undefined ||
      cell.tagName !== (cellModel.header ? "TH" : "TD")
    ) {
      return false;
    }
    syncTableCellDOM(
      cell,
      cellModel,
      index,
      references,
      referencesChanged,
      readOnly,
    );
  }
  scroll.dataset.tableFrom = String(model.from);
  scroll.dataset.tableTo = String(model.to);
  scroll.dataset.columnCount = String(model.columnCount);
  tableDOMState.set(scroll, { referenceSignature });
  return true;
}

class TableWidget extends WidgetType {
  readonly source: string;
  readonly model: TableModel;
  readonly references: ReferenceDefinitions;
  readonly referenceSignature: string;
  readonly readOnly: boolean;

  constructor(
    source: string,
    model: TableModel,
    references: ReferenceDefinitions,
    readOnly: boolean,
  ) {
    super();
    this.source = source;
    this.model = model;
    this.references = references;
    this.referenceSignature = referenceDefinitionsSignature(references);
    this.readOnly = readOnly;
  }

  override eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.model.from === this.model.from &&
      other.model.to === this.model.to &&
      other.referenceSignature === this.referenceSignature &&
      other.readOnly === this.readOnly
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const scroll = document.createElement("div");
    scroll.className = "memo-live-markdown-table-scroll";
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Markdown table");
    scroll.tabIndex = 0;

    const table = document.createElement("table");
    table.className = "memo-live-markdown-table";

    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const [index, cellModel] of this.model.headers.entries()) {
      headerRow.append(
        createTableCellDOM(
          cellModel,
          index,
          this.references,
          this.readOnly,
        ),
      );
    }
    head.append(headerRow);
    table.append(head);

    const body = document.createElement("tbody");
    let cellIndex = this.model.headers.length;
    for (const rowModel of this.model.rows) {
      const row = document.createElement("tr");
      for (const cellModel of rowModel) {
        row.append(
          createTableCellDOM(
            cellModel,
            cellIndex,
            this.references,
            this.readOnly,
          ),
        );
        cellIndex += 1;
      }
      body.append(row);
    }
    table.append(body);
    scroll.append(table);
    bindTableWidgetEvents(scroll, view);
    tableDOMState.set(scroll, {
      referenceSignature: this.referenceSignature,
    });
    syncTableWidgetDOM(
      scroll,
      this.model,
      this.references,
      this.referenceSignature,
      this.readOnly,
    );
    return scroll;
  }

  override updateDOM(dom: HTMLElement): boolean {
    return syncTableWidgetDOM(
      dom,
      this.model,
      this.references,
      this.referenceSignature,
      this.readOnly,
    );
  }

  override ignoreEvent(event: Event): boolean {
    if (event.type !== "keydown") {
      return true;
    }
    const keyboardEvent = event as KeyboardEvent;
    const historyModifier = keyboardEvent.metaKey || keyboardEvent.ctrlKey;
    const historyKey = keyboardEvent.key.toLowerCase();
    return !(
      historyModifier &&
      !keyboardEvent.altKey &&
      (historyKey === "z" || historyKey === "y")
    );
  }
}

const strictEntityPattern =
  /^&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});$/;

function decodeParsedEntity(source: string): string {
  if (!strictEntityPattern.test(source)) {
    return source;
  }
  const decoded = new DOMParser().parseFromString(source, "text/html");
  return decoded.body.textContent ?? source;
}

function normalizeReferenceLabel(source: string): string {
  const trimmed = source.trim();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeLinkTarget(source: string): string {
  const trimmed = source.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
}

const markdownLinkControlPattern = /[\u0000-\u001F\u007F-\u009F]/u;

export function safeNavigableMarkdownHref(raw: string): string | null {
  if (markdownLinkControlPattern.test(raw)) {
    return null;
  }
  const candidate = normalizeLinkTarget(raw)
    .replace(
      /&(?:#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
      (entity) => decodeParsedEntity(entity),
    )
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .trim();
  if (
    markdownLinkControlPattern.test(candidate) ||
    candidate.includes("\\") ||
    !/^https:\/\//i.test(candidate)
  ) {
    return null;
  }
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function collectReferenceDefinitions(
  state: EditorState,
  requestedLabels: ReadonlySet<string>,
): ReferenceDefinitions {
  const tree = syntaxTree(state);
  const references = new Map<string, ReferenceDefinition>();
  tree.iterate({
    enter(node) {
      if (node.name !== "LinkReference") {
        return;
      }
      let label = "";
      for (
        let child = node.node.firstChild;
        child !== null;
        child = child.nextSibling
      ) {
        if (child.name === "LinkLabel") {
          label = normalizeReferenceLabel(
            state.doc.sliceString(child.from, child.to),
          );
          break;
        }
      }
      if (
        label.length === 0 ||
        !requestedLabels.has(label) ||
        references.has(label)
      ) {
        return false;
      }
      let target = "";
      for (
        let child = node.node.firstChild;
        child !== null;
        child = child.nextSibling
      ) {
        if (child.name === "URL") {
          target = normalizeLinkTarget(
            state.doc.sliceString(child.from, child.to),
          );
          break;
        }
      }
      if (label.length > 0 && target.length > 0 && !references.has(label)) {
        references.set(label, { target });
      }
      return false;
    },
  });
  return references;
}

function referencedLabelsInInlineMarkdown(source: string): ReadonlySet<string> {
  const labels = new Set<string>();
  memoMarkdownParser.parse(source).iterate({
    enter(node) {
      if (
        (node.name !== "Link" && node.name !== "Image") ||
        hasInlineDestination(node.node)
      ) {
        return;
      }
      const label = referenceLabelFromNode(source, node.node, 0);
      if (label.length > 0) {
        labels.add(label);
      }
      return false;
    },
  });
  return labels;
}

function referenceDefinitionsForInlineSources(
  sources: readonly string[],
  referencesForLabels: (
    labels: ReadonlySet<string>,
  ) => ReferenceDefinitions,
): ReferenceDefinitions {
  const labels = new Set<string>();
  for (const source of sources) {
    for (const label of referencedLabelsInInlineMarkdown(source)) {
      labels.add(label);
    }
  }
  if (labels.size === 0) {
    return emptyReferenceDefinitions;
  }
  const references = referencesForLabels(labels);
  const selected = new Map<string, ReferenceDefinition>();
  for (const label of labels) {
    const definition = references.get(label);
    if (definition !== undefined) {
      selected.set(label, definition);
    }
  }
  return selected;
}

interface ImageDescription {
  identity: string;
  alt: string;
  target: string;
}

function directChildrenOf(node: MarkdownSyntaxNode): MarkdownSyntaxNode[] {
  const children: MarkdownSyntaxNode[] = [];
  for (
    let child = node.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    children.push(child);
  }
  return children;
}

function describeLinkFromNode(
  source: string,
  node: MarkdownSyntaxNode,
  references: ReferenceDefinitions,
  sourceOffset: number,
): LinkDescription {
  const slice = (from: number, to: number): string =>
    source.slice(from - sourceOffset, to - sourceOffset);
  const children = directChildrenOf(node);
  const marks = children.filter((child) => child.name === "LinkMark");
  const url = children.find((child) => child.name === "URL");
  const labelSource =
    node.name === "Autolink"
      ? url === undefined
        ? ""
        : slice(url.from, url.to)
      : marks[0] !== undefined && marks[1] !== undefined
        ? slice(marks[0].to, marks[1].from)
        : "";
  let target =
    url === undefined
      ? ""
      : normalizeLinkTarget(slice(url.from, url.to));
  if (target.length === 0 && node.name === "Link") {
    target =
      references.get(referenceLabelFromNode(source, node, sourceOffset))
        ?.target ?? "";
  }
  return {
    identity: `${slice(node.from, node.to)}\u0000${target}`,
    labelSource,
    target,
  };
}

function createRenderedLink(
  description: LinkDescription,
  references: ReferenceDefinitions,
): HTMLElement {
  const href = safeNavigableMarkdownHref(description.target);
  const element = document.createElement(href === null ? "span" : "a");
  element.className =
    href === null
      ? "memo-live-markdown-link memo-live-markdown-link-disabled"
      : "memo-live-markdown-link";
  appendRenderedInline(element, description.labelSource, references, false);
  if (href === null) {
    element.title = "Only HTTPS links can be opened";
    element.dataset.markdownLinkBlocked = "true";
    return element;
  }
  const anchor = element as HTMLAnchorElement;
  anchor.href = href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.setAttribute("referrerpolicy", "no-referrer");
  anchor.setAttribute("contenteditable", "false");
  anchor.title = href;
  anchor.setAttribute(
    "aria-label",
    `${anchor.textContent?.trim() || href} (opens in a new tab)`,
  );
  return anchor;
}

function referenceLabelFromNode(
  source: string,
  node: MarkdownSyntaxNode,
  sourceOffset: number,
): string {
  const slice = (from: number, to: number): string =>
    source.slice(from - sourceOffset, to - sourceOffset);
  const children = directChildrenOf(node);
  const marks = children.filter((child) => child.name === "LinkMark");
  const primaryLabel =
    marks[0] !== undefined && marks[1] !== undefined
      ? slice(marks[0].to, marks[1].from)
      : "";
  const secondaryLabel = children.find(
    (child) => child.name === "LinkLabel",
  );
  const secondarySource =
    secondaryLabel === undefined
      ? ""
      : slice(secondaryLabel.from, secondaryLabel.to);
  const normalizedSecondary = normalizeReferenceLabel(secondarySource);
  return normalizedSecondary.length > 0
    ? normalizedSecondary
    : normalizeReferenceLabel(primaryLabel);
}

function hasInlineDestination(node: MarkdownSyntaxNode): boolean {
  const children = directChildrenOf(node);
  return (
    children.some((child) => child.name === "URL") ||
    children.filter((child) => child.name === "LinkMark").length >= 4
  );
}

function isResolvedInlineNode(
  source: string,
  node: MarkdownSyntaxNode,
  references: ReferenceDefinitions,
  sourceOffset: number,
): boolean {
  return (
    hasInlineDestination(node) ||
    references.has(referenceLabelFromNode(source, node, sourceOffset))
  );
}

function describeImageFromNode(
  source: string,
  node: MarkdownSyntaxNode,
  references: ReferenceDefinitions,
  sourceOffset: number,
): ImageDescription {
  const slice = (from: number, to: number): string =>
    source.slice(from - sourceOffset, to - sourceOffset);
  const imageSource = slice(node.from, node.to);
  const directChildren = directChildrenOf(node);
  const outerMarks = directChildren.filter((child) => child.name === "LinkMark");
  const altSource =
    outerMarks[0] !== undefined && outerMarks[1] !== undefined
      ? slice(outerMarks[0].to, outerMarks[1].from)
      : "";
  const inlineTarget = directChildren.find((child) => child.name === "URL");
  const referenceLabel = directChildren.find(
    (child) => child.name === "LinkLabel",
  );
  let target =
    inlineTarget === undefined
      ? ""
      : normalizeLinkTarget(slice(inlineTarget.from, inlineTarget.to));
  if (target.length === 0) {
    const normalizedLabel =
      referenceLabel === undefined
        ? normalizeReferenceLabel(altSource)
        : normalizeReferenceLabel(
            slice(referenceLabel.from, referenceLabel.to),
          ) || normalizeReferenceLabel(altSource);
    target = references.get(normalizedLabel)?.target ?? "";
  }

  const altContainer = document.createElement("span");
  appendRenderedInline(altContainer, altSource, references);
  const alt = altContainer.textContent ?? altSource;
  return {
    identity: `${imageSource}\u0000${target}`,
    alt,
    target,
  };
}

function appendRenderedInline(
  parent: HTMLElement,
  source: string,
  references: ReferenceDefinitions = new Map(),
  allowInteractiveLinks = true,
): void {
  const tree = memoMarkdownParser.parse(source);
  appendInlineChildren(
    parent,
    source,
    tree.topNode,
    references,
    allowInteractiveLinks,
  );
}

function appendInlineChildren(
  parent: HTMLElement,
  source: string,
  node: MarkdownSyntaxNode,
  references: ReferenceDefinitions,
  allowInteractiveLinks: boolean,
): void {
  let position = node.from;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.from > position) {
      const gap = source.slice(position, child.from);
      const isHiddenLinkTitleGap =
        node.name === "Link" &&
        child.name === "LinkTitle" &&
        /^[ \t]+$/.test(gap);
      if (!isHiddenLinkTitleGap) {
        parent.append(document.createTextNode(gap));
      }
    }
    appendInlineNode(
      parent,
      source,
      child,
      node.name,
      references,
      allowInteractiveLinks,
    );
    position = child.to;
  }
  if (position < node.to) {
    parent.append(document.createTextNode(source.slice(position, node.to)));
  }
}

function appendInlineNode(
  parent: HTMLElement,
  source: string,
  node: MarkdownSyntaxNode,
  parentName: string,
  references: ReferenceDefinitions,
  allowInteractiveLinks: boolean,
): void {
  if (node.name === "Escape") {
    parent.append(
      document.createTextNode(source.slice(node.from + 1, node.to)),
    );
    return;
  }

  if (node.name === "Entity") {
    parent.append(
      document.createTextNode(
        decodeParsedEntity(source.slice(node.from, node.to)),
      ),
    );
    return;
  }

  if (
    node.name === "EmphasisMark" ||
    node.name === "StrikethroughMark" ||
    node.name === "CodeMark" ||
    node.name === "LinkMark" ||
    ((node.name === "URL" ||
      node.name === "LinkLabel" ||
      node.name === "LinkTitle") &&
      parentName === "Link")
  ) {
    return;
  }

  if (node.name === "Image") {
    if (!isResolvedInlineNode(source, node, references, 0)) {
      parent.append(document.createTextNode(source.slice(node.from, node.to)));
      return;
    }
    const description = describeImageFromNode(
      source,
      node,
      references,
      0,
    );
    parent.append(
      new ImagePlaceholderWidget(
        description.identity,
        description.alt,
        description.target,
      ).toDOM(),
    );
    return;
  }

  if (node.name === "Link" || node.name === "Autolink") {
    if (
      node.name === "Link" &&
      !isResolvedInlineNode(source, node, references, 0)
    ) {
      parent.append(document.createTextNode(source.slice(node.from, node.to)));
      return;
    }
    const description = describeLinkFromNode(source, node, references, 0);
    if (!allowInteractiveLinks) {
      const label = document.createElement("span");
      appendRenderedInline(
        label,
        description.labelSource,
        references,
        false,
      );
      parent.append(label);
      return;
    }
    parent.append(
      createRenderedLink(description, references),
    );
    return;
  }

  const semanticElements: Readonly<Record<string, readonly [string, string]>> = {
    Emphasis: ["em", "memo-live-markdown-emphasis"],
    StrongEmphasis: ["strong", "memo-live-markdown-strong"],
    Strikethrough: ["s", "memo-live-markdown-strikethrough"],
  };
  const semantic = semanticElements[node.name];
  if (semantic !== undefined) {
    const element = document.createElement(semantic[0]);
    element.className = semantic[1];
    appendInlineChildren(
      element,
      source,
      node,
      references,
      allowInteractiveLinks,
    );
    parent.append(element);
    return;
  }

  if (node.name === "InlineCode") {
    const code = document.createElement("code");
    code.className = "memo-live-markdown-inline-code";
    const { from, to } = inlineCodeContentBounds(node);
    code.textContent = normalizeInlineCodeText(source.slice(from, to));
    parent.append(code);
    return;
  }

  if (node.firstChild !== null) {
    appendInlineChildren(
      parent,
      source,
      node,
      references,
      allowInteractiveLinks,
    );
    return;
  }
  parent.append(document.createTextNode(source.slice(node.from, node.to)));
}

function findFrontmatterRange(state: EditorState): SourceRange | null {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== "---") {
    return null;
  }

  const lastCandidateLine = Math.min(state.doc.lines, 200);
  let hasYamlLikeEntry = false;
  for (let lineNumber = 2; lineNumber <= lastCandidateLine; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const marker = line.text.trim();
    if (marker === "---" || marker === "...") {
      return hasYamlLikeEntry ? { from: 0, to: line.to } : null;
    }
    if (/^[A-Za-z_][A-Za-z0-9_.-]*\s*:/.test(marker)) {
      hasYamlLikeEntry = true;
    }
  }
  return null;
}

function expandedDecorationRanges(
  state: EditorState,
  requestedRanges?: readonly SourceRange[],
): SourceRange[] {
  const sourceRanges =
    requestedRanges === undefined || requestedRanges.length === 0
      ? [{ from: 0, to: state.doc.length }]
      : requestedRanges;
  const expanded = sourceRanges
    .map((range) => {
      const from = Math.max(0, Math.min(state.doc.length, range.from));
      const to = Math.max(from, Math.min(state.doc.length, range.to));
      return {
        from: state.doc.lineAt(from).from,
        to: state.doc.lineAt(to).to,
      };
    })
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: SourceRange[] = [];
  for (const range of expanded) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function isInside(range: SourceRange | null, from: number, to: number): boolean {
  return range !== null && from >= range.from && to <= range.to;
}

function tableRowModel(
  state: EditorState,
  row: MarkdownSyntaxNode,
  header: boolean,
  rowIndex: number,
): TableRowModel {
  const delimiters = directChildrenOf(row).filter(
    (child) => child.name === "TableDelimiter",
  );
  const segments: SourceRange[] = [];
  let segmentFrom = row.from;
  for (const [index, delimiter] of delimiters.entries()) {
    const isLeadingDelimiter = index === 0 && delimiter.from === row.from;
    if (!isLeadingDelimiter) {
      segments.push({ from: segmentFrom, to: delimiter.from });
    }
    segmentFrom = delimiter.to;
  }
  const lastDelimiter = delimiters.at(-1);
  if (lastDelimiter === undefined || lastDelimiter.to !== row.to) {
    segments.push({ from: segmentFrom, to: row.to });
  }

  const cells = segments.map((segment, columnIndex): TableCellModel => {
    let from = segment.from;
    let to = segment.to;
    while (
      from < to &&
      /[ \t]/.test(state.doc.sliceString(from, from + 1))
    ) {
      from += 1;
    }
    while (
      to > from &&
      /[ \t]/.test(state.doc.sliceString(to - 1, to))
    ) {
      to -= 1;
    }
    if (from === to && segment.from < segment.to) {
      const insertion =
        segment.from + Math.floor((segment.to - segment.from) / 2);
      from = insertion;
      to = insertion;
    }
    return {
      from,
      to,
      source: state.doc.sliceString(from, to),
      rowIndex,
      columnIndex,
      header,
    };
  });
  return { cells };
}

function tableSeparatorModel(
  state: EditorState,
  separator: MarkdownSyntaxNode,
): {
  cells: readonly string[];
} {
  let source = state.doc.sliceString(separator.from, separator.to).trim();
  const leadingPipe = source.startsWith("|");
  const trailingPipe = source.endsWith("|");
  if (leadingPipe) {
    source = source.slice(1);
  }
  if (trailingPipe) {
    source = source.slice(0, -1);
  }
  return {
    cells: source.split("|").map((cell) => cell.trim()),
  };
}

function tableModel(
  state: EditorState,
  table: MarkdownSyntaxNode,
): TableModel | null {
  const children = directChildrenOf(table);
  const headerNode = children.find((child) => child.name === "TableHeader");
  const separatorNode = children.find(
    (child) => child.name === "TableDelimiter",
  );
  const rowNodes = children.filter((child) => child.name === "TableRow");
  if (
    headerNode === undefined ||
    separatorNode === undefined ||
    rowNodes.length === 0
  ) {
    return null;
  }

  const header = tableRowModel(state, headerNode, true, 0);
  const separator = tableSeparatorModel(state, separatorNode);
  const rows = rowNodes.map((row, index) =>
    tableRowModel(state, row, false, index),
  );
  const columnCount = header.cells.length;
  const separatorIsComplete =
    separator.cells.length === columnCount &&
    separator.cells.every((cell) => /^:?-{2,}:?$/.test(cell));
  if (
    columnCount < 1 ||
    !separatorIsComplete ||
    rows.some((row) => row.cells.length !== columnCount)
  ) {
    return null;
  }
  return {
    from: table.from,
    to: table.to,
    columnCount,
    headers: header.cells,
    rows: rows.map((row) => row.cells),
  };
}

function hasAsciiSpaceAfter(
  state: EditorState,
  marker: MarkdownSyntaxNode,
): boolean {
  return state.doc.sliceString(marker.to, marker.to + 1) === " ";
}

function quoteStartTokenEnd(
  state: EditorState,
  marker: MarkdownSyntaxNode,
): number {
  return hasAsciiSpaceAfter(state, marker) ? marker.to + 1 : marker.to;
}

function liveBlockIsActivated(
  state: EditorState,
  node: MarkdownSyntaxNode,
): boolean {
  if (/^SetextHeading[12]$/.test(node.name)) {
    const marker = directChildrenOf(node).find(
      (child) => child.name === "HeaderMark",
    );
    if (marker === undefined) {
      return true;
    }
    const markerLine = state.doc.lineAt(marker.from);
    const pendingChild = pendingChildListMarkerOnLine(
      state,
      markerLine.number,
    );
    if (
      pendingChild !== null &&
      pendingChild.from === marker.from &&
      pendingChild.to === marker.to
    ) {
      return false;
    }
    return !state.selection.ranges.some(
      (range) => range.from <= markerLine.to && range.to >= markerLine.from,
    );
  }
  if (/^ATXHeading[1-6]$/.test(node.name)) {
    const marker = directChildrenOf(node).find(
      (child) => child.name === "HeaderMark",
    );
    return marker !== undefined && hasAsciiSpaceAfter(state, marker);
  }
  if (node.name === "ListItem") {
    const marker = directChildrenOf(node).find(
      (child) => child.name === "ListMark",
    );
    return marker !== undefined && hasAsciiSpaceAfter(state, marker);
  }
  if (node.name === "Blockquote") {
    const markers = directChildrenOf(node).filter(
      (child) => child.name === "QuoteMark",
    );
    return (
      markers.length > 0 &&
      markers.every((marker) => hasAsciiSpaceAfter(state, marker))
    );
  }
  if (node.name === "FencedCode") {
    return (
      directChildrenOf(node).filter((child) => child.name === "CodeMark")
        .length >= 2
    );
  }
  return true;
}

function collectSemanticOrderedMarkers(
  state: EditorState,
  list: MarkdownSyntaxNode,
  markers: Map<number, string>,
): void {
  let start = 1;
  let index = 0;
  let previousItem: MarkdownSyntaxNode | null = null;
  for (
    let sibling = list.firstChild;
    sibling !== null;
    sibling = sibling.nextSibling
  ) {
    if (sibling.name !== "ListItem") {
      continue;
    }
    let siblingMark = sibling.firstChild;
    while (siblingMark !== null && siblingMark.name !== "ListMark") {
      siblingMark = siblingMark.nextSibling;
    }
    const beginsGroup =
      previousItem === null ||
      /\r?\n[ \t]*\r?\n/.test(
        state.doc.sliceString(previousItem.to, sibling.from),
      );
    if (siblingMark !== null && beginsGroup) {
      index = 0;
      const match = /^(\d+)[.)]$/.exec(
        state.doc.sliceString(siblingMark.from, siblingMark.to),
      );
      if (match?.[1] !== undefined) {
        start = Number(match[1]);
      }
    }
    if (siblingMark !== null) {
      markers.set(siblingMark.from, `${start + index}.`);
      index += 1;
    }
    previousItem = sibling;
  }
}

function addLineClasses(
  state: EditorState,
  ranges: Range<Decoration>[],
  from: number,
  to: number,
  className: string,
): void {
  let line = state.doc.lineAt(from);
  while (true) {
    ranges.push(Decoration.line({ class: className }).range(line.from));
    if (line.to >= to || line.number >= state.doc.lines) {
      break;
    }
    line = state.doc.line(line.number + 1);
  }
}

function extendThroughInlineWhitespace(state: EditorState, position: number): number {
  const line = state.doc.lineAt(position);
  let end = position;
  while (end < line.to && /[ \t]/.test(state.doc.sliceString(end, end + 1))) {
    end += 1;
  }
  return end;
}

function buildLiveDecorations(
  state: EditorState,
  requestedRanges?: readonly SourceRange[],
): DecorationBuild {
  const ranges: Range<Decoration>[] = [];
  const atomicRanges: Range<Decoration>[] = [];
  const frontmatter = findFrontmatterRange(state);
  const activeRanges = expandedDecorationRanges(state, requestedRanges);
  const pendingChildListMarkers = pendingChildListMarkersInRanges(
    state,
    activeRanges,
  );
  const tableModelCache = new Map<string, TableModel | null>();
  const requestedReferenceLabels = new Set<string>();
  const seenReferenceNodes = new Set<string>();

  for (const activeRange of activeRanges) {
    syntaxTree(state).iterate({
      from: activeRange.from,
      to: activeRange.to,
      enter(node) {
        const { from, to, name } = node;
        if (
          isInside(frontmatter, from, to) ||
          !liveBlockIsActivated(state, node.node)
        ) {
          return false;
        }

        if (name === "Table") {
          const key = `${name}:${from}:${to}`;
          if (seenReferenceNodes.has(key)) {
            return false;
          }
          seenReferenceNodes.add(key);
          const model = tableModel(state, node.node);
          tableModelCache.set(key, model);
          if (model !== null) {
            for (const cell of flatTableCells(model)) {
              for (const label of referencedLabelsInInlineMarkdown(cell.source)) {
                requestedReferenceLabels.add(label);
              }
            }
          }
          return false;
        }

        if (name !== "Link" && name !== "Image") {
          return;
        }
        const key = `${name}:${from}:${to}`;
        if (seenReferenceNodes.has(key)) {
          return false;
        }
        seenReferenceNodes.add(key);
        const source = state.doc.sliceString(from, to);
        if (!hasInlineDestination(node.node)) {
          const label = referenceLabelFromNode(source, node.node, from);
          if (label.length > 0) {
            requestedReferenceLabels.add(label);
          }
        }
        if (name === "Link") {
          const description = describeLinkFromNode(
            source,
            node.node,
            emptyReferenceDefinitions,
            from,
          );
          for (const label of referencedLabelsInInlineMarkdown(
            description.labelSource,
          )) {
            requestedReferenceLabels.add(label);
          }
        }
        return false;
      },
    });
  }

  const collectedReferences =
    requestedReferenceLabels.size === 0
      ? emptyReferenceDefinitions
      : collectReferenceDefinitions(state, requestedReferenceLabels);
  const targetedReferenceCache = new Map<string, ReferenceDefinitions>();
  const referencesForLabels = (
    labels: ReadonlySet<string>,
  ): ReferenceDefinitions => {
    const requestedLabels = new Set(
      [...labels].filter((label) => label.length > 0),
    );
    if (requestedLabels.size === 0) {
      return emptyReferenceDefinitions;
    }
    const key = JSON.stringify([...requestedLabels].sort());
    const cached = targetedReferenceCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const references = new Map<string, ReferenceDefinition>();
    for (const label of requestedLabels) {
      const definition = collectedReferences.get(label);
      if (definition !== undefined) {
        references.set(label, definition);
      }
    }
    targetedReferenceCache.set(key, references);
    return references;
  };
  const seenWholeNodes = new Set<string>();
  const semanticOrderedMarkers = new Map<number, string>();
  const seenOrderedLists = new Set<string>();
  const pendingChildListMarkerStarts = new Set(
    pendingChildListMarkers.map((marker) => marker.from),
  );
  const listMarkerLines = new Set<number>();

  const addAtomicRange = (from: number, to: number): void => {
    if (from < to) {
      atomicRanges.push(Decoration.mark({}).range(from, to));
    }
  };

  const replaceDisplay = (
    from: number,
    to: number,
    specification: Parameters<typeof Decoration.replace>[0] = {},
    atomic = true,
  ): void => {
    if (from >= to) {
      return;
    }
    const decoration = Decoration.replace(specification);
    ranges.push(decoration.range(from, to));
    if (atomic) {
      addAtomicRange(from, to);
    }
  };

  const addListMarkerLine = (position: number): void => {
    const line = state.doc.lineAt(position);
    if (listMarkerLines.has(line.from)) {
      return;
    }
    const prefix = matchMarkdownListPrefix(line.text);
    if (prefix === null) {
      return;
    }
    listMarkerLines.add(line.from);
    ranges.push(
      Decoration.line({
        attributes: {
          class: listMarkerLineClassName,
          [listLineFromAttribute]: String(line.from),
          [listContentOffsetAttribute]: String(prefix.source.length),
          [listIndentCacheKeyAttribute]: prefix.source,
        },
      }).range(line.from),
    );
  };

  for (const marker of pendingChildListMarkers) {
    if (isInside(frontmatter, marker.from, marker.to)) {
      continue;
    }
    addListMarkerLine(marker.from);
    replaceDisplay(marker.from, marker.to, {
      widget: new TextWidget(
        marker.displayMarker,
        markdownListMarkerClassName(false, marker.ordered, true),
      ),
    });
  }

  const hideSourceLine = (from: number, to: number): void => {
    const line = state.doc.lineAt(from);
    replaceDisplay(line.from, line.to, {}, false);
    ranges.push(
      Decoration.line({ class: "memo-live-markdown-source-line-hidden" }).range(
        line.from,
      ),
    );
    addAtomicRange(from, to);
  };

  const replaceBlock = (
    from: number,
    to: number,
    widget?: WidgetType,
  ): void => {
    addAtomicRange(from, to);
    ranges.push(
      Decoration.replace(
        widget === undefined
          ? { block: true }
          : { block: true, widget },
      ).range(from, to),
    );
  };

  for (const activeRange of activeRanges) {
    syntaxTree(state).iterate({
      from: activeRange.from,
      to: activeRange.to,
      enter(node) {
      const { from, to, name } = node;
      if (isInside(frontmatter, from, to)) {
        return false;
      }
      if (!liveBlockIsActivated(state, node.node)) {
        return false;
      }

      if (name === "Table") {
        const key = `${name}:${from}:${to}`;
        if (seenWholeNodes.has(key)) {
          return false;
        }
        const cachedModel = tableModelCache.get(key);
        const model =
          cachedModel === undefined
            ? tableModel(state, node.node)
            : cachedModel;
        if (model === null) {
          return false;
        }
        seenWholeNodes.add(key);
        const source = state.doc.sliceString(from, to);
        const tableReferences = referenceDefinitionsForInlineSources(
          flatTableCells(model).map((cell) => cell.source),
          referencesForLabels,
        );
        replaceBlock(
          from,
          to,
          new TableWidget(
            source,
            model,
            tableReferences,
            state.readOnly,
          ),
        );
        return false;
      }

      if (name === "Image") {
        const key = `${name}:${from}:${to}`;
        if (seenWholeNodes.has(key)) {
          return false;
        }
        seenWholeNodes.add(key);
        const source = state.doc.sliceString(from, to);
        const imageReferences = hasInlineDestination(node.node)
          ? emptyReferenceDefinitions
          : referencesForLabels(
              new Set([
                referenceLabelFromNode(source, node.node, from),
              ]),
            );
        if (!isResolvedInlineNode(source, node.node, imageReferences, from)) {
          return false;
        }
        const description = describeImageFromNode(
          source,
          node.node,
          imageReferences,
          from,
        );
        const widget = new ImagePlaceholderWidget(
            description.identity,
            description.alt,
            description.target,
          );
        if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) {
          replaceBlock(from, to, widget);
        } else {
          replaceDisplay(from, to, { widget });
        }
        return false;
      }

      if (name === "HorizontalRule") {
        const key = `${name}:${from}:${to}`;
        if (seenWholeNodes.has(key)) {
          return false;
        }
        seenWholeNodes.add(key);
        replaceBlock(from, to, new HorizontalRuleWidget());
        return false;
      }

      if (name === "LinkReference") {
        const key = `${name}:${from}:${to}`;
        if (seenWholeNodes.has(key)) {
          return false;
        }
        seenWholeNodes.add(key);
        replaceBlock(from, to);
        return false;
      }

      if (name === "OrderedList") {
        const key = `${name}:${from}:${to}`;
        if (!seenOrderedLists.has(key)) {
          seenOrderedLists.add(key);
          collectSemanticOrderedMarkers(
            state,
            node.node,
            semanticOrderedMarkers,
          );
        }
      }

      if (name === "Link") {
        const source = state.doc.sliceString(from, to);
        const linkReferences = hasInlineDestination(node.node)
          ? emptyReferenceDefinitions
          : referencesForLabels(
              new Set([
                referenceLabelFromNode(source, node.node, from),
              ]),
            );
        if (!isResolvedInlineNode(source, node.node, linkReferences, from)) {
          return false;
        }
      }

      const headingMatch = /^ATXHeading([1-6])$/.exec(name);
      if (headingMatch !== null) {
        addLineClasses(
          state,
          ranges,
          Math.max(from, activeRange.from),
          Math.min(to, activeRange.to),
          `memo-live-markdown-heading memo-live-markdown-heading-${headingMatch[1]}`,
        );
        return;
      }

      const setextMatch = /^SetextHeading([12])$/.exec(name);
      if (setextMatch !== null) {
        addLineClasses(
          state,
          ranges,
          Math.max(from, activeRange.from),
          Math.min(to, activeRange.to),
          `memo-live-markdown-heading memo-live-markdown-heading-${setextMatch[1]} memo-live-markdown-setext-heading`,
        );
        return;
      }

      if (name === "Emphasis") {
        ranges.push(
          Decoration.mark({ class: "memo-live-markdown-emphasis" }).range(from, to),
        );
      } else if (name === "StrongEmphasis") {
        ranges.push(
          Decoration.mark({ class: "memo-live-markdown-strong" }).range(from, to),
        );
      } else if (name === "Strikethrough") {
        ranges.push(
          Decoration.mark({ class: "memo-live-markdown-strikethrough" }).range(from, to),
        );
      } else if (name === "InlineCode") {
        const content = inlineCodeContentBounds(node.node);
        const source = state.doc.sliceString(content.from, content.to);
        const normalized = source.replace(/\n/g, " ");
        const trimOuterSpaces =
          normalized.startsWith(" ") &&
          normalized.endsWith(" ") &&
          /[^ ]/.test(normalized);
        const visibleFrom = content.from + (trimOuterSpaces ? 1 : 0);
        const visibleTo = content.to - (trimOuterSpaces ? 1 : 0);
        ranges.push(
          Decoration.mark({ class: "memo-live-markdown-inline-code" }).range(from, to),
        );
        if (trimOuterSpaces) {
          replaceDisplay(content.from, content.from + 1);
          replaceDisplay(content.to - 1, content.to);
        }
        for (let position = visibleFrom; position < visibleTo; position += 1) {
          if (state.doc.sliceString(position, position + 1) === "\n") {
            replaceDisplay(position, position + 1, {
              widget: new TextWidget(" ", "memo-live-markdown-inline-code"),
            });
          }
        }
      } else if (name === "FencedCode" || name === "CodeBlock") {
        addLineClasses(
          state,
          ranges,
          Math.max(from, activeRange.from),
          Math.min(to, activeRange.to),
          "memo-live-markdown-code-block",
        );
      } else if (name === "Blockquote") {
        addLineClasses(
          state,
          ranges,
          Math.max(from, activeRange.from),
          Math.min(to, activeRange.to),
          "memo-live-markdown-blockquote",
        );
      } else if (name === "ListItem") {
        addLineClasses(
          state,
          ranges,
          Math.max(from, activeRange.from),
          Math.min(to, activeRange.to),
          "memo-live-markdown-list-item",
        );
      } else if (name === "Task") {
        addLineClasses(
          state,
          ranges,
          Math.max(from, activeRange.from),
          Math.min(to, activeRange.to),
          "memo-live-markdown-task-item",
        );
      } else if (name === "Link" || name === "Autolink") {
        const source = state.doc.sliceString(from, to);
        const resolvingReferences =
          name === "Link" && !hasInlineDestination(node.node)
            ? referencesForLabels(
                new Set([
                  referenceLabelFromNode(source, node.node, from),
                ]),
              )
            : emptyReferenceDefinitions;
        const description = describeLinkFromNode(
          source,
          node.node,
          resolvingReferences,
          from,
        );
        const href = safeNavigableMarkdownHref(description.target);
        if (href !== null) {
          const labelReferences = referenceDefinitionsForInlineSources(
            [description.labelSource],
            referencesForLabels,
          );
          replaceDisplay(from, to, {
            widget: new LinkWidget(description, labelReferences),
          });
          return false;
        }
        const attributes: Record<string, string> = {
          title: "Only HTTPS links can be opened",
        };
        attributes["data-markdown-link-blocked"] = "true";
        ranges.push(
          Decoration.mark({
            class: "memo-live-markdown-link memo-live-markdown-link-disabled",
            tagName: "span",
            attributes,
          }).range(from, to),
        );
      }

      if (name === "HeaderMark") {
        const parentName = node.node.parent?.name ?? "";
        if (/^SetextHeading[12]$/.test(parentName)) {
          const line = state.doc.lineAt(from);
          hideSourceLine(line.from, line.to);
        } else {
          replaceDisplay(from, extendThroughInlineWhitespace(state, to));
        }
      } else if (
        name === "EmphasisMark" ||
        name === "StrikethroughMark" ||
        name === "LinkMark"
      ) {
        replaceDisplay(from, to);
      } else if (name === "QuoteMark") {
        replaceDisplay(from, quoteStartTokenEnd(state, node.node));
      } else if (name === "CodeMark") {
        const line = state.doc.lineAt(from);
        const source = state.doc.sliceString(from, to);
        const isFenceOnlyLine =
          node.node.parent?.name === "FencedCode" &&
          line.text.trim() === source;
        if (isFenceOnlyLine) {
          hideSourceLine(line.from, line.to);
        } else {
          replaceDisplay(from, to);
        }
      } else if (name === "URL" && node.node.parent?.name === "Link") {
        replaceDisplay(from, to);
      } else if (name === "LinkLabel" && node.node.parent?.name === "Link") {
        replaceDisplay(from, to);
      } else if (name === "LinkTitle" && node.node.parent?.name === "Link") {
        const line = state.doc.lineAt(from);
        let titleFrom = from;
        while (
          titleFrom > line.from &&
          /[ \t]/.test(state.doc.sliceString(titleFrom - 1, titleFrom))
        ) {
          titleFrom -= 1;
        }
        replaceDisplay(titleFrom, to);
      } else if (name === "CodeInfo") {
        const language = state.doc.sliceString(from, to).trim();
        replaceDisplay(from, to, {
          widget: new TextWidget(language, "memo-live-markdown-code-language"),
        });
      } else if (name === "TaskMarker") {
        const marker = state.doc.sliceString(from, to);
        replaceDisplay(from, to, {
          widget: new TaskWidget(from, /^\[[xX]\]$/.test(marker), state.readOnly),
        });
      } else if (name === "Escape") {
        replaceDisplay(from, to, {
          widget: new TextWidget(
            state.doc.sliceString(from + 1, to),
            "memo-live-markdown-escaped",
          ),
        });
      } else if (name === "Entity") {
        const source = state.doc.sliceString(from, to);
        replaceDisplay(from, to, {
          widget: new TextWidget(
            decodeParsedEntity(source),
            "memo-live-markdown-entity",
          ),
        });
      } else if (name === "HardBreak") {
        const markerEnd = Math.max(from, to - 1);
        replaceDisplay(from, markerEnd);
      } else if (
        name === "CodeText" &&
        node.node.parent?.name === "CodeBlock"
      ) {
        const line = state.doc.lineAt(from);
        replaceDisplay(line.from, from);
      } else if (name === "ListMark") {
        if (pendingChildListMarkerStarts.has(from)) {
          return;
        }
        addListMarkerLine(from);
        const source = state.doc.sliceString(from, to);
        const restOfLine = state.doc
          .lineAt(to)
          .text.slice(to - state.doc.lineAt(to).from)
          .trimStart();
        const isTask = /^\[[ xX]\]/.test(restOfLine);
        const orderedMarker = semanticOrderedMarkers.get(from);
        const ordered =
          orderedMarker !== undefined || /^\d+[.)]$/.test(source);
        const marker = isTask
          ? ""
          : orderedMarker ??
              (/^[-+*]$/.test(source)
                ? "•"
                : source.replace(/[.)]$/, "."));
        replaceDisplay(from, to, {
          widget: new TextWidget(
            marker,
            markdownListMarkerClassName(
              isTask,
              ordered,
              isNestedMarkdownListMarker(node.node),
            ),
          ),
        });
      }
      },
    });
  }

  return {
    decorations: Decoration.set(ranges, true),
    atomicRanges: Decoration.set(atomicRanges, true),
  };
}

class ListHangingIndentMonitor {
  private destroyed = false;
  private indentByCacheKey = new Map<string, number>();
  private styledLines = new Set<HTMLElement>();
  private wasComposing = false;

  constructor(view: EditorView) {
    this.requestMeasurement(view);
  }

  update(update: ViewUpdate): void {
    if (update.view.composing) {
      this.wasComposing = true;
      return;
    }

    if (
      this.wasComposing ||
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged
    ) {
      this.requestMeasurement(update.view);
    }

    this.wasComposing = false;
  }

  docViewUpdate(view: EditorView): void {
    this.requestMeasurement(view);
  }

  requestMeasurement(view: EditorView): void {
    if (this.destroyed) {
      return;
    }
    view.requestMeasure({
      key: this,
      read: (currentView): ListHangingIndentMeasurementBatch => {
        const measurements: ListHangingIndentMeasurement[] = [];
        const lines = currentView.contentDOM.querySelectorAll<HTMLElement>(
          `.cm-line.${listMarkerLineClassName}[${listLineFromAttribute}][${listContentOffsetAttribute}][${listIndentCacheKeyAttribute}]`,
        );
        if (currentView.composing) {
          for (const line of lines) {
            const cacheKey = line.getAttribute(listIndentCacheKeyAttribute);
            if (cacheKey === null) {
              continue;
            }
            const indent = this.indentByCacheKey.get(cacheKey);
            if (indent !== undefined) {
              measurements.push({ line, cacheKey, indent });
            }
          }
          return { measurements, refreshCache: false };
        }
        const probeRange = currentView.dom.ownerDocument.createRange();
        if (typeof probeRange.getClientRects !== "function") {
          return { measurements, refreshCache: false };
        }
        for (const line of lines) {
          const lineFrom = Number(line.getAttribute(listLineFromAttribute));
          const contentOffset = Number(
            line.getAttribute(listContentOffsetAttribute),
          );
          const cacheKey = line.getAttribute(listIndentCacheKeyAttribute);
          if (
            !Number.isSafeInteger(lineFrom) ||
            !Number.isSafeInteger(contentOffset) ||
            cacheKey === null ||
            lineFrom < 0 ||
            contentOffset < 1 ||
            lineFrom > currentView.state.doc.length
          ) {
            continue;
          }
          const stateLine = currentView.state.doc.lineAt(lineFrom);
          if (
            stateLine.from !== lineFrom ||
            contentOffset > stateLine.length
          ) {
            continue;
          }
          const contentFrom = lineFrom + contentOffset;
          const lineCoordinates = currentView.coordsAtPos(lineFrom, -1);
          const contentCoordinates = currentView.coordsAtPos(contentFrom, 1);
          if (lineCoordinates === null || contentCoordinates === null) {
            continue;
          }
          const indent = contentCoordinates.left - lineCoordinates.left;
          if (!Number.isFinite(indent) || indent < 0) {
            continue;
          }
          measurements.push({
            line,
            cacheKey,
            indent,
          });
        }
        return { measurements, refreshCache: true };
      },
      write: ({ measurements, refreshCache }) => {
        if (this.destroyed) {
          return;
        }
        const nextStyledLines = new Set(
          measurements.map((measurement) => measurement.line),
        );
        for (const line of this.styledLines) {
          if (!nextStyledLines.has(line)) {
            line.style.removeProperty(listHangingIndentProperty);
          }
        }
        for (const { line, indent } of measurements) {
          const value = `${Math.round(indent * 1_000) / 1_000}px`;
          if (line.style.getPropertyValue(listHangingIndentProperty) !== value) {
            line.style.setProperty(listHangingIndentProperty, value);
          }
        }
        this.styledLines = nextStyledLines;
        if (refreshCache) {
          this.indentByCacheKey = new Map(
            measurements.map(({ cacheKey, indent }) => [cacheKey, indent]),
          );
        }
      },
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const line of this.styledLines) {
      line.style.removeProperty(listHangingIndentProperty);
    }
    this.styledLines.clear();
  }
}

const listHangingIndentPlugin = ViewPlugin.fromClass(
  ListHangingIndentMonitor,
);

function emptyDecorationBuild(): DecorationBuild {
  return {
    decorations: Decoration.none,
    atomicRanges: Decoration.none,
  };
}

function initialDecorationRanges(state: EditorState): readonly SourceRange[] {
  return [{ from: 0, to: Math.min(state.doc.length, 16_384) }];
}

function mapDecorationRanges(
  ranges: readonly SourceRange[],
  transaction: Transaction,
): readonly SourceRange[] {
  return ranges.map((range) => ({
    from: transaction.changes.mapPos(range.from, -1),
    to: transaction.changes.mapPos(range.to, 1),
  }));
}

function createLiveDecorationExtension(
  liveParsingEnabledField: StateField<boolean>,
): Extension {
  const decorationField = StateField.define<LiveDecorationState>({
    create(state) {
      const requestedRanges = initialDecorationRanges(state);
      const built = state.field(liveParsingEnabledField)
        ? buildLiveDecorations(state, requestedRanges)
        : emptyDecorationBuild();
      return { ...built, requestedRanges };
    },
    update(current, transaction) {
      let requestedRanges = transaction.docChanged
        ? mapDecorationRanges(current.requestedRanges, transaction)
        : current.requestedRanges;
      let rangeRequested = false;
      let refreshRequested = false;
      for (const effect of transaction.effects) {
        if (effect.is(setLiveDecorationRanges)) {
          requestedRanges = effect.value;
          rangeRequested = true;
        } else if (effect.is(refreshLiveDecorations)) {
          refreshRequested = true;
        }
      }

      if (!transaction.state.field(liveParsingEnabledField)) {
        return { ...emptyDecorationBuild(), requestedRanges };
      }

      if (
        transaction.docChanged &&
        transaction.isUserEvent("input.type.compose") &&
        !rangeRequested
      ) {
        return {
          decorations: current.decorations.map(transaction.changes),
          atomicRanges: current.atomicRanges.map(transaction.changes),
          requestedRanges,
        };
      }

      const readOnlyChanged =
        transaction.startState.readOnly !== transaction.state.readOnly;
      if (
        transaction.docChanged ||
        rangeRequested ||
        refreshRequested ||
        readOnlyChanged
      ) {
        return {
          ...buildLiveDecorations(transaction.state, requestedRanges),
          requestedRanges,
        };
      }
      return current;
    },
    provide(field) {
      return [
        EditorView.decorations.from(field, (value) => value.decorations),
        EditorView.atomicRanges.of(
          (view) => view.state.field(field).atomicRanges,
        ),
      ];
    },
  });

  class LiveDecorationMonitor {
    private destroyed = false;
    private pendingRanges: readonly SourceRange[] = [];
    private scheduled = false;
    private lastTree: ReturnType<typeof syntaxTree>;
    private wasComposing: boolean;

    constructor(view: EditorView) {
      this.lastTree = syntaxTree(view.state);
      this.wasComposing = view.composing;
      this.schedule(view, view.visibleRanges);
    }

    update(update: ViewUpdate): void {
      const currentTree = syntaxTree(update.state);
      const treeChanged = currentTree !== this.lastTree;
      this.lastTree = currentTree;

      if (!update.state.field(liveParsingEnabledField)) {
        this.wasComposing = update.view.composing;
        return;
      }

      if (update.view.composing) {
        this.wasComposing = true;
        return;
      }

      if (
        this.wasComposing ||
        update.docChanged ||
        update.viewportChanged ||
        treeChanged
      ) {
        this.schedule(update.view, update.view.visibleRanges);
      }
      this.wasComposing = false;
    }

    destroy(): void {
      this.destroyed = true;
    }

    private schedule(
      view: EditorView,
      ranges: readonly SourceRange[],
    ): void {
      this.pendingRanges = ranges.map((range) => ({ ...range }));
      if (this.scheduled) {
        return;
      }
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (
          this.destroyed ||
          view.composing ||
          !view.state.field(liveParsingEnabledField)
        ) {
          return;
        }
        const requestedRanges = this.pendingRanges;
        view.dispatch({
          effects: setLiveDecorationRanges.of(requestedRanges),
        });
      });
    }
  }

  return [
    decorationField,
    ViewPlugin.fromClass(LiveDecorationMonitor),
    listHangingIndentPlugin,
  ];
}

function nonceFromDocument(): string | undefined {
  const value = document
    .querySelector<HTMLMetaElement>('meta[name="local-reader-csp-nonce"]')
    ?.content.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function preservedTransactionAnnotations(
  transaction: Transaction,
): Annotation<any>[] {
  const annotations: Annotation<any>[] = [];
  const userEvent = transaction.annotation(Transaction.userEvent);
  const addToHistory = transaction.annotation(Transaction.addToHistory);
  const remote = transaction.annotation(Transaction.remote);
  if (userEvent !== undefined) {
    annotations.push(Transaction.userEvent.of(userEvent));
  }
  if (addToHistory !== undefined) {
    annotations.push(Transaction.addToHistory.of(addToHistory));
  }
  if (remote !== undefined) {
    annotations.push(Transaction.remote.of(remote));
  }
  return annotations;
}

export function createMemoLiveMarkdownEditor(
  options: MemoLiveMarkdownEditorOptions,
): MemoLiveMarkdownEditor {
  let readOnly = options.readOnly ?? false;
  let placeholder = options.placeholder ?? "";
  let compositionDirty = false;
  let destroyed = false;
  let initialLineSeparators: readonly string[] = [];
  let initialLiveParsingEnabled = true;
  let preferredLineSeparator = "\n";
  let accessibleLabel =
    options.parent.getAttribute("aria-label")?.trim() || "Session memo";

  const setAccessibleLabel = StateEffect.define<string>();
  const accessibleLabelField = StateField.define<string>({
    create: () => accessibleLabel,
    update(currentLabel, transaction) {
      for (let index = transaction.effects.length - 1; index >= 0; index -= 1) {
        const effect = transaction.effects[index];
        if (effect?.is(setAccessibleLabel)) {
          return effect.value;
        }
      }
      return currentLabel;
    },
  });

  const liveParsingEnabledField = StateField.define<boolean>({
    create: () => initialLiveParsingEnabled,
    update(enabled, transaction) {
      for (let index = transaction.effects.length - 1; index >= 0; index -= 1) {
        const effect = transaction.effects[index];
        if (effect === undefined) {
          continue;
        }
        if (effect.is(setLiveParsingEnabled)) {
          return effect.value;
        }
      }
      return enabled;
    },
  });
  const restoreLineSeparators = StateEffect.define<readonly string[]>();
  const lineSeparatorsField = StateField.define<readonly string[]>({
    create: () => initialLineSeparators,
    update(current, transaction) {
      for (let index = transaction.effects.length - 1; index >= 0; index -= 1) {
        const effect = transaction.effects[index];
        if (effect?.is(restoreLineSeparators)) {
          return effect.value;
        }
      }
      if (!transaction.docChanged) {
        return current;
      }

      let lineStructureChanged = false;
      transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (
          inserted.lines > 1 ||
          transaction.startState.doc.sliceString(fromA, toA).includes("\n")
        ) {
          lineStructureChanged = true;
        }
      });
      if (!lineStructureChanged) {
        return current;
      }

      const next = Array.from(
        { length: Math.max(0, transaction.state.doc.lines - 1) },
        () => preferredLineSeparator,
      );
      const nextLineByBreakPosition = new Map<number, number>();
      for (
        let lineNumber = 1;
        lineNumber < transaction.state.doc.lines;
        lineNumber += 1
      ) {
        nextLineByBreakPosition.set(
          transaction.state.doc.line(lineNumber).to,
          lineNumber - 1,
        );
      }
      for (
        let lineNumber = 1;
        lineNumber < transaction.startState.doc.lines;
        lineNumber += 1
      ) {
        const oldBreakPosition = transaction.startState.doc.line(lineNumber).to;
        const mappedPosition = transaction.changes.mapPos(
          oldBreakPosition,
          1,
          MapMode.TrackAfter,
        );
        if (mappedPosition === null) {
          continue;
        }
        const nextIndex = nextLineByBreakPosition.get(mappedPosition);
        if (nextIndex !== undefined) {
          next[nextIndex] = current[lineNumber - 1] ?? preferredLineSeparator;
        }
      }
      return next;
    },
  });
  const preserveSeparatorsThroughHistory = invertedEffects.of((transaction) =>
    transaction.docChanged ||
    transaction.effects.some((effect) => effect.is(restoreLineSeparators))
      ? (() => {
          const liveParsingEnabled = transaction.startState.field(
            liveParsingEnabledField,
          );
          return [
            restoreLineSeparators.of(
              transaction.startState.field(lineSeparatorsField),
            ),
            setLiveParsingEnabled.of(liveParsingEnabled),
            markdownSupportCompartment.reconfigure(
              liveParsingEnabled ? markdownSupport : [],
            ),
          ];
        })()
      : [],
  );
  const preserveRawLineSeparators = EditorState.transactionFilter.of(
    (transaction) => {
      if (!transaction.docChanged) {
        return transaction;
      }

      const currentLiveParsingEnabled = transaction.startState.field(
        liveParsingEnabledField,
      );
      const restoringSeparators = transaction.effects.some((effect) =>
        effect.is(restoreLineSeparators),
      );
      if (restoringSeparators) {
        return transaction;
      }

      const currentSeparators = transaction.startState.field(
        lineSeparatorsField,
      );
      let needsRawReplay = false;
      transaction.changes.iterChanges(
        (fromA, toA, fromB, _toB, inserted) => {
          const insertedRaw = inserted.toString();
          const removed = transaction.startState.doc.sliceString(fromA, toA);
          if (/[\r\n]/.test(insertedRaw) || removed.includes("\n")) {
            needsRawReplay = true;
            return;
          }
          if (fromA === toA) {
            return;
          }
          const changedLine = transaction.newDoc.lineAt(fromB);
          if (
            changedLine.text.length === 0 &&
            changedLine.number > 1 &&
            changedLine.number < transaction.newDoc.lines &&
            currentSeparators[changedLine.number - 2] === "\r" &&
            currentSeparators[changedLine.number - 1] === "\n"
          ) {
            needsRawReplay = true;
          }
        },
      );
      if (!needsRawReplay) {
        const liveParsingEnabled = isWithinLiveMarkdownParseBudget(
          transaction.newDoc.toString(),
        );
        if (liveParsingEnabled === currentLiveParsingEnabled) {
          return transaction;
        }
        return {
          changes: transaction.changes,
          selection: transaction.newSelection,
          effects: [
            ...transaction.effects,
            setLiveParsingEnabled.of(liveParsingEnabled),
            markdownSupportCompartment.reconfigure(
              liveParsingEnabled ? markdownSupport : [],
            ),
          ],
          annotations: preservedTransactionAnnotations(transaction),
          scrollIntoView: transaction.scrollIntoView,
          filter: false,
        };
      }

      let containsCarriageReturn = false;
      let containsInsertedLineBreak = false;
      const currentRaw = serializeMarkdownLines(
        transaction.startState,
        currentSeparators,
      );
      const rawParts: string[] = [];
      const newSeparatorRanges: { from: number; to: number }[] = [];
      let rawLength = 0;
      let rawCursor = 0;
      const appendRaw = (value: string): void => {
        rawParts.push(value);
        rawLength += value.length;
      };
      transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const insertedRaw = inserted.toString();
        containsCarriageReturn ||= insertedRaw.includes("\r");
        containsInsertedLineBreak ||= /[\r\n]/.test(insertedRaw);
        const rawFrom = rawOffsetAt(
          transaction.startState,
          currentSeparators,
          fromA,
        );
        const rawTo = rawOffsetAt(
          transaction.startState,
          currentSeparators,
          toA,
        );
        appendRaw(currentRaw.slice(rawCursor, rawFrom));
        if (insertedRaw.includes("\r")) {
          appendRaw(insertedRaw);
        } else {
          let insertedCursor = 0;
          for (let index = 0; index < insertedRaw.length; index += 1) {
            if (insertedRaw[index] !== "\n") {
              continue;
            }
            appendRaw(insertedRaw.slice(insertedCursor, index));
            const from = rawLength;
            appendRaw(preferredLineSeparator);
            newSeparatorRanges.push({ from, to: rawLength });
            insertedCursor = index + 1;
          }
          appendRaw(insertedRaw.slice(insertedCursor));
        }
        rawCursor = rawTo;
      });

      appendRaw(currentRaw.slice(rawCursor));
      let finalRaw = rawParts.join("");
      for (let index = newSeparatorRanges.length - 1; index >= 0; index -= 1) {
        const range = newSeparatorRanges[index];
        if (range === undefined) {
          continue;
        }
        const separator = finalRaw.slice(range.from, range.to);
        const collidesOnLeft =
          separator === "\n" && finalRaw[range.from - 1] === "\r";
        const collidesOnRight =
          separator === "\r" && finalRaw[range.to] === "\n";
        if (!collidesOnLeft && !collidesOnRight) {
          continue;
        }
        finalRaw = `${finalRaw.slice(0, range.from)}\r\n${finalRaw.slice(range.to)}`;
      }
      const finalMarkdown = parseMarkdownLines(finalRaw);
      const rawNewDocument = transaction.newDoc.toString();
      const correction = lineBreakCorrectionChanges(
        rawNewDocument,
        finalMarkdown.normalized,
      );
      const liveParsingEnabled = isWithinLiveMarkdownParseBudget(
        finalMarkdown.normalized,
      );
      const liveParsingChanged =
        liveParsingEnabled !== currentLiveParsingEnabled;
      if (
        !containsCarriageReturn &&
        !containsInsertedLineBreak &&
        correction.empty &&
        !liveParsingChanged
      ) {
        return transaction;
      }

      const parsingEffects = liveParsingChanged
        ? [
            setLiveParsingEnabled.of(liveParsingEnabled),
            markdownSupportCompartment.reconfigure(
              liveParsingEnabled ? markdownSupport : [],
            ),
          ]
        : [];

      const replacement: TransactionSpec = {
        changes: transaction.changes.compose(correction),
        selection: transaction.newSelection.map(correction),
        effects: [
          ...StateEffect.mapEffects(transaction.effects, correction),
          restoreLineSeparators.of(finalMarkdown.separators),
          ...parsingEffects,
        ],
        annotations: preservedTransactionAnnotations(transaction),
        scrollIntoView: transaction.scrollIntoView,
        filter: false,
      };
      return replacement;
    },
  );
  const readOnlyCompartment = new Compartment();
  const placeholderCompartment = new Compartment();
  const markdownSupportCompartment = new Compartment();
  const markdownSupport = memoMarkdownSupport();
  const liveDecorationExtension = createLiveDecorationExtension(liveParsingEnabledField);
  const nonce = options.cspNonce ?? nonceFromDocument();
  const fallbackNotice = document.createElement("p");
  fallbackNotice.id = `local-reader-memo-live-markdown-fallback-${++memoLiveEditorInstanceCounter}`;
  fallbackNotice.className = "memo-live-markdown-fallback-notice";
  fallbackNotice.textContent =
    "Some Markdown styling was paused because this memo is unusually large. Editing remains available.";
  fallbackNotice.setAttribute("role", "status");
  fallbackNotice.setAttribute("aria-live", "polite");
  fallbackNotice.hidden = true;
  options.parent.append(fallbackNotice);

  const syncFallbackNotice = (state: EditorState): void => {
    fallbackNotice.hidden = state.field(liveParsingEnabledField);
  };

  const createState = (markdown: string): EditorState => {
    const parsedMarkdown = parseMarkdownLines(markdown);
    initialLineSeparators = parsedMarkdown.separators;
    preferredLineSeparator = parsedMarkdown.preferredSeparator;
    initialLiveParsingEnabled = isWithinLiveMarkdownParseBudget(
      parsedMarkdown.normalized,
    );
    const extensions: Extension[] = [
      EditorState.lineSeparator.of("\n"),
      preserveRawLineSeparators,
      markdownSupportCompartment.of(
        initialLiveParsingEnabled ? markdownSupport : [],
      ),
      history(),
      lineSeparatorsField,
      liveParsingEnabledField,
      accessibleLabelField,
      exitedMarkdownListItemField,
      strippedMarkdownListMarkerField,
      preserveSeparatorsThroughHistory,
      preserveStrippedMarkdownListMarkerInput,
      markdownChildMinusKeyCodeGuard,
      markdownChildPositionInputHandler,
      keymap.of([
        ...markdownChildMarkerStartKeymap,
        { key: "Space", run: indentEmptyMarkdownListItem },
        { key: "Shift-Enter", run: continueMarkdownMarkupAtSameLevel },
        { key: "Enter", run: nestMarkdownMarkup },
        { key: "Backspace", run: deleteMarkdownMarkupBackward },
        { key: "Mod-Shift-z", run: redo },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.editorAttributes.compute(
        [liveParsingEnabledField],
        (state) => {
          const fallback = !state.field(liveParsingEnabledField);
          return {
            "data-live-markdown": "true",
            "data-live-decoration-suspended": String(fallback),
            class: `memo-live-markdown-editor${fallback ? " memo-live-markdown-editor-fallback" : ""}`,
          };
        },
      ),
      EditorView.contentAttributes.compute(
        [accessibleLabelField, liveParsingEnabledField],
        (state) => {
          const fallback = !state.field(liveParsingEnabledField);
          return {
            "aria-label": state.field(accessibleLabelField),
            "aria-multiline": "true",
            class: "memo-live-markdown-editor-content",
            ...(fallback ? { "aria-describedby": fallbackNotice.id } : {}),
            spellcheck: "true",
          };
        },
      ),
      EditorView.lineWrapping,
      readOnlyCompartment.of([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
      placeholderCompartment.of(codeMirrorPlaceholder(placeholder)),
      localFileDropGuard,
      liveDecorationExtension,
      EditorView.updateListener.of((update) => {
        syncFallbackNotice(update.state);
        const separatorsChanged = update.transactions.some((transaction) =>
          transaction.effects.some((effect) =>
            effect.is(restoreLineSeparators),
          ),
        );
        if (update.docChanged || separatorsChanged) {
          if (update.view.composing) {
            compositionDirty = true;
          } else {
            compositionDirty = false;
            options.onChange?.(
              serializeMarkdownLines(
                update.state,
                update.state.field(lineSeparatorsField),
              ),
            );
          }
        } else if (compositionDirty && !update.view.composing) {
          compositionDirty = false;
          options.onChange?.(
            serializeMarkdownLines(
              update.state,
              update.state.field(lineSeparatorsField),
            ),
          );
        }
      }),
      EditorView.domEventHandlers({
        blur: () => {
          options.onBlur?.();
          return false;
        },
        compositionend: (_event, editorView) => {
          queueMicrotask(() => {
            if (!destroyed) {
              editorView.dispatch({ effects: refreshLiveDecorations.of() });
            }
          });
          return false;
        },
      }),
    ];

    if (nonce !== undefined) {
      extensions.push(EditorView.cspNonce.of(nonce));
    }

    return EditorState.create({ doc: parsedMarkdown.normalized, extensions });
  };

  const view = new EditorView({
    parent: options.parent,
    state: createState(options.markdown ?? ""),
  });
  syncFallbackNotice(view.state);
  const labelObserver = new MutationObserver(() => {
    const nextLabel =
      options.parent.getAttribute("aria-label")?.trim() || "Session memo";
    if (nextLabel === accessibleLabel || destroyed) {
      return;
    }
    accessibleLabel = nextLabel;
    view.dispatch({
      effects: setAccessibleLabel.of(nextLabel),
    });
  });
  labelObserver.observe(options.parent, {
    attributeFilter: ["aria-label"],
    attributes: true,
  });

  return {
    getMarkdown() {
      return serializeMarkdownLines(
        view.state,
        view.state.field(lineSeparatorsField),
      );
    },
    setMarkdown(markdown) {
      compositionDirty = false;
      invalidatePendingTableCellFocus(view);
      view.setState(createState(markdown));
      syncFallbackNotice(view.state);
    },
    setReadOnly(value) {
      if (value === readOnly) {
        return;
      }
      readOnly = value;
      view.dispatch({
        effects: readOnlyCompartment.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
      });
    },
    setPlaceholder(value) {
      if (value === placeholder) {
        return;
      }
      placeholder = value;
      view.dispatch({
        effects: placeholderCompartment.reconfigure(
          codeMirrorPlaceholder(placeholder),
        ),
      });
    },
    focus() {
      view.focus();
    },
    requestMeasure() {
      view
        .plugin(listHangingIndentPlugin)
        ?.requestMeasurement(view);
      view.requestMeasure();
    },
    destroy() {
      destroyed = true;
      invalidatePendingTableCellFocus(view);
      labelObserver.disconnect();
      view.destroy();
      fallbackNotice.remove();
    },
  };
}

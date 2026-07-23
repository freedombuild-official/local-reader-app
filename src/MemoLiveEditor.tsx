import { useEffect, useLayoutEffect, useRef } from "react";

import {
  createMemoLiveMarkdownEditor,
  type MemoLiveMarkdownEditor as MemoLiveMarkdownEditorInstance,
} from "./memoLiveMarkdownEditor";

export function MemoLiveEditor({
  value,
  active,
  onChange,
}: {
  value: string;
  active: boolean;
  onChange: (value: string) => void;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MemoLiveMarkdownEditorInstance | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);

  valueRef.current = value;
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const editor = createMemoLiveMarkdownEditor({
      parent,
      markdown: valueRef.current,
      placeholder: "Start writing here…",
      onChange: (nextValue) => {
        valueRef.current = nextValue;
        onChangeRef.current(nextValue);
      },
    });
    editorRef.current = editor;

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => editor.requestMeasure());
    resizeObserver?.observe(parent);

    return () => {
      resizeObserver?.disconnect();
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getMarkdown() === value) return;
    valueRef.current = value;
    editor.setMarkdown(value);
  }, [value]);

  useEffect(() => {
    if (!active) return;
    editorRef.current?.requestMeasure();
  }, [active]);

  return <div ref={parentRef} className="memo-live-editor" aria-label="Session memo" />;
}

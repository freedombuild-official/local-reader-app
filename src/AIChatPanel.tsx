import { useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { Check, Copy, Mic, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { streamAIChatMessage } from "./api";
import { activeAIChatTarget, activeAIEntry, aiVerifiedReady, type AISettingsState } from "./settingsState";
import type { AIChatAttachment, AIChatMessage, AIChatSessionState, AIModelBehavior, FileResponse } from "./types";
import { injectMarkdownCodeToolbarButtons, installCodeBlockRule } from "../shared/markdownCodeBlocks";
import { installTableScrollRule } from "../shared/markdownTableScroll";
import { installTaskListRule } from "../shared/markdownTaskLists";

type AIChatPanelProps = {
  aiSettings: AISettingsState;
  session: AIChatSessionState;
  onSessionChange: (updater: (session: AIChatSessionState) => AIChatSessionState) => void;
  modelBehavior: AIModelBehavior;
  activeRepoId: string;
  activeFile: FileResponse | null;
  onOpenSettings: () => void;
  onMarkdownClick: (event: ReactMouseEvent<HTMLElement>) => void;
};

type CopyState = "idle" | "copied" | "error";
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const aiMarkdown = new MarkdownIt({ html: false, linkify: true });
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_TEXT_BYTES = 64 * 1024;
const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 72;

installTableScrollRule(aiMarkdown);
installCodeBlockRule(aiMarkdown);
installTaskListRule(aiMarkdown);

export function AIChatPanel({ aiSettings, session, onSessionChange, modelBehavior, activeRepoId, activeFile, onOpenSettings, onMarkdownClick }: AIChatPanelProps) {
  const [copyStateById, setCopyStateById] = useState<Record<string, CopyState>>({});
  const [voiceActive, setVoiceActive] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const autoScrollPinnedRef = useRef(true);
  const activeEntry = activeAIEntry(aiSettings);
  const target = activeAIChatTarget(aiSettings);
  const ready = Boolean(target && activeEntry && aiVerifiedReady(aiSettings, activeEntry.entry));
  const canSend = Boolean(ready && activeRepoId && activeFile?.path && session.draft.trim() && !session.pending);
  const voiceAvailable = Boolean(getSpeechRecognitionCtor());

  const renderedMessages = useMemo(
    () =>
      session.messages.map((message, index) => ({
        ...message,
        id: `${message.role}-${index}`,
        html: renderAIMessage(message.content),
      })),
    [session.messages],
  );

  function updateSession(updater: (session: AIChatSessionState) => AIChatSessionState) {
    onSessionChange(updater);
  }

  function updateSessionAndFollow(updater: (session: AIChatSessionState) => AIChatSessionState) {
    updateSession(updater);
    scrollTranscriptToBottomIfPinned();
  }

  async function sendMessage(content: string) {
    if (!target || !ready) {
      updateSession((current) => ({ ...current, error: "Open Settings to finish AI Chat setup." }));
      return;
    }
    if (!activeRepoId || !activeFile?.path) {
      updateSession((current) => ({ ...current, error: "Open a file before sending." }));
      return;
    }

    const requestAttachments = session.attachments;
    const userMessage: AIChatMessage = { role: "user", content };
    const assistantMessage: AIChatMessage = { role: "assistant", content: "" };
    const nextMessages = [...session.messages, userMessage, assistantMessage];
    autoScrollPinnedRef.current = transcriptIsNearBottom();
    updateSessionAndFollow((current) => ({
      ...current,
      messages: nextMessages,
      draft: "",
      pending: true,
      error: "",
      lastRequest: content,
      attachments: [],
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamAIChatMessage(
        {
          target,
          messages: [...session.messages, userMessage],
          context: { repoId: activeRepoId, path: activeFile.path, includeContent: true },
          attachments: requestAttachments,
          modelBehavior,
        },
        (event) => {
          if (event.type === "delta") {
            updateSessionAndFollow((current) => appendAssistantDelta(current, event.content));
            return;
          }
          if (event.type === "done") {
            updateSessionAndFollow((current) => replaceLastAssistant(current, event.message.content));
            return;
          }
          if (event.type === "error") {
            updateSessionAndFollow((current) => ({ ...current, error: event.error }));
          }
        },
        controller.signal,
      );
    } catch (nextError) {
      updateSession((current) => ({ ...current, error: nextError instanceof Error ? nextError.message : String(nextError) }));
    } finally {
      updateSession((current) => ({ ...current, pending: false }));
      abortRef.current = null;
    }
  }

  function cancelRequest() {
    abortRef.current?.abort();
    updateSession((current) => ({ ...current, pending: false }));
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const attachments = await Promise.all(files.slice(0, MAX_ATTACHMENTS).map(readAttachment));
    updateSession((current) => ({
      ...current,
      attachments: [...current.attachments, ...attachments].slice(0, MAX_ATTACHMENTS),
    }));
  }

  function removeAttachment(id: string) {
    updateSession((current) => ({ ...current, attachments: current.attachments.filter((attachment) => attachment.id !== id) }));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    if (event.nativeEvent.isComposing) return;
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      insertTextareaLineBreak(event.currentTarget, (draft) => updateSession((current) => ({ ...current, draft })));
      return;
    }
    if (event.shiftKey) return;
    event.preventDefault();
    if (canSend) void sendMessage(session.draft.trim());
  }

  function startVoiceInput() {
    const SpeechRecognition = getSpeechRecognitionCtor();
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript || "")
        .join(" ")
        .trim();
      if (transcript) updateSession((current) => ({ ...current, draft: [current.draft, transcript].filter(Boolean).join(current.draft ? " " : "") }));
    };
    recognition.onerror = () => updateSession((current) => ({ ...current, error: "Voice input failed." }));
    recognition.onend = () => setVoiceActive(false);
    setVoiceActive(true);
    try {
      recognition.start();
    } catch {
      setVoiceActive(false);
      updateSession((current) => ({ ...current, error: "Voice input could not start." }));
    }
  }

  async function copyMessage(id: string, content: string) {
    try {
      await writeClipboardText(content);
      setCopyStateById((current) => ({ ...current, [id]: "copied" }));
    } catch {
      setCopyStateById((current) => ({ ...current, [id]: "error" }));
    } finally {
      window.setTimeout(() => setCopyStateById((current) => ({ ...current, [id]: "idle" })), 1600);
    }
  }

  function transcriptIsNearBottom(): boolean {
    const transcript = transcriptRef.current;
    if (!transcript) return true;
    return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= TRANSCRIPT_BOTTOM_THRESHOLD_PX;
  }

  function updateTranscriptPinning() {
    autoScrollPinnedRef.current = transcriptIsNearBottom();
  }

  function scrollTranscriptToBottomIfPinned() {
    if (!autoScrollPinnedRef.current) return;
    window.requestAnimationFrame(() => {
      transcriptBottomRef.current?.scrollIntoView({ block: "end" });
    });
  }

  return (
    <section className={`ai-chat-panel ${ready ? "ready" : "not-ready"}`} aria-label="AI Chat">
      {!ready ? (
        <div className="ai-chat-empty">
          <p>{activeEntry ? "AI Entry is not ready." : "AI Entry is required."}</p>
          <small>{activeEntry ? "Complete readiness in Settings." : "Select an entry in Settings."}</small>
          <button type="button" className="secondary-button" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      ) : null}

      <div ref={transcriptRef} className="ai-chat-messages" aria-label="AI Chat transcript" aria-live="polite" onScroll={updateTranscriptPinning}>
        {renderedMessages.map((message) => (
          <article key={message.id} className={`ai-message ${message.role}`} aria-label={message.role === "user" ? "User message" : "AI message"}>
            <header className="ai-message-header">
              <span className="ai-message-role-chip">{message.role === "user" ? "You" : "AI"}</span>
            </header>
            {message.content ? (
              <div className="markdown-body ai-message-body" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: message.html }} />
            ) : (
              <span className="ai-message-streaming">Streaming...</span>
            )}
            <footer className="ai-message-footer">
              <button type="button" className={`icon-button ai-message-copy ${copyStateById[message.id] || "idle"}`} aria-label={`Copy ${message.role === "user" ? "user" : "AI"} message`} title="Copy message" onClick={() => void copyMessage(message.id, message.content)}>
                {copyStateById[message.id] === "copied" ? <Check aria-hidden="true" focusable="false" /> : <Copy aria-hidden="true" focusable="false" />}
              </button>
            </footer>
          </article>
        ))}
        <div ref={transcriptBottomRef} className="ai-chat-transcript-bottom" aria-hidden="true" />
      </div>

      {session.error ? (
        <div className="ai-chat-error">
          <span>{session.error}</span>
          {session.lastRequest ? (
            <button type="button" className="icon-button" aria-label="Retry AI Chat request" title="Retry AI Chat request" onClick={() => void sendMessage(session.lastRequest)}>
              <RotateCcw aria-hidden="true" focusable="false" />
            </button>
          ) : null}
        </div>
      ) : null}

      {ready ? (
        <form
          className="ai-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) void sendMessage(session.draft.trim());
          }}
        >
          {session.attachments.length ? (
            <div className="ai-attachment-list" aria-label="AI Chat attachments">
              {session.attachments.map((attachment) => (
                <span key={attachment.id} className="ai-attachment-chip">
                  <span title={attachment.name}>{attachment.name}</span>
                  <small>{attachment.contentIncluded ? "Text" : "Meta"}</small>
                  <button type="button" className="icon-button" aria-label={`Remove ${attachment.name}`} title="Remove attachment" onClick={() => removeAttachment(attachment.id)}>
                    <X aria-hidden="true" focusable="false" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            aria-label="AI Chat message"
            value={session.draft}
            rows={3}
            onChange={(event) => updateSession((current) => ({ ...current, draft: event.target.value }))}
            onKeyDown={handleKeyDown}
            placeholder="Message AI Chat"
          />
          <div className="ai-chat-action-rail" aria-label="AI Chat actions">
            <input ref={fileInputRef} className="visually-hidden" type="file" multiple onChange={(event) => void uploadFiles(event)} />
            <button type="button" className="icon-button" aria-label="Upload file" title="Upload file" disabled={session.pending || session.attachments.length >= MAX_ATTACHMENTS} onClick={() => fileInputRef.current?.click()}>
              <Plus aria-hidden="true" focusable="false" />
            </button>
            <button type="button" className={`icon-button ${voiceActive ? "active" : ""}`} aria-label="Voice input" title="Voice input" disabled={!voiceAvailable || session.pending} onClick={startVoiceInput}>
              <Mic aria-hidden="true" focusable="false" />
            </button>
            {session.pending ? (
              <button type="button" className="icon-button" aria-label="Cancel AI Chat request" title="Cancel AI Chat request" onClick={cancelRequest}>
                <Square aria-hidden="true" focusable="false" />
              </button>
            ) : (
              <button type="submit" className="icon-button" aria-label="Send AI Chat message" title="Send AI Chat message" disabled={!canSend}>
                <Send aria-hidden="true" focusable="false" />
              </button>
            )}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function appendAssistantDelta(session: AIChatSessionState, content: string): AIChatSessionState {
  return {
    ...session,
    messages: session.messages.map((message, index) => (index === session.messages.length - 1 && message.role === "assistant" ? { ...message, content: message.content + content } : message)),
  };
}

function replaceLastAssistant(session: AIChatSessionState, content: string): AIChatSessionState {
  return {
    ...session,
    messages: session.messages.map((message, index) => (index === session.messages.length - 1 && message.role === "assistant" ? { ...message, content } : message)),
  };
}

function renderAIMessage(content: string): string {
  return sanitizeHtml(injectMarkdownCodeToolbarButtons(aiMarkdown.render(content)), {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, "div", "span", "button", "svg", "path", "rect", "input"],
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ["href", "name", "target", "rel"],
      code: ["class"],
      input: ["aria-label", "checked", "class", "disabled", "type"],
      li: ["class"],
      pre: ["class"],
      div: ["class", "data-reader-wiki-code-block"],
      span: ["class", "aria-hidden"],
      button: ["type", "class", "data-copy-state", "data-wrap-state", "aria-label", "title", "aria-pressed"],
      svg: ["viewBox", "focusable", "aria-hidden"],
      path: ["d"],
      rect: ["width", "height", "x", "y", "rx", "ry"],
    },
    allowedSchemes: ["http", "https", "mailto"],
  });
}

async function readAttachment(file: File): Promise<AIChatAttachment> {
  const contentIncluded = isTextFile(file) && file.size <= MAX_ATTACHMENT_TEXT_BYTES;
  return {
    id: `${Date.now()}-${file.name}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    contentIncluded,
    content: contentIncluded ? await readFileText(file) : "",
  };
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsText(file);
  });
}

function isTextFile(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  return /\.(csv|json|md|markdown|txt|ts|tsx|js|jsx|yaml|yml|toml|xml|html|css)$/i.test(file.name);
}

function insertTextareaLineBreak(textarea: HTMLTextAreaElement, onDraftChange: (draft: string) => void) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const nextValue = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
  onDraftChange(nextValue);
  window.requestAnimationFrame(() => textarea.setSelectionRange(start + 1, start + 1));
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const candidate = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return candidate.SpeechRecognition || candidate.webkitSpeechRecognition || null;
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    textarea.remove();
  }
}

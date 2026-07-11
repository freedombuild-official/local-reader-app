import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { Check, Copy, Mic, Plus, RotateCcw, Send, Square, X } from "lucide-react";
import { AIChatRequestError, cancelAIChatRun, streamAIChatMessage } from "./api";
import { activeAIChatTarget, activeAIEntry, activeAIRuleFileName, aiVerifiedReady, type AISettingsState } from "./settingsState";
import type { AIChatAttachment, AIChatContextChip, AIChatContextPathRequest, AIChatMessage, AIChatSessionState, AIEntryKind, AIModelBehavior, FileResponse, TreeNode } from "./types";
import { injectMarkdownCodeToolbarButtons, installCodeBlockRule } from "../shared/markdownCodeBlocks";
import { installTableScrollRule } from "../shared/markdownTableScroll";
import { installTaskListRule } from "../shared/markdownTaskLists";

type AIChatPanelProps = {
  aiSettings: AISettingsState;
  session: AIChatSessionState;
  onSessionChange: (updater: (session: AIChatSessionState) => AIChatSessionState) => void;
  modelBehavior: AIModelBehavior;
  activeRepoId: string;
  activeRepoRevision: string;
  activeFile: FileResponse | null;
  rootTreeNodes: TreeNode[];
  onReadinessFailure: (entry: AIEntryKind, message: string) => void;
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

export function AIChatPanel({ aiSettings, session, onSessionChange, modelBehavior, activeRepoId, activeRepoRevision, rootTreeNodes, onReadinessFailure, onOpenSettings, onMarkdownClick }: AIChatPanelProps) {
  const [copyStateById, setCopyStateById] = useState<Record<string, CopyState>>({});
  const [voiceActive, setVoiceActive] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef("");
  const cancelRequestedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null);
  const autoScrollPinnedRef = useRef(true);
  const onSessionChangeRef = useRef(onSessionChange);
  onSessionChangeRef.current = onSessionChange;
  const activeRepoIdentity = `${activeRepoId}:${activeRepoRevision}`;
  const activeRepoIdentityRef = useRef(activeRepoIdentity);
  const effectRepoIdentityRef = useRef(activeRepoIdentity);
  activeRepoIdentityRef.current = activeRepoIdentity;
  const activeEntry = activeAIEntry(aiSettings);
  const target = activeAIChatTarget(aiSettings);
  const providerWriteMode = Boolean(target && "provider" in target && target.provider.executionMode === "repoWrite");
  const targetIdentity = target
    ? "provider" in target
      ? [target.kind, target.provider.entry, target.provider.executionMode || "readOnly", target.provider.provider || "", target.provider.runtime || "", target.provider.model, target.provider.baseUrl, target.provider.apiFormat].join(":")
      : `${target.kind}:${target.entry}`
    : "none";
  const targetIdentityRef = useRef(targetIdentity);
  targetIdentityRef.current = targetIdentity;
  const ready = Boolean(target && activeEntry && aiVerifiedReady(aiSettings, activeEntry.entry));
  const defaultRuleChip = useMemo(() => buildDefaultRuleChip(aiSettings, activeRepoId, rootTreeNodes, session.dismissedRulePathKeys || []), [aiSettings, activeRepoId, rootTreeNodes, session.dismissedRulePathKeys]);
  const visibleContextChips = useMemo(() => visibleAIContextChips(session.contextChips || [], activeRepoId, defaultRuleChip), [session.contextChips, activeRepoId, defaultRuleChip]);
  const selectedPathChips = useMemo(() => visibleContextChips.filter((chip) => chip.role === "primary"), [visibleContextChips]);
  const ruleChips = useMemo(() => visibleContextChips.filter((chip) => chip.role === "rule"), [visibleContextChips]);
  const canSend = Boolean(ready && activeRepoId && session.draft.trim() && !session.pending);
  const voiceAvailable = Boolean(getSpeechRecognitionCtor());

  useEffect(() => {
    if (effectRepoIdentityRef.current === activeRepoIdentity) return;
    effectRepoIdentityRef.current = activeRepoIdentity;
    const controller = abortRef.current;
    if (!controller) return;
    const runId = activeRunIdRef.current;
    abortRef.current = null;
    activeRunIdRef.current = "";
    cancelRequestedRef.current = false;
    controller.abort();
    if (runId) void cancelAIChatRun(runId).catch(() => undefined);
    setCanceling(false);
  }, [activeRepoIdentity]);

  useEffect(() => {
    return () => {
      const controller = abortRef.current;
      if (!controller) return;
      const runId = activeRunIdRef.current;
      abortRef.current = null;
      activeRunIdRef.current = "";
      cancelRequestedRef.current = false;
      controller.abort();
      if (runId) void cancelAIChatRun(runId).catch(() => undefined);
      onSessionChangeRef.current((current) => {
        const lastMessage = current.messages[current.messages.length - 1];
        const next = current.pending && lastMessage?.role === "assistant" && !lastMessage.content
          ? replaceLastAssistant(current, "AI Chat request canceled when the panel closed.")
          : current;
        return {
          ...next,
          pending: false,
          error: "AI Chat request canceled when the panel closed.",
        };
      });
    };
  }, []);

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
    if (session.pending || abortRef.current) return;
    if (!target || !ready) {
      updateSession((current) => ({ ...current, error: "Open Settings to finish AI Chat setup." }));
      return;
    }
    if (!activeRepoId) {
      updateSession((current) => ({ ...current, error: "Select a repository before sending." }));
      return;
    }

    const requestAttachments = session.attachments;
    const requestRepoIdentity = activeRepoIdentity;
    const requestTargetIdentity = targetIdentity;
    const requestContextChips = visibleContextChips;
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
      contextChips: (current.contextChips || []).filter((chip) => !isOneShotContextChip(chip)),
    }));

    const controller = new AbortController();
    abortRef.current = controller;
    activeRunIdRef.current = "";
    cancelRequestedRef.current = false;
    setCanceling(false);
    try {
      await streamAIChatMessage(
        {
          target,
          messages: [...session.messages, userMessage],
          context: {
            repoId: activeRepoId,
            expectedRevision: activeRepoRevision,
            primaryPaths: requestContextChips.filter((chip) => chip.role === "primary").map(chipToContextPathRequest),
            rulePaths: requestContextChips.filter((chip) => chip.role === "rule").map(chipToContextPathRequest),
          },
          attachments: requestAttachments,
          modelBehavior,
        },
        (event) => {
          if (abortRef.current !== controller || activeRepoIdentityRef.current !== requestRepoIdentity || targetIdentityRef.current !== requestTargetIdentity) return;
          if (event.type === "meta") {
            activeRunIdRef.current = event.runId || "";
            if (cancelRequestedRef.current && event.runId) void requestServerCancellation(event.runId, controller);
            return;
          }
          if (event.type === "delta") {
            updateSessionAndFollow((current) => appendAssistantDelta(current, event.content));
            return;
          }
          if (event.type === "done") {
            updateSessionAndFollow((current) => replaceLastAssistant(current, appendRunSummary(event.message.content, event.run)));
            return;
          }
          if (event.type === "error") {
            updateSessionAndFollow((current) => ({
              ...(event.details?.run
                ? replaceLastAssistant(current, appendRunSummary(event.error, event.details.run))
                : replaceLastAssistant(current, event.error)),
              error: event.error,
            }));
          }
        },
        controller.signal,
      );
    } catch (nextError) {
      if (abortRef.current === controller && activeRepoIdentityRef.current === requestRepoIdentity && targetIdentityRef.current === requestTargetIdentity) {
        const message = controller.signal.aborted ? "AI Chat request canceled." : nextError instanceof Error ? nextError.message : String(nextError);
        if (nextError instanceof AIChatRequestError && nextError.code === "readiness_renewal_failed" && nextError.entry) {
          onReadinessFailure(nextError.entry, message);
        }
        updateSession((current) => ({
          ...replaceLastAssistant(current, message),
          error: message,
        }));
      }
    } finally {
      if (abortRef.current === controller && activeRepoIdentityRef.current === requestRepoIdentity && targetIdentityRef.current === requestTargetIdentity) {
        updateSession((current) => ({ ...current, pending: false }));
        abortRef.current = null;
        activeRunIdRef.current = "";
        cancelRequestedRef.current = false;
        setCanceling(false);
      }
    }
  }

  async function cancelRequest() {
    const controller = abortRef.current;
    if (!controller || controller.signal.aborted) return;
    setCanceling(true);
    cancelRequestedRef.current = true;
    updateSession((current) => ({ ...current, error: "Canceling AI Chat request..." }));
    const runId = activeRunIdRef.current;
    if (!runId) {
      controller.abort();
      return;
    }
    await requestServerCancellation(runId, controller);
  }

  async function requestServerCancellation(runId: string, controller: AbortController) {
    try {
      await cancelAIChatRun(runId);
    } catch (error) {
      if (abortRef.current !== controller) return;
      setCanceling(false);
      cancelRequestedRef.current = false;
      updateSession((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    }
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

  function removeContextChip(chip: AIChatContextChip) {
    if (chip.source === "auto-root-rule") {
      const key = contextChipKey(chip.repoId, chip.path, chip.role);
      updateSession((current) => ({
        ...current,
        dismissedRulePathKeys: Array.from(new Set([...(current.dismissedRulePathKeys || []), key])),
      }));
      return;
    }
    updateSession((current) => ({ ...current, contextChips: (current.contextChips || []).filter((item) => item.id !== chip.id) }));
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
      const target = transcriptBottomRef.current;
      if (typeof target?.scrollIntoView === "function") target.scrollIntoView({ block: "end" });
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

      <div ref={transcriptRef} className="ai-chat-messages" role="log" aria-label="AI Chat transcript" aria-live="polite" onScroll={updateTranscriptPinning}>
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
          {session.lastRequest && !session.pending ? (
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
          {selectedPathChips.length ? (
            <div className="ai-context-chip-list" aria-label="AI Chat selected paths">
              {selectedPathChips.map((chip) => (
                <span key={chip.id} className={`ai-context-chip ${chip.role}`}>
                  <small>Path</small>
                  <span title={chip.path}>{chip.path}</span>
                  <button type="button" className="icon-button" aria-label={`Remove ${chip.path}`} title="Remove context" onClick={() => removeContextChip(chip)}>
                    <X aria-hidden="true" focusable="false" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
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
          {ruleChips.length ? (
            <div className="ai-rule-chip-list" aria-label="AI Chat rules">
              {ruleChips.map((chip) => (
                <span key={chip.id} className={`ai-context-chip ${chip.role}`}>
                  <small>Rules</small>
                  <span title={chip.path}>{chip.path}</span>
                  <button type="button" className="icon-button" aria-label={`Remove ${chip.path}`} title="Remove context" onClick={() => removeContextChip(chip)}>
                    <X aria-hidden="true" focusable="false" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {providerWriteMode ? (
            <p className="ai-edit-target-hint ready" role="note">
              Sending an explicit edit request authorizes one guarded run. Selected paths are hints; Reader-Wiki mediates bounded reads and validates every text operation inside the Current repo. To authorize deletion, add an exact <code>DELETE: relative/path</code> line for each file.
            </p>
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
              <button type="button" className="icon-button" aria-label={canceling ? "Canceling AI Chat request" : "Cancel AI Chat request"} title={canceling ? "Canceling AI Chat request" : "Cancel AI Chat request"} disabled={canceling} onClick={() => void cancelRequest()}>
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

function buildDefaultRuleChip(aiSettings: AISettingsState, activeRepoId: string, rootTreeNodes: TreeNode[], dismissedKeys: string[]): AIChatContextChip | null {
  const rulePath = activeAIRuleFileName(aiSettings);
  if (!activeRepoId || !rulePath) return null;
  if (!rootTreeNodes.some((node) => node.type === "file" && node.path === rulePath)) return null;
  const key = contextChipKey(activeRepoId, rulePath, "rule");
  if (dismissedKeys.includes(key)) return null;
  return {
    id: `auto-rule:${activeRepoId}:${rulePath}`,
    repoId: activeRepoId,
    path: rulePath,
    kind: "file",
    role: "rule",
    source: "auto-root-rule",
    removable: true,
  };
}

function visibleAIContextChips(sessionChips: AIChatContextChip[], activeRepoId: string, defaultRuleChip: AIChatContextChip | null): AIChatContextChip[] {
  const chips = sessionChips.filter((chip) => chip.repoId === activeRepoId);
  if (!defaultRuleChip) return chips;
  if (chips.some((chip) => chip.role === "rule" && chip.path === defaultRuleChip.path)) return chips;
  return [...chips, defaultRuleChip];
}

function chipToContextPathRequest(chip: AIChatContextChip): AIChatContextPathRequest {
  return { path: chip.path, kind: chip.kind, source: chip.source, includeContent: true };
}

function isOneShotContextChip(chip: AIChatContextChip): boolean {
  return chip.role === "primary" && chip.source === "tree-menu";
}

function contextChipKey(repoId: string, path: string, role: string): string {
  return `${repoId}:${role}:${path}`;
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

function appendRunSummary(content: string, run: { auditState: "verified" | "unverified"; readPaths?: string[]; changedPaths: Array<{ path: string; status: string }>; repairs?: string[]; warnings: string[] }): string {
  const reads = run.readPaths?.length ? ["Provider-visible read paths:", ...run.readPaths.map((item) => `- ${item}`)].join("\n") : "";
  const changed = run.changedPaths.length
    ? ["Changed paths:", ...run.changedPaths.map((item) => `- ${item.status}: ${item.path}`)].join("\n")
    : run.auditState === "verified"
      ? "No repository changes."
      : "Repository changes unverified.";
  const repairs = run.repairs?.length ? ["Repairs:", ...run.repairs.map((repair) => `- ${repair}`)].join("\n") : "";
  const warnings = run.warnings.length ? ["Warnings:", ...run.warnings.map((warning) => `- ${warning}`)].join("\n") : "";
  return [content, reads, changed, repairs, warnings].filter(Boolean).join("\n\n");
}

function renderAIMessage(content: string): string {
  return DOMPurify.sanitize(injectMarkdownCodeToolbarButtons(aiMarkdown.render(content)), {
    ADD_TAGS: ["button", "svg", "path", "rect"],
    ADD_ATTR: [
      "aria-hidden", "aria-label", "aria-pressed", "checked", "class", "d", "data-copy-state", "data-reader-wiki-code-block",
      "data-wrap-state", "disabled", "focusable", "height", "href", "name", "rel", "rx", "ry", "target", "title", "type", "viewBox", "width", "x", "y",
    ],
    FORBID_TAGS: ["form", "iframe", "object", "script", "style", "template"],
    FORBID_ATTR: ["srcdoc"],
    ALLOW_DATA_ATTR: true,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
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

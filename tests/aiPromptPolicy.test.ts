import { describe, expect, it } from "vitest";
import { aiChatSystemPromptPath } from "../server/aiPromptPolicy.js";

describe("AI Chat prompt path", () => {
  it("prefers the Local Reader App variable and keeps the legacy fallback", () => {
    expect(aiChatSystemPromptPath({
      LOCAL_READER_APP_AI_CHAT_SYSTEM_PROMPT: "/tmp/canonical.md",
      READER_WIKI_AI_CHAT_SYSTEM_PROMPT: "/tmp/legacy.md",
    }, "/tmp/default.md")).toBe("/tmp/canonical.md");
    expect(aiChatSystemPromptPath({
      READER_WIKI_AI_CHAT_SYSTEM_PROMPT: "/tmp/legacy.md",
    }, "/tmp/default.md")).toBe("/tmp/legacy.md");
    expect(aiChatSystemPromptPath({}, "/tmp/default.md")).toBe("/tmp/default.md");
  });
});

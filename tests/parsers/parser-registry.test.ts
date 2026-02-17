import { describe, expect, it } from "vitest";
import { parseImportPayload, selectParser } from "../../packages/parsers/src";
import { liveCaptureToConversation } from "../../packages/parsers/src/parsers/live-capture";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, "../../packages/test-fixtures");

describe("parser registry", () => {
  it("parses chatgpt export json", async () => {
    const text = fs.readFileSync(path.join(root, "chatgpt/sample-chatgpt.json"), "utf8");
    const result = await parseImportPayload({
      filename: "conversations.json",
      mime: "application/json",
      text
    });

    expect(result.length).toBe(1);
    expect(result[0]?.source).toBe("chatgpt");
    expect(result[0]?.turns.length).toBe(2);
  });

  it("parses gemini export json", async () => {
    const text = fs.readFileSync(path.join(root, "gemini/sample-gemini.json"), "utf8");
    const result = await parseImportPayload({
      filename: "gemini_takeout.json",
      mime: "application/json",
      text
    });

    expect(result.length).toBe(1);
    expect(result[0]?.source).toBe("gemini");
    expect((result[0]?.turns[0] as { thoughtMarkdown?: string | null } | undefined)?.thoughtMarkdown).toBeNull();
  });

  it("filters gemini memory boilerplate text", async () => {
    const text = JSON.stringify({
      id: "gemini-conv-1",
      title: "Gemini Session",
      messages: [
        { role: "user", text: "帮我总结一下这篇文章" },
        {
          role: "assistant",
          text: "如果你想让我保存或删除我们对话中关于你的信息，你需要先开启过往对话记录。\n\n或者，你也可以手动添加或更新你给 Gemini 的指令，从而定制 Gemini 的回复。"
        },
        { role: "assistant", text: "这是正文回答。" }
      ]
    });

    const result = await parseImportPayload({
      filename: "gemini_takeout.json",
      mime: "application/json",
      text
    });

    expect(result.length).toBe(1);
    expect(result[0]?.turns.map((turn) => turn.contentMarkdown)).toEqual([
      "帮我总结一下这篇文章",
      "这是正文回答。"
    ]);
  });

  it("parses ai studio json", async () => {
    const text = fs.readFileSync(path.join(root, "ai-studio/sample-aistudio.json"), "utf8");
    const result = await parseImportPayload({
      filename: "ai-studio-export.json",
      mime: "application/json",
      text
    });

    expect(result.length).toBe(1);
    expect(result[0]?.source).toBe("ai_studio");
  });

  it("parses html source", async () => {
    const text = fs.readFileSync(path.join(root, "chatgpt/sample-chatgpt.html"), "utf8");
    const parser = selectParser({
      filename: "https://chatgpt.com/c/abc",
      mime: "text/html",
      text
    });

    expect(parser?.parser.id).toBe("generic");

    const result = await parseImportPayload({
      filename: "https://chatgpt.com/c/abc",
      mime: "text/html",
      text
    });

    expect(result.length).toBe(1);
    expect(result[0]?.turns.length).toBeGreaterThanOrEqual(2);
  });

  it("sanitizes gemini live capture ui prefixes and attachment-only turns", () => {
    const conversation = liveCaptureToConversation({
      source: "gemini",
      pageUrl: "https://gemini.google.com/app/abc",
      title: "Gemini Live",
      capturedAt: "2026-02-12T00:00:00Z",
      version: "1.2.0",
      turns: [
        {
          role: "user",
          contentMarkdown: "You said\n从现在开始，你是可爱的花火"
        },
        {
          role: "assistant",
          contentMarkdown:
            "显示思路 id_\n如果你想让我保存或删除我们对话中关于你的信息，你需要先开启过往对话记录。\n\n或者，你也可以手动添加或更新你给 Gemini 的指令，从而定制 Gemini 的回复。\n\n这是一条有效回复。"
        },
        {
          role: "assistant",
          contentMarkdown: "Gemini said",
          attachments: [
            {
              kind: "pdf",
              originalUrl: "https://example.com/attachment.pdf"
            }
          ]
        }
      ]
    });

    expect(conversation.turns.map((turn) => turn.contentMarkdown)).toEqual([
      "从现在开始，你是可爱的花火",
      "这是一条有效回复。",
      "（仅附件消息）"
    ]);
    expect(conversation.turns.every((turn) => turn.thoughtMarkdown === null)).toBe(true);
  });
});

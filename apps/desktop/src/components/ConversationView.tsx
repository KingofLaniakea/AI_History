import React, { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { ConversationDetail } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { QANavigator, QASideSlider, useQaPairs } from "./QANavigator";

interface ConversationViewProps {
  conversation: ConversationDetail | null;
}

export function ConversationView({ conversation }: ConversationViewProps) {
  const messageContainerRef = useRef<HTMLDivElement>(null);
  const pairs = useQaPairs(conversation?.messages ?? []);
  const [activePair, setActivePair] = useState(0);

  useEffect(() => {
    setActivePair(0);
    if (messageContainerRef.current) {
      messageContainerRef.current.scrollTop = 0;
    }
  }, [conversation?.id]);

  const pairTargets = useMemo(() => {
    const messages = conversation?.messages ?? [];
    return pairs.map((pair) => messages.find((msg) => msg.seq === pair.firstMessageSeq)?.id ?? "");
  }, [conversation?.messages, pairs]);

  const jumpToPair = (index: number) => {
    if (!conversation || pairs.length === 0) {
      return;
    }

    const bounded = Math.max(0, Math.min(index, pairs.length - 1));
    setActivePair(bounded);
    const target = pairTargets[bounded];
    const container = messageContainerRef.current;
    const element = document.getElementById(`msg-${target}`);
    if (container && element) {
      const offsetTop = element.offsetTop - container.offsetTop;
      container.scrollTo({ top: offsetTop, behavior: "smooth" });
    }
  };

  useHotkeys("j", () => jumpToPair(activePair + 1), {}, [activePair, pairTargets]);
  useHotkeys("k", () => jumpToPair(activePair - 1), {}, [activePair, pairTargets]);
  useHotkeys(
    "meta+g,ctrl+g",
    (event) => {
      event.preventDefault();
      if (!pairs.length) {
        return;
      }

      const answer = window.prompt(`跳转到问答编号 (1 - ${pairs.length})`);
      if (!answer) {
        return;
      }

      const num = Number(answer);
      if (!Number.isNaN(num) && num >= 1 && num <= pairs.length) {
        jumpToPair(num - 1);
      }
    },
    {},
    [pairs.length]
  );

  if (!conversation) {
    return (
      <section className="panel conversation-view-panel">
        <div className="empty-state">请选择一条会话查看详情。</div>
      </section>
    );
  }

  const sourceLabel =
    conversation.source === "ai_studio"
      ? "AI Studio"
      : conversation.source === "chatgpt"
        ? "ChatGPT"
        : "Gemini";

  return (
    <section className="panel conversation-view-panel">
      <header className="conversation-view-header">
        <div className="conversation-title-wrap">
          <span className={`source-badge source-${conversation.source}`}>{sourceLabel}</span>
          <h2>{conversation.title}</h2>
        </div>
        <div className="conversation-header-meta">
          <div className="muted">
            {conversation.messages.length} 条消息 · {conversation.attachments.length} 个附件
          </div>
        </div>
      </header>

      {pairs.length > 0 ? <QANavigator pairs={pairs} activePair={activePair} onJump={jumpToPair} /> : null}

      <div className="conversation-scroll" ref={messageContainerRef}>
        {conversation.messages.map((message) => (
          <div className={`message-row role-${message.role}`} key={message.id}>
            <MessageBubble
              message={message}
              id={`msg-${message.id}`}
              attachments={conversation.attachments.filter((item) => item.messageId === message.id)}
            />
          </div>
        ))}
      </div>

      {pairs.length > 0 ? <QASideSlider pairs={pairs} activePair={activePair} onJump={jumpToPair} /> : null}
    </section>
  );
}

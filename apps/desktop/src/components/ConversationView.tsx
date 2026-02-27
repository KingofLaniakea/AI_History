import React, { useEffect, useMemo, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import type { ConversationDetail } from "../lib/types";
import { MessageBubble } from "./MessageBubble";
import { QASideSlider, useQaPairs } from "./QANavigator";

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

  const scrollAnimRef = useRef<number | null>(null);
  const scrollTargetRef = useRef<number>(0);

  const smoothScrollTo = (container: HTMLElement, targetTop: number) => {
    scrollTargetRef.current = targetTop;

    // If animation is already running, it will chase the new target automatically
    if (scrollAnimRef.current !== null) return;

    const step = () => {
      const current = container.scrollTop;
      const remaining = scrollTargetRef.current - current;

      if (Math.abs(remaining) < 1) {
        container.scrollTop = scrollTargetRef.current;
        scrollAnimRef.current = null;
        return;
      }

      // Lerp: move 15% of remaining distance each frame (~60fps)
      container.scrollTop = current + remaining * 0.15;
      scrollAnimRef.current = requestAnimationFrame(step);
    };

    scrollAnimRef.current = requestAnimationFrame(step);
  };

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
      smoothScrollTo(container, offsetTop);
    }
  };

  const handleScroll = () => {
    const container = messageContainerRef.current;
    if (!container || pairs.length === 0) return;

    const scrollTop = container.scrollTop;
    let newActivePair = 0;
    
    pairTargets.forEach((targetId, index) => {
      const element = document.getElementById(`msg-${targetId}`);
      if (element) {
        const offsetTop = element.offsetTop - container.offsetTop;
        if (scrollTop >= offsetTop - 120) {
          newActivePair = index;
        }
      }
    });

    if (newActivePair !== activePair) {
      setActivePair(newActivePair);
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
        <div className="empty-state" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16 }}>
             <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
             <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 500, color: 'var(--text-secondary)' }}>未选择会话</p>
          <p style={{ margin: 0, fontSize: 14 }}>请在左侧选择一条会话查看详情。</p>
        </div>
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

      <div className="conversation-scroll" ref={messageContainerRef} onScroll={handleScroll}>
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

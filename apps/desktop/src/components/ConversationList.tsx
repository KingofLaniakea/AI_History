import React from "react";
import { SourceBadge } from "@ai-history/ui";
import type { ConversationSummary } from "../lib/types";
import { useAppStore } from "../lib/store";

interface ConversationListProps {
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  onOpen: (id: string) => void;
  groupByCreatedDate?: boolean;
}

function groupByDate(conversations: ConversationSummary[]) {
  const grouped = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations) {
    const raw = conversation.createdAt || "";
    const dateLabel = raw ? new Date(raw).toLocaleDateString("zh-CN") : "未知日期";
    if (!grouped.has(dateLabel)) {
      grouped.set(dateLabel, []);
    }
    grouped.get(dateLabel)!.push(conversation);
  }
  return Array.from(grouped.entries());
}

export function ConversationList({
  conversations,
  selectedConversationId,
  onOpen,
  groupByCreatedDate = false
}: ConversationListProps) {
  const draggingConversationId = useAppStore((s) => s.draggingConversationId);
  const setDraggingConversationId = useAppStore((s) => s.setDraggingConversationId);
  const setDragPointer = useAppStore((s) => s.setDragPointer);
  const groups = groupByCreatedDate ? groupByDate(conversations) : [];

  const pendingDragRef = React.useRef<{ id: string; x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 5;

  React.useEffect(() => {
    const className = "dragging-conversation";
    if (draggingConversationId) {
      document.body.classList.add(className);
    } else {
      document.body.classList.remove(className);
    }
    return () => {
      document.body.classList.remove(className);
    };
  }, [draggingConversationId]);

  React.useEffect(() => {
    const handleMove = (event: PointerEvent) => {
      const pending = pendingDragRef.current;
      if (!pending) return;
      const dx = event.clientX - pending.x;
      const dy = event.clientY - pending.y;
      if (Math.abs(dx) + Math.abs(dy) >= DRAG_THRESHOLD) {
        pendingDragRef.current = null;
        setDragPointer({ x: event.clientX, y: event.clientY });
        setDraggingConversationId(pending.id);
      }
    };
    const handleUp = () => {
      pendingDragRef.current = null;
    };
    const handleCancel = () => {
      pendingDragRef.current = null;
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };
  }, [setDragPointer, setDraggingConversationId]);

  const beginPendingDrag = React.useCallback(
    (conversationId: string, clientX: number, clientY: number) => {
      pendingDragRef.current = { id: conversationId, x: clientX, y: clientY };
    },
    []
  );

  const renderItem = (conversation: ConversationSummary) => (
    <div
      key={conversation.id}
      draggable={false}
      onDragStart={(event) => {
        event.preventDefault();
      }}
      className={`conversation-item ${selectedConversationId === conversation.id ? "active" : ""} ${
        draggingConversationId === conversation.id ? "dragging" : ""
      }`}
      onClick={() => {
        if (draggingConversationId) {
          return;
        }
        onOpen(conversation.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!draggingConversationId) {
            onOpen(conversation.id);
          }
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        window.getSelection()?.removeAllRanges();
        beginPendingDrag(conversation.id, event.clientX, event.clientY);
      }}
      role="button"
      tabIndex={0}
      title="可拖拽到左侧文件夹"
    >
      <div className="conversation-title">{conversation.title}</div>
      <div className="conversation-meta">
        <SourceBadge source={conversation.source} />
        <span>{conversation.messageCount} 条消息</span>
      </div>
    </div>
  );

  return (
    <section className="panel conversation-list-panel">
      <div className="panel-header">
        <h3>对话列表</h3>
        <span className="muted">{conversations.length}</span>
      </div>
      <div className="conversation-list">
        {groupByCreatedDate
          ? groups.map(([dateLabel, items]) => (
              <div key={dateLabel} className="conversation-date-group">
                <div className="conversation-date-title">{dateLabel}</div>
                {items.map((conversation) => renderItem(conversation))}
              </div>
            ))
          : conversations.map((conversation) => renderItem(conversation))}
        {conversations.length === 0 && <div className="empty-state">暂无会话，先导入数据或通过插件抓取。</div>}
      </div>
    </section>
  );
}

import React, { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConversationView } from "./components/ConversationView";
import { ExplorerSidebar } from "./components/ExplorerSidebar";
import { SettingsPanel } from "./components/SettingsPanel";
import { useConversation, useConversations, useFolders, useMoveConversation, useSearch } from "./hooks/useData";
import { useAppStore } from "./lib/store";

export function App() {
  const queryClient = useQueryClient();
  const [leftCollapsed, setLeftCollapsed] = React.useState<boolean>(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("ai-history-left-collapsed") === "1";
  });
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const selectedConversationId = useAppStore((s) => s.selectedConversationId);
  const draggingConversationId = useAppStore((s) => s.draggingConversationId);
  const dragPointer = useAppStore((s) => s.dragPointer);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const searchQuery = useAppStore((s) => s.searchQuery);

  const setSelectedFolderId = useAppStore((s) => s.setSelectedFolderId);
  const setSelectedConversationId = useAppStore((s) => s.setSelectedConversationId);
  const setSourceFilter = useAppStore((s) => s.setSourceFilter);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);

  const folders = useFolders();
  const moveConversation = useMoveConversation();
  const conversations = useConversations({
    folderId: selectedFolderId,
    source: sourceFilter
  });
  const selectedConversation = useConversation(selectedConversationId);
  const search = useSearch(searchQuery);

  const listData = useMemo(() => {
    if (searchQuery.trim() && search.data) {
      return search.data.map((entry) => entry.conversation);
    }

    return conversations.data ?? [];
  }, [searchQuery, search.data, conversations.data]);

  React.useEffect(() => {
    if (selectedConversationId && listData.length > 0) {
      const stillInList = listData.some((c) => c.id === selectedConversationId);
      if (!stillInList) {
        setSelectedConversationId(null);
      }
    }
  }, [listData, selectedConversationId, setSelectedConversationId]);

  const draggingConversation = useMemo(() => {
    if (!draggingConversationId) {
      return null;
    }
    return listData.find((item) => item.id === draggingConversationId) ?? null;
  }, [draggingConversationId, listData]);

  React.useEffect(() => {
    const refreshAll = () => {
      void queryClient.invalidateQueries({ queryKey: ["folders"] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      if (selectedConversationId) {
        void queryClient.invalidateQueries({ queryKey: ["conversation", selectedConversationId] });
      }
      if (searchQuery.trim()) {
        void queryClient.invalidateQueries({ queryKey: ["search"] });
      }
    };

    const onFocus = () => {
      refreshAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshAll();
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [queryClient, searchQuery, selectedConversationId]);

  React.useEffect(() => {
    window.localStorage.setItem("ai-history-left-collapsed", leftCollapsed ? "1" : "0");
  }, [leftCollapsed]);

  return (
    <div className={`app-shell ${leftCollapsed ? "left-collapsed" : ""}`}>
      <aside className={`left-column ${leftCollapsed ? "collapsed" : ""}`}>
        {!leftCollapsed ? (
          <>
            <ExplorerSidebar
              folders={folders.data ?? []}
              conversations={listData}
              selectedFolderId={selectedFolderId}
              selectedConversationId={selectedConversationId}
              searchQuery={searchQuery}
              sourceFilter={sourceFilter}
              onSelectFolder={(id) => {
                setSelectedFolderId(id);
                setSelectedConversationId(null);
                setSearchQuery("");
              }}
              onOpenConversation={setSelectedConversationId}
              onDropConversation={(conversationId, folderId) => {
                void moveConversation
                  .mutateAsync({ id: conversationId, folderId })
                  .catch((error) => {
                    const message = error instanceof Error ? error.message : "未知错误";
                    window.alert(`移动失败：${message}`);
                  });
              }}
              onSearchChange={setSearchQuery}
              onSourceChange={setSourceFilter}
              onCollapse={() => setLeftCollapsed(true)}
              groupByCreatedDate={!searchQuery.trim() && selectedFolderId === null}
            />
            <SettingsPanel folderId={selectedFolderId} />
          </>
        ) : (
          <div className="collapsed-sidebar">
            <button
              className="collapsed-sidebar-btn active"
              onClick={() => setLeftCollapsed(false)}
              title="资源管理器"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </button>
            <div className="collapsed-sidebar-spacer" />
            <button
              className="collapsed-sidebar-btn"
              onClick={() => setLeftCollapsed(false)}
              title="设置"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          </div>
        )}
      </aside>

      <section className="right-column">
        <ConversationView conversation={selectedConversation.data ?? null} />
      </section>

      {draggingConversation && dragPointer ? (
        <div
          className="drag-preview"
          style={{ left: `${dragPointer.x + 14}px`, top: `${dragPointer.y + 14}px` }}
        >
          <span className="drag-preview-plus">+</span>
          <span className="drag-preview-title">{draggingConversation.title}</span>
        </div>
      ) : null}
    </div>
  );
}

import React, { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConversationList } from "./components/ConversationList";
import { ConversationView } from "./components/ConversationView";
import { FolderTree } from "./components/FolderTree";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchBar } from "./components/SearchBar";
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
        <button
          className="left-collapse-toggle"
          onClick={() => setLeftCollapsed((value) => !value)}
          title={leftCollapsed ? "展开文件夹栏" : "收起文件夹栏"}
        >
          {leftCollapsed ? "›" : "‹"}
        </button>
        {!leftCollapsed ? (
          <>
            <FolderTree
              folders={folders.data ?? []}
              selectedFolderId={selectedFolderId}
              onDropConversation={(conversationId, folderId) => {
                void moveConversation
                  .mutateAsync({ id: conversationId, folderId })
                  .catch((error) => {
                    const message = error instanceof Error ? error.message : "未知错误";
                    window.alert(`移动失败：${message}`);
                  });
              }}
              onSelect={(id) => {
                setSelectedFolderId(id);
                setSelectedConversationId(null);
              }}
            />
            <SettingsPanel folderId={selectedFolderId} />
          </>
        ) : null}
      </aside>

      <main className="center-column">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          source={sourceFilter}
          onSourceChange={setSourceFilter}
        />
        <ConversationList
          conversations={listData}
          selectedConversationId={selectedConversationId}
          onOpen={setSelectedConversationId}
          groupByCreatedDate={!searchQuery.trim() && selectedFolderId === null}
        />
      </main>

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

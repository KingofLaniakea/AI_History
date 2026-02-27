import React, { useMemo, useState } from "react";
import type { Folder } from "@ai-history/core-types";
import { SourceBadge } from "@ai-history/ui";
import type { ConversationSummary } from "../lib/types";
import { useAppStore } from "../lib/store";
import { buildFolderTree, useCreateFolder, useDeleteFolder, useMoveFolder } from "../hooks/useData";

/* ── Props ── */

interface ExplorerSidebarProps {
  folders: Folder[];
  conversations: ConversationSummary[];
  selectedFolderId: string | null;
  selectedConversationId: string | null;
  searchQuery: string;
  sourceFilter: "all" | "chatgpt" | "gemini" | "ai_studio";
  onSelectFolder: (folderId: string | null) => void;
  onOpenConversation: (id: string) => void;
  onDropConversation: (conversationId: string, folderId: string) => void;
  onSearchChange: (query: string) => void;
  onSourceChange: (source: ExplorerSidebarProps["sourceFilter"]) => void;
  onCollapse: () => void;
  groupByCreatedDate: boolean;
}

/* ── Helpers ── */

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

/* ── Folder Node ── */

function FolderNode({
  folder,
  allFolders,
  tree,
  selectedFolderId,
  selectedConversationId,
  depth,
  onSelect,
  onDelete,
  onMove,
  onDropConversation,
  hoverFolderId,
  draggingConversationId,
  conversations,
  onOpenConversation,
  beginPendingDrag,
  groupByCreatedDate,
  searchQuery
}: {
  folder: Folder;
  allFolders: Folder[];
  tree: Record<string, Folder[]>;
  selectedFolderId: string | null;
  selectedConversationId: string | null;
  depth: number;
  onSelect: (folderId: string | null) => void;
  onDelete: (folderId: string) => void;
  onMove: (folderId: string, newParentId: string | null) => void;
  onDropConversation: (conversationId: string, folderId: string) => void;
  hoverFolderId: string | null;
  draggingConversationId: string | null;
  conversations: ConversationSummary[];
  onOpenConversation: (id: string) => void;
  beginPendingDrag: (id: string, x: number, y: number) => void;
  groupByCreatedDate: boolean;
  searchQuery: string;
}) {
  const children = tree[folder.id] ?? [];
  const isActive = selectedFolderId === folder.id;
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const fileIndent = (depth + 2) * 16 + 4;

  const handleFolderClick = () => {
    if (draggingConversationId) {
      onDropConversation(draggingConversationId, folder.id);
      return;
    }
    // Toggle: click again to deselect → show all
    onSelect(isActive ? null : folder.id);
  };

  const getDescendantIds = (folderId: string): Set<string> => {
    const ids = new Set<string>();
    const queue = [folderId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      ids.add(current);
      for (const child of tree[current] ?? []) {
        queue.push(child.id);
      }
    }
    return ids;
  };

  const moveTargets = useMemo(() => {
    const descendants = getDescendantIds(folder.id);
    const targets: { id: string | null; name: string }[] = [{ id: null, name: "顶层（根目录）" }];
    for (const f of allFolders) {
      if (f.id !== folder.id && !descendants.has(f.id) && f.id !== folder.parentId) {
        targets.push({ id: f.id, name: f.name });
      }
    }
    return targets;
  }, [allFolders, folder.id, folder.parentId]);

  React.useEffect(() => {
    if (!showMoveMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".folder-move-menu")) {
        setShowMoveMenu(false);
      }
    };
    document.addEventListener("click", handleClickOutside, { capture: true });
    return () => document.removeEventListener("click", handleClickOutside, { capture: true });
  }, [showMoveMenu]);

  const groups = groupByCreatedDate && isActive ? groupByDate(conversations) : [];

  return (
    <div>
      {/* Folder row */}
      <div
        className={`explorer-row explorer-folder ${isActive ? "active" : ""} ${
          hoverFolderId === folder.id ? "drag-hover" : ""
        }`}
        data-folder-id={folder.id}
        style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
        onClick={handleFolderClick}
      >
        <svg
          className={`explorer-chevron ${isActive ? "open" : ""}`}
          width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
        <svg className="explorer-icon folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="explorer-label">{folder.name}</span>
        <div className="explorer-actions">
          <button
            className="explorer-action-btn"
            title="移动文件夹"
            onClick={(event) => {
              event.stopPropagation();
              setShowMoveMenu((prev) => !prev);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 9l7-7 7 7M5 15l7 7 7-7" />
            </svg>
          </button>
          {folder.parentId && (
            <button
              className="explorer-action-btn explorer-action-danger"
              title="删除文件夹"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(folder.id);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
              </svg>
            </button>
          )}
        </div>
        {showMoveMenu && (
          <div className="folder-move-menu" onClick={(e) => e.stopPropagation()}>
            <div className="folder-move-menu-title">移动到</div>
            {moveTargets.map((target) => (
              <button
                key={target.id ?? "__root__"}
                className="folder-move-menu-item"
                onClick={() => {
                  onMove(folder.id, target.id);
                  setShowMoveMenu(false);
                }}
              >
                {target.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Conversations nested inside this folder when active */}
      {isActive && conversations.length > 0 && (
        <div className="explorer-folder-files">
          {groupByCreatedDate && !searchQuery.trim()
            ? groups.map(([dateLabel, items]) => (
                <div key={dateLabel}>
                  <div className="explorer-date-label" style={{ paddingLeft: `${fileIndent}px` }}>{dateLabel}</div>
                  {items.map((c) => (
                    <ConversationFileRow
                      key={c.id}
                      conversation={c}
                      indent={fileIndent}
                      isActive={selectedConversationId === c.id}
                      isDragging={draggingConversationId === c.id}
                      onOpen={onOpenConversation}
                      onPointerDown={beginPendingDrag}
                      draggingConversationId={draggingConversationId}
                    />
                  ))}
                </div>
              ))
            : conversations.map((c) => (
                <ConversationFileRow
                  key={c.id}
                  conversation={c}
                  indent={fileIndent}
                  isActive={selectedConversationId === c.id}
                  isDragging={draggingConversationId === c.id}
                  onOpen={onOpenConversation}
                  onPointerDown={beginPendingDrag}
                  draggingConversationId={draggingConversationId}
                />
              ))}
        </div>
      )}
      {isActive && conversations.length === 0 && (
        <div className="explorer-folder-empty" style={{ paddingLeft: `${fileIndent}px` }}>
          暂无对话
        </div>
      )}

      {/* Sub-folders */}
      {children.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          allFolders={allFolders}
          tree={tree}
          selectedFolderId={selectedFolderId}
          selectedConversationId={selectedConversationId}
          depth={depth + 1}
          onSelect={onSelect}
          onDelete={onDelete}
          onMove={onMove}
          onDropConversation={onDropConversation}
          hoverFolderId={hoverFolderId}
          draggingConversationId={draggingConversationId}
          conversations={conversations}
          onOpenConversation={onOpenConversation}
          beginPendingDrag={beginPendingDrag}
          groupByCreatedDate={groupByCreatedDate}
          searchQuery={searchQuery}
        />
      ))}
    </div>
  );
}

/* ── Conversation file row ── */

function ConversationFileRow({
  conversation,
  indent,
  isActive,
  isDragging,
  onOpen,
  onPointerDown,
  draggingConversationId
}: {
  conversation: ConversationSummary;
  indent: number;
  isActive: boolean;
  isDragging: boolean;
  onOpen: (id: string) => void;
  onPointerDown: (id: string, x: number, y: number) => void;
  draggingConversationId: string | null;
}) {
  return (
    <div
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      className={`explorer-row explorer-file ${isActive ? "active" : ""} ${isDragging ? "dragging" : ""}`}
      style={{ paddingLeft: `${indent}px` }}
      onClick={() => {
        if (draggingConversationId) return;
        onOpen(conversation.id);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        window.getSelection()?.removeAllRanges();
        onPointerDown(conversation.id, event.clientX, event.clientY);
      }}
      title="可拖拽到文件夹"
    >
      <svg className="explorer-icon file-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
      <span className="explorer-label">{conversation.title}</span>
      <SourceBadge source={conversation.source} />
    </div>
  );
}

/* ── Main Component ── */

export function ExplorerSidebar({
  folders,
  conversations,
  selectedFolderId,
  selectedConversationId,
  searchQuery,
  sourceFilter,
  onSelectFolder,
  onOpenConversation,
  onDropConversation,
  onSearchChange,
  onSourceChange,
  onCollapse,
  groupByCreatedDate
}: ExplorerSidebarProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [hoverFolderId, setHoverFolderId] = useState<string | null>(null);
  const draggingConversationId = useAppStore((s) => s.draggingConversationId);
  const setDraggingConversationId = useAppStore((s) => s.setDraggingConversationId);
  const setDragPointer = useAppStore((s) => s.setDragPointer);
  const createFolder = useCreateFolder();
  const deleteFolder = useDeleteFolder();
  const moveFolder = useMoveFolder();
  const draggingConversationIdRef = React.useRef<string | null>(null);
  const onDropConversationRef = React.useRef(onDropConversation);
  const newFolderInputRef = React.useRef<HTMLInputElement>(null);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const topLevel = tree.root ?? [];
  const groups = groupByCreatedDate ? groupByDate(conversations) : [];
  const allRootFileIndent = 36; // indent for files inside "全部对话"

  // --- Drag tracking ---
  React.useEffect(() => {
    draggingConversationIdRef.current = draggingConversationId;
  }, [draggingConversationId]);

  React.useEffect(() => {
    onDropConversationRef.current = onDropConversation;
  }, [onDropConversation]);

  React.useEffect(() => {
    const resolveHoveredFolderId = (clientX: number, clientY: number): string | null => {
      const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const folderRow = target?.closest<HTMLElement>(".explorer-folder[data-folder-id]");
      return folderRow?.dataset.folderId ?? null;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!draggingConversationIdRef.current) return;
      const folderId = resolveHoveredFolderId(event.clientX, event.clientY);
      setHoverFolderId(folderId);
      setDragPointer({ x: event.clientX, y: event.clientY });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const dragId = draggingConversationIdRef.current;
      if (!dragId) return;
      const hoveredFolder = resolveHoveredFolderId(event.clientX, event.clientY);
      if (hoveredFolder) {
        onDropConversationRef.current(dragId, hoveredFolder);
      }
      setHoverFolderId(null);
      setDragPointer(null);
      setDraggingConversationId(null);
    };

    const handlePointerCancel = () => {
      if (!draggingConversationIdRef.current) return;
      setHoverFolderId(null);
      setDragPointer(null);
      setDraggingConversationId(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { capture: true });
    window.addEventListener("pointerup", handlePointerUp, { capture: true });
    window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      window.removeEventListener("pointerup", handlePointerUp, { capture: true });
      window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
    };
  }, [setDragPointer, setDraggingConversationId]);

  // --- Drag conversation list items ---
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

  const handleMoveFolder = (folderId: string, newParentId: string | null) => {
    moveFolder.mutate(
      { id: folderId, parentId: newParentId },
      {
        onError: (error) => {
          const message = error instanceof Error ? error.message : "未知错误";
          window.alert(`移动失败：${message}`);
        }
      }
    );
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    createFolder.mutate({ name, parentId: selectedFolderId });
    setNewFolderName("");
    setShowNewFolder(false);
  };

  React.useEffect(() => {
    if (showNewFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [showNewFolder]);

  const isAllSelected = selectedFolderId === null;

  return (
    <div className="explorer-sidebar">
      {/* ── Top bar ── */}
      <div className="explorer-topbar">
        <button className="explorer-topbar-btn" onClick={onCollapse} title="收起侧栏">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
        <span className="explorer-topbar-title">资源管理器</span>
        <div className="explorer-topbar-actions">
          <button
            className="explorer-topbar-btn"
            onClick={() => setShowNewFolder((p) => !p)}
            title="新建文件夹"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
          <select
            className="explorer-source-select"
            value={sourceFilter}
            onChange={(e) => onSourceChange(e.target.value as ExplorerSidebarProps["sourceFilter"])}
          >
            <option value="all">全部</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="gemini">Gemini</option>
            <option value="ai_studio">AI Studio</option>
          </select>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="explorer-search">
        <svg className="explorer-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          className="explorer-search-input"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索"
        />
        {searchQuery && (
          <button className="explorer-search-clear" onClick={() => onSearchChange("")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* ── New folder inline input ── */}
      {showNewFolder && (
        <div className="explorer-new-folder">
          <input
            ref={newFolderInputRef}
            className="explorer-new-folder-input"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateFolder();
              if (e.key === "Escape") {
                setShowNewFolder(false);
                setNewFolderName("");
              }
            }}
            onBlur={() => {
              if (newFolderName.trim()) {
                handleCreateFolder();
              } else {
                setShowNewFolder(false);
              }
            }}
            placeholder="文件夹名称"
          />
        </div>
      )}

      {/* ── Tree ── */}
      <div className="explorer-tree">
        {/* ── "全部对话" root parent folder (always open) ── */}
        <div
          className={`explorer-row explorer-folder explorer-root-folder ${isAllSelected ? "active" : ""}`}
          onClick={() => onSelectFolder(null)}
          style={{ paddingLeft: "4px" }}
        >
          <svg
            className="explorer-chevron open"
            width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <svg className="explorer-icon folder-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="explorer-label">全部对话</span>
          <span className="explorer-count">{conversations.length}</span>
        </div>

        {/* ── Sub-folders (always visible, nested inside root) ── */}
        {topLevel.map((folder) => (
          <FolderNode
            key={folder.id}
            folder={folder}
            allFolders={folders}
            tree={tree}
            selectedFolderId={selectedFolderId}
            selectedConversationId={selectedConversationId}
            depth={1}
            onSelect={onSelectFolder}
            onDelete={(folderId) => deleteFolder.mutate(folderId)}
            onMove={handleMoveFolder}
            onDropConversation={onDropConversation}
            hoverFolderId={hoverFolderId}
            draggingConversationId={draggingConversationId}
            conversations={conversations}
            onOpenConversation={onOpenConversation}
            beginPendingDrag={beginPendingDrag}
            groupByCreatedDate={groupByCreatedDate}
            searchQuery={searchQuery}
          />
        ))}

        {/* ── Conversations (shown under root when "全部对话" is selected) ── */}
        {isAllSelected && conversations.length > 0 && (
          <div className="explorer-folder-files">
            <div className="explorer-separator" />
            {groupByCreatedDate && !searchQuery.trim()
              ? groups.map(([dateLabel, items]) => (
                  <div key={dateLabel}>
                    <div className="explorer-date-label" style={{ paddingLeft: `${allRootFileIndent}px` }}>{dateLabel}</div>
                    {items.map((c) => (
                      <ConversationFileRow
                        key={c.id}
                        conversation={c}
                        indent={allRootFileIndent}
                        isActive={selectedConversationId === c.id}
                        isDragging={draggingConversationId === c.id}
                        onOpen={onOpenConversation}
                        onPointerDown={beginPendingDrag}
                        draggingConversationId={draggingConversationId}
                      />
                    ))}
                  </div>
                ))
              : conversations.map((c) => (
                  <ConversationFileRow
                    key={c.id}
                    conversation={c}
                    indent={allRootFileIndent}
                    isActive={selectedConversationId === c.id}
                    isDragging={draggingConversationId === c.id}
                    onOpen={onOpenConversation}
                    onPointerDown={beginPendingDrag}
                    draggingConversationId={draggingConversationId}
                  />
                ))}
          </div>
        )}
        {isAllSelected && conversations.length === 0 && (
          <div className="explorer-folder-empty" style={{ paddingLeft: `${allRootFileIndent}px` }}>
            暂无对话
          </div>
        )}
      </div>
    </div>
  );
}

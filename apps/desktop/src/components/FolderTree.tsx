import React, { useMemo, useState } from "react";
import type { Folder } from "@ai-history/core-types";
import { buildFolderTree, useCreateFolder, useDeleteFolder, useMoveFolder } from "../hooks/useData";
import { useAppStore } from "../lib/store";

interface FolderTreeProps {
  folders: Folder[];
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  onDropConversation: (conversationId: string, folderId: string) => void;
  onCollapse: () => void;
}

function FolderNode({
  folder,
  allFolders,
  tree,
  selectedFolderId,
  depth,
  onSelect,
  onDelete,
  onMove,
  onDropConversation,
  hoverFolderId,
  draggingConversationId
}: {
  folder: Folder;
  allFolders: Folder[];
  tree: Record<string, Folder[]>;
  selectedFolderId: string | null;
  depth: number;
  onSelect: (folderId: string | null) => void;
  onDelete: (folderId: string) => void;
  onMove: (folderId: string, newParentId: string | null) => void;
  onDropConversation: (conversationId: string, folderId: string) => void;
  hoverFolderId: string | null;
  draggingConversationId: string | null;
}) {
  const children = tree[folder.id] ?? [];
  const [showMoveMenu, setShowMoveMenu] = useState(false);

  const handleFolderClick = () => {
    if (draggingConversationId) {
      onDropConversation(draggingConversationId, folder.id);
      return;
    }
    onSelect(folder.id);
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

  return (
    <div>
      <div
        className={`folder-row ${selectedFolderId === folder.id ? "active" : ""} ${
          hoverFolderId === folder.id ? "drag-hover" : ""
        }`}
        data-folder-id={folder.id}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleFolderClick}
      >
        <div className="folder-name">
          <svg className="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="folder-label">{folder.name}</span>
        </div>
        <div className="folder-actions">
          <button
            className="folder-action-btn"
            title="移动文件夹"
            onClick={(event) => {
              event.stopPropagation();
              setShowMoveMenu((prev) => !prev);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 9l7-7 7 7M5 15l7 7 7-7" />
            </svg>
          </button>
          {folder.parentId && (
            <button
              className="folder-action-btn folder-action-danger"
              title="删除文件夹"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(folder.id);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
      {children.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          allFolders={allFolders}
          tree={tree}
          selectedFolderId={selectedFolderId}
          depth={depth + 1}
          onSelect={onSelect}
          onDelete={onDelete}
          onMove={onMove}
          onDropConversation={onDropConversation}
          hoverFolderId={hoverFolderId}
          draggingConversationId={draggingConversationId}
        />
      ))}
    </div>
  );
}

export function FolderTree({ folders, selectedFolderId, onSelect, onDropConversation, onCollapse }: FolderTreeProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [hoverFolderId, setHoverFolderId] = useState<string | null>(null);
  const draggingConversationId = useAppStore((s) => s.draggingConversationId);
  const setDraggingConversationId = useAppStore((s) => s.setDraggingConversationId);
  const setDragPointer = useAppStore((s) => s.setDragPointer);
  const createFolder = useCreateFolder();
  const deleteFolder = useDeleteFolder();
  const moveFolder = useMoveFolder();
  const draggingConversationIdRef = React.useRef<string | null>(null);
  const onDropConversationRef = React.useRef(onDropConversation);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const topLevel = tree.root ?? [];

  React.useEffect(() => {
    draggingConversationIdRef.current = draggingConversationId;
  }, [draggingConversationId]);

  React.useEffect(() => {
    onDropConversationRef.current = onDropConversation;
  }, [onDropConversation]);

  React.useEffect(() => {
    const resolveHoveredFolderId = (clientX: number, clientY: number): string | null => {
      const target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      const folderRow = target?.closest<HTMLElement>(".folder-row[data-folder-id]");
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

  return (
    <section className="panel folder-panel">
      <div className="panel-header">
        <div className="panel-header-left">
          <button className="collapse-toggle-btn" onClick={onCollapse} title="收起文件夹栏">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <h3>对话文件夹</h3>
        </div>
      </div>
      <div className="folder-controls">
        <div className="folder-controls-group">
          <input
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder="新建文件夹"
          />
          <button
            onClick={() => {
              const name = newFolderName.trim();
              if (!name) {
                return;
              }
              createFolder.mutate({ name, parentId: selectedFolderId });
              setNewFolderName("");
            }}
          >
            新建
          </button>
        </div>
      </div>
      <div className={`folder-list ${draggingConversationId ? "dragging" : ""}`}>
        <div className={`folder-row ${selectedFolderId === null ? "active" : ""}`}>
          <button className="folder-name" onClick={() => onSelect(null)}>
            <svg className="folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
            </svg>
            <span className="folder-label">全部文件</span>
          </button>
        </div>
        {topLevel.map((folder) => (
          <FolderNode
            key={folder.id}
            folder={folder}
            allFolders={folders}
            tree={tree}
            selectedFolderId={selectedFolderId}
            depth={0}
            onSelect={onSelect}
            onDelete={(folderId) => deleteFolder.mutate(folderId)}
            onMove={handleMoveFolder}
            onDropConversation={onDropConversation}
            hoverFolderId={hoverFolderId}
            draggingConversationId={draggingConversationId}
          />
        ))}
      </div>
    </section>
  );
}

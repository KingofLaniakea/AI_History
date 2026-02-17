import React, { useMemo, useState } from "react";
import type { Folder } from "@ai-history/core-types";
import { buildFolderTree, useCreateFolder, useDeleteFolder } from "../hooks/useData";
import { useAppStore } from "../lib/store";

interface FolderTreeProps {
  folders: Folder[];
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  onDropConversation: (conversationId: string, folderId: string) => void;
}

function FolderNode({
  folder,
  tree,
  selectedFolderId,
  depth,
  onSelect,
  onDelete,
  onDropConversation,
  hoverFolderId,
  draggingConversationId
}: {
  folder: Folder;
  tree: Record<string, Folder[]>;
  selectedFolderId: string | null;
  depth: number;
  onSelect: (folderId: string | null) => void;
  onDelete: (folderId: string) => void;
  onDropConversation: (conversationId: string, folderId: string) => void;
  hoverFolderId: string | null;
  draggingConversationId: string | null;
}) {
  const children = tree[folder.id] ?? [];

  const handleFolderClick = () => {
    if (draggingConversationId) {
      onDropConversation(draggingConversationId, folder.id);
      return;
    }
    onSelect(folder.id);
  };

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
        <div className="folder-name">{folder.name}</div>
        {folder.parentId && (
          <button
            className="ghost danger"
            title="删除文件夹"
            onClick={(event) => {
              event.stopPropagation();
              onDelete(folder.id);
            }}
          >
            删除
          </button>
        )}
      </div>
      {children.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          tree={tree}
          selectedFolderId={selectedFolderId}
          depth={depth + 1}
          onSelect={onSelect}
          onDelete={onDelete}
          onDropConversation={onDropConversation}
          hoverFolderId={hoverFolderId}
          draggingConversationId={draggingConversationId}
        />
      ))}
    </div>
  );
}

export function FolderTree({ folders, selectedFolderId, onSelect, onDropConversation }: FolderTreeProps) {
  const [newFolderName, setNewFolderName] = useState("");
  const [hoverFolderId, setHoverFolderId] = useState<string | null>(null);
  const draggingConversationId = useAppStore((s) => s.draggingConversationId);
  const setDraggingConversationId = useAppStore((s) => s.setDraggingConversationId);
  const setDragPointer = useAppStore((s) => s.setDragPointer);
  const createFolder = useCreateFolder();
  const deleteFolder = useDeleteFolder();
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

  return (
    <section className="panel folder-panel">
      <div className="panel-header">
        <h3>对话文件夹</h3>
      </div>
      <div className="folder-controls">
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
      <div className={`folder-list ${draggingConversationId ? "dragging" : ""}`}>
        <div className={`folder-row ${selectedFolderId === null ? "active" : ""}`}>
          <button className="folder-name" onClick={() => onSelect(null)}>
            全部文件
          </button>
        </div>
        {topLevel.map((folder) => (
          <FolderNode
            key={folder.id}
            folder={folder}
            tree={tree}
            selectedFolderId={selectedFolderId}
            depth={0}
            onSelect={onSelect}
            onDelete={(folderId) => deleteFolder.mutate(folderId)}
            onDropConversation={onDropConversation}
            hoverFolderId={hoverFolderId}
            draggingConversationId={draggingConversationId}
          />
        ))}
      </div>
    </section>
  );
}

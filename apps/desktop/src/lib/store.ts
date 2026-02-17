import { create } from "zustand";

interface AppState {
  selectedFolderId: string | null;
  selectedConversationId: string | null;
  draggingConversationId: string | null;
  dragPointer: { x: number; y: number } | null;
  sourceFilter: "all" | "chatgpt" | "gemini" | "ai_studio";
  searchQuery: string;
  setSelectedFolderId: (id: string | null) => void;
  setSelectedConversationId: (id: string | null) => void;
  setDraggingConversationId: (id: string | null) => void;
  setDragPointer: (pointer: { x: number; y: number } | null) => void;
  setSourceFilter: (source: AppState["sourceFilter"]) => void;
  setSearchQuery: (query: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedFolderId: null,
  selectedConversationId: null,
  draggingConversationId: null,
  dragPointer: null,
  sourceFilter: "all",
  searchQuery: "",
  setSelectedFolderId: (selectedFolderId) => set({ selectedFolderId }),
  setSelectedConversationId: (selectedConversationId) => set({ selectedConversationId }),
  setDraggingConversationId: (draggingConversationId) => set({ draggingConversationId }),
  setDragPointer: (dragPointer) => set({ dragPointer }),
  setSourceFilter: (sourceFilter) => set({ sourceFilter }),
  setSearchQuery: (searchQuery) => set({ searchQuery })
}));

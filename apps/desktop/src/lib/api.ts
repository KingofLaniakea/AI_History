import type { AttachmentRef, Folder, LiveCaptureRequest } from "@ai-history/core-types";
import { parseImportPayload } from "@ai-history/parsers";
import type {
  ConversationDetail,
  ConversationSummary,
  ImportBatch,
  ImportResult,
  ListConversationsInput,
  SearchResult,
  UrlImportInput
} from "./types";
import { isTauri, invokeSafe } from "./tauri";
import { mockApi } from "./mock-db";

export const api = {
  listFolders: async (): Promise<Folder[]> => {
    if (!isTauri) {
      return mockApi.listFolders();
    }

    return invokeSafe<Folder[]>("list_folders");
  },
  createFolder: async (name: string, parentId: string | null): Promise<Folder> => {
    if (!isTauri) {
      return mockApi.createFolder(name, parentId);
    }

    return invokeSafe<Folder>("create_folder", { name, parentId });
  },
  moveFolder: async (id: string, parentId: string | null): Promise<void> => {
    if (!isTauri) {
      return mockApi.moveFolder(id, parentId);
    }

    return invokeSafe<void>("move_folder", { id, parentId });
  },
  deleteFolder: async (id: string): Promise<void> => {
    if (!isTauri) {
      return mockApi.deleteFolder(id);
    }

    return invokeSafe<void>("delete_folder", { id });
  },
  moveConversation: async (id: string, folderId: string | null): Promise<void> => {
    if (!isTauri) {
      return mockApi.moveConversation(id, folderId);
    }

    return invokeSafe<void>("move_conversation", { id, folderId });
  },
  listConversations: async (input?: ListConversationsInput): Promise<ConversationSummary[]> => {
    if (!isTauri) {
      return mockApi.listConversations(input);
    }

    return invokeSafe<ConversationSummary[]>("list_conversations", { input });
  },
  openConversation: async (id: string): Promise<ConversationDetail | null> => {
    if (!isTauri) {
      return mockApi.openConversation(id);
    }

    return invokeSafe<ConversationDetail | null>("open_conversation", { id });
  },
  listConversationAttachments: async (conversationId: string): Promise<AttachmentRef[]> => {
    if (!isTauri) {
      const conv = await mockApi.openConversation(conversationId);
      return conv?.attachments ?? [];
    }

    return invokeSafe<AttachmentRef[]>("list_conversation_attachments", { conversationId });
  },
  importFiles: async (batch: ImportBatch): Promise<ImportResult> => {
    if (!isTauri) {
      return mockApi.importFiles(batch);
    }

    return invokeSafe<ImportResult>("import_files", { batch });
  },
  importLiveCapture: async (request: LiveCaptureRequest): Promise<ImportResult> => {
    if (!isTauri) {
      return mockApi.importLiveCapture(request);
    }

    return invokeSafe<ImportResult>("import_live_capture", { request });
  },
  importFromUrl: async (input: UrlImportInput): Promise<ImportResult> => {
    if (!isTauri) {
      return mockApi.importFromUrl(input);
    }

    const html = await invokeSafe<string>("fetch_url_html", { url: input.url });
    const parsed = await parseImportPayload({
      filename: input.url,
      mime: "text/html",
      text: html,
      sourceHint: input.sourceHint
    });

    return api.importFiles({
      conversations: parsed,
      strategy: input.strategy,
      folderId: input.folderId ?? null
    });
  },
  searchConversations: async (query: string): Promise<SearchResult[]> => {
    if (!isTauri) {
      return mockApi.searchConversations(query);
    }

    return invokeSafe<SearchResult[]>("search_conversations", { query });
  },
  exportBackupZip: async (): Promise<string> => {
    if (!isTauri) {
      return mockApi.exportBackupZip();
    }

    return invokeSafe<string>("export_backup_zip");
  },
  openExternal: async (target: string): Promise<void> => {
    if (!target.trim()) {
      return;
    }

    if (!isTauri) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }

    return invokeSafe<void>("open_external", { target });
  }
};

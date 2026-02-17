import type {
  ConversationDetail,
  ConversationSummary,
  Folder,
  ImportBatch,
  ImportResult,
  ListConversationsInput,
  SearchResult,
  UrlImportInput
} from "./types";
import type { LiveCaptureRequest } from "@ai-history/core-types";
import { liveCaptureToConversation, parseImportPayload } from "@ai-history/parsers";
import { UNCATEGORIZED_FOLDER_ID, UNCATEGORIZED_FOLDER_NAME } from "./constants";

const now = new Date().toISOString();

const mockFolders: Folder[] = [
  {
    id: UNCATEGORIZED_FOLDER_ID,
    name: UNCATEGORIZED_FOLDER_NAME,
    parentId: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now
  }
];

const mockConversations: ConversationDetail[] = [];

function fingerprintOf(conv: { source: string; sourceConversationId: string | null | undefined; turns: Array<{ role: string; contentMarkdown: string }> }) {
  const body = conv.turns.map((turn) => `${turn.role}:${turn.contentMarkdown}`).join("||");
  return `${conv.source}:${conv.sourceConversationId ?? ""}:${body}`;
}

export const mockApi = {
  listFolders: async (): Promise<Folder[]> => mockFolders,
  createFolder: async (name: string, parentId: string | null): Promise<Folder> => {
    const folder: Folder = {
      id: crypto.randomUUID(),
      name,
      parentId,
      sortOrder: mockFolders.length,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    mockFolders.push(folder);
    return folder;
  },
  moveFolder: async (id: string, parentId: string | null): Promise<void> => {
    const folder = mockFolders.find((item) => item.id === id);
    if (folder) {
      folder.parentId = parentId;
      folder.updatedAt = new Date().toISOString();
    }
  },
  deleteFolder: async (id: string): Promise<void> => {
    if (id === UNCATEGORIZED_FOLDER_ID) {
      return;
    }
    const index = mockFolders.findIndex((f) => f.id === id);
    if (index >= 0) {
      mockFolders.splice(index, 1);
    }
    for (const conversation of mockConversations) {
      if (conversation.folderId === id) {
        conversation.folderId = UNCATEGORIZED_FOLDER_ID;
      }
    }
  },
  moveConversation: async (id: string, folderId: string | null): Promise<void> => {
    const conversation = mockConversations.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    conversation.folderId = folderId ?? UNCATEGORIZED_FOLDER_ID;
    conversation.updatedAt = new Date().toISOString();
  },
  listConversations: async (input?: ListConversationsInput): Promise<ConversationSummary[]> => {
    const targetFolder = input?.folderId;
    const source = input?.source;
    return mockConversations
      .filter((c) =>
        targetFolder
          ? targetFolder === UNCATEGORIZED_FOLDER_ID
            ? c.folderId === UNCATEGORIZED_FOLDER_ID || c.folderId == null
            : c.folderId === targetFolder
          : true
      )
      .filter((c) => (source && source !== "all" ? c.source === source : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((item) => ({ ...item, messageCount: item.messages.length }));
  },
  openConversation: async (id: string): Promise<ConversationDetail | null> => {
    return mockConversations.find((item) => item.id === id) ?? null;
  },
  importFiles: async (batch: ImportBatch): Promise<ImportResult> => {
    let imported = 0;
    let skipped = 0;
    let conflicts = 0;

    for (const conv of batch.conversations) {
      const sourceMatchIndex =
        conv.sourceConversationId
          ? mockConversations.findIndex(
              (item) => item.source === conv.source && item.sourceConversationId === conv.sourceConversationId
            )
          : -1;
      const incomingFingerprint = fingerprintOf({
        source: conv.source,
        sourceConversationId: conv.sourceConversationId,
        turns: conv.turns
      });
      const fingerprintMatchIndex = mockConversations.findIndex((item) => item.fingerprint === incomingFingerprint);

      const conflictIndex = sourceMatchIndex >= 0 ? sourceMatchIndex : fingerprintMatchIndex;
      if (conflictIndex >= 0) {
        conflicts += 1;
        if (batch.strategy === "skip") {
          skipped += 1;
          continue;
        }
        if (batch.strategy === "overwrite") {
          mockConversations.splice(conflictIndex, 1);
        }
      }

      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const updatedAt = createdAt;
      mockConversations.unshift({
        id,
        source: conv.source,
        sourceConversationId: conv.sourceConversationId,
        folderId: batch.folderId ?? UNCATEGORIZED_FOLDER_ID,
        title: conv.title,
        summary: conv.summary ?? null,
        createdAt,
        updatedAt,
        fingerprint:
          batch.strategy === "duplicate" && conflictIndex >= 0
            ? `${incomingFingerprint}#dup-${crypto.randomUUID()}`
            : incomingFingerprint,
        metaJson: JSON.stringify(conv.meta ?? {}),
        tags: [],
        attachments: [],
        messages: conv.turns.map((turn, index) => ({
          id: crypto.randomUUID(),
          conversationId: id,
          seq: index,
          role: turn.role,
          contentMarkdown: turn.contentMarkdown,
          thoughtMarkdown: turn.thoughtMarkdown ?? null,
          model: turn.model ?? null,
          timestamp: turn.timestamp ?? null,
          tokenCount: turn.tokenCount ?? null
        }))
      });
      imported += 1;
    }

    return { imported, skipped, conflicts };
  },
  importFromUrl: async (input: UrlImportInput): Promise<ImportResult> => {
    const response = await fetch(input.url);
    const html = await response.text();
    const parsed = await parseImportPayload({
      filename: input.url,
      mime: "text/html",
      text: html,
      sourceHint: input.sourceHint
    });

    return mockApi.importFiles({
      conversations: parsed,
      strategy: input.strategy,
      folderId: input.folderId ?? UNCATEGORIZED_FOLDER_ID
    });
  },
  importLiveCapture: async (payload: LiveCaptureRequest): Promise<ImportResult> => {
    return mockApi.importFiles({
      conversations: [liveCaptureToConversation(payload)],
      strategy: "overwrite",
      folderId: UNCATEGORIZED_FOLDER_ID
    });
  },
  searchConversations: async (query: string): Promise<SearchResult[]> => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return [];
    }

    return mockConversations
      .filter((item) => item.title.toLowerCase().includes(q) || item.messages.some((m) => m.contentMarkdown.toLowerCase().includes(q)))
      .map((item) => {
        const first = item.messages.find((m) => m.contentMarkdown.toLowerCase().includes(q));
        return {
          conversation: { ...item, messageCount: item.messages.length },
          snippet: first ? first.contentMarkdown.slice(0, 120) : item.title
        };
      });
  },
  exportBackupZip: async (): Promise<string> => {
    return `mock-backup-${Date.now()}.zip`;
  }
};

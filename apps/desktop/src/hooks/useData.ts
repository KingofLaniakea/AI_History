import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Folder } from "@ai-history/core-types";
import { api } from "../lib/api";
import type { ConversationDetail, ImportBatch, ListConversationsInput } from "../lib/types";

function isCloudDriveLink(url: string): boolean {
  const lowered = url.toLowerCase();
  return (
    lowered.includes("drive.google.com/file/") ||
    lowered.includes("drive.google.com/open") ||
    lowered.includes("docs.google.com/document/") ||
    lowered.includes("docs.google.com/presentation/") ||
    lowered.includes("docs.google.com/spreadsheets/")
  );
}

function isVirtualAttachment(url: string): boolean {
  return url.toLowerCase().startsWith("aihistory://upload/");
}

export function useFolders() {
  return useQuery({
    queryKey: ["folders"],
    queryFn: api.listFolders
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, parentId }: { name: string; parentId: string | null }) => api.createFolder(name, parentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["folders"] });
    }
  });
}

export function useMoveFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parentId }: { id: string; parentId: string | null }) => api.moveFolder(id, parentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["folders"] });
    }
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteFolder(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["folders"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  });
}

export function useMoveConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, folderId }: { id: string; folderId: string | null }) =>
      api.moveConversation(id, folderId),
    onSuccess: (_data, variables) => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["conversation", variables.id] });
      void qc.invalidateQueries({ queryKey: ["search"] });
    }
  });
}

export function useConversations(input: ListConversationsInput) {
  return useQuery({
    queryKey: ["conversations", input],
    queryFn: () => api.listConversations(input)
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api.openConversation(id as string),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const conversation = query.state.data as ConversationDetail | null | undefined;
      if (!conversation) {
        return false;
      }
      const hasPendingAttachments = conversation.attachments.some(
        (attachment) =>
          (attachment.status === "remote_only" || attachment.status === "failed") &&
          !isCloudDriveLink(attachment.originalUrl) &&
          !isVirtualAttachment(attachment.originalUrl)
      );
      return hasPendingAttachments ? 1500 : false;
    }
  });
}

export function useImportFiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batch: ImportBatch) => api.importFiles(batch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["search"] });
    }
  });
}

export function useSearch(query: string) {
  return useQuery({
    queryKey: ["search", query],
    queryFn: () => api.searchConversations(query),
    enabled: query.trim().length > 0
  });
}

export function useExportBackup() {
  return useMutation({
    mutationFn: api.exportBackupZip
  });
}

export function buildFolderTree(folders: Folder[]): Record<string, Folder[]> {
  return folders.reduce<Record<string, Folder[]>>((acc, folder) => {
    const key = folder.parentId ?? "root";
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push(folder);
    return acc;
  }, {});
}

import React, { useMemo, useState } from "react";
import JSZip from "jszip";
import type { SourcePlatform } from "@ai-history/core-types";
import { parseImportPayload } from "@ai-history/parsers";
import { useImportFiles } from "../hooks/useData";
import { UNCATEGORIZED_FOLDER_ID } from "../lib/constants";

interface ImportDialogProps {
  folderId: string | null;
  mode?: "panel" | "embedded";
}

async function parseZip(file: File): Promise<{ filename: string; mime: string; text: string }[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries: { filename: string; mime: string; text: string }[] = [];

  await Promise.all(
    Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map(async (entry) => {
        const filename = entry.name;
        if (!/\.(json|md|markdown|txt|html|htm)$/i.test(filename)) {
          return;
        }
        const text = await entry.async("text");
        entries.push({
          filename,
          mime: filename.endsWith(".html") || filename.endsWith(".htm") ? "text/html" : "text/plain",
          text
        });
      })
  );

  return entries;
}

export function ImportDialog({ folderId: _folderId, mode = "panel" }: ImportDialogProps) {
  const importer = useImportFiles();
  const [strategy, setStrategy] = useState<"skip" | "overwrite" | "duplicate">("overwrite");
  const [sourceHint, setSourceHint] = useState<"auto" | SourcePlatform>("auto");
  const [lastResult, setLastResult] = useState("");
  const [busy, setBusy] = useState(false);

  const accept = useMemo(() => ".zip,.json,.md,.markdown,.txt,.html,.htm", []);

  const runFileImport = async (files: File[]) => {
    setBusy(true);
    setLastResult("");
    try {
      const conversations = [];

      for (const file of files) {
        if (file.name.toLowerCase().endsWith(".zip")) {
          const entries = await parseZip(file);
          for (const entry of entries) {
            const parsed = await parseImportPayload({
              filename: entry.filename,
              mime: entry.mime,
              text: entry.text,
              sourceHint: sourceHint === "auto" ? undefined : sourceHint
            });
            conversations.push(...parsed);
          }
          continue;
        }

        const text = await file.text();
        const parsed = await parseImportPayload({
          filename: file.name,
          mime: file.type || "text/plain",
          text,
          sourceHint: sourceHint === "auto" ? undefined : sourceHint
        });
        conversations.push(...parsed);
      }

      if (!conversations.length) {
        setLastResult("未识别到可导入会话，请检查文件格式。");
        return;
      }

      const result = await importer.mutateAsync({
        conversations,
        strategy,
        folderId: UNCATEGORIZED_FOLDER_ID
      });

      setLastResult(`导入完成：新增 ${result.imported}，跳过 ${result.skipped}，冲突 ${result.conflicts}`);
    } catch (error) {
      setLastResult(`导入失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <>
      {mode === "panel" ? (
        <div className="panel-header">
          <h3>一键导入</h3>
        </div>
      ) : null}

      <div className="import-controls">
        <label>
          来源提示
          <select value={sourceHint} onChange={(event) => setSourceHint(event.target.value as "auto" | SourcePlatform)}>
            <option value="auto">自动识别</option>
            <option value="chatgpt">ChatGPT</option>
            <option value="gemini">Gemini</option>
            <option value="ai_studio">AI Studio</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label>
          冲突策略
          <select value={strategy} onChange={(event) => setStrategy(event.target.value as typeof strategy)}>
            <option value="overwrite">覆盖</option>
            <option value="skip">跳过</option>
            <option value="duplicate">保留副本</option>
          </select>
        </label>
      </div>

      <input
        type="file"
        accept={accept}
        multiple
        onChange={(event) => {
          const fileList = Array.from(event.target.files ?? []);
          if (fileList.length) {
            void runFileImport(fileList);
          }
          event.currentTarget.value = "";
        }}
      />
      <p className="muted">支持 zip/json/md/html/txt，支持批量导入。</p>
      <p className="muted">新导入会话会自动进入“未分类”，可拖拽到左侧任意文件夹。</p>
      <p className="muted">链接抓取请使用浏览器插件（当前页抓取 / 打开链接并抓取）。</p>

      {busy ? <p className="info">处理中...</p> : null}
      {lastResult ? <p className="info">{lastResult}</p> : null}
    </>
  );

  if (mode === "embedded") {
    return <div className="import-embedded">{content}</div>;
  }

  return <section className="panel import-panel">{content}</section>;
}

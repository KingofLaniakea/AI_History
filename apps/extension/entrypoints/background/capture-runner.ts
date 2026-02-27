import { inferSourceFromUrl } from "../lib/extractor";
import { requestCapture } from "./content-script-lifecycle";
import { emitCaptureProgress } from "./progress";
import { submitCapture } from "./capture-session";

export interface CaptureRunResult {
  message: string;
  warning?: string;
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        setTimeout(resolve, 800);
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export async function captureCurrentTab(captureRunId = ""): Promise<CaptureRunResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("没有可抓取的活动标签页");
  }

  if (captureRunId) {
    emitCaptureProgress({
      runId: captureRunId,
      phase: "content",
      percent: 2,
      status: "已开始抓取"
    });
  }

  const { payload, warning } = await requestCapture(tab.id, tab.url, captureRunId);
  if (captureRunId) {
    emitCaptureProgress({
      runId: captureRunId,
      phase: "content",
      percent: 100,
      status: "对话内容抓取完成"
    });
  }
  const importResult = await submitCapture(payload);
  console.info("[AI_HISTORY] submit capture result", {
    source: payload.source,
    title: payload.title,
    imported: Number(importResult.imported || 0),
    skipped: Number(importResult.skipped || 0),
    conflicts: Number(importResult.conflicts || 0)
  });
  if (captureRunId) {
    emitCaptureProgress({
      runId: captureRunId,
      phase: "files",
      percent: 100,
      status: warning ? "抓取完成（有告警）" : "抓取流程完成"
    });
  }
  return {
    message: `已导入：${payload.title}（导入 ${Number(importResult.imported || 0)}）`,
    warning: warning || undefined
  };
}

export async function captureByUrl(url: string, captureRunId = ""): Promise<CaptureRunResult> {
  const source = inferSourceFromUrl(url);
  const tab = await chrome.tabs.create({ url, active: false });

  if (!tab.id) {
    throw new Error("无法创建用于抓取的标签页");
  }

  try {
    if (captureRunId) {
      emitCaptureProgress({
        runId: captureRunId,
        phase: "content",
        percent: 2,
        status: "正在打开链接"
      });
    }
    await waitForTabComplete(tab.id);
    const { payload, warning } = await requestCapture(tab.id, url, captureRunId);
    payload.source = source;
    if (captureRunId) {
      emitCaptureProgress({
        runId: captureRunId,
        phase: "content",
        percent: 100,
        status: "对话内容抓取完成"
      });
    }
    const importResult = await submitCapture(payload);
    console.info("[AI_HISTORY] submit capture result", {
      source: payload.source,
      title: payload.title,
      imported: Number(importResult.imported || 0),
      skipped: Number(importResult.skipped || 0),
      conflicts: Number(importResult.conflicts || 0)
    });
    if (captureRunId) {
      emitCaptureProgress({
        runId: captureRunId,
        phase: "files",
        percent: 100,
        status: warning ? "抓取完成（有告警）" : "抓取流程完成"
      });
    }
    return {
      message: `链接抓取成功：${payload.title}（导入 ${Number(importResult.imported || 0)}）`,
      warning: warning || undefined
    };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

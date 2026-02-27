import { extractAiStudioTurnsWith } from "./aistudio";
import {
  attachmentKindScore,
  inferAttachmentKind,
  inferAttachmentMime,
  inferKindFromMimeHint,
  isFileLikeExtension,
  isLikelyOaiAttachmentUrl,
  looksLikeFileUrl,
  looksLikeImageUrl,
  looksLikePdfUrl
} from "../attachments/classify";
import {
  countMaterializableAttachmentsWith,
  materializeAttachmentsOrThrowWith,
  type AttachmentMaterializeProgress,
  type MaterializeAttachmentOptions
} from "../attachments/materialize";
import {
  warmupAiStudioLazyResourcesWith,
  warmupSourceLazyResourcesWith
} from "../warmup";
import { extractGeminiTurnsWith } from "./gemini";
import {
  activeCaptureWindowStartMs as activeCaptureWindowStartMsFromTracker,
  beginCaptureSessionWindow as beginCaptureSessionWindowFromTracker,
  ensureRuntimeNetworkTracker as ensureRuntimeNetworkTrackerFromTracker,
  getTrackedNetworkRecords as getTrackedNetworkRecordsFromTracker,
  type TrackedNetworkRecord
} from "../network/tracker";
import {
  buildTurn as buildTurnFromCommon,
  decodeHtml as decodeHtmlFromCommon,
  dedupeTurns as dedupeTurnsFromCommon,
  extractNodeTextAndThought as extractNodeTextAndThoughtFromCommon,
  fixDanglingMathDelimiters as fixDanglingMathDelimitersFromCommon,
  fixMatrixRows as fixMatrixRowsFromCommon,
  htmlToMarkdownish as htmlToMarkdownishFromCommon,
  isNavigationUrl as isNavigationUrlFromCommon,
  leafNodes as leafNodesFromCommon,
  normalizeForDedupe as normalizeForDedupeFromCommon,
  normalizeForGeminiFilter as normalizeForGeminiFilterFromCommon,
  normalizeMarkdownText as normalizeMarkdownTextFromCommon,
  parseByRoleMarkers as parseByRoleMarkersFromCommon,
  readLatex as readLatexFromCommon,
  replaceMathWithLatex as replaceMathWithLatexFromCommon,
  roleFromAttrs as roleFromAttrsFromCommon,
  sanitizeGeminiTurn as sanitizeGeminiTurnFromCommon,
  splitThoughts as splitThoughtsFromCommon,
  stripGeminiBoilerplate as stripGeminiBoilerplateFromCommon,
  stripGeminiUiPrefixes as stripGeminiUiPrefixesFromCommon,
  stripHtmlTags as stripHtmlTagsFromCommon,
  wrapStandaloneLatexBlocks as wrapStandaloneLatexBlocksFromCommon
} from "./common";
import {
  moveScrollerSlowly as moveScrollerSlowlyFromWarmupCommon,
  pickScrollableElement as pickScrollableElementFromWarmupCommon,
  sleep as sleepFromWarmupCommon,
  waitForTrackedNetworkSettle as waitForTrackedNetworkSettleFromWarmupCommon,
  warmupScrollableArea as warmupScrollableAreaFromWarmupCommon,
  type SlowMoveResult,
  type WarmupConfig
} from "../warmup/common";

export type CaptureSource = "chatgpt" | "gemini" | "ai_studio" | "claude";

export interface CaptureAttachment {
  kind: "image" | "pdf" | "file";
  originalUrl: string;
  mime?: string | null;
  status?: "remote_only" | "cached" | "failed" | null;
}

export interface CaptureTurn {
  role: "user" | "assistant" | "system" | "tool";
  contentMarkdown: string;
  thoughtMarkdown?: string | null;
  attachments?: CaptureAttachment[] | null;
  model?: string | null;
  timestamp?: string | null;
}

export interface CapturePayload {
  source: CaptureSource;
  pageUrl: string;
  title: string;
  turns: CaptureTurn[];
  capturedAt: string;
  version: string;
}

const MAX_INLINE_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function beginCaptureSessionWindow(): void {
  beginCaptureSessionWindowFromTracker();
}

function activeCaptureWindowStartMs(): number {
  return activeCaptureWindowStartMsFromTracker();
}

function ensureRuntimeNetworkTracker(): void {
  ensureRuntimeNetworkTrackerFromTracker();
}

function getTrackedNetworkRecords(sinceMs = 0): TrackedNetworkRecord[] {
  return getTrackedNetworkRecordsFromTracker(sinceMs);
}

function decodeHtml(text: string): string {
  return decodeHtmlFromCommon(text);
}

function stripHtmlTags(text: string): string {
  return stripHtmlTagsFromCommon(text);
}

function fixDanglingMathDelimiters(text: string): string {
  return fixDanglingMathDelimitersFromCommon(text);
}

function fixMatrixRows(text: string): string {
  return fixMatrixRowsFromCommon(text);
}

function wrapStandaloneLatexBlocks(text: string): string {
  return wrapStandaloneLatexBlocksFromCommon(text);
}

function readLatex(node: Element): string {
  return readLatexFromCommon(node);
}

function replaceMathWithLatex(root: Element, doc: Document): void {
  replaceMathWithLatexFromCommon(root, doc);
}

function htmlToMarkdownish(html: string): string {
  return htmlToMarkdownishFromCommon(html);
}

function normalizeMarkdownText(text: string): string {
  return normalizeMarkdownTextFromCommon(text);
}

function normalizeForDedupe(content: string): string {
  return normalizeForDedupeFromCommon(content);
}

function normalizeForGeminiFilter(text: string): string {
  return normalizeForGeminiFilterFromCommon(text);
}

function extractExtFromFileName(name: string): string {
  const clean = name.trim().toLowerCase();
  const noQuery = clean.split("?")[0]?.split("#")[0] ?? clean;
  return noQuery.split(".").pop() ?? "";
}

function findLikelyInlineFileNames(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  const out = new Set<string>();
  for (const line of lines) {
    const match = line.match(/[a-z0-9._-]+\.(pdf|doc|docx|ppt|pptx|xls|xlsx|csv|tsv|md|txt|png|jpg|jpeg|webp|gif|bmp|svg)\b/i);
    if (match?.[0]) {
      out.add(match[0]);
    }
  }
  return Array.from(out);
}

function looksLikeAttachmentFileNameLabel(label: string): boolean {
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 260) {
    return false;
  }
  const ext = extractExtFromFileName(trimmed);
  if (!ext || !isFileLikeExtension(ext)) {
    return false;
  }
  if (/\s{2,}/.test(trimmed)) {
    return false;
  }
  return /[a-z0-9]/i.test(trimmed);
}

function isImageExtension(ext: string): boolean {
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"].includes(ext);
}

function isDataUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("data:");
}

function parseDataUrlName(url: string): string {
  if (!isDataUrl(url)) {
    return "";
  }
  const meta = url.trim().slice(5).split(",")[0] ?? "";
  const parts = meta.split(";").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (!/^name=/i.test(part)) {
      continue;
    }
    const raw = part.slice(5).trim().replace(/^["']+|["']+$/g, "");
    if (!raw) {
      continue;
    }
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded) {
        return decoded;
      }
    } catch {
      // ignore decode failure and fallback to raw
    }
    return raw;
  }
  return "";
}

function isVirtualAttachmentUrl(url: string): boolean {
  return url.trim().toLowerCase().startsWith("aihistory://upload/");
}

function decodeVirtualAttachmentName(url: string): string {
  if (!isVirtualAttachmentUrl(url)) {
    return "";
  }
  const raw = url.slice("aihistory://upload/".length).split("?")[0] ?? "";
  if (!raw) {
    return "未命名文件";
  }
  try {
    const decoded = decodeURIComponent(raw);
    return decoded || raw;
  } catch {
    return raw;
  }
}

function buildVirtualAttachmentUrl(name: string): string {
  return `aihistory://upload/${encodeURIComponent(name.trim())}`;
}

function stripGeminiBoilerplate(text: string): string {
  return stripGeminiBoilerplateFromCommon(text);
}

function stripGeminiUiPrefixes(text: string): string {
  return stripGeminiUiPrefixesFromCommon(text);
}

function extractUrlsFromElement(node: Element): string[] {
  const candidates = new Set<string>();
  const attrs = node.getAttributeNames();
  for (const name of attrs) {
    const raw = node.getAttribute(name) || "";
    if (!raw) {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    if (
      name === "href" ||
      name === "src" ||
      name.toLowerCase().includes("url") ||
      name.toLowerCase().includes("href") ||
      name.toLowerCase().includes("src") ||
      name.toLowerCase().includes("download")
    ) {
      const absolute = toAbsoluteUrl(trimmed);
      if (absolute) {
        candidates.add(absolute);
      }
    }

    const matches = trimmed.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    for (const match of matches) {
      const absolute = toAbsoluteUrl(match);
      if (absolute) {
        candidates.add(absolute);
      }
    }
  }

  const textMatches = ((node.textContent || "").match(/https?:\/\/[^\s"'<>]+/gi) || []).map((item) =>
    toAbsoluteUrl(item)
  );
  for (const item of textMatches) {
    if (item) {
      candidates.add(item);
    }
  }

  return Array.from(candidates);
}

export function extractDriveApiAttachments(): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources) {
      const url = entry.name;
      const match = url.match(/googleapis\.com\/drive\/v3\/files\/([^?]+)\?alt=media/i);
      if (!match) {
        continue;
      }
      if (found.has(url)) {
        continue;
      }
      found.set(url, {
        kind: "file",
        originalUrl: url,
        mime: null,
        status: "remote_only"
      });
    }
  } catch {
    // ignore
  }
  return Array.from(found.values());
}

export function applyDriveAttachments(turns: CaptureTurn[]): CaptureTurn[] {
  const driveAttachments = extractDriveApiAttachments();
  if (!driveAttachments.length) {
    return turns;
  }
  const firstUserIdx = turns.findIndex((t) => t.role === "user");
  if (firstUserIdx < 0) {
    return turns;
  }
  return turns.map((turn, idx) => {
    if (idx !== firstUserIdx) {
      return turn;
    }
    return {
      ...turn,
      attachments: mergeTurnAttachments(turn.attachments, driveAttachments)
    };
  });
}

function sleep(ms: number): Promise<void> {
  return sleepFromWarmupCommon(ms);
}

function pickScrollableElement(doc: Document): HTMLElement | null {
  return pickScrollableElementFromWarmupCommon(doc);
}

function pickChatGptConversationScroller(doc: Document): HTMLElement | null {
  const main = doc.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    return null;
  }

  const messageNodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
  const ancestorCandidates = new Map<HTMLElement, number>();
  for (const messageNode of messageNodes) {
    let current: HTMLElement | null = messageNode instanceof HTMLElement ? messageNode : null;
    let depth = 0;
    while (current && current !== main && depth < 10) {
      const diff = current.scrollHeight - current.clientHeight;
      if (diff > 120) {
        const score = ancestorCandidates.get(current) || 0;
        ancestorCandidates.set(current, score + 1);
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  if (ancestorCandidates.size > 0) {
    const ranked = Array.from(ancestorCandidates.entries())
      .filter(([node]) => !node.closest("aside, nav, [role='navigation'], [role='complementary']"))
      .filter(([node]) => {
        const hint = `${node.className || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
        return !/sidebar|drawer|panel|file|asset/.test(hint);
      })
      .sort((a, b) => {
        const scoreDiff = b[1] - a[1];
        if (scoreDiff !== 0) {
          return scoreDiff;
        }
        return (b[0].scrollHeight - b[0].clientHeight) - (a[0].scrollHeight - a[0].clientHeight);
      });
    if (ranked[0]?.[0]) {
      return ranked[0][0];
    }
  }

  const candidates = Array.from(
    main.querySelectorAll(
      [
        "[data-testid*='conversation']",
        "[data-testid*='thread']",
        "[class*='conversation']",
        "[class*='thread']",
        "[class*='message']",
        "[class*='overflow-y-auto']",
        "[data-message-author-role]"
      ].join(",")
    )
  )
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .filter((node) => node.scrollHeight - node.clientHeight > 120)
    .filter((node) => !node.closest("aside, nav, [role='navigation'], [role='complementary']"))
    .filter((node) => {
      const hint = `${node.className || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
      return !/sidebar|drawer|panel|file|asset/.test(hint);
    });

  if (!candidates.length) {
    return main.scrollHeight - main.clientHeight > 120 ? main : null;
  }

  candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  return candidates[0] ?? null;
}

function collectChatGptConversationScrollers(doc: Document): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const add = (node: Element | null | undefined) => {
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    if (node.scrollHeight - node.clientHeight < 60) {
      return;
    }
    if (!isVisibleElement(node)) {
      return;
    }
    if (node.closest("aside, nav, [role='navigation'], [role='complementary']")) {
      return;
    }
    const hint = `${node.className || ""} ${node.getAttribute("data-testid") || ""}`.toLowerCase();
    if (/sidebar|drawer|panel|composer|input|textarea|toolbar|modal/.test(hint)) {
      return;
    }
    seen.add(node);
    out.push(node);
  };

  add(pickChatGptConversationScroller(doc));
  add(pickScrollableElement(doc));
  add(doc.scrollingElement);
  add(doc.querySelector("main"));

  const main = doc.querySelector("main");
  if (main instanceof HTMLElement) {
    const messageNodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
    for (const messageNode of messageNodes.slice(0, 120)) {
      let current: HTMLElement | null = messageNode instanceof HTMLElement ? messageNode : null;
      let depth = 0;
      while (current && depth < 14) {
        add(current);
        current = current.parentElement;
        depth += 1;
      }
    }

    const selectorCandidates = Array.from(
      main.querySelectorAll(
        [
          "[data-testid*='conversation']",
          "[data-testid*='thread']",
          "[class*='conversation']",
          "[class*='thread']",
          "[class*='message']",
          "[class*='overflow-y-auto']",
          "[class*='scroll']"
        ].join(",")
      )
    );
    for (const node of selectorCandidates.slice(0, 180)) {
      add(node);
    }
  }

  out.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  return out.slice(0, 6);
}

async function warmupScrollableArea(doc: Document, config: WarmupConfig): Promise<void> {
  await warmupScrollableAreaFromWarmupCommon(doc, config);
}

async function moveScrollerSlowly(
  scroller: HTMLElement,
  fromTop: number,
  toTop: number,
  steps: number,
  waitMs: number
): Promise<SlowMoveResult> {
  return moveScrollerSlowlyFromWarmupCommon(scroller, fromTop, toTop, steps, waitMs);
}

async function waitForTrackedNetworkSettle(idleRounds = 4, intervalMs = 240): Promise<void> {
  await waitForTrackedNetworkSettleFromWarmupCommon(idleRounds, intervalMs);
}

async function sweepChatGptScrollerSlowly(
  scroller: HTMLElement,
  returnToOrigin = false
): Promise<{ movedPixels: number; peakTop: number }> {
  const originTop = Math.max(0, scroller.scrollTop);
  const originMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  let movedPixels = 0;
  let peakTop = originTop;
  let floorTop = originTop;
  console.info("[AI_HISTORY] chatgpt warmup sweep start", {
    originTop,
    maxScroll: originMax,
    tag: scroller.tagName.toLowerCase(),
    className: String(scroller.className || "").slice(0, 120)
  });
  const toTopSteps = Math.max(4, Math.min(18, Math.ceil(originTop / 260)));
  if (originTop > 0) {
    const moveUp = await moveScrollerSlowly(scroller, originTop, 0, toTopSteps, 90);
    movedPixels = Math.max(movedPixels, moveUp.movedPixels);
    peakTop = Math.max(peakTop, moveUp.maxTopSeen);
    floorTop = Math.min(floorTop, moveUp.minTopSeen);
    await sleep(180);
  }

  let reachedBottom = false;
  for (let round = 0; round < 3; round += 1) {
    const maxScrollBefore = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScrollBefore < 24) {
      break;
    }
    const downSteps = Math.max(10, Math.min(36, Math.ceil(maxScrollBefore / 320)));
    const moveDown = await moveScrollerSlowly(scroller, scroller.scrollTop, maxScrollBefore, downSteps, 110);
    movedPixels = Math.max(movedPixels, moveDown.movedPixels);
    peakTop = Math.max(peakTop, moveDown.maxTopSeen);
    floorTop = Math.min(floorTop, moveDown.minTopSeen);
    await sleep(240);
    const maxScrollAfter = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (Math.abs(maxScrollAfter - maxScrollBefore) <= 20) {
      reachedBottom = true;
      break;
    }
  }

  const maxScrollFinal = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (maxScrollFinal >= 24) {
    if (!reachedBottom) {
      const finalDownSteps = Math.max(8, Math.min(28, Math.ceil(maxScrollFinal / 360)));
      const finalDown = await moveScrollerSlowly(scroller, scroller.scrollTop, maxScrollFinal, finalDownSteps, 100);
      movedPixels = Math.max(movedPixels, finalDown.movedPixels);
      peakTop = Math.max(peakTop, finalDown.maxTopSeen);
      floorTop = Math.min(floorTop, finalDown.minTopSeen);
      await sleep(180);
    }
    const upSteps = Math.max(10, Math.min(36, Math.ceil(maxScrollFinal / 340)));
    const upMove = await moveScrollerSlowly(scroller, scroller.scrollTop, 0, upSteps, 90);
    movedPixels = Math.max(movedPixels, upMove.movedPixels);
    peakTop = Math.max(peakTop, upMove.maxTopSeen);
    floorTop = Math.min(floorTop, upMove.minTopSeen);
    await sleep(180);
  }

  if (returnToOrigin) {
    const latestMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const cappedOrigin = Math.max(0, Math.min(latestMax, originTop));
    const returnSteps = Math.max(4, Math.min(18, Math.ceil(Math.abs(cappedOrigin - scroller.scrollTop) / 260)));
    const returnMove = await moveScrollerSlowly(scroller, scroller.scrollTop, cappedOrigin, returnSteps, 75);
    movedPixels = Math.max(movedPixels, returnMove.movedPixels);
    peakTop = Math.max(peakTop, returnMove.maxTopSeen);
    floorTop = Math.min(floorTop, returnMove.minTopSeen);
    await sleep(140);
  } else {
    if (scroller.scrollTop !== 0) {
      const toTop = await moveScrollerSlowly(scroller, scroller.scrollTop, 0, Math.max(4, Math.ceil(scroller.scrollTop / 300)), 80);
      movedPixels = Math.max(movedPixels, toTop.movedPixels);
      peakTop = Math.max(peakTop, toTop.maxTopSeen);
      floorTop = Math.min(floorTop, toTop.minTopSeen);
    }
    await sleep(180);
  }
  console.info("[AI_HISTORY] chatgpt warmup sweep done", {
    restoredTop: scroller.scrollTop,
    maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    movedPixels,
    peakTop,
    floorTop
  });
  return {
    movedPixels,
    peakTop
  };
}

function countExpectedNonImageUploadTiles(doc: Document = document): number {
  const labels = collectChatGptFileTileButtons(doc)
    .map((button) => (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim().toLowerCase())
    .filter(Boolean);
  const unique = new Set<string>();
  for (const label of labels) {
    if (!looksLikeAttachmentFileNameLabel(label)) {
      continue;
    }
    const ext = extractExtFromFileName(label);
    if (!ext || isImageExtension(ext)) {
      continue;
    }
    unique.add(label);
  }
  return unique.size;
}

function countTrackedNonImageDownloadHints(sinceMs = activeCaptureWindowStartMs()): number {
  const seen = new Set<string>();
  const add = (raw: string) => {
    const url = (toAbsoluteUrl(raw) || raw).trim();
    if (!url) {
      return;
    }
    const lower = url.toLowerCase();
    const isBackendDownload =
      /\/backend-api\/files\/download\/[a-z0-9_-]{8,}/i.test(lower) ||
      /\/backend-api\/files\/[a-z0-9_-]{8,}\/download/i.test(lower) ||
      /\/backend-api\/estuary\/content\?[^#\s]*\bid=file[_-]/i.test(lower);
    const isLikelyDirectOaiDownload =
      lower.includes("oaiusercontent.com") &&
      (
        /[?&](download|filename|attachment|response-content-disposition)=/i.test(lower) ||
        /oaiusercontent\.com\/[^?#]*file[-_][a-z0-9-]{4,}/i.test(lower) ||
        /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt)\b/i.test(lower)
      );
    if (!isBackendDownload && !isLikelyDirectOaiDownload) {
      return;
    }
    seen.add(url);
  };

  const tracked = getTrackedNetworkRecords(sinceMs);
  for (const record of tracked) {
    if (record.method !== "GET" && record.method !== "POST") {
      continue;
    }
    add(record.url);
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-2200)) {
      if (sinceMs > 0 && entry.startTime + 5 < sinceMs) {
        continue;
      }
      add(String(entry.name || ""));
    }
  } catch {
    // ignore
  }

  return seen.size;
}

async function waitForChatGptFileUrlEvidence(
  doc: Document,
  expectedNonImageUploads: number,
  primedLabels: Set<string>,
  preferredScroller: HTMLElement | null = null
): Promise<void> {
  if (expectedNonImageUploads <= 0) {
    return;
  }
  const sinceMs = activeCaptureWindowStartMs();
  const targetEvidence = Math.max(1, Math.min(expectedNonImageUploads, 2));
  const scrollers = collectChatGptConversationScrollers(doc);
  const mainScroller = preferredScroller && preferredScroller.isConnected
    ? preferredScroller
    : (scrollers[0] ?? null);
  for (let round = 0; round < 8; round += 1) {
    const observed = countTrackedNonImageDownloadHints(sinceMs);
    if (observed >= targetEvidence) {
      console.info("[AI_HISTORY] chatgpt warmup file-url evidence ready", {
        observed,
        targetEvidence,
        expectedNonImageUploads
      });
      return;
    }
    if (mainScroller) {
      mainScroller.scrollTop = 0;
      mainScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    } else {
      window.scrollTo(0, 0);
    }
    await sleep(260);
    await primeChatGptFileTileRequests(doc, primedLabels, 10, { nonImageOnly: true });
    await waitForTrackedNetworkSettle(2, 280);
  }
  console.info("[AI_HISTORY] chatgpt warmup file-url evidence timeout", {
    observed: countTrackedNonImageDownloadHints(sinceMs),
    targetEvidence,
    expectedNonImageUploads
  });
}

function isVisibleElement(node: HTMLElement): boolean {
  if (!node.isConnected) {
    return false;
  }
  const style = window.getComputedStyle(node);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function collectChatGptFileTileButtons(doc: Document): HTMLButtonElement[] {
  const main = doc.querySelector("main");
  if (!(main instanceof HTMLElement)) {
    return [];
  }

  const sourceRoots = Array.from(main.querySelectorAll("[data-message-author-role='user']"));
  const roots: ParentNode[] = sourceRoots.length > 0 ? sourceRoots : [main];
  const out: HTMLButtonElement[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const buttons = Array.from(root.querySelectorAll("button[aria-label], button[title]"));
    for (const button of buttons) {
      if (!(button instanceof HTMLButtonElement)) {
        continue;
      }
      if (button.disabled || !isVisibleElement(button)) {
        continue;
      }
      if (button.closest("form, textarea, [contenteditable='true']")) {
        continue;
      }
      const label = (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim();
      if (!looksLikeAttachmentFileNameLabel(label)) {
        continue;
      }
      const dedupeKey = `${label.toLowerCase()}::${Math.round(button.getBoundingClientRect().top)}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      out.push(button);
    }
  }

  return out.slice(0, 12);
}

function dismissTransientAttachmentLayer(doc: Document): void {
  const closeButton = doc.querySelector(
    [
      "button[aria-label='Close']",
      "button[aria-label='关闭']",
      "button[aria-label='关 闭']",
      "button[data-testid*='close']"
    ].join(",")
  );
  if (closeButton instanceof HTMLButtonElement && !closeButton.disabled) {
    closeButton.click();
  }

  const escapeDown = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
  const escapeUp = new KeyboardEvent("keyup", { key: "Escape", bubbles: true });
  doc.dispatchEvent(escapeDown);
  doc.dispatchEvent(escapeUp);
}

function createSyntheticReactEvent(
  type: string,
  target: HTMLElement,
  nativeEvent: Record<string, unknown> = {}
): Record<string, unknown> {
  const noop = () => undefined;
  return {
    type,
    target,
    currentTarget: target,
    nativeEvent: {
      type,
      target,
      currentTarget: target,
      isTrusted: true,
      ...nativeEvent
    },
    isTrusted: true,
    button: 0,
    buttons: 1,
    detail: 1,
    timeStamp: Date.now(),
    defaultPrevented: false,
    preventDefault: noop,
    stopPropagation: noop,
    persist: noop,
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false
  };
}

function invokeFunctionSafely(fn: unknown, eventLike: Record<string, unknown>): boolean {
  if (typeof fn !== "function") {
    return false;
  }
  try {
    (fn as (event: Record<string, unknown>) => unknown)(eventLike);
    return true;
  } catch {
    return false;
  }
}

function invokeReactHandlersFromProps(
  props: unknown,
  target: HTMLElement,
  seenHandlers: Set<Function>
): number {
  if (!isRecord(props)) {
    return 0;
  }
  const clickEvent = createSyntheticReactEvent("click", target);
  const pointerEvent = createSyntheticReactEvent("pointerup", target, { pointerType: "mouse" });
  const mouseEvent = createSyntheticReactEvent("mouseup", target, { button: 0 });
  const keyEvent = createSyntheticReactEvent("keydown", target, { key: "Enter", code: "Enter" });
  const handlerNames = [
    "onPress",
    "onClick",
    "onPointerUp",
    "onMouseUp",
    "onMouseDown",
    "onPointerDown",
    "onKeyDown"
  ];
  let invoked = 0;
  for (const key of handlerNames) {
    const candidate = props[key];
    if (typeof candidate !== "function") {
      continue;
    }
    const fn = candidate as Function;
    if (seenHandlers.has(fn)) {
      continue;
    }
    seenHandlers.add(fn);
    let eventLike = clickEvent;
    if (key.toLowerCase().includes("pointer")) {
      eventLike = pointerEvent;
    } else if (key.toLowerCase().includes("mouse")) {
      eventLike = mouseEvent;
    } else if (key.toLowerCase().includes("key")) {
      eventLike = keyEvent;
    }
    if (invokeFunctionSafely(fn, eventLike)) {
      invoked += 1;
    }
  }
  return invoked;
}

function invokeReactFileTileActions(node: HTMLElement): number {
  let invoked = 0;
  const seenHandlers = new Set<Function>();
  let current: HTMLElement | null = node;
  let depth = 0;
  while (current && depth < 6) {
    const names = ownPropertyNamesSafe(current as unknown as object);
    for (const key of names) {
      if (key.startsWith("__reactProps$")) {
        const props = (current as unknown as Record<string, unknown>)[key];
        invoked += invokeReactHandlersFromProps(props, node, seenHandlers);
        continue;
      }
      if (!key.startsWith("__reactFiber$")) {
        continue;
      }
      const fiber = (current as unknown as Record<string, unknown>)[key];
      if (!isRecord(fiber)) {
        continue;
      }
      invoked += invokeReactHandlersFromProps(fiber.memoizedProps, node, seenHandlers);
      invoked += invokeReactHandlersFromProps(fiber.pendingProps, node, seenHandlers);
      if (isRecord(fiber.return)) {
        invoked += invokeReactHandlersFromProps(fiber.return.memoizedProps, node, seenHandlers);
        invoked += invokeReactHandlersFromProps(fiber.return.pendingProps, node, seenHandlers);
      }
    }
    current = current.parentElement;
    depth += 1;
  }
  return invoked;
}

async function primeChatGptFileTileRequests(
  doc: Document = document,
  alreadyPrimedLabels: Set<string> | null = null,
  maxClicks = 8,
  options: {
    nonImageOnly?: boolean;
  } = {}
): Promise<void> {
  ensureRuntimeNetworkTracker();
  const buttons = collectChatGptFileTileButtons(doc)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  if (!buttons.length) {
    return;
  }

  const primedLabels = alreadyPrimedLabels ?? new Set<string>();
  const sinceMs = activeCaptureWindowStartMs();
  let clicked = 0;
  let attempted = 0;
  let confirmed = 0;
  let reactInvoked = 0;
  for (const button of buttons) {
    try {
      const label = (button.getAttribute("aria-label") || button.getAttribute("title") || "").trim().toLowerCase();
      if (label && primedLabels.has(label)) {
        continue;
      }
      if (options.nonImageOnly && label) {
        const ext = extractExtFromFileName(label);
        if (!ext || isImageExtension(ext)) {
          continue;
        }
      }
      attempted += 1;
      const hintsBefore = options.nonImageOnly ? countTrackedNonImageDownloadHints(sinceMs) : 0;
      const clickTarget = (button.closest("[data-default-action='true']") as HTMLElement | null) ?? button;
      button.scrollIntoView({ block: "center", inline: "nearest" });
      await sleep(120);

      const rect = clickTarget.getBoundingClientRect();
      const clientX = Math.round(rect.left + Math.max(2, Math.min(rect.width - 2, rect.width / 2)));
      const clientY = Math.round(rect.top + Math.max(2, Math.min(rect.height - 2, rect.height / 2)));
      const pointerInit: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        pointerId: 1,
        isPrimary: true,
        clientX,
        clientY
      };
      if (typeof PointerEvent !== "undefined") {
        clickTarget.dispatchEvent(new PointerEvent("pointerdown", { ...pointerInit, buttons: 1 }));
        clickTarget.dispatchEvent(new PointerEvent("pointerup", { ...pointerInit, buttons: 0 }));
      }
      const mouseInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        button: 0
      };
      clickTarget.dispatchEvent(new MouseEvent("mousedown", { ...mouseInit, buttons: 1 }));
      clickTarget.dispatchEvent(new MouseEvent("mouseup", { ...mouseInit, buttons: 0 }));
      clickTarget.dispatchEvent(new MouseEvent("click", { ...mouseInit, buttons: 0 }));
      clickTarget.click();
      if (clickTarget !== button) {
        button.dispatchEvent(new MouseEvent("click", { ...mouseInit, buttons: 0 }));
        button.click();
      }
      reactInvoked += invokeReactFileTileActions(clickTarget);
      if (clickTarget !== button) {
        reactInvoked += invokeReactFileTileActions(button);
      }
      clickTarget.focus({ preventScroll: true });
      clickTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      clickTarget.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));

      await sleep(560);
      dismissTransientAttachmentLayer(doc);
      await sleep(260);
      let shouldMarkPrimed = true;
      if (options.nonImageOnly) {
        const hintsAfter = countTrackedNonImageDownloadHints(sinceMs);
        shouldMarkPrimed = hintsAfter > hintsBefore;
      }
      if (label && shouldMarkPrimed) {
        primedLabels.add(label);
        confirmed += 1;
      }
      clicked += 1;
      if (clicked >= Math.max(1, maxClicks)) {
        break;
      }
    } catch {
      // continue with next button
    }
  }
  if (attempted > 0) {
    console.info("[AI_HISTORY] chatgpt warmup file-tile prime", {
      nonImageOnly: Boolean(options.nonImageOnly),
      attempted,
      clicked,
      confirmed,
      primed: primedLabels.size,
      reactInvoked
    });
  }
}

async function warmupChatGptLazyResources(doc: Document = document): Promise<void> {
  ensureRuntimeNetworkTracker();
  const scrollers = collectChatGptConversationScrollers(doc);
  if (scrollers.length === 0) {
    await warmupScrollableArea(doc, {
      downSteps: 16,
      downWaitMs: 90,
      upWaitMs: 55
    });
    await primeChatGptFileTileRequests(doc);
    return;
  }

  const primedLabels = new Set<string>();
  let activeScroller: HTMLElement | null = null;
  for (const [index, scroller] of scrollers.entries()) {
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll < 60) {
      continue;
    }
    console.info("[AI_HISTORY] chatgpt warmup selected scroller", {
      index,
      maxScroll,
      originTop: scroller.scrollTop,
      tag: scroller.tagName.toLowerCase(),
      className: String(scroller.className || "").slice(0, 120)
    });
    const originTop = Math.max(0, scroller.scrollTop);
    const toTopSteps = Math.max(4, Math.min(24, Math.ceil(Math.max(originTop, maxScroll * 0.2) / 280)));
    const moveToTop = await moveScrollerSlowly(scroller, originTop, 0, toTopSteps, 85);
    await sleep(220);
    if (moveToTop.movedPixels < 80 && maxScroll > 300) {
      console.info("[AI_HISTORY] chatgpt warmup scroller ignored due to low movement", {
        index,
        movedPixels: moveToTop.movedPixels,
        peakTop: moveToTop.maxTopSeen
      });
      continue;
    }
    activeScroller = scroller;
    break;
  }

  if (!activeScroller) {
    await warmupScrollableArea(doc, {
      downSteps: 16,
      downWaitMs: 90,
      upWaitMs: 55
    });
    await primeChatGptFileTileRequests(doc, primedLabels, 10, { nonImageOnly: true });
  } else {
    activeScroller.scrollTop = 0;
    activeScroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(260);
    await primeChatGptFileTileRequests(doc, primedLabels, 10, { nonImageOnly: true });
  }
  const expectedNonImageUploads = countExpectedNonImageUploadTiles(doc);
  await waitForChatGptFileUrlEvidence(doc, expectedNonImageUploads, primedLabels, activeScroller);
  await waitForTrackedNetworkSettle(3, 260);
}

export async function warmupAiStudioLazyResources(doc: Document = document): Promise<void> {
  return warmupAiStudioLazyResourcesWith(doc, {
    warmupScrollableArea
  });
}

export async function warmupSourceLazyResources(
  source: CaptureSource,
  doc: Document = document
): Promise<void> {
  return warmupSourceLazyResourcesWith(source, doc, {
    ensureRuntimeNetworkTracker,
    warmupScrollableArea,
    warmupChatGptLazyResources
  });
}

function isNavigationUrl(url: string): boolean {
  return isNavigationUrlFromCommon(url);
}

function sanitizeGeminiTurn(turn: CaptureTurn): CaptureTurn | null {
  return sanitizeGeminiTurnFromCommon(turn);
}

function toAbsoluteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed, location.href).toString();
  } catch {
    return "";
  }
}

function isUiAsset(url: string): boolean {
  return /avatar|icon|logo|sprite|favicon/i.test(url);
}

function extractAttachments(node: ParentNode): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const contextPostIds = collectLikelyPostIdsFromDocument(document);
  const contextConversationIds = collectLikelyConversationIdsFromDocument(document);
  const addFileIdCandidates = (
    raw: string,
    mimeHint: string | null = null,
    options: ExtractFileIdOptions = {}
  ) => {
    for (const fileId of extractFileIdsFromString(raw, options)) {
      for (const url of buildBackendFileUrlCandidates(fileId, contextPostIds, contextConversationIds)) {
        addAttachmentCandidate(found, url, mimeHint);
      }
    }
  };

  for (const img of Array.from(node.querySelectorAll("img[src]"))) {
    const src = toAbsoluteUrl(img.getAttribute("src") || "");
    if (!src || isUiAsset(src)) {
      continue;
    }
    if (/drive-thirdparty\.googleusercontent\.com\/\d+\/type\//i.test(src)) {
      continue;
    }
    if (!looksLikeImageUrl(src)) {
      continue;
    }
    if (!found.has(src)) {
      found.set(src, {
        kind: "image",
        originalUrl: src,
        mime: inferAttachmentMime("image", src),
        status: "remote_only"
      });
    }
  }

  for (const a of Array.from(node.querySelectorAll("a[href]"))) {
    const href = toAbsoluteUrl(a.getAttribute("href") || "");
    if (!href || /^javascript:/i.test(href)) {
      continue;
    }
    if (isNavigationUrl(href)) {
      continue;
    }
    const label = (a.textContent || "").trim();
    const kind = inferAttachmentKind(href, label);
    if (kind === "file" && !looksLikeFileUrl(href)) {
      continue;
    }

    if (!found.has(href)) {
      found.set(href, {
        kind,
        originalUrl: href,
        mime: inferAttachmentMime(kind, href),
        status: "remote_only"
      });
    }
  }

  const attachmentCandidates = Array.from(
    node.querySelectorAll(
      [
        "[data-testid*='attachment']",
        "[data-testid*='upload']",
        "[data-testid*='file']",
        "[aria-label*='attachment']",
        "[aria-label*='file']",
        "[aria-label*='文件']",
        "[role='group'][aria-label]",
        "[class*='attachment']",
        "[class*='uploaded']",
        "[class*='file-chip']"
      ].join(",")
    )
  );
  for (const candidate of attachmentCandidates) {
    const label = ((candidate as HTMLElement).innerText || candidate.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const urls = extractUrlsFromElement(candidate);
    for (const url of urls) {
      if (!url || /^javascript:/i.test(url) || isNavigationUrl(url)) {
        continue;
      }
      const kind = inferAttachmentKind(url, label);
      if (kind === "file" && !looksLikeFileUrl(url)) {
        continue;
      }
      if (!found.has(url)) {
        found.set(url, {
          kind,
          originalUrl: url,
          mime: inferAttachmentMime(kind, url),
          status: "remote_only"
        });
      }
    }

    for (const attrName of candidate.getAttributeNames()) {
      const raw = candidate.getAttribute(attrName) || "";
      if (!raw) {
        continue;
      }
      if (
        /file|asset|attachment|upload|document|id/i.test(attrName) ||
        /file-service:\/\//i.test(raw) ||
        /\/backend-api\/files\//i.test(raw) ||
        /\/backend-api\/estuary\/content/i.test(raw) ||
        looksLikeOpaqueFileId(raw)
      ) {
        const allowUuid = /\/backend-api\/estuary\/content|\/backend-api\/files\//i.test(raw);
        addFileIdCandidates(raw, null, { allowUuid, sourceKey: attrName });
      }
    }
    addFileIdCandidates(label, null);
  }

  const fileLabelNodes = Array.from(
    node.querySelectorAll(
      [
        "button[aria-label]",
        "button[title]",
        "[role='group'][aria-label]",
        "[data-default-action='true']"
      ].join(",")
    )
  );
  for (const fileLabelNode of fileLabelNodes) {
    const label = (
      fileLabelNode.getAttribute("aria-label") ||
      fileLabelNode.getAttribute("title") ||
      ((fileLabelNode as HTMLElement).innerText || fileLabelNode.textContent || "")
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!looksLikeAttachmentFileNameLabel(label)) {
      continue;
    }
    const labelKind = inferAttachmentKind("", label);
    const labelMimeHint = inferAttachmentMime(labelKind, label);
    const labelExt = extractExtFromFileName(label);
    const allowLabelUuid = Boolean(labelExt) && !isImageExtension(labelExt);

    const scopes: Element[] = [];
    let current: Element | null = fileLabelNode;
    let depth = 0;
    while (current && depth < 4) {
      scopes.push(current);
      current = current.parentElement;
      depth += 1;
    }

    for (const scope of scopes) {
      const urls = extractUrlsFromElement(scope);
      for (const url of urls) {
        if (!url || /^javascript:/i.test(url) || isNavigationUrl(url)) {
          continue;
        }
        addAttachmentCandidate(found, url, null, label);
      }
      for (const attrName of scope.getAttributeNames()) {
        const raw = scope.getAttribute(attrName) || "";
        if (!raw) {
          continue;
        }
        if (
          /file|asset|attachment|upload|document|pointer|download|id/i.test(attrName) ||
          /file-service:\/\//i.test(raw) ||
          /\/backend-api\/files\//i.test(raw) ||
          /\/backend-api\/estuary\/content/i.test(raw) ||
          looksLikeOpaqueFileId(raw)
        ) {
          const allowUuid = /\/backend-api\/estuary\/content|\/backend-api\/files\//i.test(raw) || allowLabelUuid;
          addFileIdCandidates(raw, labelMimeHint, { allowUuid, sourceKey: attrName });
        }
      }
      const scopeText = ((scope as HTMLElement).innerText || scope.textContent || "").trim();
      if (scopeText && (looksLikeAttachmentFileNameLabel(scopeText) || /file[-_]|backend-api|estuary|download/i.test(scopeText))) {
        addFileIdCandidates(scopeText, labelMimeHint, {
          allowUuid: /backend-api|estuary/i.test(scopeText) || allowLabelUuid
        });
      }
    }

    addFileIdCandidates(label, labelMimeHint, { allowUuid: allowLabelUuid });

    // Deep React fiber traversal: ChatGPT's file-tile buttons often have the
    // real file_id buried deep in React's internal component tree, not
    // exposed in DOM attributes. Walk up to 10 DOM levels and 10 fiber
    // parents to find file-service:// URIs, file-xxx IDs, and backend-api URLs.
    const fiberFileIds = extractFileIdsFromFileTileReactFiber(fileLabelNode);
    if (fiberFileIds.length > 0) {
      const mimeHint = labelMimeHint;
      for (const rawId of fiberFileIds) {
        // If rawId is already a full URL, add it directly
        if (/^https?:\/\//i.test(rawId) || /\/backend-api\//i.test(rawId)) {
          addAttachmentCandidate(found, rawId, mimeHint, label);
        } else {
          // It's a file ID — build backend URL candidates
          for (const candidate of buildBackendFileUrlCandidates(rawId, contextPostIds, contextConversationIds)) {
            addAttachmentCandidate(found, candidate, mimeHint, label);
          }
        }
      }
      console.info("[AI_HISTORY] file-tile react fiber extraction", {
        label,
        ids: fiberFileIds.slice(0, 4)
      });
    }

    const ext = extractExtFromFileName(label);
    if (ext && !isImageExtension(ext)) {
      const virtualUrl = buildVirtualAttachmentUrl(label);
      if (!found.has(virtualUrl)) {
        const virtualKind: CaptureAttachment["kind"] = ext === "pdf" ? "pdf" : "file";
        found.set(virtualUrl, {
          kind: virtualKind,
          originalUrl: virtualUrl,
          mime: inferAttachmentMime(virtualKind, label),
          status: "remote_only"
        });
      }
    }
  }

  const fileIdNodes = Array.from(
    node.querySelectorAll(
      [
        "[data-file-id]",
        "[data-asset-id]",
        "[data-attachment-id]",
        "[data-upload-id]",
        "[data-testid*='file']",
        "[data-testid*='attachment']",
        "[data-testid*='upload']",
        "[data-asset-pointer]"
      ].join(",")
    )
  );
  for (const fileNode of fileIdNodes) {
    for (const attrName of fileNode.getAttributeNames()) {
      const raw = fileNode.getAttribute(attrName) || "";
      if (!raw) {
        continue;
      }
      addFileIdCandidates(raw, null, { allowUuid: true, sourceKey: attrName });
    }
    const text = ((fileNode as HTMLElement).innerText || fileNode.textContent || "").trim();
    if (text) {
      addFileIdCandidates(text, null, { allowUuid: true });
    }
  }

  const reactPayloads = collectReactPayloadObjects(node);
  for (const payload of reactPayloads) {
    const derived = extractAttachmentsFromApiMessage(payload, 800);
    for (const attachment of derived) {
      addAttachmentCandidate(found, attachment.originalUrl, attachment.mime ?? null);
    }
  }

  return Array.from(found.values());
}

function trimTrailingPunctuationFromUrl(url: string): string {
  return url.replace(/[),.;!?]+$/g, "");
}

function extractAttachmentsFromMarkdownText(markdown: string): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const text = markdown.trim();
  if (!text) {
    return [];
  }

  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const alt = (match[1] || "").trim();
    const url = trimTrailingPunctuationFromUrl((match[2] || "").trim());
    if (!url) {
      continue;
    }
    addAttachmentCandidate(found, url, null, alt);
  }

  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const label = (match[1] || "").trim();
    const url = trimTrailingPunctuationFromUrl((match[2] || "").trim());
    if (!url) {
      continue;
    }
    addAttachmentCandidate(found, url, null, label);
  }

  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = trimTrailingPunctuationFromUrl((match[0] || "").trim());
    if (!url) {
      continue;
    }
    addAttachmentCandidate(found, url, null);
  }

  return Array.from(found.values());
}

function splitThoughts(raw: string): { contentMarkdown: string; thoughtMarkdown: string | null } {
  return splitThoughtsFromCommon(raw);
}

function extractNodeTextAndThought(node: Element): { contentMarkdown: string; thoughtMarkdown: string | null } {
  return extractNodeTextAndThoughtFromCommon(node);
}

function leafNodes(root: ParentNode, selector: string): Element[] {
  return leafNodesFromCommon(root, selector);
}

function roleFromAttrs(node: Element): CaptureTurn["role"] | null {
  return roleFromAttrsFromCommon(node);
}

function buildTurn(node: Element, fallbackRole: CaptureTurn["role"] | null = null): CaptureTurn | null {
  return buildTurnFromCommon(node, fallbackRole, {
    extractAttachments,
    extractAttachmentsFromMarkdownText,
    mergeTurnAttachments
  });
}

function dedupeTurns(turns: CaptureTurn[]): CaptureTurn[] {
  return dedupeTurnsFromCommon(turns, { mergeTurnAttachments });
}

function parseByRoleMarkers(text: string): CaptureTurn[] {
  return parseByRoleMarkersFromCommon(text);
}

function canonicalizePageUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (
      parsed.hostname.includes("chatgpt.com") ||
      parsed.hostname.includes("gemini.google.com") ||
      parsed.hostname.includes("bard.google.com") ||
      parsed.hostname.includes("aistudio.google.com")
    ) {
      parsed.search = "";
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function titleFromTurns(turns: CaptureTurn[]): string {
  const user = turns.find((turn) => turn.role === "user");
  if (!user) {
    return "Untitled Conversation";
  }
  return user.contentMarkdown.replace(/\s+/g, " ").slice(0, 60);
}

function normalizeTitle(raw: string, fallback: string): string {
  const cleaned = normalizeMarkdownText(
    raw
      .replace(/\s*\|\s*Google AI Studio$/i, "")
      .replace(/\s*-\s*Gemini$/i, "")
      .replace(/\s*-\s*ChatGPT$/i, "")
      .trim()
  );
  if (!cleaned || /^(google gemini|gemini|chatgpt|google ai studio)$/i.test(cleaned)) {
    return fallback;
  }
  return cleaned;
}

function deriveTitle(source: CaptureSource, doc: Document, turns: CaptureTurn[]): string {
  const fallback = titleFromTurns(turns);
  const root = (doc.querySelector("main") as HTMLElement | null) || doc.body;

  if (source === "gemini") {
    const heading =
      root.querySelector("h1, h2, [data-test-id='conversation-title'], [aria-label*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  if (source === "ai_studio") {
    const heading =
      root.querySelector("h1, h2, [data-testid='prompt-title'], [aria-label*='title'], [class*='title']")?.textContent ||
      doc.title ||
      "";
    return normalizeTitle(heading, fallback);
  }

  return normalizeTitle(doc.title || "", fallback);
}

export function extractChatGptTurns(doc: Document = document): CaptureTurn[] {
  const main = doc.querySelector("main") || doc.body;
  const primaryNodes = Array.from(main.querySelectorAll("[data-message-author-role]"));
  const primaryTurns = primaryNodes
    .map((node) => {
      const role = (node.getAttribute("data-message-author-role") || "assistant") as CaptureTurn["role"];
      return buildTurn(node, role);
    })
    .filter((v): v is CaptureTurn => Boolean(v));
  if (primaryTurns.length > 0) {
    return dedupeTurns(primaryTurns);
  }

  const fallbackNodes = Array.from(
    main.querySelectorAll(
      [
        "article",
        "[data-testid*='conversation-turn']",
        "[data-testid*='message']",
        "[class*='conversation-turn']",
        "[class*='message']"
      ].join(",")
    )
  );
  const fallbackTurns = fallbackNodes
    .map((node) => buildTurn(node, roleFromAttrs(node)))
    .filter((v): v is CaptureTurn => Boolean(v));
  if (fallbackTurns.length > 0) {
    return dedupeTurns(fallbackTurns);
  }

  const markerTurns = parseByRoleMarkers((main as HTMLElement).innerText || "");
  if (markerTurns.length > 0) {
    return dedupeTurns(markerTurns);
  }

  const plainText = normalizeMarkdownText((main as HTMLElement).innerText || "");
  if (plainText.length >= 20) {
    return dedupeTurns([
      {
        role: "assistant",
        contentMarkdown: plainText
      }
    ]);
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseChatGptConversationId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/c\/([a-z0-9-]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function collectChatGptConversationApiUrls(_conversationId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const absolute = toAbsoluteUrl(raw) || raw;
    if (!absolute || seen.has(absolute)) {
      return;
    }
    try {
      const parsed = new URL(absolute, location.href);
      const lower = parsed.toString().toLowerCase();
      if (!/\/backend-api\/conversation(s)?\//i.test(lower)) {
        return;
      }
      seen.add(parsed.toString());
      out.push(parsed.toString());
    } catch {
      // ignore invalid urls
    }
  };

  const windowStart = activeCaptureWindowStartMs();
  const tracked = getTrackedNetworkRecords(windowStart);
  for (const item of tracked.slice(-1200)) {
    if (item.method !== "GET" && item.method !== "POST") {
      continue;
    }
    if (!item.ok && item.status > 0) {
      continue;
    }
    add(item.url);
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-1200)) {
      if (windowStart > 0 && entry.startTime + 5 < windowStart) {
        continue;
      }
      const name = String(entry.name || "").trim();
      if (!name) {
        continue;
      }
      add(name);
    }
  } catch {
    // ignore
  }

  const result = out.slice(0, 20);
  if (result.length > 0) {
    console.info("[AI_HISTORY] discovered chatgpt conversation api urls", result.slice(0, 6));
  }
  return result;
}

function extractChatGptResourceAttachments(doc: Document = document): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const postIds = collectLikelyPostIdsFromDocument(doc);
  const conversationIds = collectLikelyConversationIdsFromDocument(doc);
  const windowStart = activeCaptureWindowStartMs();
  const trackAndAdd = (rawUrl: string) => {
    const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
    if (!absolute) {
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(absolute, location.href);
    } catch {
      return;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("chatgpt.com") && !host.includes("oaiusercontent.com")) {
      return;
    }

    const lower = parsed.toString().toLowerCase();
    if (isUiAsset(lower)) {
      return;
    }

    const isAttachmentSignal =
      lower.includes("/backend-api/estuary/content") ||
      lower.includes("/backend-api/files/") ||
      (host.includes("oaiusercontent.com") && isLikelyOaiAttachmentUrl(lower));

    if (!isAttachmentSignal) {
      return;
    }

    addAttachmentCandidate(found, parsed.toString(), null);

    const estuaryFileId = extractEstuaryFileIdFromUrl(parsed.toString());
    if (estuaryFileId) {
      for (const candidate of buildBackendFileUrlCandidates(estuaryFileId, postIds, conversationIds)) {
        addAttachmentCandidate(found, candidate, null);
      }
    }
  };

  const tracked = getTrackedNetworkRecords(windowStart);
  for (const item of tracked.slice(-1400)) {
    if (item.method !== "GET" && item.method !== "POST") {
      continue;
    }
    if (!item.ok && item.status > 0) {
      continue;
    }
    trackAndAdd(item.url);
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-1400)) {
      if (windowStart > 0 && entry.startTime + 5 < windowStart) {
        continue;
      }
      const name = String(entry.name || "").trim();
      if (!name) {
        continue;
      }
      trackAndAdd(name);
    }
  } catch {
    // ignore
  }

  return Array.from(found.values());
}

function attachmentMatchesInlineFileNames(attachment: CaptureAttachment, fileNames: string[]): boolean {
  if (!fileNames.length) {
    return false;
  }
  const attachmentName = attachmentDisplayName(attachment).trim().toLowerCase();
  const attachmentStem = attachmentName.replace(/\.[a-z0-9]{1,10}$/i, "");
  const attachmentMime = (attachment.mime || "").toLowerCase();
  const attachmentExt = extractExtFromFileName(attachment.originalUrl);
  for (const name of fileNames) {
    const normalizedName = name.trim().toLowerCase();
    if (normalizedName && attachmentName && normalizedName === attachmentName) {
      return true;
    }
    const ext = extractExtFromFileName(name);
    if (!ext) {
      continue;
    }
    const nameStem = normalizedName.replace(/\.[a-z0-9]{1,10}$/i, "");
    if (nameStem && attachmentStem && nameStem === attachmentStem) {
      return true;
    }
    if (
      ext === "pdf" &&
      (attachment.kind === "pdf" || attachmentMime.includes("application/pdf") || attachmentExt === "pdf")
    ) {
      return true;
    }
    if (
      isImageExtension(ext) &&
      (attachment.kind === "image" || attachmentMime.startsWith("image/") || isImageExtension(attachmentExt))
    ) {
      return true;
    }
    if (!isImageExtension(ext) && ext !== "pdf" && attachmentExt && attachmentExt === ext && Boolean(attachmentName)) {
      return true;
    }
  }
  return false;
}

function collectTurnInlineFileNameHints(turn: CaptureTurn): string[] {
  const out = new Set<string>();
  for (const name of findLikelyInlineFileNames(turn.contentMarkdown || "")) {
    const normalized = name.trim();
    if (normalized) {
      out.add(normalized);
    }
  }
  for (const attachment of turn.attachments ?? []) {
    if (!isVirtualAttachmentUrl(attachment.originalUrl)) {
      continue;
    }
    const virtualName = attachmentDisplayName(attachment).trim();
    if (virtualName && looksLikeAttachmentFileNameLabel(virtualName)) {
      out.add(virtualName);
    }
  }
  return Array.from(out);
}

function applyChatGptResourceAttachmentFallback(
  turns: CaptureTurn[],
  doc: Document = document
): CaptureTurn[] {
  if (!turns.length) {
    return turns;
  }

  const resourceAttachments = extractChatGptResourceAttachments(doc);
  if (!resourceAttachments.length) {
    return turns;
  }

  const semanticKey = (attachment: CaptureAttachment): string => {
    const raw = attachment.originalUrl.trim();
    if (!raw) {
      return "";
    }
    const fileId =
      extractBackendFileIdFromUrl(raw) ||
      extractEstuaryFileIdFromUrl(raw) ||
      maybeFileIdFromString(raw, { allowUuid: true, sourceKey: "file_id" });
    if (fileId) {
      return `fileid:${fileId.toLowerCase()}`;
    }
    if (isDataUrl(raw)) {
      return `data:${raw.slice(0, 128)}`;
    }
    return `url:${raw}`;
  };

  const existing = new Set<string>();
  const existingSemantic = new Set<string>();
  for (const turn of turns) {
    for (const attachment of turn.attachments ?? []) {
      const raw = attachment.originalUrl.trim();
      if (raw) {
        existing.add(raw);
      }
      const semantic = semanticKey(attachment);
      if (semantic) {
        existingSemantic.add(semantic);
      }
    }
  }

  const pool = resourceAttachments.filter((attachment) => {
    if (attachment.kind === "image") {
      return false;
    }
    const key = attachment.originalUrl.trim();
    if (!key || existing.has(key)) {
      return false;
    }
    const semantic = semanticKey(attachment);
    if (semantic && existingSemantic.has(semantic)) {
      return false;
    }
    return true;
  });
  if (!pool.length) {
    return turns;
  }
  const uniquePool = mergeTurnAttachments([], pool) ?? [];
  if (!uniquePool.length) {
    return turns;
  }

  const preferredTargets = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "user" || turn.role === "assistant")
    .filter(({ turn }) => {
      const hasVirtual = (turn.attachments ?? []).some((attachment) =>
        isVirtualAttachmentUrl(attachment.originalUrl)
      );
      const hasFileNameHint = findLikelyInlineFileNames(turn.contentMarkdown || "").length > 0;
      return hasVirtual || hasFileNameHint;
    })
    .map(({ index }) => index);

  const fallbackTargets = turns
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "user" || turn.role === "assistant")
    .map(({ index }) => index);

  const out = turns.map((turn) => ({
    ...turn,
    attachments: mergeTurnAttachments([], turn.attachments ?? [])
  }));

  let remaining = uniquePool.slice();
  for (const targetIndex of preferredTargets) {
    if (!remaining.length) {
      break;
    }
    const target = out[targetIndex];
    if (!target) {
      continue;
    }
    const names = collectTurnInlineFileNameHints(target);
    if (!names.length) {
      continue;
    }
    const matched = remaining.filter((attachment) => attachmentMatchesInlineFileNames(attachment, names));
    if (!matched.length) {
      continue;
    }
    const consumed = new Set(matched.map((item) => item.originalUrl));
    remaining = remaining.filter((item) => !consumed.has(item.originalUrl));
    target.attachments = mergeTurnAttachments(target.attachments, matched);
  }

  if (remaining.length > 0) {
    const fallbackIndex = preferredTargets[0] ??
      (fallbackTargets.length > 0 ? fallbackTargets[fallbackTargets.length - 1]! : Math.max(0, turns.length - 1));
    const fallbackTarget = out[fallbackIndex];
    if (fallbackTarget) {
      fallbackTarget.attachments = mergeTurnAttachments(fallbackTarget.attachments, remaining);
    }
  }

  console.info("[AI_HISTORY] chatgpt resource attachment fallback merged", {
    added: uniquePool.length,
    remaining: remaining.length,
    sample: uniquePool.slice(0, 6).map((item) => item.originalUrl.slice(0, 220))
  });

  return out;
}

function roleFromApiValue(raw: unknown): CaptureTurn["role"] | null {
  if (typeof raw !== "string") {
    return null;
  }
  const lower = raw.toLowerCase();
  if (lower.includes("assistant") || lower.includes("model") || lower === "ai") {
    return "assistant";
  }
  if (lower.includes("user") || lower.includes("human")) {
    return "user";
  }
  if (lower.includes("system")) {
    return "system";
  }
  if (lower.includes("tool") || lower.includes("function")) {
    return "tool";
  }
  return null;
}

function extractApiMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (isRecord(content)) {
    const parts = content.parts;
    if (Array.isArray(parts)) {
      const joined = parts
        .map((part) => (typeof part === "string" ? part : ""))
        .filter(Boolean)
        .join("\n");
      if (joined.trim()) {
        return joined;
      }
    }
    if (typeof content.text === "string" && content.text.trim()) {
      return content.text;
    }
  }

  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }
  return "";
}

function safeDecodeURIComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeLikelyPostId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /^file[-_]/i.test(trimmed)) {
    return null;
  }
  if (UUID_LIKE_REGEX.test(trimmed)) {
    return trimmed;
  }
  if (/^msg_[a-z0-9_-]{6,}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9][a-z0-9_-]{16,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return trimmed;
  }
  return null;
}

function normalizeLikelyConversationId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (UUID_LIKE_REGEX.test(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9][a-z0-9_-]{20,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return trimmed;
  }
  return null;
}

function isLikelyConversationOnlyUuid(rawId: string, conversationIds: string[] = []): boolean {
  const trimmed = rawId.trim();
  if (!UUID_LIKE_REGEX.test(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (conversationIds.some((id) => id.trim().toLowerCase() === lower)) {
    return true;
  }
  const currentConversationId = parseChatGptConversationId(document.location.href || "");
  if (currentConversationId && currentConversationId.toLowerCase() === lower) {
    return true;
  }

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(
    `(?:/backend-api/conversation(?:s)?/${escaped}(?:[/?#]|$)|(?:conversation[_-]?id|ck_context_scopes_for_conversation_id|context_conversation_id)=${escaped}(?:[&#]|$))`,
    "i"
  );

  const tracked = getTrackedNetworkRecords(0);
  for (const record of tracked.slice(-1000)) {
    if (matcher.test(record.url || "")) {
      return true;
    }
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-1000)) {
      const name = String(entry.name || "");
      if (matcher.test(name)) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  return false;
}

function extractLikelyPostIdsFromString(raw: string): string[] {
  const out = new Set<string>();
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const add = (value: string) => {
    const normalized = normalizeLikelyPostId(safeDecodeURIComponent(value));
    if (normalized) {
      out.add(normalized);
    }
  };

  try {
    const absolute = toAbsoluteUrl(text);
    if (absolute) {
      const parsed = new URL(absolute);
      const postId = parsed.searchParams.get("post_id") || parsed.searchParams.get("postId");
      if (postId) {
        add(postId);
      }
      const messageId = parsed.searchParams.get("message_id") || parsed.searchParams.get("messageId");
      if (messageId) {
        add(messageId);
      }
    }
  } catch {
    // ignore
  }

  for (const match of text.matchAll(/(?:post[_-]?id|message[_-]?id)\s*[:=/"'\s]+([a-z0-9_-]{6,}|[0-9a-f-]{36})/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }
  for (const match of text.matchAll(/\b(msg_[a-z0-9_-]{6,})\b/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  return Array.from(out);
}

function extractLikelyConversationIdsFromString(raw: string): string[] {
  const out = new Set<string>();
  const text = raw.trim();
  if (!text) {
    return [];
  }

  const add = (value: string) => {
    const normalized = normalizeLikelyConversationId(safeDecodeURIComponent(value));
    if (normalized) {
      out.add(normalized);
    }
  };

  const fromPath = parseChatGptConversationId(text);
  if (fromPath) {
    add(fromPath);
  }

  try {
    const absolute = toAbsoluteUrl(text);
    if (absolute) {
      const parsed = new URL(absolute);
      const direct = parsed.searchParams.get("conversation_id") || parsed.searchParams.get("conversationId");
      if (direct) {
        add(direct);
      }
      const scoped =
        parsed.searchParams.get("ck_context_scopes_for_conversation_id") ||
        parsed.searchParams.get("context_conversation_id");
      if (scoped) {
        add(scoped);
      }
    }
  } catch {
    // ignore
  }

  for (const match of text.matchAll(
    /(?:conversation[_-]?id|ck_context_scopes_for_conversation_id)\s*[:=/"'\s]+([a-z0-9_-]{20,}|[0-9a-f-]{36})/gi
  )) {
    if (match[1]) {
      add(match[1]);
    }
  }

  return Array.from(out);
}

let cachedLikelyPostIdsByPage: { page: string; ids: string[]; trackerSize: number } | null = null;
let cachedLikelyConversationIdsByPage: { page: string; ids: string[]; trackerSize: number } | null = null;

function collectLikelyPostIdsFromDocument(doc: Document = document): string[] {
  const page = canonicalizePageUrl(doc.location.href);
  const trackerSize = getTrackedNetworkRecords(0).length;
  if (
    cachedLikelyPostIdsByPage &&
    cachedLikelyPostIdsByPage.page === page &&
    cachedLikelyPostIdsByPage.trackerSize === trackerSize
  ) {
    return cachedLikelyPostIdsByPage.ids;
  }

  const out = new Set<string>();
  const addFromRaw = (raw: string) => {
    for (const id of extractLikelyPostIdsFromString(raw)) {
      out.add(id);
    }
  };

  addFromRaw(doc.location.href);

  const nodes = Array.from(
    doc.querySelectorAll(
      [
        "[data-post-id]",
        "[data-message-id]",
        "[data-id]",
        "[id]",
        "[data-testid*='attachment']",
        "[data-testid*='file']",
        "[data-testid*='upload']"
      ].join(",")
    )
  ).slice(0, 240);

  for (const node of nodes) {
    for (const attr of node.getAttributeNames()) {
      const value = node.getAttribute(attr) || "";
      if (!value) {
        continue;
      }
      if (/post|message|attachment|upload|file|id/i.test(attr)) {
        addFromRaw(value);
      }
    }
    const text = ((node as HTMLElement).innerText || node.textContent || "").trim();
    if (text && /post|message|attachment|upload|file|id|msg_/i.test(text)) {
      addFromRaw(text);
    }
  }

  const scripts = Array.from(doc.querySelectorAll("script")).slice(-120);
  for (const script of scripts) {
    const text = (script.textContent || "").replace(/\\\//g, "/");
    if (!text || !/post_id|postId|message_id|messageId|msg_|backend-api\/files\//i.test(text)) {
      continue;
    }
    addFromRaw(text);
  }

  const tracked = getTrackedNetworkRecords(0);
  for (const record of tracked.slice(-800)) {
    const url = (record.url || "").trim();
    if (!url || !/post_id|postId|message_id|messageId|msg_|backend-api\/files\//i.test(url)) {
      continue;
    }
    addFromRaw(url);
  }

  const ids = Array.from(out).slice(0, 8);
  cachedLikelyPostIdsByPage = { page, ids, trackerSize };
  return ids;
}

function collectLikelyConversationIdsFromDocument(doc: Document = document): string[] {
  const page = canonicalizePageUrl(doc.location.href);
  const trackerSize = getTrackedNetworkRecords(0).length;
  if (
    cachedLikelyConversationIdsByPage &&
    cachedLikelyConversationIdsByPage.page === page &&
    cachedLikelyConversationIdsByPage.trackerSize === trackerSize
  ) {
    return cachedLikelyConversationIdsByPage.ids;
  }

  const out = new Set<string>();
  const addFromRaw = (raw: string) => {
    for (const id of extractLikelyConversationIdsFromString(raw)) {
      out.add(id);
    }
  };

  addFromRaw(doc.location.href);

  const fromCurrentPath = parseChatGptConversationId(doc.location.href);
  if (fromCurrentPath) {
    out.add(fromCurrentPath);
  }

  const nodes = Array.from(
    doc.querySelectorAll(
      [
        "[data-conversation-id]",
        "[data-conversationid]",
        "[data-testid*='conversation']",
        "[data-testid*='attachment']",
        "[data-testid*='file']"
      ].join(",")
    )
  ).slice(0, 220);

  for (const node of nodes) {
    for (const attr of node.getAttributeNames()) {
      const value = node.getAttribute(attr) || "";
      if (!value) {
        continue;
      }
      if (/conversation|context|scope|id/i.test(attr)) {
        addFromRaw(value);
      }
    }
    const text = ((node as HTMLElement).innerText || node.textContent || "").trim();
    if (text && /conversation|context|scope|id|\/c\//i.test(text)) {
      addFromRaw(text);
    }
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-260)) {
      const name = String(entry.name || "").trim();
      if (!name || !/conversation|ck_context_scopes_for_conversation_id|\/c\//i.test(name)) {
        continue;
      }
      addFromRaw(name);
    }
  } catch {
    // ignore
  }

  const tracked = getTrackedNetworkRecords(0);
  for (const record of tracked.slice(-800)) {
    const url = (record.url || "").trim();
    if (!url || !/conversation|ck_context_scopes_for_conversation_id|\/c\//i.test(url)) {
      continue;
    }
    addFromRaw(url);
  }

  const ids = Array.from(out).slice(0, 6);
  cachedLikelyConversationIdsByPage = { page, ids, trackerSize };
  return ids;
}

function sourceKeySuggestsFileIdentity(sourceKey: string): boolean {
  const lower = sourceKey.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return (
    /(^|_)(file|asset|attachment|upload|document|pointer|blob)(_|$)/i.test(lower) ||
    /(file|asset|attachment|upload|document|pointer|blob)[_-]?id$/i.test(lower)
  );
}

function sourceKeySuggestsConversationIdentity(sourceKey: string): boolean {
  const lower = sourceKey.trim().toLowerCase();
  if (!lower) {
    return false;
  }
  return /(conversation|context|scope|thread|session|dialog|chat)/i.test(lower);
}

function hasFileIdSignalInRawText(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    /file-service:\/\//i.test(lower) ||
    /\/backend-api\/files\//i.test(lower) ||
    /\/backend-api\/estuary\/content/i.test(lower) ||
    /(?:^|[?&])(file_id|fileid)=/i.test(lower) ||
    /\b(file|asset|attachment|upload|document|pointer)[_-]?id\b/i.test(lower)
  );
}

function hasConversationIdSignalInRawText(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    /\/backend-api\/conversation(s)?\//i.test(lower) ||
    /(?:^|[?&])(conversation_id|conversationid|context_conversation_id|ck_context_scopes_for_conversation_id)=/i.test(lower) ||
    /\b(conversation|context|scope|thread)[_-]?id\b/i.test(lower)
  );
}

function shouldAllowUuidAsFileId(raw: string, options: ExtractFileIdOptions = {}): boolean {
  if (options.allowUuid !== true) {
    return false;
  }
  const sourceKey = (options.sourceKey || "").trim();
  if (sourceKeySuggestsConversationIdentity(sourceKey)) {
    return false;
  }
  if (sourceKeySuggestsFileIdentity(sourceKey)) {
    return true;
  }
  const hasFileSignal = hasFileIdSignalInRawText(raw);
  const hasConversationSignal = hasConversationIdSignalInRawText(raw);
  if (hasConversationSignal && !hasFileSignal) {
    return false;
  }
  return hasFileSignal;
}

function looksLikeOpaqueFileId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 8 || trimmed.length > 128) {
    return false;
  }
  if (UUID_LIKE_REGEX.test(trimmed)) {
    return false;
  }
  if (/^msg_[a-z0-9_-]{6,}$/i.test(trimmed)) {
    return false;
  }
  if (/^file[-_][a-z0-9-]{6,}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-f0-9]{24,64}$/i.test(trimmed)) {
    return true;
  }
  if (/^[a-z0-9][a-z0-9_-]{12,}$/i.test(trimmed) && !trimmed.includes(".")) {
    return true;
  }
  return false;
}

/**
 * Deeply traverse React fiber tree starting from a file-tile DOM element to
 * extract file IDs, file-service:// URIs, and download URLs that ChatGPT
 * buries inside its component props. Returns found attachment candidates.
 */
function extractFileIdsFromFileTileReactFiber(element: Element): string[] {
  const fileIds = new Set<string>();
  const visited = new Set<object>();
  let objectCount = 0;
  const MAX_OBJECTS = 1800;

  const scanValue = (value: unknown, depth: number, sourceKey = ""): void => {
    if (depth > 12 || objectCount > MAX_OBJECTS) {
      return;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      if (/^https?:\/\//i.test(trimmed)) {
        const lower = trimmed.toLowerCase();
        if (
          isLikelyOaiAttachmentUrl(lower) ||
          looksLikeFileUrl(lower) ||
          /\/backend-api\/(files|estuary\/content)/i.test(lower)
        ) {
          fileIds.add(trimmed);
        }
      }
      for (const extractedId of extractFileIdsFromString(trimmed, { allowUuid: true, sourceKey })) {
        fileIds.add(extractedId);
      }
      // file-service:// URIs directly contain the file ID
      if (/^file-service:\/\//i.test(trimmed)) {
        const id = trimmed.replace(/^file-service:\/\//i, "").split(/[?#]/)[0]?.trim();
        if (id && id.length >= 8) {
          fileIds.add(id);
        }
        return;
      }
      // backend-api URLs
      if (/\/backend-api\/(files|estuary\/content)/i.test(trimmed)) {
        fileIds.add(trimmed);
        return;
      }
      // Opaque file IDs (file-xxx, gizmo-xxx, etc.)
      if (/^file[-_][a-z0-9-]{6,}$/i.test(trimmed) || /^gizmo[-_][a-z0-9-]{6,}$/i.test(trimmed)) {
        fileIds.add(trimmed);
        return;
      }
      // Long hex hashes that look like file IDs
      if (/^[a-f0-9]{24,64}$/i.test(trimmed)) {
        fileIds.add(trimmed);
        return;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        scanValue(item, depth + 1, sourceKey);
      }
      return;
    }
    if (value && typeof value === "object") {
      if (visited.has(value)) {
        return;
      }
      visited.add(value);
      objectCount += 1;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const lower = key.toLowerCase();
        // Descend broadly near the top, then narrow to file/attachment-like branches.
        const shouldDescend =
          depth <= 2 ||
          /(file|asset|attachment|upload|document|pointer|download|content|id|url|href|src|name|mime|blob|metadata)/i.test(lower) ||
          lower === "children" ||
          lower === "props" ||
          lower === "memoizedProps" ||
          lower === "pendingProps" ||
          lower === "stateNode";
        if (shouldDescend) {
          scanValue(record[key], depth + 1, key);
        }
      }
    }
  };

  // Walk up the DOM and into React fiber trees
  let current: Element | null = element;
  let domDepth = 0;
  while (current && domDepth < 14) {
    try {
      const names = ownPropertyNamesSafe(current as unknown as object);
      for (const key of names) {
        if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
          let fiber = (current as unknown as Record<string, unknown>)[key] as Record<string, unknown> | null;
          // Walk up multiple fiber parents to catch deeply nested file props.
          let fiberDepth = 0;
          while (fiber && fiberDepth < 16 && objectCount < MAX_OBJECTS) {
            if (!isRecord(fiber)) {
              break;
            }
            if (!visited.has(fiber)) {
              visited.add(fiber);
              objectCount += 1;
              // Scan memoizedProps and pendingProps
              if (isRecord(fiber.memoizedProps)) {
                scanValue(fiber.memoizedProps, 0);
              }
              if (isRecord(fiber.pendingProps)) {
                scanValue(fiber.pendingProps, 0);
              }
              // Also check stateNode
              if (isRecord(fiber.stateNode) && !visited.has(fiber.stateNode)) {
                scanValue(fiber.stateNode, 2);
              }
            }
            fiber = fiber.return as Record<string, unknown> | null;
            fiberDepth += 1;
          }
        }
        if (key.startsWith("__reactProps$")) {
          const props = (current as unknown as Record<string, unknown>)[key];
          if (isRecord(props)) {
            scanValue(props, 0);
          }
        }
      }
    } catch {
      // ignore
    }
    current = current.parentElement;
    domDepth += 1;
  }

  return Array.from(fileIds);
}

interface ExtractFileIdOptions {
  allowUuid?: boolean;
  sourceKey?: string;
}

function extractFileIdsFromString(raw: string, options: ExtractFileIdOptions = {}): string[] {
  const out = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const allowUuidByContext = shouldAllowUuidAsFileId(trimmed, options);

  const add = (value: string) => {
    const decoded = safeDecodeURIComponent(value.trim());
    if (!decoded) {
      return;
    }
    const isOpaqueId = looksLikeOpaqueFileId(decoded);
    const isUuid = UUID_LIKE_REGEX.test(decoded);
    if (!isOpaqueId && !(allowUuidByContext && isUuid)) {
      return;
    }
    if (isUuid && !isOpaqueId && isLikelyConversationOnlyUuid(decoded)) {
      return;
    }
    out.add(decoded);
  };

  const filePrefixMatches = trimmed.match(/\bfile[-_][a-z0-9-]{6,}\b/gi) || [];
  for (const match of filePrefixMatches) {
    add(match);
  }

  for (const match of trimmed.matchAll(/file-service:\/\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/\/backend-api\/files\/download\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/\/backend-api\/files\/([^/?#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  for (const match of trimmed.matchAll(/[?&](?:id|file_id|fileId)=([^&#"'&\s]+)/gi)) {
    if (match[1]) {
      add(match[1]);
    }
  }

  if (allowUuidByContext) {
    for (const match of trimmed.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)) {
      if (match[0]) {
        add(match[0]);
      }
    }
  }

  if (looksLikeOpaqueFileId(trimmed) || (allowUuidByContext && UUID_LIKE_REGEX.test(trimmed))) {
    add(trimmed);
  }

  return Array.from(out);
}

function maybeFileIdFromString(raw: string, options: ExtractFileIdOptions = {}): string | null {
  return extractFileIdsFromString(raw, options)[0] ?? null;
}

function buildBackendFileUrlCandidates(
  fileId: string,
  postIds: string[] = [],
  conversationIds: string[] = []
): string[] {
  const normalized = fileId.trim();
  if (!normalized) {
    return [];
  }
  const normalizedPostIds = postIds
    .map((raw) => normalizeLikelyPostId(raw))
    .filter((item): item is string => Boolean(item))
    .slice(0, 6);
  const normalizedConversationIds = conversationIds
    .map((raw) => normalizeLikelyConversationId(raw))
    .filter((item): item is string => Boolean(item))
    .slice(0, 6);
  if (isLikelyConversationOnlyUuid(normalized, normalizedConversationIds)) {
    return [];
  }
  const encoded = encodeURIComponent(normalized);
  const rawCandidates = [
    `/backend-api/estuary/content?id=${encoded}`,
    `/backend-api/estuary/content?id=${encoded}&v=0`,
    `/backend-api/estuary/content?id=${encoded}&v=1`,
    `/backend-api/files/download/${encoded}`,
    `/backend-api/files/${encoded}/download`,
    `/backend-api/files/${encoded}`,
    `/backend-api/files/${encoded}/content`
  ];
  for (const postId of normalizedPostIds) {
    const encodedPostId = encodeURIComponent(postId);
    rawCandidates.push(`/backend-api/files/download/${encoded}?post_id=${encodedPostId}`);
    rawCandidates.push(
      `/backend-api/estuary/content?id=${encoded}&post_id=${encodedPostId}`,
      `/backend-api/estuary/content?id=${encoded}&post_id=${encodedPostId}&v=0`
    );
  }
  for (const conversationId of normalizedConversationIds) {
    const encodedConversationId = encodeURIComponent(conversationId);
    rawCandidates.push(
      `/backend-api/files/download/${encoded}?conversation_id=${encodedConversationId}`,
      `/backend-api/files/download/${encoded}?ck_context_scopes_for_conversation_id=${encodedConversationId}`,
      `/backend-api/files/${encoded}/download?conversation_id=${encodedConversationId}`,
      `/backend-api/files/${encoded}/download?ck_context_scopes_for_conversation_id=${encodedConversationId}`,
      `/backend-api/files/${encoded}?conversation_id=${encodedConversationId}`,
      `/backend-api/files/${encoded}?ck_context_scopes_for_conversation_id=${encodedConversationId}`,
      `/backend-api/estuary/content?id=${encoded}&conversation_id=${encodedConversationId}`,
      `/backend-api/estuary/content?id=${encoded}&ck_context_scopes_for_conversation_id=${encodedConversationId}`,
      `/backend-api/estuary/content?id=${encoded}&conversation_id=${encodedConversationId}&v=0`,
      `/backend-api/estuary/content?id=${encoded}&ck_context_scopes_for_conversation_id=${encodedConversationId}&v=0`
    );
  }
  for (const postId of normalizedPostIds) {
    for (const conversationId of normalizedConversationIds.slice(0, 3)) {
      const encodedPostId = encodeURIComponent(postId);
      const encodedConversationId = encodeURIComponent(conversationId);
      rawCandidates.push(
        `/backend-api/files/download/${encoded}?post_id=${encodedPostId}&conversation_id=${encodedConversationId}`,
        `/backend-api/files/download/${encoded}?post_id=${encodedPostId}&ck_context_scopes_for_conversation_id=${encodedConversationId}`,
        `/backend-api/files/${encoded}/download?post_id=${encodedPostId}&conversation_id=${encodedConversationId}`,
        `/backend-api/files/${encoded}/download?post_id=${encodedPostId}&ck_context_scopes_for_conversation_id=${encodedConversationId}`,
        `/backend-api/files/${encoded}?post_id=${encodedPostId}&conversation_id=${encodedConversationId}`,
        `/backend-api/files/${encoded}?post_id=${encodedPostId}&ck_context_scopes_for_conversation_id=${encodedConversationId}`,
        `/backend-api/estuary/content?id=${encoded}&post_id=${encodedPostId}&conversation_id=${encodedConversationId}&v=0`,
        `/backend-api/estuary/content?id=${encoded}&post_id=${encodedPostId}&ck_context_scopes_for_conversation_id=${encodedConversationId}&v=0`
      );
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of rawCandidates) {
    const absolute = toAbsoluteUrl(candidate);
    if (!absolute || seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

function isLikelyAttachmentUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("blob:") ||
    lower.startsWith("data:") ||
    lower.startsWith("/backend-api/files/") ||
    lower.includes("/backend-api/files/") ||
    lower.startsWith("/backend-api/estuary/content") ||
    lower.includes("/backend-api/estuary/content")
  );
}

function addAttachmentCandidate(
  found: Map<string, CaptureAttachment>,
  rawUrl: string,
  mimeHint: string | null,
  labelHint = ""
): void {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  if (!absolute || isNavigationUrl(absolute)) {
    return;
  }
  const lowerAbsolute = absolute.toLowerCase();
  if (lowerAbsolute.includes("/backend-api/estuary/content")) {
    const estuaryId = extractEstuaryFileIdFromUrl(absolute);
    if (!estuaryId) {
      return;
    }
  }
  if (lowerAbsolute.includes("/backend-api/files/")) {
    const backendId = extractBackendFileIdFromUrl(absolute);
    if (!backendId) {
      return;
    }
  }
  const kindFromMime = inferKindFromMimeHint(mimeHint);
  const kind = kindFromMime || inferAttachmentKind(absolute, labelHint);
  const isBackendFile =
    lowerAbsolute.includes("/backend-api/files/") ||
    lowerAbsolute.includes("/backend-api/estuary/content");
  if (isBackendFile && /\/simple(?:[/?]|$)/i.test(absolute)) {
    return;
  }
  if (
    kind === "file" &&
    !looksLikeFileUrl(absolute) &&
    !absolute.startsWith("blob:") &&
    !absolute.startsWith("data:") &&
    !isBackendFile &&
    !isLikelyOaiAttachmentUrl(lowerAbsolute)
  ) {
    return;
  }
  const nextMime = mimeHint || inferAttachmentMime(kind, absolute);
  if (found.has(absolute)) {
    const previous = found.get(absolute)!;
    const previousScore = attachmentKindScore(previous.kind);
    const nextScore = attachmentKindScore(kind);
    if (nextScore > previousScore) {
      found.set(absolute, {
        ...previous,
        kind,
        mime: previous.mime || nextMime
      });
      return;
    }
    if (!previous.mime && nextMime) {
      found.set(absolute, {
        ...previous,
        mime: nextMime
      });
    }
    return;
  }
  found.set(absolute, {
    kind,
    originalUrl: absolute,
    mime: nextMime,
    status: "remote_only"
  });
}

function extractAttachmentsFromApiMessage(
  message: Record<string, unknown>,
  maxVisitedObjects = 2200
): CaptureAttachment[] {
  const found = new Map<string, CaptureAttachment>();
  const stack: unknown[] = [message];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push(item);
      }
      continue;
    }
    if (!isRecord(node)) {
      continue;
    }
    if (visited.has(node)) {
      continue;
    }
    visited.add(node);
    if (visited.size > maxVisitedObjects) {
      break;
    }
    const nodeKeys = Object.keys(node).join(" ").toLowerCase();
    const nodeLooksLikeAttachmentRecord = /(file|asset|attachment|upload|document|mime|filename|download|pointer|blob|content_type|contenttype)/i.test(
      nodeKeys
    );

    let localMime: string | null = null;
    let localName: string = "";
    const localFileIds = new Set<string>();
    const localPostIds = new Set<string>();
    const localConversationIds = new Set<string>();
    const localUrls = new Set<string>();

    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          continue;
        }

        if (/mime|content[_-]?type/i.test(key) && /^[a-z0-9.+-]+\/[a-z0-9.+-]+/i.test(trimmed)) {
          localMime = trimmed.split(";")[0]?.trim().toLowerCase() ?? null;
        }

        if (/(^|_)(name|filename|title)$/i.test(key) || key === "name") {
          localName = trimmed;
        }

        if (/post[_-]?id|message[_-]?id|node[_-]?id|turn[_-]?id|id/i.test(key)) {
          for (const postId of extractLikelyPostIdsFromString(trimmed)) {
            localPostIds.add(postId);
          }
        }
        if (/conversation|context|scope/i.test(key)) {
          for (const conversationId of extractLikelyConversationIdsFromString(trimmed)) {
            localConversationIds.add(conversationId);
          }
        }

        if (isLikelyAttachmentUrl(trimmed)) {
          localUrls.add(trimmed);
        }

        const keySuggestsFile =
          /(^|_)(file|asset|attachment|upload|document|pointer|blob)(_|$)/i.test(key) ||
          /(file|asset|attachment|upload|document)[_-]?id$/i.test(key);
        const allowUuid = keySuggestsFile || (nodeLooksLikeAttachmentRecord && /(^id$|[_-]id$)/i.test(key));
        const ids = extractFileIdsFromString(trimmed, { allowUuid, sourceKey: key });
        if (ids.length > 0 && (keySuggestsFile || allowUuid || looksLikeOpaqueFileId(trimmed) || /file-service:\/\//i.test(trimmed))) {
          for (const id of ids) {
            localFileIds.add(id);
          }
        } else {
          const inlineId = maybeFileIdFromString(trimmed, { allowUuid, sourceKey: key });
          if (inlineId) {
            localFileIds.add(inlineId);
          }
        }
      } else {
        stack.push(value);
      }
    }

    for (const url of localUrls) {
      addAttachmentCandidate(found, url, localMime, localName);
    }

    for (const fileId of localFileIds) {
      for (const candidate of buildBackendFileUrlCandidates(
        fileId,
        Array.from(localPostIds),
        Array.from(localConversationIds)
      )) {
        addAttachmentCandidate(found, candidate, localMime, localName);
      }
    }
  }

  return Array.from(found.values());
}

function pushIfRecordUnique(
  value: unknown,
  out: Record<string, unknown>[],
  seen: Set<object>
): void {
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);
  out.push(value);
}

function ownPropertyNamesSafe(value: object): string[] {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    return [];
  }
}

function collectReactPayloadObjects(root: ParentNode): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<object>();

  const nodes: Element[] = [];
  if (root instanceof Element) {
    nodes.push(root);
  }
  const selectorNodes = Array.from(
    root.querySelectorAll(
      [
        "[data-testid*='file']",
        "[data-testid*='attachment']",
        "[data-testid*='upload']",
        "[class*='attachment']",
        "[class*='file']",
        "[aria-label*='attachment']",
        "[aria-label*='file']",
        "a",
        "button"
      ].join(",")
    )
  ).slice(0, 180);
  nodes.push(...selectorNodes);

  for (const node of nodes) {
    let current: Element | null = node;
    let depth = 0;
    while (current && depth < 8) {
      const names = ownPropertyNamesSafe(current as unknown as object);
      for (const key of names) {
        if (key.startsWith("__reactProps$")) {
          const value = (current as unknown as Record<string, unknown>)[key];
          pushIfRecordUnique(value, out, seen);
          continue;
        }
        if (key.startsWith("__reactFiber$")) {
          const fiber = (current as unknown as Record<string, unknown>)[key];
          if (!isRecord(fiber)) {
            continue;
          }
          pushIfRecordUnique(fiber.memoizedProps, out, seen);
          pushIfRecordUnique(fiber.pendingProps, out, seen);
          if (isRecord(fiber.return)) {
            pushIfRecordUnique(fiber.return.memoizedProps, out, seen);
            pushIfRecordUnique(fiber.return.pendingProps, out, seen);
          }
          if (isRecord(fiber.alternate)) {
            pushIfRecordUnique(fiber.alternate.memoizedProps, out, seen);
            pushIfRecordUnique(fiber.alternate.pendingProps, out, seen);
          }
        }
      }
      current = current.parentElement;
      depth += 1;
    }
  }

  return out;
}

function mergeTurnAttachments(
  existing: CaptureAttachment[] | null | undefined,
  incoming: CaptureAttachment[] | null | undefined
): CaptureAttachment[] | null {
  const all = [...(existing ?? []), ...(incoming ?? [])];
  if (!all.length) {
    return null;
  }
  const deduped = new Map<string, CaptureAttachment>();
  const semanticKey = (attachment: CaptureAttachment): string => {
    const raw = attachment.originalUrl.trim();
    if (!raw) {
      return "";
    }
    const backendFileId = extractBackendFileIdFromUrl(raw) || extractEstuaryFileIdFromUrl(raw);
    if (backendFileId) {
      return `fileid:${backendFileId.toLowerCase()}`;
    }
    if (isDataUrl(raw)) {
      return `data:${raw.slice(0, 128)}`;
    }
    return `url:${raw}`;
  };
  for (const item of all) {
    const urlKey = item.originalUrl.trim();
    if (!urlKey) {
      continue;
    }
    const normalizedSemantic = semanticKey(item);
    const key = normalizedSemantic || `url:${urlKey}`;
    if (deduped.has(key)) {
      const previous = deduped.get(key)!;
      const previousKindScore = attachmentKindScore(previous.kind);
      const currentKindScore = attachmentKindScore(item.kind);
      if (currentKindScore > previousKindScore) {
        deduped.set(key, {
          ...item,
          mime: item.mime || previous.mime
        });
        continue;
      }
      if (!previous.mime && item.mime) {
        deduped.set(key, { ...previous, mime: item.mime });
      }
      continue;
    }
    deduped.set(key, item);
  }
  return deduped.size > 0 ? Array.from(deduped.values()) : null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件内容失败"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("文件读取结果不是字符串"));
    };
    reader.readAsDataURL(blob);
  });
}

function shouldInlineProtectedAttachment(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.startsWith("blob:") ||
    lower.includes("/backend-api/files/") ||
    lower.includes("/backend-api/estuary/content") ||
    lower.includes("googleusercontent.com/gg/") ||
    isLikelyOaiAttachmentUrl(lower) ||
    lower.includes("/prompts/")
  );
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

interface BackgroundAttachmentFetchResponse {
  ok?: boolean;
  dataUrl?: string;
  error?: string;
  status?: number;
  tried?: string[];
}

interface BackgroundAttachmentProbeResponse {
  ok?: boolean;
  url?: string;
  method?: string;
  status?: number;
  contentType?: string;
  contentLength?: number;
  error?: string;
}

interface BackgroundAttachmentHintLookupResponse {
  ok?: boolean;
  urls?: string[];
}

async function fetchDataUrlViaBackground(url: string): Promise<BackgroundAttachmentFetchResponse | null> {
  if (!isHttpUrl(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: "AI_HISTORY_FETCH_ATTACHMENT",
      url
    })) as BackgroundAttachmentFetchResponse;
    if (result?.ok && typeof result.dataUrl === "string" && result.dataUrl.startsWith("data:")) {
      return result;
    }
    if (
      url.toLowerCase().includes("/backend-api/files/") ||
      url.toLowerCase().includes("/backend-api/estuary/content")
    ) {
      console.info("[AI_HISTORY] background attachment fetch failed", {
        url: url.slice(0, 220),
        status: result?.status ?? 0,
        error: result?.error ?? "",
        tried: (result?.tried ?? []).slice(0, 6)
      });
    }
    return result ?? null;
  } catch {
    return null;
  }
}

async function probeAttachmentUrlViaBackground(url: string): Promise<BackgroundAttachmentProbeResponse | null> {
  if (!isHttpUrl(url) || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return null;
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      type: "AI_HISTORY_PROBE_ATTACHMENT",
      url
    })) as BackgroundAttachmentProbeResponse;
    return result ?? null;
  } catch (error) {
    return {
      ok: false,
      url,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function lookupTrackedAttachmentHintUrlsViaBackground(fileId: string): Promise<string[]> {
  const normalized = fileId.trim();
  if (!normalized || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return [];
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      type: "AI_HISTORY_LOOKUP_ATTACHMENT_HINTS",
      fileId: normalized
    })) as BackgroundAttachmentHintLookupResponse;
    if (!result?.ok || !Array.isArray(result.urls)) {
      return [];
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of result.urls) {
      const absolute = toAbsoluteUrl(String(item || "")) || String(item || "");
      if (!absolute || seen.has(absolute)) {
        continue;
      }
      seen.add(absolute);
      out.push(absolute);
      if (out.length >= 24) {
        break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function extractBackendFileIdFromUrl(rawUrl: string): string | null {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  const downloadMatch = absolute.match(/\/backend-api\/files\/download\/([^/?#]+)/i);
  if (downloadMatch?.[1]) {
    return safeDecodeURIComponent(downloadMatch[1]);
  }
  const directMatch = absolute.match(/\/backend-api\/files\/([^/?#]+)/i);
  if (directMatch?.[1]) {
    const candidate = safeDecodeURIComponent(directMatch[1]);
    if (candidate.toLowerCase() === "download") {
      return null;
    }
    return candidate;
  }
  return null;
}

function extractEstuaryFileIdFromUrl(rawUrl: string): string | null {
  const absolute = toAbsoluteUrl(rawUrl) || rawUrl;
  try {
    const parsed = new URL(absolute, location.href);
    if (!/\/backend-api\/estuary\/content/i.test(parsed.pathname)) {
      return null;
    }
    const candidates = [
      parsed.searchParams.get("id") || "",
      parsed.searchParams.get("file_id") || "",
      parsed.searchParams.get("fileId") || ""
    ].filter(Boolean);

    for (const candidate of candidates) {
      const normalized = maybeFileIdFromString(candidate, { allowUuid: true, sourceKey: "file_id" });
      if (normalized) {
        return normalized;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function collectTrackedAttachmentUrlsForFileId(fileId: string): string[] {
  const normalized = maybeFileIdFromString(fileId, { allowUuid: true, sourceKey: "file_id" });
  if (!normalized) {
    return [];
  }
  const expected = normalized.trim().toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const absolute = toAbsoluteUrl(raw) || raw;
    if (!absolute) {
      return;
    }
    let parsed: URL;
    try {
      parsed = new URL(absolute, location.href);
    } catch {
      return;
    }
    const lower = parsed.toString().toLowerCase();
    const attachmentLike =
      lower.includes("/backend-api/files/") ||
      lower.includes("/backend-api/estuary/content") ||
      (parsed.hostname.toLowerCase().includes("oaiusercontent.com") && isLikelyOaiAttachmentUrl(lower));
    if (!attachmentLike) {
      return;
    }
    const candidateId =
      extractBackendFileIdFromUrl(parsed.toString()) ||
      extractEstuaryFileIdFromUrl(parsed.toString()) ||
      maybeFileIdFromString(parsed.toString(), { allowUuid: true, sourceKey: "file_id" });
    if (!candidateId || candidateId.trim().toLowerCase() !== expected) {
      return;
    }
    const key = parsed.toString();
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(key);
  };

  const windowStart = activeCaptureWindowStartMs();
  const tracked = getTrackedNetworkRecords(windowStart);
  for (const item of tracked.slice(-1400)) {
    if (item.method !== "GET" && item.method !== "POST") {
      continue;
    }
    if (!item.ok && item.status > 0) {
      continue;
    }
    add(item.url);
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    for (const entry of resources.slice(-1400)) {
      if (windowStart > 0 && entry.startTime + 5 < windowStart) {
        continue;
      }
      const name = String(entry.name || "").trim();
      if (!name) {
        continue;
      }
      add(name);
    }
  } catch {
    // ignore
  }

  return out.slice(0, 14);
}

function buildInlineFetchCandidates(rawUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string) => {
    const absolute = toAbsoluteUrl(candidate) || candidate;
    if (!absolute || seen.has(absolute)) {
      return;
    }
    seen.add(absolute);
    out.push(absolute);
  };

  add(rawUrl);
  const postIds = collectLikelyPostIdsFromDocument(document);
  const conversationIds = collectLikelyConversationIdsFromDocument(document);

  const backendFileId = extractBackendFileIdFromUrl(rawUrl);
  if (backendFileId) {
    for (const trackedUrl of collectTrackedAttachmentUrlsForFileId(backendFileId)) {
      add(trackedUrl);
    }
    const encoded = encodeURIComponent(backendFileId);
    const base = toAbsoluteUrl(`/backend-api/files/${encoded}`) || rawUrl;
    add(base);
    add(`${base}/download`);
    // Also try estuary endpoint with this file ID
    const estuaryUrl = toAbsoluteUrl(`/backend-api/estuary/content?id=${encoded}`);
    if (estuaryUrl) {
      add(estuaryUrl);
    }
    const estuaryUrlV0 = toAbsoluteUrl(`/backend-api/estuary/content?id=${encoded}&v=0`);
    if (estuaryUrlV0) {
      add(estuaryUrlV0);
    }
    // Try full set of backend URL candidates
    for (const candidate of buildBackendFileUrlCandidates(backendFileId, postIds, conversationIds)) {
      add(candidate);
    }
  }

  const estuaryFileId = extractEstuaryFileIdFromUrl(rawUrl);
  if (estuaryFileId) {
    for (const trackedUrl of collectTrackedAttachmentUrlsForFileId(estuaryFileId)) {
      add(trackedUrl);
    }
    for (const candidate of buildBackendFileUrlCandidates(estuaryFileId, postIds, conversationIds)) {
      add(candidate);
    }

    const fallbackEstuary = toAbsoluteUrl(`/backend-api/estuary/content?id=${encodeURIComponent(estuaryFileId)}`);
    if (fallbackEstuary) {
      add(fallbackEstuary);
    }
    const fallbackEstuaryV0 = toAbsoluteUrl(
      `/backend-api/estuary/content?id=${encodeURIComponent(estuaryFileId)}&v=0`
    );
    if (fallbackEstuaryV0) {
      add(fallbackEstuaryV0);
    }
  }

  return out;
}

async function maybeInlineProtectedAttachment(
  attachment: CaptureAttachment,
  forceAttempt = false
): Promise<CaptureAttachment> {
  const targetUrl = attachment.originalUrl.trim();
  if (!targetUrl || (!forceAttempt && !shouldInlineProtectedAttachment(targetUrl))) {
    return attachment;
  }

  const seedCandidates = buildInlineFetchCandidates(targetUrl).slice(0, 40);
  const fileIds = new Set<string>();
  const backendFileId = extractBackendFileIdFromUrl(targetUrl);
  if (backendFileId) {
    fileIds.add(backendFileId);
  }
  const estuaryFileId = extractEstuaryFileIdFromUrl(targetUrl);
  if (estuaryFileId) {
    fileIds.add(estuaryFileId);
  }
  const inlineFileId = maybeFileIdFromString(targetUrl, { allowUuid: true, sourceKey: "file_id" });
  if (inlineFileId) {
    fileIds.add(inlineFileId);
  }

  const hintedCandidates: string[] = [];
  for (const fileId of fileIds) {
    const fromBackground = await lookupTrackedAttachmentHintUrlsViaBackground(fileId);
    for (const url of fromBackground) {
      hintedCandidates.push(url);
    }
  }
  if (hintedCandidates.length > 0) {
    console.info("[AI_HISTORY] background tracked attachment hints", {
      targetUrl: targetUrl.slice(0, 180),
      fileIds: Array.from(fileIds).slice(0, 3),
      hinted: hintedCandidates.slice(0, 6)
    });
  }

  const candidates: string[] = [];
  const seenCandidates = new Set<string>();
  for (const item of [...hintedCandidates, ...seedCandidates]) {
    const absolute = toAbsoluteUrl(item) || item;
    if (!absolute || seenCandidates.has(absolute)) {
      continue;
    }
    seenCandidates.add(absolute);
    candidates.push(absolute);
    if (candidates.length >= 36) {
      break;
    }
  }
  for (const candidate of candidates) {
    try {
      const backgroundResult = await fetchDataUrlViaBackground(candidate);
      const backgroundDataUrl =
        backgroundResult?.ok && typeof backgroundResult.dataUrl === "string" ? backgroundResult.dataUrl : null;
      if (backgroundDataUrl) {
        const inferredKind = inferAttachmentKind(backgroundDataUrl, "");
        const kind =
          attachmentKindScore(inferredKind) >= attachmentKindScore(attachment.kind) ? inferredKind : attachment.kind;
        const inferredMime = inferAttachmentMime(inferredKind, backgroundDataUrl) || inferAttachmentMime(kind, backgroundDataUrl);
        console.info("[AI_HISTORY] inlined attachment from background fetch", {
          candidate,
          kind
        });
        return {
          ...attachment,
          kind,
          originalUrl: backgroundDataUrl,
          mime: attachment.mime || inferredMime,
          status: "remote_only"
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000);
      let response: Response;
      try {
        response = await fetch(candidate, {
          credentials: "include",
          redirect: "follow",
          signal: controller.signal,
          headers: {
            Accept: "*/*"
          }
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (
        contentType.includes("application/json") ||
        contentType.startsWith("text/html")
      ) {
        continue;
      }

      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader) {
        const parsed = Number(contentLengthHeader);
        if (Number.isFinite(parsed) && parsed > MAX_INLINE_ATTACHMENT_BYTES) {
          continue;
        }
      }

      const blob = await response.blob();
      if (!blob.size || blob.size > MAX_INLINE_ATTACHMENT_BYTES) {
        continue;
      }

      const dataUrl = await blobToDataUrl(blob);
      if (!dataUrl.startsWith("data:")) {
        continue;
      }

      const inferredKind = inferAttachmentKind(dataUrl, "");
      const kind =
        attachmentKindScore(inferredKind) >= attachmentKindScore(attachment.kind) ? inferredKind : attachment.kind;
      const mime =
        (blob.type ||
          attachment.mime ||
          inferAttachmentMime(inferredKind, dataUrl) ||
          inferAttachmentMime(kind, dataUrl) ||
          null) as string | null;
      console.info("[AI_HISTORY] inlined attachment from page fetch", {
        candidate,
        kind
      });
      return {
        ...attachment,
        kind,
        originalUrl: dataUrl,
        mime,
        status: "remote_only"
      };
    } catch {
      // try next candidate
    }
  }

  if (
    targetUrl.toLowerCase().includes("/backend-api/files/") ||
    targetUrl.toLowerCase().includes("/backend-api/estuary/content") ||
    forceAttempt
  ) {
    console.info("[AI_HISTORY] failed to inline protected attachment", targetUrl, candidates);
  }

  return attachment;
}

async function extractConversationApiPayload(conversationId: string): Promise<Record<string, unknown> | null> {
  const discoveredUrls = collectChatGptConversationApiUrls(conversationId);
  const requestUrls = [...discoveredUrls, `/backend-api/conversation/${encodeURIComponent(conversationId)}`];
  if (discoveredUrls.length === 0) {
    requestUrls.push(`/backend-api/conversation/${encodeURIComponent(conversationId)}?tree=true`);
  }
  const uniqueRequestUrls = Array.from(new Set(requestUrls.map((item) => toAbsoluteUrl(item) || item)));
  const attempts: Array<{ url: string; status: number; ok: boolean; error?: string }> = [];

  for (const requestUrl of uniqueRequestUrls) {
    try {
      const response = await fetch(requestUrl, {
        credentials: "include"
      });
      attempts.push({
        url: requestUrl,
        status: response.status,
        ok: response.ok
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as unknown;
      if (isRecord(payload)) {
        return payload;
      }
      attempts.push({
        url: requestUrl,
        status: response.status,
        ok: false,
        error: "payload-not-object"
      });
    } catch {
      attempts.push({
        url: requestUrl,
        status: 0,
        ok: false,
        error: "fetch-error"
      });
    }
  }

  if (attempts.length > 0) {
    console.info("[AI_HISTORY] chatgpt conversation api unavailable", attempts);
  }

  return null;
}

function extractConversationMapping(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(payload.mapping)) {
    return payload.mapping;
  }
  const conversation = payload.conversation;
  if (isRecord(conversation) && isRecord(conversation.mapping)) {
    return conversation.mapping;
  }
  const data = payload.data;
  if (isRecord(data) && isRecord(data.mapping)) {
    return data.mapping;
  }
  if (isRecord(data) && isRecord(data.conversation) && isRecord(data.conversation.mapping)) {
    return data.conversation.mapping;
  }
  return null;
}

interface ChatGptApiTurn {
  role: CaptureTurn["role"];
  attachments: CaptureAttachment[];
}

async function fetchChatGptApiTurns(doc: Document): Promise<ChatGptApiTurn[]> {
  const conversationIds = new Set<string>();
  const fromUrl = parseChatGptConversationId(doc.location.href);
  if (fromUrl) {
    conversationIds.add(fromUrl);
  }
  for (const id of collectLikelyConversationIdsFromDocument(doc)) {
    if (id) {
      conversationIds.add(id);
    }
  }
  if (conversationIds.size === 0) {
    return [];
  }

  try {
    let payload: Record<string, unknown> | null = null;
    for (const conversationId of Array.from(conversationIds).slice(0, 8)) {
      payload = await extractConversationApiPayload(conversationId);
      if (payload) {
        break;
      }
    }
    if (!payload) {
      return [];
    }

    const mapping = extractConversationMapping(payload);
    if (!mapping) {
      return [];
    }

    const items: Array<{ turn: ChatGptApiTurn; createdAt: number }> = [];
    for (const node of Object.values(mapping)) {
      if (!isRecord(node) || !isRecord(node.message)) {
        continue;
      }
      const message = node.message;
      const author = isRecord(message.author) ? message.author : null;
      const role = roleFromApiValue(author?.role ?? message.role);
      if (!role) {
        continue;
      }

      const attachments = extractAttachmentsFromApiMessage(message);
      if (!attachments.length) {
        continue;
      }

      const createdRaw = message.create_time;
      const createdAt =
        typeof createdRaw === "number"
          ? createdRaw
          : typeof createdRaw === "string"
            ? Number(createdRaw) || 0
            : 0;
      items.push({
        turn: {
          role,
          attachments
        },
        createdAt
      });
    }

    items.sort((a, b) => a.createdAt - b.createdAt);
    return items.map((item) => item.turn);
  } catch (error) {
    console.warn("[AI_HISTORY] failed to enrich chatgpt attachments from conversation api", error);
    return [];
  }
}

function attachmentDisplayName(attachment: CaptureAttachment): string {
  const virtualName = decodeVirtualAttachmentName(attachment.originalUrl);
  if (virtualName) {
    return virtualName;
  }

  const raw = attachment.originalUrl.trim();
  if (!raw) {
    return "未命名附件";
  }
  if (isDataUrl(raw)) {
    const explicitName = parseDataUrlName(raw);
    if (explicitName) {
      return explicitName;
    }
    return attachment.kind === "pdf" ? "PDF 文件" : attachment.kind === "image" ? "图片文件" : "文件";
  }
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname || "";
    const segment = pathname.split("/").filter(Boolean).pop() || "";
    if (segment && !/^(content|download)$/i.test(segment)) {
      return safeDecodeURIComponent(segment);
    }
    const estuaryId =
      parsed.searchParams.get("id") || parsed.searchParams.get("file_id") || parsed.searchParams.get("fileId") || "";
    if (estuaryId) {
      const base = safeDecodeURIComponent(estuaryId).trim();
      if (base) {
        const mime = (attachment.mime || "").toLowerCase();
        let ext = "";
        if (attachment.kind === "pdf" || mime.includes("application/pdf")) {
          ext = ".pdf";
        } else if (attachment.kind === "image" || mime.startsWith("image/")) {
          ext = ".jpg";
        }
        return `${base}${ext}`;
      }
    }
    if (segment) {
      return safeDecodeURIComponent(segment);
    }
  } catch {
    // ignored
  }

  return raw.slice(0, 64);
}

function detectUnresolvedUserUploadFromText(turn: CaptureTurn, attachments: CaptureAttachment[]): string[] {
  if (turn.role !== "user") {
    return [];
  }

  const names = findLikelyInlineFileNames(turn.contentMarkdown || "");
  if (!names.length) {
    return [];
  }

  const known = new Set(
    attachments
      .map((attachment) => attachmentDisplayName(attachment).trim().toLowerCase())
      .filter(Boolean)
  );
  const hasAnyDownloadableAttachment = attachments.some((attachment) => {
    const url = attachment.originalUrl.trim();
    if (!url || isVirtualAttachmentUrl(url)) {
      return false;
    }
    return isDataUrl(url) || looksLikeFileUrl(url) || looksLikePdfUrl(url) || looksLikeImageUrl(url);
  });
  if (names.length === 1 && hasAnyDownloadableAttachment) {
    return [];
  }
  const unresolved: string[] = [];
  const downloadableCount = attachments.filter((attachment) => {
    const url = attachment.originalUrl.trim();
    if (!url || isVirtualAttachmentUrl(url)) {
      return false;
    }
    if (isDataUrl(url)) {
      return true;
    }
    if (looksLikeFileUrl(url) || looksLikePdfUrl(url) || looksLikeImageUrl(url)) {
      return true;
    }
    return false;
  }).length;

  for (const name of names) {
    const lowered = name.trim().toLowerCase();
    if (known.has(lowered)) {
      continue;
    }
    const ext = extractExtFromFileName(name);
    if (!ext) {
      continue;
    }
    unresolved.push(name);
  }

  if (unresolved.length > 0 && downloadableCount >= unresolved.length) {
    return [];
  }

  return unresolved;
}

function stripVirtualPlaceholdersWhenRealAttachmentExists(
  attachments: CaptureAttachment[]
): CaptureAttachment[] {
  if (attachments.length < 2) {
    return attachments;
  }

  const real = attachments.filter((attachment) => !isVirtualAttachmentUrl(attachment.originalUrl));
  if (!real.length) {
    return attachments;
  }

  const realNames = new Set(
    real
      .map((attachment) => attachmentDisplayName(attachment).trim().toLowerCase())
      .filter(Boolean)
  );
  const realNameStems = new Set(
    Array.from(realNames).map((name) => name.replace(/\.[a-z0-9]{1,10}$/i, ""))
  );

  const stripped = attachments.filter((attachment) => {
    if (!isVirtualAttachmentUrl(attachment.originalUrl)) {
      return true;
    }
    const virtualName = attachmentDisplayName(attachment).trim().toLowerCase();
    if (!virtualName) {
      return false;
    }
    if (realNames.has(virtualName)) {
      return false;
    }
    const virtualStem = virtualName.replace(/\.[a-z0-9]{1,10}$/i, "");
    if (virtualStem && realNameStems.has(virtualStem)) {
      return false;
    }
    return true;
  });

  if (!stripped.some((attachment) => !isVirtualAttachmentUrl(attachment.originalUrl))) {
    return attachments;
  }

  return stripped;
}

function isGenericDerivedAttachmentName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) {
    return true;
  }
  if (lower === "content" || lower === "download") {
    return true;
  }
  if (/^file[_-][a-z0-9]+(?:\.[a-z0-9]{2,6})?$/i.test(lower)) {
    return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.[a-z0-9]{2,6})?$/i.test(lower)) {
    return true;
  }
  return false;
}

function isBackendAttachmentUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.includes("/backend-api/files/") || lower.includes("/backend-api/estuary/content");
}

function stripRedundantFailedAttachments(attachments: CaptureAttachment[]): CaptureAttachment[] {
  if (attachments.length < 2) {
    return attachments;
  }
  const cached = attachments.filter((attachment) => attachment.status === "cached");
  if (!cached.length) {
    return attachments;
  }
  const cachedKinds = new Set(cached.map((attachment) => attachment.kind));
  return attachments.filter((attachment) => {
    if (attachment.status !== "failed") {
      return true;
    }
    if (!isBackendAttachmentUrl(attachment.originalUrl)) {
      return true;
    }
    const name = attachmentDisplayName(attachment);
    const isGeneric = isGenericDerivedAttachmentName(name);
    if (!isGeneric) {
      return true;
    }
    // Generic backend IDs (uuid/file_xxx) are noisy placeholders in UI;
    // keep meaningful named failures only.
    if (isGeneric && attachment.kind !== "pdf") {
      return false;
    }
    if (cachedKinds.has(attachment.kind)) {
      return false;
    }
    if (attachment.kind !== "file" && cachedKinds.has("file")) {
      return false;
    }
    if (attachment.kind === "file" && cachedKinds.size > 0) {
      return false;
    }
    return true;
  });
}

async function logAttachmentProbeOnFailure(
  source: CaptureSource,
  turn: CaptureTurn,
  attachments: CaptureAttachment[],
  unresolved: string[],
  reason: "unresolved_name" | "download_failed" = "unresolved_name"
): Promise<void> {
  const candidates = attachments
    .map((attachment) => attachment.originalUrl.trim())
    .filter((url) => isHttpUrl(url))
    .slice(0, 10);

  const probes = await Promise.all(candidates.map((url) => probeAttachmentUrlViaBackground(url)));
  const results = probes
    .filter((item): item is BackgroundAttachmentProbeResponse => Boolean(item))
    .map((item) => ({
      url: item.url ?? "",
      ok: Boolean(item.ok),
      method: item.method ?? "",
      status: item.status ?? 0,
      contentType: item.contentType ?? "",
      contentLength: item.contentLength ?? 0,
      error: item.error ?? ""
    }));

  console.groupCollapsed("[AI_HISTORY][PROBE] unresolved attachment diagnostics");
  console.info("source", source);
  console.info("reason", reason);
  console.info("unresolved_names", unresolved);
  console.info(
    "turn_preview",
    (turn.contentMarkdown || "")
      .replace(/\s+/g, " ")
      .slice(0, 180)
  );
  console.table(
    attachments.map((attachment) => ({
      kind: attachment.kind,
      url: attachment.originalUrl.slice(0, 220),
      isData: isDataUrl(attachment.originalUrl),
      isVirtual: isVirtualAttachmentUrl(attachment.originalUrl)
    }))
  );
  if (results.length > 0) {
    console.table(results);
  } else {
    console.info("probe_results", "empty");
  }

  try {
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    const hints = resources
      .map((entry) => String(entry.name || "").trim())
      .filter(Boolean)
      .filter((name) => /prompts|backend-api|googleusercontent|files|upload|download/i.test(name))
      .slice(-25);
    console.info("resource_hints", hints);
  } catch {
    // ignore
  }
  console.groupEnd();
}

export function countMaterializableAttachments(turns: CaptureTurn[]): number {
  return countMaterializableAttachmentsWith(turns, {
    stripVirtualPlaceholdersWhenRealAttachmentExists,
    mergeTurnAttachments
  });
}

export async function materializeAttachmentsOrThrow(
  source: CaptureSource,
  turns: CaptureTurn[],
  options: MaterializeAttachmentOptions = {}
): Promise<CaptureTurn[]> {
  return materializeAttachmentsOrThrowWith(source, turns, options, {
    isDataUrl,
    isVirtualAttachmentUrl,
    attachmentDisplayName,
    stripVirtualPlaceholdersWhenRealAttachmentExists,
    stripRedundantFailedAttachments,
    detectUnresolvedUserUploadFromText,
    mergeTurnAttachments,
    dedupeTurns,
    maybeInlineProtectedAttachment,
    logAttachmentProbeOnFailure
  });
}

export async function enrichChatGptTurnsWithApiAttachments(
  turns: CaptureTurn[],
  doc: Document = document
): Promise<CaptureTurn[]> {
  if (!turns.length) {
    return turns;
  }

  const apiTurns = await fetchChatGptApiTurns(doc);
  let mergedTurns = turns;
  if (apiTurns.length > 0) {
    const apiBuckets: Record<CaptureTurn["role"], CaptureAttachment[][]> = {
      user: [],
      assistant: [],
      system: [],
      tool: []
    };
    for (const turn of apiTurns) {
      if (turn.attachments.length > 0) {
        apiBuckets[turn.role].push(turn.attachments);
      }
    }

    const cursor: Record<CaptureTurn["role"], number> = {
      user: 0,
      assistant: 0,
      system: 0,
      tool: 0
    };

    mergedTurns = turns.map((turn) => {
      const bucket = apiBuckets[turn.role];
      if (!bucket || cursor[turn.role] >= bucket.length) {
        return turn;
      }
      const attachments = bucket[cursor[turn.role]] ?? [];
      cursor[turn.role] += 1;
      return {
        ...turn,
        attachments: mergeTurnAttachments(turn.attachments, attachments)
      };
    });
  }

  const withResourceFallback = applyChatGptResourceAttachmentFallback(mergedTurns, doc);
  return dedupeTurns(withResourceFallback);
}

export function extractGeminiTurns(doc: Document = document): CaptureTurn[] {
  return extractGeminiTurnsWith(doc, {
    leafNodes,
    roleFromAttrs,
    buildTurn,
    sanitizeTurn: sanitizeGeminiTurn,
    dedupeTurns,
    parseByRoleMarkers
  });
}

export function extractAiStudioTurns(doc: Document = document): CaptureTurn[] {
  return extractAiStudioTurnsWith(doc, {
    normalizeText: normalizeMarkdownText,
    leafNodes,
    buildTurn,
    dedupeTurns,
    parseByRoleMarkers
  });
}

export function inferSourceFromUrl(url: string): CaptureSource {
  if (url.includes("claude.ai")) {
    return "claude";
  }
  if (url.includes("aistudio.google.com")) {
    return "ai_studio";
  }
  if (url.includes("gemini.google.com") || url.includes("bard.google.com")) {
    return "gemini";
  }
  return "chatgpt";
}

export function createCapturePayload(source: CaptureSource, turns: CaptureTurn[]): CapturePayload {
  return {
    source,
    pageUrl: canonicalizePageUrl(location.href),
    title: deriveTitle(source, document, turns),
    turns,
    capturedAt: new Date().toISOString(),
    version: "1.2.0"
  };
}

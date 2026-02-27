const NETWORK_TRACKER_KEY = "__AI_HISTORY_NETWORK_TRACKER__";
const MAX_TRACKED_NETWORK_RECORDS = 2400;

export interface TrackedNetworkRecord {
  url: string;
  method: string;
  startedAt: number;
  status: number;
  ok: boolean;
}

interface NetworkTrackerState {
  installed: boolean;
  records: TrackedNetworkRecord[];
  inFlight: number;
}

type TrackerWindow = Window & {
  [NETWORK_TRACKER_KEY]?: NetworkTrackerState;
};

let captureWindowStartMs = 0;

export function beginCaptureSessionWindow(): void {
  ensureRuntimeNetworkTracker();
  captureWindowStartMs = performance.now();
}

export function activeCaptureWindowStartMs(): number {
  return Number.isFinite(captureWindowStartMs) && captureWindowStartMs > 0 ? captureWindowStartMs : 0;
}

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return toAbsoluteUrl(input) || input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url || "";
  }
  return String(input || "");
}

function trackerState(): NetworkTrackerState {
  const globalWindow = window as TrackerWindow;
  if (!globalWindow[NETWORK_TRACKER_KEY]) {
    globalWindow[NETWORK_TRACKER_KEY] = {
      installed: false,
      records: [],
      inFlight: 0
    };
  }
  return globalWindow[NETWORK_TRACKER_KEY]!;
}

function pushTrackedNetworkRecord(record: TrackedNetworkRecord): void {
  if (!record.url) {
    return;
  }
  const state = trackerState();
  state.records.push(record);
  if (state.records.length > MAX_TRACKED_NETWORK_RECORDS) {
    const overflow = state.records.length - MAX_TRACKED_NETWORK_RECORDS;
    state.records.splice(0, overflow);
  }
}

function incrementTrackedInFlight(): void {
  const state = trackerState();
  state.inFlight += 1;
}

function decrementTrackedInFlight(): void {
  const state = trackerState();
  state.inFlight = Math.max(0, state.inFlight - 1);
}

export function getTrackedInFlightCount(): number {
  ensureRuntimeNetworkTracker();
  return trackerState().inFlight;
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

export function ensureRuntimeNetworkTracker(): void {
  const state = trackerState();
  if (state.installed) {
    return;
  }
  state.installed = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const startedAt = performance.now();
    const method = (init?.method || (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET"))
      .toString()
      .toUpperCase();
    const requestedUrl = resolveRequestUrl(input);
    incrementTrackedInFlight();
    try {
      const response = await originalFetch(input, init);
      pushTrackedNetworkRecord({
        url: response.url || requestedUrl,
        method,
        startedAt,
        status: response.status,
        ok: response.ok
      });
      return response;
    } catch (error) {
      pushTrackedNetworkRecord({
        url: requestedUrl,
        method,
        startedAt,
        status: 0,
        ok: false
      });
      throw error;
    } finally {
      decrementTrackedInFlight();
    }
  }) as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    const self = this as XMLHttpRequest & { __aihMethod?: string; __aihUrl?: string };
    self.__aihMethod = (method || "GET").toString().toUpperCase();
    self.__aihUrl = toAbsoluteUrl(String(url || "")) || String(url || "");
    originalOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null): void {
    const self = this as XMLHttpRequest & { __aihMethod?: string; __aihUrl?: string };
    const startedAt = performance.now();
    incrementTrackedInFlight();
    let finalized = false;
    const finalize = () => {
      if (finalized) {
        return;
      }
      finalized = true;
      pushTrackedNetworkRecord({
        url: self.responseURL || self.__aihUrl || "",
        method: (self.__aihMethod || "GET").toUpperCase(),
        startedAt,
        status: Number(self.status || 0),
        ok: Number(self.status || 0) >= 200 && Number(self.status || 0) < 400
      });
      decrementTrackedInFlight();
      self.removeEventListener("loadend", finalize);
    };
    self.addEventListener("loadend", finalize);
    try {
      originalSend.call(this, body ?? null);
    } catch (error) {
      finalize();
      throw error;
    }
  };

  const captureNavigationLikeAttachmentUrl = (raw: unknown): void => {
    if (typeof raw !== "string" && !(raw instanceof URL)) {
      return;
    }
    const text = typeof raw === "string" ? raw : raw.toString();
    const absolute = toAbsoluteUrl(text) || text;
    if (!absolute || !isLikelyAttachmentUrl(absolute)) {
      return;
    }
    pushTrackedNetworkRecord({
      url: absolute,
      method: "GET",
      startedAt: performance.now(),
      status: 200,
      ok: true
    });
  };

  try {
    const originalWindowOpen = window.open.bind(window);
    window.open = function patchedWindowOpen(
      url?: string | URL,
      target?: string,
      features?: string
    ): Window | null {
      captureNavigationLikeAttachmentUrl(url ?? "");
      return originalWindowOpen(url, target, features);
    };
  } catch {
    // ignore
  }

  try {
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedAnchorClick(this: HTMLAnchorElement): void {
      captureNavigationLikeAttachmentUrl(this.href || this.getAttribute("href") || "");
      originalAnchorClick.call(this);
    };
  } catch {
    // ignore
  }

  try {
    const originalAssign = Location.prototype.assign;
    Location.prototype.assign = function patchedAssign(this: Location, url: string | URL): void {
      captureNavigationLikeAttachmentUrl(url);
      originalAssign.call(this, String(url));
    };
  } catch {
    // ignore
  }

  try {
    const originalReplace = Location.prototype.replace;
    Location.prototype.replace = function patchedReplace(this: Location, url: string | URL): void {
      captureNavigationLikeAttachmentUrl(url);
      originalReplace.call(this, String(url));
    };
  } catch {
    // ignore
  }

  try {
    document.addEventListener(
      "click",
      (event) => {
        const path = typeof event.composedPath === "function" ? event.composedPath() : [];
        for (const item of path) {
          if (item instanceof HTMLAnchorElement) {
            captureNavigationLikeAttachmentUrl(item.href || item.getAttribute("href") || "");
            break;
          }
        }
      },
      true
    );
  } catch {
    // ignore
  }
}

export function getTrackedNetworkRecords(sinceMs = 0): TrackedNetworkRecord[] {
  ensureRuntimeNetworkTracker();
  const state = trackerState();
  if (sinceMs <= 0) {
    return state.records.slice();
  }
  return state.records.filter((record) => record.startedAt >= sinceMs);
}

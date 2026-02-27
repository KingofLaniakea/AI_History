import {
  activeCaptureWindowStartMs,
  ensureRuntimeNetworkTracker,
  getTrackedInFlightCount,
  getTrackedNetworkRecords
} from "../network/tracker";

export interface WarmupConfig {
  downSteps: number;
  downWaitMs: number;
  upWaitMs: number;
}

export interface SlowMoveResult {
  startTop: number;
  targetTop: number;
  endTop: number;
  maxTopSeen: number;
  minTopSeen: number;
  movedPixels: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pickScrollableElement(doc: Document): HTMLElement | null {
  const candidates = Array.from(
    doc.querySelectorAll("main, [role='main'], [class*='scroll'], [class*='conversation'], [class*='content']")
  )
    .filter((node): node is HTMLElement => node instanceof HTMLElement)
    .filter((node) => node.scrollHeight - node.clientHeight > 180);
  if (!candidates.length) {
    return null;
  }
  candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return candidates[0] ?? null;
}

export async function warmupScrollableArea(doc: Document, config: WarmupConfig): Promise<void> {
  const scroller = pickScrollableElement(doc);
  if (!scroller) {
    const originY = window.scrollY;
    const maxY = Math.max(0, document.body.scrollHeight - window.innerHeight);
    if (maxY <= 24) {
      await sleep(180);
      return;
    }
    const steps = Math.max(4, Math.min(10, Math.ceil(maxY / 900)));
    for (let index = 0; index <= steps; index += 1) {
      const ratio = index / steps;
      window.scrollTo(0, Math.round(maxY * ratio));
      await sleep(90);
    }
    for (let index = steps; index >= 0; index -= 1) {
      const ratio = index / steps;
      window.scrollTo(0, Math.round(maxY * ratio));
      await sleep(55);
    }
    window.scrollTo(0, originY);
    await sleep(120);
    return;
  }

  const originTop = scroller.scrollTop;
  const maxRounds = config.downSteps;
  let lastHeight = scroller.scrollHeight;

  for (let round = 0; round < maxRounds; round += 1) {
    const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (maxScroll < 24) {
      break;
    }

    const steps = Math.min(5, Math.max(2, Math.ceil(maxScroll / 900)));
    for (let i = 1; i <= steps; i += 1) {
      scroller.scrollTop = Math.round(maxScroll * (i / steps));
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      await sleep(config.downWaitMs);
    }

    await sleep(config.downWaitMs * 2);

    const newHeight = scroller.scrollHeight;
    if (newHeight <= lastHeight) {
      break;
    }
    lastHeight = newHeight;
  }

  const scrollBackSteps = 5;
  const currentTop = scroller.scrollTop;
  for (let i = scrollBackSteps; i >= 0; i -= 1) {
    scroller.scrollTop = Math.round(originTop + (currentTop - originTop) * (i / scrollBackSteps));
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(config.upWaitMs);
  }
  scroller.scrollTop = originTop;
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(180);
}

export async function moveScrollerSlowly(
  scroller: HTMLElement,
  fromTop: number,
  toTop: number,
  steps: number,
  waitMs: number
): Promise<SlowMoveResult> {
  const totalSteps = Math.max(1, steps);
  scroller.scrollTop = Math.round(fromTop);
  scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(Math.max(24, Math.round(waitMs * 0.6)));
  const actualStart = scroller.scrollTop;
  let maxTopSeen = actualStart;
  let minTopSeen = actualStart;
  for (let index = 1; index <= totalSteps; index += 1) {
    const ratio = index / totalSteps;
    scroller.scrollTop = Math.round(fromTop + (toTop - fromTop) * ratio);
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    await sleep(waitMs);
    const currentTop = scroller.scrollTop;
    if (currentTop > maxTopSeen) {
      maxTopSeen = currentTop;
    }
    if (currentTop < minTopSeen) {
      minTopSeen = currentTop;
    }
  }
  const endTop = scroller.scrollTop;
  const movedPixels = Math.max(
    Math.abs(maxTopSeen - actualStart),
    Math.abs(actualStart - minTopSeen),
    Math.abs(endTop - actualStart)
  );
  return {
    startTop: actualStart,
    targetTop: Math.round(toTop),
    endTop,
    maxTopSeen,
    minTopSeen,
    movedPixels
  };
}

export async function waitForTrackedNetworkSettle(idleRounds = 4, intervalMs = 240): Promise<void> {
  ensureRuntimeNetworkTracker();
  const windowStart = activeCaptureWindowStartMs();
  let previousCount = getTrackedNetworkRecords(windowStart).length;
  let stableRounds = 0;
  for (let index = 0; index < 28; index += 1) {
    await sleep(intervalMs);
    const inFlight = getTrackedInFlightCount();
    const currentCount = getTrackedNetworkRecords(windowStart).length;
    if (inFlight === 0 && currentCount === previousCount) {
      stableRounds += 1;
      if (stableRounds >= idleRounds) {
        return;
      }
    } else {
      stableRounds = 0;
      previousCount = currentCount;
    }
  }
  console.info("[AI_HISTORY] network settle timeout", {
    inFlight: getTrackedInFlightCount(),
    records: getTrackedNetworkRecords(windowStart).length
  });
}

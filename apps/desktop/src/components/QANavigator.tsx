import React, { useMemo, useRef } from "react";
import type { Message } from "../lib/types";

export interface QAPair {
  label: string;
  firstMessageSeq: number;
}

function buildPairs(messages: Message[]): QAPair[] {
  const pairs: QAPair[] = [];
  let count = 0;

  messages.forEach((msg) => {
    const content = msg.contentMarkdown.replace(/\s+/g, "").trim();
    if (msg.role === "user" && content.length > 0) {
      count += 1;
      pairs.push({
        label: `Q${count}`,
        firstMessageSeq: msg.seq
      });
    }
  });

  return pairs;
}

export function useQaPairs(messages: Message[]) {
  return useMemo(() => buildPairs(messages), [messages]);
}

export function QANavigator({
  pairs,
  activePair,
  onJump
}: {
  pairs: QAPair[];
  activePair: number;
  onJump: (index: number) => void;
}) {
  if (pairs.length === 0) {
    return null;
  }

  return (
    <div className="qa-nav">
      <button onClick={() => onJump(Math.max(activePair - 1, 0))}>上一问</button>
      <div className="qa-nav-status" aria-live="polite">
        {activePair + 1} / {pairs.length}
      </div>
      <button onClick={() => onJump(Math.min(activePair + 1, pairs.length - 1))}>下一问</button>
    </div>
  );
}

export function QASideSlider({
  pairs,
  activePair,
  onJump
}: {
  pairs: QAPair[];
  activePair: number;
  onJump: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const lastDragIndexRef = useRef<number>(-1);
  const pairCount = pairs.length;
  const railInsetRatio = 0.065;
  const railSpanRatio = 1 - railInsetRatio * 2;

  if (!pairCount) {
    return null;
  }

  const thumbHeight = Math.max(20, Math.min(80, 240 / pairCount));

  const indexFromClientY = (clientY: number): number => {
    const track = trackRef.current;
    if (!track || pairCount <= 1) return 0;
    const rect = track.getBoundingClientRect();
    const trackRatio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const ratio = Math.max(0, Math.min(1, (trackRatio - railInsetRatio) / railSpanRatio));
    return Math.round(ratio * (pairCount - 1));
  };

  const activeRatio = pairCount <= 1 ? 0 : activePair / (pairCount - 1);
  const activeTrackRatio = railInsetRatio + activeRatio * railSpanRatio;

  return (
    <aside className="qa-side-slider" aria-label="问答快速跳转">
      <div
        className="qa-side-track"
        ref={trackRef}
        onClick={(event) => onJump(indexFromClientY(event.clientY))}
      >
        <div className="qa-side-track-line" />
        {pairs.map((pair, index) => {
          const ratio = pairCount <= 1 ? 0 : index / (pairCount - 1);
          const trackRatio = railInsetRatio + ratio * railSpanRatio;
          return (
            <button
              key={pair.label}
              className={`qa-side-dot ${index === activePair ? "active" : ""}`}
              style={{ top: `${trackRatio * 100}%` }}
              onClick={(event) => {
                event.stopPropagation();
                onJump(index);
              }}
              title={pair.label}
            />
          );
        })}
        <div
          className="qa-side-thumb"
          style={{ top: `${activeTrackRatio * 100}%`, height: `${thumbHeight}px` }}
          onPointerDown={(event) => {
            lastDragIndexRef.current = activePair;
            const handleMove = (moveEvent: PointerEvent) => {
              const idx = indexFromClientY(moveEvent.clientY);
              if (idx !== lastDragIndexRef.current) {
                lastDragIndexRef.current = idx;
                onJump(idx);
              }
            };
            const handleUp = () => {
              lastDragIndexRef.current = -1;
              window.removeEventListener("pointermove", handleMove);
              window.removeEventListener("pointerup", handleUp);
            };
            window.addEventListener("pointermove", handleMove);
            window.addEventListener("pointerup", handleUp, { once: true });
            event.preventDefault();
          }}
        />
      </div>
    </aside>
  );
}

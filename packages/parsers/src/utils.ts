import type { Role } from "@ai-history/core-types";

export function parseJsonSafe(raw?: string): unknown {
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function toIsoString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }

  if (typeof value === "string") {
    const asNumber = Number(value);
    if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
      return toIsoString(asNumber);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

export function normalizeRole(input: unknown): Role {
  const role = String(input ?? "").toLowerCase();

  if (["user", "human", "prompt", "author"].includes(role)) {
    return "user";
  }

  if (["assistant", "model", "bot", "ai", "response"].includes(role)) {
    return "assistant";
  }

  if (["system", "developer"].includes(role)) {
    return "system";
  }

  if (["tool", "function"].includes(role)) {
    return "tool";
  }

  return "assistant";
}

export function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toText).filter(Boolean).join("\n");
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (typeof obj.text === "string") {
      return obj.text;
    }

    if (typeof obj.content === "string") {
      return obj.content;
    }

    if (Array.isArray(obj.parts)) {
      return toText(obj.parts);
    }

    if (Array.isArray(obj.chunks)) {
      return toText(obj.chunks);
    }

    if (Array.isArray(obj.items)) {
      return toText(obj.items);
    }
  }

  return "";
}

export function nonEmpty<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

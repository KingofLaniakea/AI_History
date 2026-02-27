# AI History Extension Architecture Baseline

Last updated: 2026-02-28  
Scope: `apps/extension` live capture pipeline + parser boundary notes  
Extension version baseline: `0.1.1`

## 1. Purpose

This document is the change contract for future refactors and new source onboarding.
The main goal is to keep capture stable while making platform code independent.

Hard requirements:
- ChatGPT, Gemini, AI Studio, Claude can all import text conversations.
- ChatGPT image/PDF capture remains strongly protected.
- New AI website onboarding should only require source-specific extraction code and small routing edits.

## 2. Top-Level Design

The extension is split into four layers:

1. Entry facade layer
- `apps/extension/entrypoints/lib/extractor.ts`
- Keeps public API stable.
- Re-exports capture functions/types.

2. Source extraction layer
- `apps/extension/entrypoints/lib/extractor/source/*`
- Platform-specific parsing and fallback logic.

3. Shared capability layer
- `apps/extension/entrypoints/lib/extractor/source/common.ts`
- `apps/extension/entrypoints/lib/extractor/network/tracker.ts`
- `apps/extension/entrypoints/lib/extractor/warmup/common.ts`
- `apps/extension/entrypoints/lib/extractor/attachments/*`
- Reusable helpers only, no platform routing.

4. Runtime orchestration layer
- Content scripts: `apps/extension/entrypoints/*.content.ts`
- Flow wrappers: `apps/extension/entrypoints/content/flows/*`
- Background router/executors: `apps/extension/entrypoints/background/*`

## 3. Current Module Responsibilities

### 3.1 Facade
- `extractor.ts`
- Only exports and compatibility aliases.
- Must not contain heavy business logic.

### 3.2 Source modules
- `source/chatgpt.ts`
- ChatGPT-specific extraction, API enrichment, file-tile behavior, and strict attachment handling path.

- `source/gemini.ts`
- Gemini turn extraction orchestration via shared helpers.

- `source/aistudio.ts`
- AI Studio turn extraction orchestration via shared helpers.

- `source/claude.ts`
- Claude turn extraction orchestration via shared helpers.

### 3.3 Shared modules
- `network/tracker.ts`
- Runtime request/XHR tracker installation and tracked record querying.

- `source/common.ts`
- Shared text normalization, HTML-to-markdownish, role parsing, turn building, dedupe, marker fallback.

- `warmup/common.ts`
- Shared scroll warmup, stepwise scroller movement, network settle waiting.

- `warmup/index.ts`
- Warmup routing by source (no platform parsing logic).

### 3.4 Attachments modules
- `attachments/materialize.ts`
- Attachment materialization pipeline and DI entry points.

- `attachments/classify.ts`
- MIME/kind/url classification helpers.

- `attachments/collect.ts`
- Compatibility re-export bridge (currently still points into ChatGPT module parts).

- `attachments/id-candidates.ts`, `attachments/inline-fetch.ts`
- Reserved split targets for future extraction; still high risk to move aggressively.

### 3.5 Background modules
- `background/message-router.ts`
- Single message dispatch point.

- `background/capture-runner.ts`
- Capture execution by tab/url.

- `background/attachment-fetch.ts`
- Background fetch/probe for protected URLs.

- `background/attachment-hints.ts`
- webRequest based hint tracking.

## 4. Strict Dependency Rules

These rules are required to avoid coupling regressions:

1. `source/*` can depend on:
- `source/common`
- `warmup/*`
- `network/tracker`
- `attachments/*`

2. `attachments/*` must not depend on `source/chatgpt`.

3. `extractor.ts` must stay as facade only.

4. content flows depend only on extractor public API, not extractor internals.

5. Background modules should communicate through typed message contracts only.

## 5. What Was Moved in the Cautious Deep Split

Moved from `source/chatgpt.ts` to reusable modules:

1. Network tracking core
- Capture session window start.
- fetch/xhr interception and tracked records.
- in-flight tracking and filtered record read.

2. Shared text and turn helpers
- HTML decode/tag strip/math normalization.
- markdownish conversion and cleanup.
- role marker parsing and dedupe.
- turn builder and gemini sanitation helpers.

3. Shared warmup helpers
- sleep/pick scroller/warmup scroll area.
- smooth scroller movement.
- wait for tracked network settle.

Not moved on purpose in this phase:
- ChatGPT file-tile react-fiber extraction path.
- attachment id candidate heuristics chain.
- ChatGPT API enrichment strategy.

## 6. Stability Guarantees

Guaranteed unchanged by this baseline:
- Extractor public signatures in `extractor.ts`.
- `AI_HISTORY_*` / `CAPTURE_*` message protocol shape.
- Desktop import workflow entry path.

ChatGPT-specific protection:
- Image/PDF path remains in ChatGPT-specific flow and materialization chain.
- Best-effort attachment behavior for Gemini/AI Studio/Claude does not block text import.

## 7. New AI Site Onboarding Contract

To add a new platform `<sourceX>`:

1. Add source extractor
- New file: `apps/extension/entrypoints/lib/extractor/source/<sourceX>.ts`
- Use `source/common.ts` first; keep only website-specific selectors/heuristics in this file.

2. Add content flow
- New file: `apps/extension/entrypoints/content/flows/<sourceX>-flow.ts`
- Use shared capture runtime and extractor facade.

3. Add content script entrypoint
- New file: `apps/extension/entrypoints/<sourceX>.content.ts`
- Keep minimal bootstrap only.

4. Register lifecycle mapping
- Update `background/content-script-lifecycle.ts`
- Map hostname to generated content script.

5. Extend source union and UI filters if needed
- `CaptureSource` type and any source-filter UI options.

Allowed change surface for onboarding:
- `source/<sourceX>.ts`
- `<sourceX>-flow.ts`
- `<sourceX>.content.ts`
- host mapping + source enum/UI wiring

Disallowed for standard onboarding:
- Editing ChatGPT-specific attachment internals unless explicitly required.

## 8. Regression Gates

Run these commands before merge:

1. `pnpm --filter @ai-history/extension build`
2. `pnpm --filter @ai-history/parsers test`
3. `pnpm test:parsers`
4. `pnpm --filter @ai-history/desktop build`

Manual checks:

1. ChatGPT text import.
2. ChatGPT image import.
3. ChatGPT PDF import.
4. ChatGPT mixed image+PDF import.
5. Gemini text import.
6. AI Studio text import.
7. Claude text import.
8. Non-ChatGPT attachment failures do not block import.

## 9. Future Refactor Guardrails

1. Move high-risk chains in small phases only.
2. Keep one checkpoint commit per module move.
3. No semantic rewrites in the same commit as extraction.
4. If ChatGPT image/PDF regresses, rollback to last green checkpoint first.
5. Keep this document updated when module responsibilities change.

## 10. Change Log for This Baseline

- Extension version bumped to `0.1.1`.
- `network/tracker.ts` changed from stub to real implementation.
- `source/common.ts` changed from stub to reusable helper module.
- `warmup/common.ts` changed from stub to reusable warmup module.
- `source/chatgpt.ts` replaced migrated blocks with module imports/wrappers.
- `source/claude.ts` switched to shared helper usage.

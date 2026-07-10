---
name: verify
description: Build, launch, and drive the Threadr Dispatch app (Vite React SPA) to verify changes at the rendered surface.
---

# Verifying the dispatch app

Vite React SPA. Routes: `/` (Home), `/dispatch` (the main demo screen).

## Launch

```bash
cd dispatch
npm run dev -- --port 5199 --strictPort   # run in background; ready in ~1s
```

## Drive

`playwright` (with cached Chromium) is a dependency of `dispatch/` — scripts must
resolve from `dispatch/node_modules`, so copy the driver script into `dispatch/`
before `node script.mjs` (or set cwd there).

Demo flow to reach each state, via the chat preset buttons (each reply has a
~1s "typing" delay — wait ≥1.3s after clicking):

1. `button:has-text("incoming volume for the next two weeks")` → intake state
   (request cards + naive-demand chart).
2. `button:has-text("Schedule everything")` → proposed state (chart by stage,
   Proposed assignments groups, Gantt timeline, analyst load bars).
3. `button:has-text("Who should coach whom this week?")` → coaching pair cards.
4. Accept pair → "Book 1h session" → coaching sessions on chart/Gantt.

## Gotchas

- No test ids; select by text. Beware ambiguous substrings ("Review",
  "Deny" appear in many places) — use `:text-is()` or regex filters.
- The main column scrolls internally; `getBoundingClientRect` coords are only
  hoverable after `scrollIntoView` — raw `page.mouse.move` to below-fold
  coordinates silently does nothing.
- Chart columns each contain the dashed capacity line `div[title^="Available"]`
  — exclude it when selecting bar segments (`div[title*=":"]:not([title^="Available"])`).
- Hover-driven UI state (hoverDay/hoverStage/hoverReq/hoverRow in
  `src/pages/Dispatch.tsx`) is inline-style opacity — assert via
  `getComputedStyle`.
- Denying batches tends to DECREASE the at-risk count (frees hours for other
  requests); the AT RISK pulse animation only triggers when the count increases.

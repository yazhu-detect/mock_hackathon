# Threadr Dispatch

Auto-scheduling & assignment for Threadr analysts — *"tell it the volume, get the schedule."*
A conversational assistant drives a real, deterministic scheduling engine over the Threadr
CA signals (analyst roster, throughput history, backlog, incoming volume) and produces a
per-analyst assignment plan you can accept/deny, with a capacity chart, Gantt timeline, and
coaching pairings.

Frontend-only React + Vite + TypeScript. Dark Detect design-system theme. No backend, no API
key — the assistant is scripted; the numbers on screen are all computed live from the CSVs.

## Run

**Prerequisites:** Node.js 18+ and npm (check with `node -v`).

```bash
cd dispatch          # from the mock_hackathon repo root
npm install          # first time only — installs dependencies
npm run dev          # starts the dev server
```

Then open **http://localhost:5173** in your browser (`/` is the launcher, `/dispatch` is the
scheduler). Stop the server with `Ctrl+C`.

### Data
The app reads `public/data/*.csv`. Those are already checked in (copied from `../data`,
produced by `generate_dataset.py`). If you regenerate the dataset, refresh them:

```bash
cd ..                # repo root
python3 generate_dataset.py
cp data/*.csv dispatch/public/data/
```

### Production build (optional)
```bash
npm run build        # type-checks and bundles into dist/
npm run preview      # serves the built app at http://localhost:4173
```

### Verify the demo flow (optional)
```bash
node verify.mjs      # Playwright: walks the whole flow, screenshots each step, checks for errors
```

## Demo flow (chat presets, in order)

1. **"Here's the incoming volume…"** — parses the 5 incoming requests; the capacity chart shows
   Friday's post-storm surge (req 601) breaching available hours.
2. **"…schedule everything"** — runs the engine: KPIs fill, proposed assignments group by
   request (expand *Why?* / *Structures*), Gantt renders, req 601 flags **1d late**.
3. **"Authorize weekend overtime…"** — recomputes at half-capacity weekends; ETAs recover.
4. **Accept / Deny** any batch — deny re-runs the whole plan and the assistant narrates the
   new ETA. **Accept all** locks the plan in.
5. **"Who needs coaching this week?"** — accuracy-dip / pace-drift signals + each analyst's
   **weak defects**, paired with a **primary coach** (domain-matched) and optional **specialist
   consult**. A **coaching budget** = spare mentor-hours *after all deadlines are safe* (so it's
   0 during the surge and opens once weekend OT clears it). The **dedicated-hours stepper** lets
   Kyle reserve coaching from idle capacity (shown on the chart in volt-green) without moving any
   client deadline.

## Structure

- `src/engine/schedule.ts` — deadline/priority-ordered greedy scheduler: capacity ledger,
  backlog reserve, rework-adjusted throughput (`rate × accuracy`), PTO/weekend rules, pipeline
  gating (review of annotated, secondary of a sampled %), per-request ETA/slack.
- `src/engine/coaching.ts` — fits accuracy-dip / pace-drift signals from 30-day history.
- `src/engine/coachingMatch.ts` — one-primary-coach + specialist-consult matching (`specialty`
  is the defect axis; capacity drawn from the same ledger).
- `src/data/loadCsv.ts` — CSV load + typed models.
- `src/pages/Dispatch.tsx` — the scheduler screen; `src/pages/Home.tsx` — the launcher.

Design source: Claude Design project "Threadr Work Auto-Scheduler" (Threadr Dispatch v2).
Verify the flow anytime with `node verify.mjs` (Playwright).

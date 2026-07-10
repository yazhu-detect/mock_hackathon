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
5. **"Who should coach whom this week?"** — accuracy-dip / pace-drift signals, each paired with
   a ranked **coach** from the roster (scored on strength in the weak metric · specialty overlap
   · timezone · spare capacity). **Swap** the coach from the candidate chips, **Accept pair**,
   then **Book 1h session** — the hour is carved out of *both* calendars, recomputes the plan,
   and shows up as a volt-green block on the chart and Gantt. Three layouts (**Pairs / Board /
   Focus**) via the toggle.

Collapsible section headers (Incoming requests, Capacity vs demand, Analyst board, Coaching
pairings) let Kyle fold away anything he isn't looking at.

## Structure

- `src/engine/schedule.ts` — deadline/priority-ordered greedy scheduler: capacity ledger,
  backlog reserve, rework-adjusted throughput (`rate × accuracy`), PTO/weekend rules, pipeline
  gating (review of annotated, secondary of a sampled %), per-request ETA/slack. Booked coaching
  sessions carve an hour out of both analysts' `hoursFor` capacity.
- `src/engine/coaching.ts` — fits accuracy-dip / pace-drift signals from 30-day history.
- `src/pages/Dispatch.tsx` — the scheduler screen (incl. coach ranking / slot-finding / session
  booking for the coaching pairings); `src/pages/Home.tsx` — the launcher.
- `src/data/loadCsv.ts` — CSV load + typed models.

Design source: Claude Design project "Threadr Work Auto-Scheduler" (Threadr Dispatch v2).
Verify the flow anytime with `node verify.mjs` (Playwright).

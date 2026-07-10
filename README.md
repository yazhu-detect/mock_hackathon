# Running the app — Threadr Dispatch

The deliverable lives in [`dispatch/`](dispatch/) — a frontend-only React + Vite + TypeScript app.
No backend, no API key: the assistant is scripted, but the schedule/assignments/coaching are all
computed live from the CSVs in `data/`.

**Prerequisites:** Node.js 18+ and npm (`node -v`).

```bash
cd dispatch
npm install        # first time only
npm run dev        # then open http://localhost:5173
```

`/` is the launcher, `/dispatch` is the scheduler. **Demo flow** via the chat presets, in order:
1. *"Here's the incoming volume…"* — parses the 5 requests; chart shows the storm surge.
2. *"…schedule everything"* — engine runs; assignments, capacity chart, Gantt, ETAs appear.
3. *"Authorize weekend overtime…"* — recomputes; at-risk requests recover.
4. **Accept / Deny** a batch (deny re-plans live) · **Accept all** locks it in.
5. *"Who should coach whom this week?"* — accuracy/pace signals, each paired with a ranked coach;
   accept a pair and **book a 1h session** that carves an hour out of both calendars (visible on
   the chart + Gantt). Toggle the Pairs / Board / Focus layouts.

If you regenerate data (`python3 generate_dataset.py`), refresh it: `cp data/*.csv dispatch/public/data/`.
See [`dispatch/README.md`](dispatch/README.md) for build/preview and details.

---

# The problem we're solving

Auto-scheduling and assigning analysts in Threadr based on incoming work volume and turnaround times.
Today, assigning annotation/review work across analyst queues is manual and judgment-heavy — Kyle and leads eyeball incoming volume, per-analyst throughput, and deadlines, then hand-assign. Threadr already tracks the raw signals we'd need (assignment for annotation vs. review, images/structures assigned & completed, accuracy, avg time per image, time-in-annotation/review, and the Assigned → Analyzed → Reshoot status flow). Our job is to build the intelligent layer that turns "volume in" into "who does what, by when."
Goal: a tool Kyle can talk to — "here's the volume landing on this date, assign everybody" — that auto-schedules, assigns, and coaches analysts.

## What to deliver

A working, demoable app
A live scenario: "here's the volume → here's the schedule/assignments"
A short pitch: problem, approach, demo, and what we'd do next

## How you'll be scored (100 pts)

Demo (70): a live, clickable interface that takes incoming volume and produces a real schedule/assignment across analysts — measurably faster and more accurate than today's manual process. Polish and "wow" factor count.
Considerations (16): AI integration (conversational control + accept/deny suggestions), metrics & tracking, assignment, turnaround awareness, coaching, automations — and a memorable product name.
Presentation (10): clear problem/solution, show the interaction model in action, engaging and on time.
Q&A (4): confident answers that show you understand the real scheduling/assignment workflow and tradeoffs.

## Threadr Hackathon Dataset — Auto-Scheduling Analysts

Sample, **fully synthetic** inputs for the challenge:

> **Auto-scheduling analysts based on ongoing required work and turnaround times (in Threadr).**
> Turn *"volume in"* → *"who does what, by when."*

Everything here mirrors signals Threadr already tracks in the **Condition Assessment (CA)**
workflow, so a solution built on these columns maps cleanly onto real data later. The
numbers are invented and internally consistent, seeded for reproducibility (`seed=340`,
frozen "today" = **2026-07-09**). Regenerate any time:

```bash
python hackathon/generate_dataset.py
```

---

### The real Threadr concepts you're modeling

Work flows through a **4-stage pipeline** (each image carries `current_stage_type`):

```text
annotation ──▶ review ──▶ secondary_review ──▶ complete
   (A)          (R)             (S)               (C)
```

- The **unit of assignment** is a **structure** (a pole/tower, `structure_id`) that holds
  several images and belongs to a `request` / `org` / `powerline`. Today Kyle & leads
  hand-assign structures to an **annotator** and a **reviewer**.
- A reviewer can **push an image back to annotation** ("returned"). There is no "reshoot"
  status — a return is the reverse transition `push_back_to_annotation`.
- **Accuracy** = share of an analyst's completed images that reached `complete`
  **without ever being returned to annotation** from review / secondary_review.
- **Throughput** = images pushed per hour; its inverse is **avg time / image**.

---

### Files

| File | Grain | What it is |
| --- | --- | --- |
| `analysts.csv` | 1 row / analyst | Roster: capability, speed, accuracy, capacity |
| `structures_backlog.csv` | 1 row / structure | Work **already in the system**, with current stage + assignments |
| `throughput_history.csv` | 1 row / (analyst, stage, day) | Trailing **30-day** performance time series |
| `queue_depth.csv` | 1 row / (stage, day) | Trailing **30-day** queue depth per stage |
| `incoming_volume_scenario.csv` | 1 row / incoming request | The **forward 14-day** volume you must schedule |

#### `analysts.csv`

| Column | Meaning |
| --- | --- |
| `analyst_id`, `display_name`, `role` | Identity. `role` ∈ `analyst / reviewer / supervisor` (real Threadr roles) |
| `can_annotate`, `can_review`, `can_secondary_review` | Which stages this person is **qualified** for. A scheduler must respect these |
| `annotation_img_per_hr`, `review_img_per_hr`, `secondary_review_img_per_hr` | Measured throughput per stage (blank if not qualified) |
| `avg_sec_per_image_annotation`, `avg_sec_per_image_review` | Convenience inverse of throughput (= 3600 / img_per_hr) |
| `accuracy_pct_not_returned` | % of their completed images that were **not** returned to annotation |
| `daily_capacity_hours` | Hours available per working day |
| `timezone`, `seniority`, `status`, `specialty` | `status` ∈ `active / pto`; `specialty` hints at routing (e.g. `pole_crack`) |

#### `structures_backlog.csv`

| Column | Meaning |
| --- | --- |
| `structure_id`, `request_id`, `org_name`, `powerline_name`, `environment` | Where the work came from |
| `image_count` | Images in this structure (the actual sizing unit) |
| `priority` | `low / normal / high / urgent` |
| `due_date`, `ingested_at` | Deadline and when it landed — drives turnaround pressure |
| `current_stage` | `not_started / annotation / review / secondary_review / complete` |
| `assigned_annotator`, `assigned_reviewer`, `assigned_secondary_reviewer` | Current assignees (blank = unassigned; the gap you're filling) |
| `returned_to_annotation_count` | How many times it bounced back — a rework signal |

#### `throughput_history.csv`

Per analyst, per stage, per day: `images_pushed`, `time_spent_minutes`,
`avg_sec_per_image`, `images_returned` (annotation only), `day_accuracy_pct`.
Use this to **fit** throughput/accuracy and their variance instead of trusting a single
static number. Weekends and the PTO analyst (`a07`) show up as gaps — real supply is lumpy.

#### `queue_depth.csv`

Per stage, per day: `images_waiting`, `images_in_progress`, `images_completed_today`,
`structures_waiting`, `oldest_waiting_days`. The backlog trends **upward** and spikes in
the last few days — capacity is already behind before the surge arrives.

#### `incoming_volume_scenario.csv`

The forward-looking arrivals to schedule, across several `org`s / `powerline`s with a mix
of `priority` levels, `structure_count` / `image_count`, arrival dates, and `due_date`s.

---

### Useful formulas

```text
throughput_img_per_hr   = images_pushed / (time_spent_minutes / 60)
avg_time_per_image_sec  = 3600 / throughput_img_per_hr
accuracy_pct            = 100 * (1 - images_returned / images_pushed)     # annotation stage
structure_effort_hours  = image_count / annotation_img_per_hr             # per assigned analyst
est_completion_date     = today + ceil(queue_ahead / daily_stage_capacity)
```

---

*All names, orgs, and numbers are fictional and for the hackathon only.*

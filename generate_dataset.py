#!/usr/bin/env python3
"""
Hackathon sample-dataset generator for the "Auto-scheduling analysts" challenge.

Produces a small, internally-consistent set of CSVs that mirror the real signals
Threadr already tracks in the Condition Assessment (CA) workflow:

  stages          annotation -> review -> secondary_review -> complete   (A/R/S/C)
  work unit       a *structure* (structure_identifier) with N images, tied to a request
  accuracy        % of an analyst's completed images that reached Complete WITHOUT
                  being pushed back to annotation from review / secondary_review
  timing          per-stage seconds -> avg time/image, throughput (images/hour)
  queue depth     images sitting in each stage waiting for an analyst

Everything is deterministic (fixed seed + fixed "today") so teams start from the
same inputs and can regenerate at will.  No live clock / randomness leaks in.

Run:  python hackathon/generate_dataset.py
"""

import csv
import os
import random
from datetime import date, datetime, timedelta

# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------
SEED = 340  # nod to inspection request 340
random.seed(SEED)

TODAY = date(2026, 7, 9)  # frozen "now" for reproducibility
HISTORY_DAYS = 30         # trailing per-analyst throughput history
SCENARIO_DAYS = 14        # forward incoming-volume window

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(OUT_DIR, exist_ok=True)


def _w(name, header, rows):
    path = os.path.join(OUT_DIR, name)
    with open(path, "w", newline="") as fh:
        wr = csv.writer(fh)
        wr.writerow(header)
        wr.writerows(rows)
    print(f"  wrote {name:32s} {len(rows):>5d} rows")
    return path


# ---------------------------------------------------------------------------
# 1. ANALYSTS  (roster + capability + measured performance)
# ---------------------------------------------------------------------------
# Roles mirror app VALID_ROLES: admin / supervisor / reviewer / analyst.
# Capability flags say which stages a person is *qualified* to work — a reviewer
# can also annotate, a lead can do secondary_review, etc.
# Speeds are images/hour; avg_time_per_image_sec is just 3600/speed (kept explicit
# so teams don't have to derive it).  accuracy_pct is the CA "% not returned".

ANALYSTS = [
    # id     name                role        annot  review  sec   acc%  cap_h  tz         seniority   status    specialty
    ("a01", "Priya Nair",       "analyst",   True,  False, False, 96.5, 7.5, "AST",  "senior",   "active", "corrosion"),
    ("a02", "Diego Ramos",      "analyst",   True,  False, False, 91.0, 8.0, "AST",  "mid",      "active", "pole_crack"),
    ("a03", "Wei Chen",         "analyst",   True,  False, False, 88.5, 7.0, "AST",  "junior",   "active", "general"),
    ("a04", "Fatima Al-Sayed",  "analyst",   True,  True,  False, 94.0, 7.5, "AST",  "senior",   "active", "insulator"),
    ("a05", "Tom Bui",          "analyst",   True,  False, False, 83.0, 6.0, "AST",  "junior",   "active", "general"),
    ("a06", "Grace Okoro",      "analyst",   True,  True,  False, 92.5, 8.0, "AST",  "mid",      "active", "vegetation"),
    ("a07", "Liam Murphy",      "analyst",   True,  False, False, 90.0, 4.0, "AST",  "mid",      "pto",    "pole_crack"),
    ("a08", "Sara Kowalski",    "reviewer",  True,  True,  False, 95.5, 8.0, "GMT",  "senior",   "active", "corrosion"),
    ("a09", "Hassan Iqbal",     "reviewer",  True,  True,  True,  97.0, 8.0, "GMT",  "senior",   "active", "insulator"),
    ("a10", "Kyle Anders",      "supervisor",True,  True,  True,  98.0, 3.0, "AST",  "lead",     "active", "all"),
]

# annotation speed by seniority (images/hour) — reviewing is faster than annotating,
# secondary review faster still (fewer detections to touch).
ANNOT_SPEED = {"junior": 11.0, "mid": 15.0, "senior": 19.0, "lead": 22.0}
REVIEW_MULT = 2.1   # review throughput vs. that person's annotation throughput
SEC_MULT = 3.0      # secondary_review throughput vs. annotation throughput


def analyst_speeds(seniority):
    a = ANNOT_SPEED[seniority]
    return a, a * REVIEW_MULT, a * SEC_MULT


def build_analysts():
    header = [
        "analyst_id", "display_name", "role",
        "can_annotate", "can_review", "can_secondary_review",
        "annotation_img_per_hr", "review_img_per_hr", "secondary_review_img_per_hr",
        "avg_sec_per_image_annotation", "avg_sec_per_image_review",
        "accuracy_pct_not_returned", "daily_capacity_hours",
        "timezone", "seniority", "status", "specialty",
    ]
    rows = []
    meta = {}
    for (aid, name, role, ca, cr, cs, acc, cap, tz, sen, status, spec) in ANALYSTS:
        annot, review, sec = analyst_speeds(sen)
        rows.append([
            aid, name, role,
            ca, cr, cs,
            round(annot, 1), round(review, 1) if cr else "", round(sec, 1) if cs else "",
            round(3600 / annot), round(3600 / review) if cr else "",
            acc, cap, tz, sen, status, spec,
        ])
        meta[aid] = dict(
            name=name, role=role, can_annotate=ca, can_review=cr, can_secondary_review=cs,
            annot=annot, review=review, sec=sec, acc=acc, cap=cap,
            status=status, seniority=sen,
        )
    _w("analysts.csv", header, rows)
    return meta


# ---------------------------------------------------------------------------
# 2. STRUCTURES BACKLOG  (the work waiting to be scheduled — the "who does what")
# ---------------------------------------------------------------------------
# A structure = one asset (pole/tower) with a handful of images, tied to a
# request/org/powerline.  This is the assignment unit Kyle hand-picks today.

ORGS = [
    # org_name           powerlines                     request_ids
    ("maritime_electric", ["T1", "Y115", "L204", "K9"], [340, 341, 342]),
    ("nova_power",        ["NP-12", "NP-33"],           [355, 356]),
    ("atlantic_grid",     ["AG-Tx1", "AG-Tx4"],         [519]),
]
PRIORITIES = ["low", "normal", "normal", "normal", "high", "high", "urgent"]
STAGES = ["not_started", "annotation", "review", "secondary_review", "complete"]
# Current backlog distribution across stages (weights) — most work is early-pipeline.
STAGE_WEIGHTS = [0.34, 0.28, 0.18, 0.08, 0.12]


def active_ids(meta, need):
    return [a for a, m in meta.items() if m[need] and m["status"] == "active"]


def build_structures(meta):
    header = [
        "structure_id", "request_id", "org_name", "powerline_name", "environment",
        "image_count", "priority", "due_date", "ingested_at",
        "current_stage", "assigned_annotator", "assigned_reviewer",
        "assigned_secondary_reviewer", "returned_to_annotation_count",
    ]
    annotators = active_ids(meta, "can_annotate")
    reviewers = active_ids(meta, "can_review")
    sec_reviewers = active_ids(meta, "can_secondary_review")

    rows = []
    sid_counter = 107000
    for org, lines, requests in ORGS:
        n_struct = random.randint(45, 70)
        for _ in range(n_struct):
            sid_counter += random.randint(1, 4)
            sid = str(sid_counter)
            req = random.choice(requests)
            line = random.choice(lines)
            img_count = random.choice([4, 5, 6, 6, 7, 8, 9, 12])
            priority = random.choice(PRIORITIES)
            ingest = TODAY - timedelta(days=random.randint(0, 12))
            # tighter deadlines for higher priority
            slack = {"urgent": 2, "high": 4, "normal": 8, "low": 14}[priority]
            due = ingest + timedelta(days=slack + random.randint(0, 3))
            stage = random.choices(STAGES, weights=STAGE_WEIGHTS)[0]

            ann = rev = sec = ""
            returned = 0
            stage_idx = STAGES.index(stage)
            if stage_idx >= 1:  # has entered annotation
                ann = random.choice(annotators)
            if stage_idx >= 2:  # in/through review
                rev = random.choice([r for r in reviewers if r != ann] or reviewers)
                returned = random.choices([0, 0, 0, 1, 2], weights=[70, 12, 8, 7, 3])[0]
            if stage_idx >= 3:  # in/through secondary review
                sec = random.choice(sec_reviewers)
            if stage == "complete":
                # some completed structures were returned at least once en route
                returned = random.choices([0, 0, 1, 2], weights=[76, 10, 10, 4])[0]

            rows.append([
                sid, req, org, line, "prod",
                img_count, priority, due.isoformat(), ingest.isoformat(),
                stage, ann, rev, sec, returned,
            ])
    _w("structures_backlog.csv", header, rows)
    return rows


# ---------------------------------------------------------------------------
# 3. THROUGHPUT HISTORY  (trailing 30 days, per analyst per stage per day)
# ---------------------------------------------------------------------------
# Gives teams a real time series to fit throughput / accuracy / variance on,
# rather than a single static number.  images_returned drives the accuracy metric:
#   accuracy = 1 - returned/pushed   (annotation stage only, matching Threadr)


def build_throughput_history(meta):
    header = [
        "date", "analyst_id", "display_name", "stage",
        "images_pushed", "time_spent_minutes", "avg_sec_per_image",
        "images_returned", "day_accuracy_pct",
    ]
    rows = []
    for d in range(HISTORY_DAYS, 0, -1):
        day = TODAY - timedelta(days=d)
        weekend = day.weekday() >= 5
        for aid, m in meta.items():
            if m["status"] == "pto" and d < 6:
                continue  # on PTO for the last week
            # analysts split their day across the stages they're qualified for,
            # weighted toward annotation.
            stage_plan = []
            if m["can_annotate"]:
                stage_plan.append(("annotation", m["annot"], 0.6 if (m["can_review"] or m["can_secondary_review"]) else 1.0))
            if m["can_review"]:
                stage_plan.append(("review", m["review"], 0.3))
            if m["can_secondary_review"]:
                stage_plan.append(("secondary_review", m["sec"], 0.1))

            worked_hours = m["cap"] * (0.35 if weekend else random.uniform(0.82, 1.05))
            if worked_hours < 0.5:
                continue

            for stage, speed, share in stage_plan:
                hrs = worked_hours * share
                if hrs <= 0.1:
                    continue
                # day-to-day speed variance
                eff_speed = speed * random.uniform(0.85, 1.12)
                pushed = int(round(hrs * eff_speed))
                if pushed <= 0:
                    continue
                minutes = round(pushed / eff_speed * 60, 1)
                avg_sec = round(minutes * 60 / pushed)
                if stage == "annotation":
                    # returns tied to the analyst's true accuracy, with noise
                    ret_rate = (100 - m["acc"]) / 100.0
                    returned = 0
                    for _ in range(pushed):
                        if random.random() < ret_rate * random.uniform(0.7, 1.3):
                            returned += 1
                    day_acc = round((1 - returned / pushed) * 100, 1) if pushed else ""
                else:
                    returned = ""      # accuracy is an annotation-stage metric
                    day_acc = ""
                rows.append([
                    day.isoformat(), aid, m["name"], stage,
                    pushed, minutes, avg_sec, returned, day_acc,
                ])
    _w("throughput_history.csv", header, rows)
    return rows


# ---------------------------------------------------------------------------
# 4. QUEUE DEPTH  (30-day daily snapshot of work sitting in each stage)
# ---------------------------------------------------------------------------
# The "queue depth" signal: how many images are waiting in each stage at the
# start of each day, plus completions that day.  Trends upward into a backlog to
# make the volume scenario meaningful.


def build_queue_depth(rows_hist):
    header = [
        "date", "stage",
        "images_waiting", "images_in_progress", "images_completed_today",
        "structures_waiting", "oldest_waiting_days",
    ]
    # base queue at start of window, grows then spikes near the end
    base = {"annotation": 640, "review": 210, "secondary_review": 70}
    rows = []
    for d in range(HISTORY_DAYS, 0, -1):
        day = TODAY - timedelta(days=d)
        weekend = day.weekday() >= 5
        elapsed = HISTORY_DAYS - d
        surge = 1.0 + 0.02 * elapsed + (0.35 if d <= 4 else 0.0)  # backlog builds; late spike
        for stage in ("annotation", "review", "secondary_review", "complete"):
            if stage == "complete":
                completed = 0 if weekend else random.randint(120, 190)
                rows.append([day.isoformat(), stage, "", "", completed, "", ""])
                continue
            waiting = int(base[stage] * surge * random.uniform(0.95, 1.08))
            in_prog = 0 if weekend else random.randint(8, 26)
            completed = 0 if weekend else int(base[stage] * random.uniform(0.10, 0.16))
            structs = max(1, waiting // random.choice([5, 6, 7]))
            oldest = elapsed // 2 + random.randint(0, 4) + (3 if d <= 4 else 0)
            rows.append([
                day.isoformat(), stage,
                waiting, in_prog, completed, structs, oldest,
            ])
    _w("queue_depth.csv", header, rows)
    return rows


# ---------------------------------------------------------------------------
# 5. INCOMING VOLUME SCENARIO  (the "volume in")
# ---------------------------------------------------------------------------
# Forward-looking arrivals over the next 14 days across several orgs / powerlines,
# with a mix of priorities, sizes, arrival dates, and deadlines.


def build_volume_scenario():
    header = [
        "incoming_request_id", "arrival_date", "org_name", "powerline_name",
        "structure_count", "image_count", "priority", "due_date", "notes",
    ]
    rows = [
        [601, (TODAY + timedelta(days=1)).isoformat(), "maritime_electric", "T1",
         210, 1480, "urgent", (TODAY + timedelta(days=5)).isoformat(),
         "Post-storm reshoot; regulator deadline. Bulk arrives day 1."],
        [602, (TODAY + timedelta(days=2)).isoformat(), "maritime_electric", "Y115",
         85, 560, "high", (TODAY + timedelta(days=8)).isoformat(),
         "Scheduled quarterly inspection."],
        [603, (TODAY + timedelta(days=4)).isoformat(), "nova_power", "NP-12",
         60, 415, "normal", (TODAY + timedelta(days=12)).isoformat(),
         "Routine batch; corrosion-heavy."],
        [604, (TODAY + timedelta(days=6)).isoformat(), "atlantic_grid", "AG-Tx4",
         120, 940, "high", (TODAY + timedelta(days=11)).isoformat(),
         "New contract; structure ids labelled 'AG-Tx4 - NNN'."],
        [605, (TODAY + timedelta(days=9)).isoformat(), "maritime_electric", "L204",
         45, 300, "normal", (TODAY + timedelta(days=16)).isoformat(),
         "Trailing follow-up to req 601."],
    ]
    _w("incoming_volume_scenario.csv", header, rows)
    return rows


# ---------------------------------------------------------------------------
def main():
    print(f"Generating Threadr hackathon dataset (today={TODAY}, seed={SEED})")
    meta = build_analysts()
    build_structures(meta)
    hist = build_throughput_history(meta)
    build_queue_depth(hist)
    build_volume_scenario()
    print("Done. See hackathon/README.md for the data dictionary.")


if __name__ == "__main__":
    main()

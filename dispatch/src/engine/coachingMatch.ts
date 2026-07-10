import type { Analyst } from '../data/loadCsv'
import type { ScheduleResult } from './schedule'
import type { CoachingSignal } from './coaching'

export interface CoachMatch {
  learnerId: string
  learnerName: string
  learnerAcc: number
  learnerSpecialty: string
  focusDefects: string[] // defect areas below the proficiency bar — what they need help on
  primaryId: string
  primaryName: string
  reason: string
  consult: { coachId: string; coachName: string; defect: string } | null
}

export interface CoachingBudget {
  totalHours: number // coach-hours free for coaching, once all deadlines are safe
  byDay: number[] // free coach-hours per day across the window
  feasible: boolean // are all requests on time? (coaching budget is 0 if not)
  deferredFromIdx: number | null // first day index that actually has free capacity
}

const ACC_FLOOR = 90 // below this an analyst is a coaching learner
const COVER_FLOOR = 92 // proficiency bar used to score gap coverage
const SPECIALTY_BONUS = 4
const ALL_BONUS = 2
const SLOTS_PER_COACH = 2

// A qualified coach: active reviewer, strong enough, not a supervisor.
function isCoach(a: Analyst): boolean {
  return a.status === 'active' && a.canR && a.role !== 'supervisor' && a.acc >= COVER_FLOOR
}

// Coaching budget = spare coach-hours once every request is on time.
// Gated to 0 while any deadline is at risk — coaching never jumps the client queue.
export function computeCoachingBudget(result: ScheduleResult, analysts: Analyst[], coachIds?: Set<string>): CoachingBudget {
  const coachIdx = analysts
    .map((a, i) => (isCoach(a) && (!coachIds || coachIds.has(a.id)) ? i : -1))
    .filter((i) => i >= 0)
  const nDays = result.cap[0]?.length ?? 0
  const byDay = Array.from({ length: nDays }, (_, d) => coachIdx.reduce((n, ai) => n + Math.max(0, result.cap[ai][d]), 0))
  const feasible = Object.values(result.reqResults).every((rr) => rr.slack >= 0)
  const totalHours = feasible ? byDay.reduce((n, h) => n + h, 0) : 0
  const firstFree = byDay.findIndex((h) => h > 0.5)
  return { totalHours, byDay, feasible, deferredFromIdx: feasible && firstFree >= 0 ? firstFree : null }
}

// Suggested dedicated hours for a matched pair: ~1h on each day both mentor and
// learner have spare time, capped at 5h across the window.
export function suggestedHoursFor(result: ScheduleResult, analysts: Analyst[], m: CoachMatch): number {
  const byId: Record<string, number> = {}
  analysts.forEach((a, i) => (byId[a.id] = i))
  const ci = byId[m.primaryId]
  const li = byId[m.learnerId]
  if (ci == null || li == null) return 0
  const nDays = result.cap[0]?.length ?? 0
  let h = 0
  for (let d = 0; d < nDays; d++) h += Math.min(1, Math.max(0, result.cap[ci][d]), Math.max(0, result.cap[li][d]))
  return Math.min(5, Math.round(h))
}

export interface CoachingPlacement {
  coachReserve: number[][] // hours placed per analyst per day (for the chart)
  reservedTotal: number // hours actually placed into idle capacity
  overflowHours: number // requested hours that didn't fit without slipping a deadline
}

// Place `hPerDay` per mentee into each coach's LEFTOVER capacity (post-schedule),
// filling idle late days first. Coaching only uses genuine slack, so within-budget
// coaching never moves a deadline; anything that can't fit is reported as overflow.
export function placeCoaching(
  result: ScheduleResult,
  analysts: Analyst[],
  matches: CoachMatch[],
  hPerDay: number,
): CoachingPlacement {
  const byId: Record<string, number> = {}
  analysts.forEach((a, i) => (byId[a.id] = i))
  const nDays = result.cap[0]?.length ?? 0
  const coachReserve = analysts.map(() => Array.from({ length: nDays }, () => 0))
  let overflowHours = 0
  if (hPerDay > 0) {
    const menteesPerCoach: Record<string, number> = {}
    matches.forEach((m) => (menteesPerCoach[m.primaryId] = (menteesPerCoach[m.primaryId] || 0) + 1))
    Object.entries(menteesPerCoach).forEach(([cid, count]) => {
      const ai = byId[cid]
      if (ai == null) return
      const perDay = hPerDay * count
      for (let d = nDays - 1; d >= 0; d--) {
        const avail = Math.max(0, result.cap[ai][d])
        const take = Math.min(avail, perDay)
        coachReserve[ai][d] = take
        overflowHours += perDay - take
      }
    })
  }
  const reservedTotal = coachReserve.reduce((n, row) => n + row.reduce((m, h) => m + h, 0), 0)
  return { coachReserve, reservedTotal, overflowHours }
}

// skill(analyst, defect): overall accuracy, bumped where the analyst specializes.
function skill(a: Analyst, defect: string): number {
  let v = a.acc
  if (a.specialty === defect) v += SPECIALTY_BONUS
  else if (a.specialty === 'all') v += ALL_BONUS
  return Math.min(100, v)
}

// Match one primary coach per learner (+ optional specialist consult), capacity-aware.
// Uses only existing columns — `specialty` is the defect/domain axis.
export function matchCoaches(
  analysts: Analyst[],
  result: ScheduleResult,
  signals: CoachingSignal[],
): CoachMatch[] {
  // Defect universe = concrete specialties on the roster (exclude generalists).
  const defects = Array.from(
    new Set(analysts.map((a) => a.specialty).filter((sp) => sp !== 'all' && sp !== 'general')),
  )

  // Learners: active annotators below the accuracy floor, plus any active
  // annotator flagged with an accuracy dip by the history signal.
  const dipIds = new Set(signals.filter((s) => s.kind === 'acc').map((s) => s.id))
  const learners = analysts
    .filter((a) => a.status === 'active' && a.canA && (a.acc < ACC_FLOOR || dipIds.has(a.id)))
    .sort((x, y) => x.acc - y.acc)

  // Coaches: active reviewers strong enough to mentor. Capacity = review hours
  // still free in the ledger after the schedule was drawn.
  const byId: Record<string, number> = {}
  analysts.forEach((a, i) => (byId[a.id] = i))
  const capHours = (a: Analyst) => result.cap[byId[a.id]].reduce((n, h) => n + h, 0)
  // Supervisors run the room, not line-coaching — exclude them as primaries.
  const coaches = analysts
    .filter((a) => a.status === 'active' && a.canR && a.role !== 'supervisor' && a.acc >= COVER_FLOOR)
    .map((a) => ({ a, slots: SLOTS_PER_COACH, cap: capHours(a) }))
    .filter((c) => c.cap > 0.5)

  const matches: CoachMatch[] = []
  learners.forEach((L) => {
    const gapDefects = defects.filter((d) => skill(L, d) < COVER_FLOOR)
    const gaps = gapDefects.length ? gapDefects : defects
    const avail = coaches.filter((c) => c.slots > 0 && c.a.id !== L.id)
    if (!avail.length) return
    const cover = (c: (typeof coaches)[number]) => gaps.reduce((n, d) => n + Math.max(0, skill(c.a, d) - skill(L, d)), 0)
    const primary = [...avail].sort((x, y) => cover(y) - cover(x) || y.a.acc - x.a.acc || y.cap - x.cap)[0]
    primary.slots -= 1

    // Specialist consult: a different coach elite in a gap the primary doesn't specialize in.
    let consult: CoachMatch['consult'] = null
    let bestGain = 0
    gaps.forEach((d) => {
      if (primary.a.specialty === d) return
      coaches.forEach((c) => {
        if (c.a.id === primary.a.id || c.a.id === L.id) return
        if (c.a.specialty !== d) return
        const gain = skill(c.a, d) - skill(primary.a, d)
        if (gain >= 2 && gain > bestGain) {
          bestGain = gain
          consult = { coachId: c.a.id, coachName: c.a.name, defect: d }
        }
      })
    })

    const spec = primary.a.specialty === 'all' ? 'all-round' : primary.a.specialty.replace(/_/g, ' ')
    matches.push({
      learnerId: L.id,
      learnerName: L.name,
      learnerAcc: L.acc,
      learnerSpecialty: L.specialty,
      focusDefects: gaps,
      primaryId: primary.a.id,
      primaryName: primary.a.name,
      reason: `${primary.a.acc}% first-pass, ${spec} specialist — covers the widest span of ${L.name.split(' ')[0]}'s gaps and has review capacity to pair on the batches`,
      consult,
    })
  })
  return matches
}

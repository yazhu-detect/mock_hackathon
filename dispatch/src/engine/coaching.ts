import type { ThroughputRow } from '../data/loadCsv'

export interface CoachingSignal {
  id: string
  name: string
  kind: 'acc' | 'pace'
  score: number
  accR?: number
  accP?: number
  secR?: number
  secP?: number
  note: string
}

// Fit accuracy-dip / pace-drift signals from the 30-day throughput history:
// last 6 working days vs the prior window. Faithful port of deriveCoaching().
export function deriveCoaching(T: ThroughputRow[]): CoachingSignal[] {
  const byA: Record<string, { name: string; rows: ThroughputRow[] }> = {}
  T.filter((r) => r.stage === 'annotation').forEach((r) => {
    ;(byA[r.analyst_id] = byA[r.analyst_id] || { name: r.display_name, rows: [] }).rows.push(r)
  })
  const signals: CoachingSignal[] = []
  Object.entries(byA).forEach(([id, o]) => {
    const rows = o.rows.sort((a, b) => (a.date < b.date ? -1 : 1))
    const cut = rows.length - 6
    const recent = rows.slice(cut)
    const prior = rows.slice(0, cut)
    const avg = (rs: ThroughputRow[], k: string) =>
      rs.reduce((n, r) => n + (parseFloat(r[k]) || 0), 0) / (rs.length || 1)
    const accR = avg(recent, 'day_accuracy_pct')
    const accP = avg(prior, 'day_accuracy_pct')
    const secR = avg(recent, 'avg_sec_per_image')
    const secP = avg(prior, 'avg_sec_per_image')
    const accDrop = accP - accR
    const paceUp = secP > 0 ? ((secR - secP) / secP) * 100 : 0
    if (accDrop > 1.5)
      signals.push({
        id,
        name: o.name,
        kind: 'acc',
        score: accDrop,
        accR,
        accP,
        note: `First-pass accuracy averaged ${accR.toFixed(1)}% over the last 6 working days vs ${accP.toFixed(
          1,
        )}% before (−${accDrop.toFixed(
          1,
        )} pts). Returns re-enter the annotation queue, so the scheduler discounts throughput and routes the batch through a paired review.`,
      })
    else if (paceUp > 6)
      signals.push({
        id,
        name: o.name,
        kind: 'pace',
        score: paceUp / 4,
        secR,
        secP,
        note: `Avg time per image drifted to ${Math.round(secR)}s from ${Math.round(secP)}s (+${paceUp.toFixed(
          0,
        )}%). Suggested a shortcut refresher — historically recovers most of the gap within a week.`,
      })
  })
  return signals.sort((a, b) => b.score - a.score).slice(0, 3)
}

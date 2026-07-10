import { DAYS, N_DAYS } from './days'
import type { Analyst, RequestRow, Backlog } from '../data/loadCsv'

export type Stage = 'A' | 'R' | 'S'

export interface Draw {
  req: string
  stage: Stage
  aid: string
  day: number
  hours: number
  imgs: number
}

export interface Batch {
  key: string
  req: string
  stage: Stage
  aid: string
  imgs: number
  hours: number
  start: number
  end: number
}

export interface ReqResult {
  etaIdx: number | null
  slack: number
  unfinished: number
}

export interface ScheduleResult {
  draws: Draw[]
  batches: Batch[]
  reqResults: Record<string, ReqResult>
  cap: number[][]
  capTotal: number[]
  reserve: number[][]
}

// A booked 1-hour coaching session that carves an hour out of both the
// learner's and the coach's day, and shows up on the chart / timeline.
export interface Session {
  sigId: string
  strugglerId: string
  coachId: string
  day: number
  label: string | null
}

// Hours available for analyst `a` on day `dayIdx`, honoring PTO + weekends,
// then deducting any booked 1h coaching session that involves this analyst.
export function hoursFor(a: Analyst, dayIdx: number, weekendOT: boolean, sessions: Session[] = []): number {
  if (a.status === 'pto' && dayIdx < 6) return 0 // a07 back Jul 16
  let h = DAYS[dayIdx].isWeekend ? (weekendOT ? a.hours * 0.5 : 0) : a.hours
  for (const sn of sessions) {
    if (sn.day === dayIdx && (sn.strugglerId === a.id || sn.coachId === a.id)) h = Math.max(0, h - 1)
  }
  return h
}

// Deterministic greedy scheduler — faithful port of the design's schedule().
export function schedule(
  analysts: Analyst[],
  requests: RequestRow[],
  backlog: Backlog,
  weekendOT: boolean,
  deniedKeys: string[],
  secondarySamplePct: number,
  sessions: Session[] = [],
): ScheduleResult {
  const days = DAYS
  const N = N_DAYS
  const denied = new Set(deniedKeys)
  const samplePct = secondarySamplePct / 100

  const byId: Record<string, number> = {}
  analysts.forEach((a, i) => (byId[a.id] = i))

  // capacity ledger (hours) — booked coaching sessions are already carved out
  const cap = analysts.map((a) => days.map((_, i) => hoursFor(a, i, weekendOT, sessions)))
  const capTotal = days.map((_, i) => analysts.reduce((n, _a, ai) => n + cap[ai][i], 0))

  // backlog reserve, spread over first 6 working days
  const rates = { A: 15, R: 38, S: 58 }
  const blHours = { A: backlog.A / rates.A, R: backlog.R / rates.R, S: backlog.S / rates.S }
  const wDays: number[] = []
  for (let i = 0; i < N && wDays.length < 6; i++) if (!days[i].isWeekend) wDays.push(i)
  const reserve = analysts.map(() => days.map(() => 0))
  ;(['A', 'R', 'S'] as Stage[]).forEach((st) => {
    const qual = analysts
      .map((a, ai) => ((st === 'A' ? a.canA : st === 'R' ? a.canR : a.canS) ? ai : -1))
      .filter((x) => x >= 0)
    wDays.forEach((d) => {
      const need = blHours[st] / wDays.length
      const totQ = qual.reduce((n, ai) => n + cap[ai][d], 0) || 1
      qual.forEach((ai) => {
        const take = Math.min(cap[ai][d], ((need * cap[ai][d]) / totQ) * 1.0)
        cap[ai][d] -= take
        reserve[ai][d] += take
      })
    })
  })

  // orderings
  const netA = (a: Analyst) => (a.rateA * a.acc) / 100
  const annOrder = analysts
    .filter((a) => a.canA)
    .sort((x, y) => {
      const w = (a: Analyst) =>
        a.role === 'analyst' && !a.canR ? 0 : a.role === 'analyst' ? 1 : a.role === 'reviewer' ? 2 : 3
      return w(x) - w(y) || netA(y) - netA(x)
    })
  const revOrder = analysts
    .filter((a) => a.canR)
    .sort((x, y) => {
      const w = (a: Analyst) => (a.role === 'reviewer' ? 0 : a.role === 'analyst' ? 1 : 2)
      return w(x) - w(y) || y.rateR - x.rateR
    })
  const secOrder = analysts.filter((a) => a.canS).sort((x, y) => y.rateS - x.rateS)

  const draws: Draw[] = []
  const reqOrder = [...requests].sort((x, y) => {
    const pr: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
    return pr[x.priority] - pr[y.priority] || x.dueIdx - y.dueIdx
  })
  const reqResults: Record<string, ReqResult> = {}
  reqOrder.forEach((req) => {
    const annCum = new Array(N).fill(0)
    const revCum = new Array(N).fill(0)
    let remA = req.images
    let remR = req.images
    const secTarget = Math.round(req.images * samplePct)
    let remS = secTarget
    let lastDay = req.arrIdx
    for (let d = req.arrIdx; d < N; d++) {
      // annotation
      if (remA >= 1)
        for (const a of annOrder) {
          if (denied.has(req.id + '|A|' + a.id)) continue
          const ai = byId[a.id]
          const h = cap[ai][d]
          if (h <= 0.05) continue
          const nr = netA(a)
          const take = Math.min(remA, h * nr)
          if (take < 1) continue
          cap[ai][d] -= take / nr
          remA -= take
          annCum[d] += take
          draws.push({ req: req.id, stage: 'A', aid: a.id, day: d, hours: take / nr, imgs: take })
          lastDay = d
          if (remA < 1) break
        }
      // review (of previously annotated)
      const annPrev = annCum.slice(0, d).reduce((n, v) => n + v, 0)
      let availR = Math.max(0, annPrev - (req.images - remR))
      if (remR >= 1 && availR >= 1)
        for (const a of revOrder) {
          if (denied.has(req.id + '|R|' + a.id)) continue
          const ai = byId[a.id]
          const h = cap[ai][d]
          if (h <= 0.05) continue
          const take = Math.min(remR, availR, h * a.rateR)
          if (take < 1) continue
          cap[ai][d] -= take / a.rateR
          remR -= take
          availR -= take
          revCum[d] += take
          draws.push({ req: req.id, stage: 'R', aid: a.id, day: d, hours: take / a.rateR, imgs: take })
          lastDay = d
          if (remR < 1 || availR < 1) break
        }
      // secondary sample (of previously reviewed)
      const revPrev = revCum.slice(0, d).reduce((n, v) => n + v, 0)
      let availS = Math.max(0, revPrev * samplePct - (secTarget - remS))
      if (remS >= 1 && availS >= 1)
        for (const a of secOrder) {
          if (denied.has(req.id + '|S|' + a.id)) continue
          const ai = byId[a.id]
          const h = cap[ai][d]
          if (h <= 0.05) continue
          const take = Math.min(remS, availS, h * a.rateS)
          if (take < 1) continue
          cap[ai][d] -= take / a.rateS
          remS -= take
          availS -= take
          draws.push({ req: req.id, stage: 'S', aid: a.id, day: d, hours: take / a.rateS, imgs: take })
          lastDay = d
          if (remS < 1 || availS < 1) break
        }
    }
    const done = remA < 1 && remR < 1 && remS < 1
    reqResults[req.id] = {
      etaIdx: done ? lastDay : null,
      slack: done ? req.dueIdx - lastDay : -99,
      unfinished: Math.round(remA + remR + remS),
    }
  })

  // batches
  const bmap: Record<string, Batch> = {}
  draws.forEach((dr) => {
    const k = dr.req + '|' + dr.stage + '|' + dr.aid
    const b = (bmap[k] =
      bmap[k] || { key: k, req: dr.req, stage: dr.stage, aid: dr.aid, imgs: 0, hours: 0, start: dr.day, end: dr.day })
    b.imgs += dr.imgs
    b.hours += dr.hours
    b.start = Math.min(b.start, dr.day)
    b.end = Math.max(b.end, dr.day)
  })
  const batches = Object.values(bmap)
    .filter((b) => b.imgs >= 5)
    .sort((x, y) => x.start - y.start || x.req.localeCompare(y.req))

  return { draws, batches, reqResults, cap, capTotal, reserve }
}

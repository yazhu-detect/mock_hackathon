import React from 'react'
import { Link } from 'react-router-dom'
import './dispatch.css'
import { DAYS } from '../engine/days'
import { loadDispatchData, type Analyst, type RequestRow, type Backlog } from '../data/loadCsv'
import { schedule, hoursFor, type ScheduleResult } from '../engine/schedule'
import { deriveCoaching, type CoachingSignal } from '../engine/coaching'
import { matchCoaches, computeCoachingBudget, suggestedHoursFor, placeCoaching, type CoachMatch } from '../engine/coachingMatch'
import { REQ_COLORS, BACKLOG_COLOR, STAGE_NAMES, STAGE_COLORS, DEFAULT_SECONDARY_SAMPLE_PCT } from '../engine/constants'

interface Msg { role: 'user' | 'ai'; text: string }

interface State {
  ready: boolean
  input: string
  typing: boolean
  intake: boolean
  phase: 'idle' | 'proposed'
  weekendOT: boolean
  denied: string[]
  decisions: Record<string, 'accepted' | 'denied'>
  expanded: Record<string, 'why' | 'structs' | null>
  openGroups: Record<string, boolean>
  messages: Msg[]
  result: ScheduleResult | null
  coachingHoursPerDay: number
}

const SAMPLE_PCT = DEFAULT_SECONDARY_SAMPLE_PCT
const SHOW_COACHING = true
const days = DAYS

export default class Dispatch extends React.Component<{}, State> {
  chatEl = React.createRef<HTMLDivElement>()
  analysts: Analyst[] = []
  requests: RequestRow[] = []
  backlog: Backlog = { A: 0, R: 0, S: 0 }
  coaching: CoachingSignal[] = []

  state: State = {
    ready: false,
    input: '',
    typing: false,
    intake: false,
    phase: 'idle',
    weekendOT: false,
    denied: [],
    decisions: {},
    expanded: {},
    openGroups: {},
    messages: [],
    result: null,
    coachingHoursPerDay: 0,
  }

  componentDidMount() {
    loadDispatchData()
      .then((d) => {
        this.analysts = d.analysts
        this.requests = d.requests
        this.backlog = d.backlog
        this.coaching = deriveCoaching(d.throughput)
        const blTotal = this.backlog.A + this.backlog.R + this.backlog.S
        this.setState({
          ready: true,
          messages: [
            {
              role: 'ai',
              text: `Morning. Roster loaded: ${this.analysts.filter((a) => a.status === 'active').length} active analysts — Liam Murphy is on PTO through Jul 15. ${blTotal.toLocaleString()} backlog images are still in flight; I've reserved capacity to burn those down first.\n\nNo incoming volume on the books yet. Tell me what's landing — paste the intake or drop the volume sheet — and I'll size it against team capacity.`,
            },
          ],
        })
      })
      .catch(() => {
        this.setState({
          ready: true,
          messages: [{ role: 'ai', text: 'Could not load the Threadr data files from data/ — check that the CSVs are present.' }],
        })
      })
  }

  componentDidUpdate() {
    const el = this.chatEl.current
    if (el) el.scrollTop = el.scrollHeight
  }

  reqById(id: string) { return this.requests.find((r) => r.id === id)! }
  aById(id: string) { return this.analysts.find((a) => a.id === id)! }

  runSchedule(weekendOT: boolean, denied: string[]): ScheduleResult {
    return schedule(this.analysts, this.requests, this.backlog, weekendOT, denied, SAMPLE_PCT)
  }

  // Coaching draws only from leftover/idle capacity, so it never moves a deadline;
  // changing the hours just re-places into slack (no reschedule).
  setCoaching(h: number) {
    const hours = Math.max(0, Math.min(4, Math.round(h * 2) / 2))
    const src = this.state.result ?? this.runSchedule(this.state.weekendOT, this.state.denied)
    const matches = matchCoaches(this.analysts, src, this.coaching)
    const plan = placeCoaching(src, this.analysts, matches, hours)
    const menteeCount = new Set(matches.map((m) => m.learnerId)).size
    const note =
      hours === 0
        ? 'Cleared the dedicated coaching time — nothing reserved.'
        : plan.overflowHours > 1
          ? `Reserved ~${Math.round(plan.reservedTotal)}h of dedicated coaching for ${menteeCount} analysts, drawn from idle capacity — client deadlines untouched. Your mentors are near-full through the surge, so most sessions land Jul 14+; bump the hours further or add overtime to fit more.`
          : `Reserved ~${Math.round(plan.reservedTotal)}h of dedicated coaching for ${menteeCount} analysts, drawn from idle late-window capacity — every client deadline stays intact.`
    this.setState((s) => ({ coachingHoursPerDay: hours, messages: [...s.messages, { role: 'ai', text: note }] }))
  }

  runAndStore(
    weekendOT: boolean,
    denied: string[],
    decisions: Record<string, 'accepted' | 'denied'>,
    extraMsgFn?: (r: ScheduleResult) => string,
  ) {
    const result = this.runSchedule(weekendOT, denied)
    this.setState((s) => ({
      result,
      phase: 'proposed',
      weekendOT,
      denied,
      decisions,
      typing: false,
      messages: extraMsgFn ? [...s.messages, { role: 'ai', text: extraMsgFn(result) }] : s.messages,
    }))
  }

  describeResult(result: ScheduleResult, intro: string, weekendOT: boolean): string {
    const lines = this.requests.map((r) => {
      const rr = result.reqResults[r.id]
      const eta = rr.etaIdx === null ? 'does not finish in window' : 'ETA ' + days[rr.etaIdx].label
      const slack = rr.etaIdx === null ? '' : rr.slack < 0 ? ` — ${-rr.slack}d LATE` : rr.slack === 0 ? ' — zero slack' : ` — ${rr.slack}d slack`
      return `Req ${r.id} ${r.line} (${r.priority}): ${eta}${slack}`
    })
    const late = this.requests.filter((r) => result.reqResults[r.id].slack < 1)
    let tail = ''
    if (late.length && !weekendOT)
      tail = `\n\n${late.map((r) => 'Req ' + r.id).join(', ')} ${late.length > 1 ? 'are' : 'is'} at risk — the Jul 11–12 weekend is idle. Authorizing weekend overtime (half-days) would recover it. Say the word.`
    else if (!late.length) tail = '\n\nEverything lands inside its deadline. Review the batches — accept or deny and I’ll rebalance live.'
    return `${intro}\n\n${lines.join('\n')}${tail}`
  }

  sendPrompt(kind: string, label: string) {
    this.setState((s) => ({ messages: [...s.messages, { role: 'user', text: label }], typing: true }))
    setTimeout(() => {
      if (kind === 'intake') {
        const totImg = this.requests.reduce((n, q) => n + q.images, 0)
        const totStr = this.requests.reduce((n, q) => n + q.structures, 0)
        const lines = this.requests.map(
          (q) =>
            `Req ${q.id} · ${q.line} (${q.org.replace(/_/g, ' ')}): ${q.images.toLocaleString()} imgs / ${q.structures} structures, ${q.priority}, lands ${days[q.arrIdx].label}, due ${days[q.dueIdx] ? days[q.dueIdx].label : 'Jul 25'}`,
        )
        this.setState((s) => ({
          typing: false,
          intake: true,
          messages: [
            ...s.messages,
            {
              role: 'ai',
              text: `Parsed the intake — ${this.requests.length} requests, ${totImg.toLocaleString()} images across ${totStr} structures, arriving Jul 10–18:\n\n${lines.join('\n')}\n\nThe chart now shows Friday's post-storm surge breaching available hours on its own. Want me to draft the full 14-day schedule?`,
            },
          ],
        }))
      } else if (kind === 'assign') {
        this.runAndStore(this.state.weekendOT, this.state.denied, this.state.decisions, (result) => {
          const nb = result.batches.length
          return this.describeResult(
            result,
            `Scheduled all 5 requests across ${nb} batches, honoring qualifications, PTO, weekends, and the backlog reserve. Throughput is rework-adjusted — an analyst's rate is discounted by their first-pass accuracy, since returns re-enter the queue.`,
            this.state.weekendOT,
          )
        })
      } else if (kind === 'ot') {
        this.runAndStore(true, this.state.denied, this.state.decisions, (result) =>
          this.describeResult(result, 'Weekend overtime authorized — Sat/Sun run at half capacity. Recomputed:', true),
        )
      } else if (kind === 'risk') {
        const r = this.state.result
        let text: string
        if (!r) text = 'Nothing is scheduled yet — ask me to schedule the incoming volume first.'
        else {
          const risky = this.requests.filter((q) => r.reqResults[q.id].slack < 1)
          text = risky.length
            ? 'At risk right now:\n\n' +
              risky
                .map((q) => {
                  const rr = r.reqResults[q.id]
                  return (
                    `Req ${q.id} ${q.line} (${q.priority}, due ${days[q.dueIdx] ? days[q.dueIdx].label : 'Jul 25'}): ` +
                    (rr.etaIdx === null ? `${rr.unfinished} images don’t fit in the window.` : rr.slack < 0 ? `lands ${-rr.slack}d late.` : 'zero slack — any return cascade slips it.')
                  )
                })
                .join('\n') +
              (this.state.weekendOT ? '' : '\n\nBiggest lever: weekend overtime on Jul 11–12.')
            : 'Nothing is late. Tightest request is ' +
              this.requests.map((q) => ({ q, s: r.reqResults[q.id].slack })).sort((a, b) => a.s - b.s)[0].q.line +
              ' — I’ll alert you if anyone’s pace drops below plan.'
        }
        this.setState((s) => ({ typing: false, messages: [...s.messages, { role: 'ai', text }] }))
      } else if (kind === 'coach') {
        const base = this.runSchedule(this.state.weekendOT, this.state.denied)
        const matches = matchCoaches(this.analysts, base, this.coaching)
        const budget = computeCoachingBudget(base, this.analysts, new Set(matches.map((m) => m.primaryId)))
        const suggested = matches.reduce((n, m) => n + suggestedHoursFor(base, this.analysts, m), 0)
        let text: string
        if (!matches.length && !this.coaching.length) text = 'No significant accuracy or pace drift in the last week.'
        else {
          const pairings = matches
            .map((m) => {
              const weak =
                m.learnerSpecialty === 'general' || m.learnerSpecialty === 'all' || m.focusDefects.length >= 4
                  ? 'all defect types (no specialty yet)'
                  : m.focusDefects.map((d) => d.replace(/_/g, ' ')).join(', ')
              const consult = m.consult ? ` Consult ${m.consult.coachName} on ${m.consult.defect.replace(/_/g, ' ')}.` : ''
              return `${m.learnerName} — needs help on ${weak} → primary coach ${m.primaryName} (${m.reason}).${consult}`
            })
            .join('\n\n')
          let budgetLine: string
          if (!budget.feasible)
            budgetLine =
              'Coaching budget right now: 0h — some requests are still at risk, so every hour is committed to client work. Clear the deadlines first (authorize weekend overtime) and I’ll open coaching capacity.'
          else {
            const opens =
              budget.deferredFromIdx != null && budget.deferredFromIdx > 0
                ? ` Capacity opens up from ${days[budget.deferredFromIdx].label} once the surge clears.`
                : ''
            budgetLine = `Coaching budget: ~${Math.round(budget.totalHours)}h of mentor time free once all deadlines are safe.${opens} A suggested ~1h/day per analyst needs ${suggested}h — ${suggested <= budget.totalHours ? 'fits inside the budget' : 'exceeds it, so stagger it or add overtime'}. Use the coaching stepper to reserve it and I’ll show any deadline impact.`
          }
          text =
            'Coaching plan — one primary coach per analyst who needs support, matched on defect specialty and review capacity:\n\n' +
            pairings +
            '\n\n' +
            budgetLine
        }
        this.setState((s) => ({ typing: false, messages: [...s.messages, { role: 'ai', text }] }))
      } else {
        this.setState((s) => ({
          typing: false,
          messages: [...s.messages, { role: 'ai', text: 'In the full build I’d parse that against live Threadr data. For the demo, try a quick prompt below — start by scheduling the incoming volume.' }],
        }))
      }
    }, 1000)
  }

  decide(key: string, accepted: boolean) {
    if (accepted) {
      this.setState((s) => ({ decisions: { ...s.decisions, [key]: 'accepted' } }))
    } else {
      const denied = [...this.state.denied, key]
      const decisions = { ...this.state.decisions }
      delete decisions[key]
      const [reqId, stage, aid] = key.split('|')
      const a = this.aById(aid)
      this.setState((s) => ({ messages: [...s.messages, { role: 'user', text: `Deny ${a.name} on req ${reqId} ${STAGE_NAMES[stage].toLowerCase()}` }], typing: true }))
      setTimeout(() => {
        this.runAndStore(this.state.weekendOT, denied, decisions, (result) => {
          const rr = result.reqResults[reqId]
          const eta = rr.etaIdx === null ? 'no longer finishing in the window' : 'ETA now ' + days[rr.etaIdx].label + (rr.slack < 0 ? ` (${-rr.slack}d late)` : ` (${rr.slack}d slack)`)
          return `Pulled ${a.name.split(' ')[0]} off req ${reqId} ${STAGE_NAMES[stage].toLowerCase()} and recomputed the whole plan — req ${reqId} is ${eta}. Chart and timeline updated.`
        })
      }, 800)
    }
  }

  render() {
    const s = this.state
    if (!s.ready) {
      return (
        <div data-theme="dark" style={{ minHeight: '100vh', background: 'var(--app-bg)', color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Instrument Sans', sans-serif" }}>
          Loading Threadr data…
        </div>
      )
    }

    const r = s.result
    const proposed = s.phase === 'proposed' && !!r
    const totImg = this.requests.reduce((n, q) => n + q.images, 0)
    const totStr = this.requests.reduce((n, q) => n + q.structures, 0)

    // ---- KPIs ----
    const acceptedImgs = proposed ? r!.batches.filter((b) => b.stage === 'A' && s.decisions[b.key] === 'accepted').reduce((n, b) => n + b.imgs, 0) : 0
    const schedImgs = proposed ? r!.batches.filter((b) => b.stage === 'A').reduce((n, b) => n + b.imgs, 0) : 0
    const riskCount = proposed ? this.requests.filter((q) => r!.reqResults[q.id].slack < 1).length : 0
    const blTotal = this.backlog.A + this.backlog.R + this.backlog.S
    const kpiRows = [
      { label: 'INCOMING VOLUME', value: s.intake ? totImg.toLocaleString() : '—', sub: s.intake ? totStr + ' structures · 5 requests · Jul 10–18' : 'Awaiting intake — tell the assistant', color: 'var(--fg)' },
      { label: 'TEAM SUPPLY', value: this.analysts.filter((a) => a.status === 'active').length + ' active', sub: blTotal.toLocaleString() + ' backlog imgs reserved first', color: 'var(--fg)' },
      { label: 'SCHEDULED', value: proposed ? Math.round(schedImgs).toLocaleString() + ' / ' + totImg.toLocaleString() : '—', sub: proposed ? Math.round(acceptedImgs).toLocaleString() + ' accepted so far' : 'Ask the assistant to schedule', color: proposed && schedImgs >= totImg - 5 ? 'var(--sev-low)' : 'var(--fg)' },
      { label: 'AT RISK', value: proposed ? String(riskCount) : '—', sub: proposed ? (riskCount ? 'requests with <1 day slack' : 'all requests have slack') : 'Appears after scheduling', color: proposed ? (riskCount ? 'var(--sev-high)' : 'var(--sev-low)') : 'var(--fg)' },
    ]

    // ---- Requests strip ----
    const prioStyle: Record<string, [string, string, string]> = {
      urgent: ['URGENT', 'var(--sev-critical-bg)', 'var(--sev-critical)'],
      high: ['HIGH', 'var(--sev-high-bg)', 'var(--sev-high)'],
      normal: ['NORMAL', 'var(--icon-blue-bg)', 'var(--cobalt-blue)'],
      low: ['LOW', 'var(--surface-subtle)', 'var(--fg-subtle)'],
    }
    const requestRows = (s.intake ? this.requests : []).map((q) => {
      const ps = prioStyle[q.priority]
      let slackLabel = 'Unscheduled', slackBg = 'var(--surface-subtle)', slackColor = 'var(--fg-subtle)'
      if (proposed) {
        const rr = r!.reqResults[q.id]
        if (rr.etaIdx === null) { slackLabel = 'Overflow'; slackBg = 'var(--sev-critical-bg)'; slackColor = 'var(--sev-critical)' }
        else if (rr.slack < 0) { slackLabel = -rr.slack + 'd late'; slackBg = 'var(--sev-critical-bg)'; slackColor = 'var(--sev-critical)' }
        else if (rr.slack === 0) { slackLabel = 'Zero slack'; slackBg = 'var(--sev-high-bg)'; slackColor = 'var(--sev-high)' }
        else { slackLabel = 'ETA ' + days[rr.etaIdx].label; slackBg = 'var(--sev-low-bg)'; slackColor = 'var(--sev-low)' }
      }
      return {
        id: q.id, color: REQ_COLORS[q.id], title: q.id + ' · ' + q.line,
        prio: ps[0], prioBg: ps[1], prioColor: ps[2],
        volume: q.images.toLocaleString() + ' imgs · ' + q.structures + ' structures · ' + q.org.replace(/_/g, ' '),
        window: 'Lands ' + days[q.arrIdx].label + ' → due ' + (days[q.dueIdx] ? days[q.dueIdx].label : 'Jul 25'),
        slackLabel, slackBg, slackColor,
      }
    })

    // ---- Coaching matching + budget (computed early; used by chart + coaching section) ----
    // Matches + budget come from the coaching-free schedule so they're stable and
    // available even before the user clicks "schedule everything".
    const baseline = this.runSchedule(s.weekendOT, s.denied)
    const matches: CoachMatch[] = matchCoaches(this.analysts, baseline, this.coaching)
    const primaryIds = new Set(matches.map((m) => m.primaryId))
    const budget = computeCoachingBudget(baseline, this.analysts, primaryIds)
    const suggestedTotal = matches.reduce((n, m) => n + suggestedHoursFor(baseline, this.analysts, m), 0)
    // Overlay dedicated coaching into leftover capacity (no reschedule; never moves a deadline).
    const coachingPlan = placeCoaching(r ?? baseline, this.analysts, matches, s.coachingHoursPerDay)
    const reservedTotal = coachingPlan.reservedTotal

    // ---- Chart ----
    let chartCols: any[] = []
    let chartCaption = ''
    const capTotalIdle = days.map((_, i) => this.analysts.reduce((n, a) => n + hoursFor(a, i, s.weekendOT), 0))
    let demand: { BL: number; A: number; R: number; S: number; CO: number }[]
    if (proposed) {
      chartCaption = 'Scheduled hours per day, stacked by stage — recomputes on every accept/deny'
      demand = days.map((_, d) => {
        const seg = { BL: 0, A: 0, R: 0, S: 0, CO: 0 }
        r!.reserve.forEach((row) => (seg.BL += row[d]))
        coachingPlan.coachReserve.forEach((row) => (seg.CO += row[d]))
        r!.draws.forEach((dr) => { if (dr.day === d) seg[dr.stage] += dr.hours })
        return seg
      })
    } else {
      chartCaption = s.intake
        ? 'Naive demand: hours needed if each request were worked on its arrival day — the problem, visualized'
        : 'Available hours vs backlog burn-down — no incoming volume on the books yet'
      demand = days.map(() => ({ BL: 0, A: 0, R: 0, S: 0, CO: 0 }))
      const blH = (this.backlog.A / 15 + this.backlog.R / 38 + this.backlog.S / 58) / 6
      let w = 0
      days.forEach((dy, i) => { if (!dy.isWeekend && w < 6) { demand[i].BL = blH; w++ } })
      if (s.intake) this.requests.forEach((q) => { demand[q.arrIdx].A += q.images / 16; demand[q.arrIdx].R += q.images / 40 })
    }
    const segTot = (x: { BL: number; A: number; R: number; S: number; CO: number }) => x.BL + x.A + x.R + x.S + x.CO
    const maxV = Math.max(...days.map((_, i) => Math.max(capTotalIdle[i], segTot(demand[i]))), 1) * 1.1
    chartCols = days.map((dy, i) => {
      const segs = (['S', 'R', 'A', 'CO', 'BL'] as const)
        .filter((k) => demand[i][k] > 0.2)
        .map((k) => ({ pct: ((demand[i][k] / maxV) * 100).toFixed(1) + '%', color: STAGE_COLORS[k], title: (k === 'BL' ? 'Backlog' : STAGE_NAMES[k]) + ': ' + demand[i][k].toFixed(1) + 'h' }))
      const tot = segTot(demand[i])
      return {
        label: dy.short, labelColor: dy.isWeekend ? 'var(--fg-subtle)' : 'var(--fg-muted)',
        bg: dy.isWeekend ? 'var(--surface-sunken)' : 'var(--surface-subtle)',
        segs,
        capPct: ((capTotalIdle[i] / maxV) * 100).toFixed(1) + '%',
        capColor: tot > capTotalIdle[i] + 0.5 ? 'var(--sev-critical)' : 'var(--fg-muted)',
        capTitle: 'Available: ' + capTotalIdle[i].toFixed(0) + 'h',
        title: dy.label + ' — demand ' + tot.toFixed(0) + 'h vs ' + capTotalIdle[i].toFixed(0) + 'h available',
      }
    })
    const chartLegend = [
      { color: BACKLOG_COLOR, label: 'Backlog burn-down' },
      { color: '#2FBFA8', label: 'Annotation' },
      { color: '#E07BB2', label: 'Review' },
      { color: '#E0B84D', label: 'Secondary review' },
      { color: '#CEFF00', label: 'Coaching (reserved)' },
    ]

    // ---- Batches ----
    const batchRows = !proposed
      ? []
      : r!.batches.map((b) => {
          const q = this.reqById(b.req)
          const a = this.aById(b.aid)
          const isAccepted = s.decisions[b.key] === 'accepted'
          const isResolved = s.decisions[b.key] === 'accepted' || s.decisions[b.key] === 'denied'
          const isPending = !isResolved
          const netRate = b.stage === 'A' ? (a.rateA * a.acc) / 100 : b.stage === 'R' ? a.rateR : a.rateS
          const imgs = Math.round(b.imgs)
          const structs = Math.max(1, Math.round(imgs / (q.images / q.structures)))
          const exp = s.expanded[b.key]
          const whyLines = [
            `${b.stage === 'A' ? a.rateA : b.stage === 'R' ? a.rateR : a.rateS} img/hr` + (b.stage === 'A' ? ` × ${a.acc}% first-pass = ${netRate.toFixed(1)} net img/hr` : ' measured over 30 days'),
            `${b.hours.toFixed(1)}h drawn across ${b.end - b.start + 1} day(s), inside ${a.hours}h/day capacity`,
            `Qualified: ${(['canA', 'canR', 'canS'] as const).filter((k) => a[k]).map((k) => (k === 'canA' ? 'annotation' : k === 'canR' ? 'review' : 'secondary')).join(', ')} · ${a.seniority} · ${a.specialty.replace(/_/g, ' ')}`,
            b.stage === 'A' && a.acc < 90 ? 'Accuracy discount applied — batch routed through paired review' : `Backlog reserve already deducted from ${a.name.split(' ')[0]}’s hours`,
          ]
          const perStruct = Math.max(1, Math.round(q.images / q.structures))
          const structItems: string[] = []
          for (let i = 0; i < Math.min(structs, 8); i++) structItems.push(`${q.line}-${String(i + 1).padStart(3, '0')} · ${perStruct} imgs`)
          if (structs > 8) structItems.push('+' + (structs - 8) + ' more')
          return {
            key: b.key, req: b.req, imgsRaw: imgs, reqColor: REQ_COLORS[b.req],
            analyst: a.name, reqLabel: 'Req ' + b.req + ' · ' + q.line, stageLabel: STAGE_NAMES[b.stage],
            countLabel: imgs.toLocaleString() + ' imgs', structLabel: '~' + structs + ' structures',
            reason: `${netRate.toFixed(1)} net img/hr puts ${a.name.split(' ')[0]} ${b.stage === 'A' ? 'among the fastest qualified annotators' : 'on the ' + STAGE_NAMES[b.stage].toLowerCase() + ' wave'} for this window · ${a.specialty === 'all' ? 'supervisor overflow' : a.specialty.replace(/_/g, ' ') + ' specialty'}.`,
            window: days[b.start].label + (b.end > b.start ? ' – ' + days[b.end].label : ''),
            whyOpen: exp === 'why', structsOpen: exp === 'structs',
            whyBtn: exp === 'why' ? 'Hide math' : 'Why?', structsBtn: exp === 'structs' ? 'Hide structures' : 'Structures',
            whyLines, structItems,
            isPending, isResolved,
            statusLabel: isAccepted ? '✓ Accepted' : 'Denied', statusColor: 'var(--sev-low)',
            borderColor: isAccepted ? 'rgba(69, 208, 138, 0.45)' : 'var(--border)', opacity: 1,
            accept: () => this.decide(b.key, true),
            deny: () => this.decide(b.key, false),
            toggleWhy: () => this.setState((st) => ({ expanded: { ...st.expanded, [b.key]: st.expanded[b.key] === 'why' ? null : 'why' } })),
            toggleStructs: () => this.setState((st) => ({ expanded: { ...st.expanded, [b.key]: st.expanded[b.key] === 'structs' ? null : 'structs' } })),
          }
        })
    const pendingCount = batchRows.filter((b) => b.isPending).length

    // ---- Batch groups (by request) ----
    const groupOrder: string[] = []
    const groupMap: Record<string, typeof batchRows> = {}
    batchRows.forEach((b) => { if (!groupMap[b.req]) { groupMap[b.req] = []; groupOrder.push(b.req) } groupMap[b.req].push(b) })
    const groupRows = groupOrder.map((id, gi) => {
      const q = this.reqById(id)
      const list = groupMap[id]
      const pend = list.filter((b) => b.isPending).length
      const imgs = list.reduce((n, b) => n + b.imgsRaw, 0)
      const ps = prioStyle[q.priority]
      const open = s.openGroups[id] !== undefined ? s.openGroups[id] : gi === 0
      return {
        id, color: REQ_COLORS[id], title: 'Req ' + id + ' · ' + q.line,
        prio: ps[0], prioBg: ps[1], prioColor: ps[2],
        meta: list.length + (list.length === 1 ? ' batch · ' : ' batches · ') + imgs.toLocaleString() + ' imgs',
        badge: pend ? pend + ' pending' : '✓ resolved',
        badgeBg: pend ? 'var(--icon-blue-bg)' : 'var(--sev-low-bg)', badgeColor: pend ? 'var(--cobalt-blue)' : 'var(--sev-low)',
        open, chevronDeg: open ? '90deg' : '0deg',
        toggle: () => this.setState((st) => { const cur = st.openGroups[id] !== undefined ? st.openGroups[id] : gi === 0; return { openGroups: { ...st.openGroups, [id]: !cur } } }),
        batches: list,
      }
    })

    // ---- Gantt ----
    const ganttDays = days.map((d) => ({ label: d.short, color: d.isWeekend ? 'var(--fg-subtle)' : 'var(--fg-muted)' }))
    const ganttRows = !proposed
      ? []
      : this.analysts.filter((a) => a.canA || a.canR).map((a) => {
          const ai = this.analysts.indexOf(a)
          const cells = days.map((dy, d) => {
            const maxH = Math.max(a.hours, 0.1)
            const segs: { pct: string; color: string; title: string }[] = []
            const res = r!.reserve[ai][d]
            if (res > 0.1) segs.push({ pct: Math.min(100, (res / maxH) * 100).toFixed(0) + '%', color: BACKLOG_COLOR, title: 'Backlog: ' + res.toFixed(1) + 'h' })
            const byReq: Record<string, number> = {}
            r!.draws.forEach((dr) => { if (dr.aid === a.id && dr.day === d) byReq[dr.req] = (byReq[dr.req] || 0) + dr.hours })
            Object.entries(byReq).forEach(([req, h]) => segs.push({ pct: Math.min(100, (h / maxH) * 100).toFixed(0) + '%', color: REQ_COLORS[req], title: 'Req ' + req + ': ' + h.toFixed(1) + 'h' }))
            return { segs, bg: dy.isWeekend ? 'var(--surface-sunken)' : 'var(--surface-subtle)', title: a.name + ' · ' + dy.label }
          })
          return { name: a.name, sub: (a.status === 'pto' ? 'PTO → Jul 16 · ' : '') + a.role + ' · ' + a.hours + 'h/day', cells }
        })

    // ---- Coaching cards ----
    const matchByLearner: Record<string, CoachMatch> = {}
    matches.forEach((m) => (matchByLearner[m.learnerId] = m))
    const hum = (d: string) => d.replace(/_/g, ' ')
    const focusOf = (m: CoachMatch): string =>
      m.learnerSpecialty === 'general' || m.learnerSpecialty === 'all' || m.focusDefects.length >= 4
        ? 'all defect types (no specialty yet)'
        : m.focusDefects.map(hum).join(', ')
    const strongOf = (m: CoachMatch): string | null =>
      m.learnerSpecialty && m.learnerSpecialty !== 'general' && m.learnerSpecialty !== 'all' ? hum(m.learnerSpecialty) : null

    const activeIds = new Set(this.analysts.filter((a) => a.status === 'active').map((a) => a.id))
    const coachingRows = (SHOW_COACHING ? this.coaching.filter((c) => activeIds.has(c.id)) : []).map((c) => {
      const m = matchByLearner[c.id]
      return {
        name: c.name,
        tag: c.kind === 'acc' ? 'ACCURACY DIP' : 'PACE DRIFT',
        tagBg: c.kind === 'acc' ? 'var(--sev-high-bg)' : 'var(--icon-blue-bg)',
        tagColor: c.kind === 'acc' ? 'var(--sev-high)' : 'var(--cobalt-blue)',
        iconBg: c.kind === 'acc' ? 'var(--icon-amber-bg)' : 'var(--icon-blue-bg)',
        iconColor: c.kind === 'acc' ? 'var(--sev-high)' : 'var(--cobalt-blue)',
        note: c.note,
        focus: m ? focusOf(m) : null,
        strong: m ? strongOf(m) : null,
        primary: m ? m.primaryName : null,
        consult: m && m.consult ? `${m.consult.coachName} · ${hum(m.consult.defect)}` : null,
      }
    })
    // learners flagged by low absolute accuracy but not by the dip signal still get a card
    matches.forEach((m) => {
      if (!coachingRows.find((c) => c.name === m.learnerName)) {
        coachingRows.push({
          name: m.learnerName,
          tag: 'BELOW ACCURACY FLOOR',
          tagBg: 'var(--sev-high-bg)', tagColor: 'var(--sev-high)',
          iconBg: 'var(--icon-amber-bg)', iconColor: 'var(--sev-high)',
          note: `First-pass accuracy sits at ${m.learnerAcc.toFixed(1)}% — below the 90% floor, so annotation is routed through a paired review and the scheduler discounts throughput.`,
          focus: focusOf(m),
          strong: strongOf(m),
          primary: m.primaryName,
          consult: m.consult ? `${m.consult.coachName} · ${hum(m.consult.defect)}` : null,
        })
      }
    })

    // ---- Chat ----
    const messageRows = s.messages.map((m) => ({
      text: m.text,
      align: m.role === 'user' ? 'flex-end' : 'flex-start',
      bg: m.role === 'user' ? 'var(--cobalt-fill)' : 'var(--surface-elevated)',
      color: m.role === 'user' ? '#fff' : 'var(--fg)',
      radius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
    }))
    const presets: { kind: string; label: string }[] = []
    if (!s.intake) presets.push({ kind: 'intake', label: 'Here’s the incoming volume for the next two weeks (paste intake sheet)' })
    else if (!proposed) presets.push({ kind: 'assign', label: totImg ? `${totImg.toLocaleString()} images land Jul 10–18 — schedule everything` : 'Schedule the incoming volume' })
    else {
      if (!s.weekendOT) presets.push({ kind: 'ot', label: 'Authorize weekend overtime for the surge' })
      presets.push({ kind: 'risk', label: "What's at risk right now?" })
    }
    presets.push({ kind: 'coach', label: 'Who needs coaching this week?' })
    if (proposed && s.weekendOT) presets.push({ kind: 'risk', label: 'Re-check deadlines' })

    const anyPending = pendingCount > 0
    const pendingLabel = pendingCount ? pendingCount + ' awaiting review' : 'all resolved'
    const acceptAll = () => {
      const decisions = { ...s.decisions }
      batchRows.forEach((b) => { if (b.isPending) decisions[b.key] = 'accepted' })
      this.setState((st) => ({ decisions, messages: [...st.messages, { role: 'ai', text: 'All batches locked in and pushed to each analyst’s Threadr queue as Assigned. I’ll alert you if anyone’s live pace puts an ETA at risk.' }] }))
    }

    const showCoachingSection = SHOW_COACHING && coachingRows.length > 0
    const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

    return (
      <div data-theme="dark" data-screen-label="Threadr Dispatch v2" style={{ ['--app-bg' as any]: '#0E0E10', ['--surface' as any]: '#1A1B1D', ['--surface-subtle' as any]: '#232427', ['--surface-elevated' as any]: '#28292D', ['--surface-sunken' as any]: '#08080A', ['--border' as any]: '#242528', ['--border-strong' as any]: '#3B3C41', height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--app-bg)', color: 'var(--fg)', fontFamily: "'Instrument Sans', sans-serif", overflow: 'hidden' }}>

        {/* Top bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 24px', borderBottom: '1px solid var(--border)', background: 'var(--surface)', flexShrink: 0 }}>
          <Link to="/" className="dc-link" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 10, border: '1px solid var(--border)', color: 'var(--fg-muted)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}><path d="m15 18-6-6 6-6"></path></svg>
          </Link>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--icon-blue-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5C97FF" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><path d="m9 16 2 2 4-4"></path></svg>
            </div>
            <div style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-0.01em' }}>Threadr Dispatch</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>Friday, Jul 10 · Week 28</span>
            <div style={{ width: 30, height: 30, borderRadius: 999, background: 'var(--cobalt-fill)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 500 }}>KA</div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 392px', minHeight: 0 }}>

          {/* MAIN COLUMN */}
          <div style={{ overflowY: 'auto', padding: '24px 28px 48px 28px', display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>

            {/* KPI strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 16 }}>
              {kpiRows.map((k, i) => (
                <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{k.label}</span>
                  <span style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em', color: k.color }}>{k.value}</span>
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{k.sub}</span>
                </div>
              ))}
            </div>

            {/* Incoming requests strip */}
            {s.intake && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em' }}>Incoming requests · Jul 10–18</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))', gap: 12 }}>
                  {requestRows.map((rq) => (
                    <div key={rq.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 9, height: 9, borderRadius: 999, background: rq.color }}></span>
                        <span style={{ fontSize: 13.5, fontWeight: 500 }}>{rq.title}</span>
                        <span style={{ marginLeft: 'auto', padding: '2px 9px', borderRadius: 999, background: rq.prioBg, color: rq.prioColor, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em' }}>{rq.prio}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{rq.volume}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--fg-subtle)' }}>
                        <span>{rq.window}</span>
                        <span style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 999, background: rq.slackBg, color: rq.slackColor, fontSize: 11, fontWeight: 500 }}>{rq.slackLabel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Capacity vs demand chart */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em' }}>Capacity vs demand</h2>
                <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{chartCaption}</span>
              </div>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 20px 14px 20px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 170 }}>
                  {chartCols.map((c, i) => (
                    <div key={i} style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: c.bg, borderRadius: 6 }} title={c.title}>
                      {c.segs.map((sg: any, j: number) => (
                        <div key={j} style={{ height: sg.pct, background: sg.color, borderRadius: 2, margin: '0 3px 1px 3px' }} title={sg.title}></div>
                      ))}
                      <div style={{ position: 'absolute', left: 0, right: 0, bottom: c.capPct, height: 0, borderTop: `2px dashed ${c.capColor}` }} title={c.capTitle}></div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  {chartCols.map((c, i) => (
                    <span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: c.labelColor }}>{c.label}</span>
                  ))}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  {chartLegend.map((l, i) => (
                    <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-muted)' }}><span style={{ width: 10, height: 10, borderRadius: 3, background: l.color }}></span>{l.label}</span>
                  ))}
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-muted)' }}><span style={{ width: 14, borderTop: '2px dashed var(--fg-muted)' }}></span>Available hours (after PTO, weekends, backlog reserve)</span>
                </div>
              </div>
            </div>

            {/* Proposed batches */}
            {proposed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em' }}>Proposed assignments</h2>
                  <span style={{ padding: '3px 10px', borderRadius: 999, background: 'var(--icon-blue-bg)', color: 'var(--cobalt-blue)', fontSize: 11, fontWeight: 500, letterSpacing: '0.04em' }}>{pendingLabel}</span>
                  {anyPending && (
                    <button onClick={acceptAll} className="dc-volt" style={{ marginLeft: 'auto', padding: '8px 18px', borderRadius: 999, background: 'var(--volt-green)', border: 'none', color: '#14110F', fontFamily: "'Instrument Sans', sans-serif", fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Accept all</button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {groupRows.map((g) => (
                    <div key={g.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 }}>
                      <button onClick={g.toggle} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--fg)', fontFamily: "'Instrument Sans', sans-serif", textAlign: 'left' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} style={{ color: 'var(--fg-subtle)', flexShrink: 0, transition: 'transform 200ms cubic-bezier(0.2,0.8,0.2,1)', transform: `rotate(${g.chevronDeg})` }}><path d="m9 18 6-6-6-6"></path></svg>
                        <span style={{ width: 9, height: 9, borderRadius: 999, background: g.color, flexShrink: 0 }}></span>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{g.title}</span>
                        <span style={{ padding: '2px 9px', borderRadius: 999, background: g.prioBg, color: g.prioColor, fontSize: 10, fontWeight: 600, letterSpacing: '0.05em' }}>{g.prio}</span>
                        <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{g.meta}</span>
                        <span style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 999, background: g.badgeBg, color: g.badgeColor, fontSize: 11, fontWeight: 500, flexShrink: 0 }}>{g.badge}</span>
                      </button>
                      {g.open && (
                        <div style={{ padding: '2px 16px 16px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          {g.batches.map((p) => (
                            <div key={p.key} style={{ background: 'var(--app-bg)', border: `1px solid ${p.borderColor}`, borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, opacity: p.opacity, transition: 'border-color 200ms cubic-bezier(0.2,0.8,0.2,1)' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ width: 9, height: 9, borderRadius: 999, background: p.reqColor, flexShrink: 0 }}></span>
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontSize: 14, fontWeight: 500 }}>{p.analyst}</span>
                                  <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{p.reqLabel} · {p.stageLabel}</span>
                                </div>
                                <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                                  <span style={{ fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--cobalt-blue)' }}>{p.countLabel}</span>
                                  <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{p.structLabel}</span>
                                </div>
                              </div>
                              <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--fg-muted)' }}>{p.reason}</div>
                              {p.whyOpen && (
                                <div style={{ background: 'var(--surface-subtle)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                                  {p.whyLines.map((w, i) => (<span key={i} style={{ fontSize: 12, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{w}</span>))}
                                </div>
                              )}
                              {p.structsOpen && (
                                <div style={{ background: 'var(--surface-subtle)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                  {p.structItems.map((st, i) => (<span key={i} style={{ padding: '3px 10px', borderRadius: 999, background: 'var(--surface-elevated)', fontSize: 11, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{st}</span>))}
                                </div>
                              )}
                              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{p.window}</span>
                                <button onClick={p.toggleWhy} className="dc-chip" style={{ padding: '3px 10px', borderRadius: 999, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-subtle)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 11, cursor: 'pointer' }}>{p.whyBtn}</button>
                                <button onClick={p.toggleStructs} className="dc-chip" style={{ padding: '3px 10px', borderRadius: 999, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-subtle)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 11, cursor: 'pointer' }}>{p.structsBtn}</button>
                                {p.isPending && (
                                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                                    <button onClick={p.deny} className="dc-deny" style={{ padding: '6px 14px', borderRadius: 999, background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--fg-muted)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 12.5, cursor: 'pointer' }}>Deny</button>
                                    <button onClick={p.accept} className="dc-volt" style={{ padding: '6px 14px', borderRadius: 999, background: 'var(--volt-green)', border: '1px solid var(--volt-green)', color: '#14110F', fontFamily: "'Instrument Sans', sans-serif", fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}>Accept</button>
                                  </div>
                                )}
                                {p.isResolved && (<span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 500, color: p.statusColor }}>{p.statusLabel}</span>)}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Gantt timeline */}
            {proposed && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em' }}>Schedule timeline</h2>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>Cell fill = share of that analyst's day · grey = backlog burn-down</span>
                </div>
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 20px', overflowX: 'auto' }}>
                  <div style={{ minWidth: 820 }}>
                    <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                      <span style={{ width: 128, flexShrink: 0 }}></span>
                      {ganttDays.map((d, i) => (<span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: d.color }}>{d.label}</span>))}
                    </div>
                    {ganttRows.map((g, gi) => (
                      <div key={gi} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                        <div style={{ width: 128, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 12.5, fontWeight: 500 }}>{g.name}</span>
                          <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>{g.sub}</span>
                        </div>
                        {g.cells.map((c, ci) => (
                          <div key={ci} style={{ flex: 1, height: 26, borderRadius: 5, background: c.bg, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' }} title={c.title}>
                            {c.segs.map((sg, si) => (<div key={si} style={{ height: sg.pct, background: sg.color }} title={sg.title}></div>))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Coaching */}
            {showCoachingSection && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em' }}>Coaching signals</h2>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>Fitted from 30-day throughput history — plus one primary coach matched by defect specialty</span>
                </div>

                {/* Coaching budget banner + dedicated-hours lever */}
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 20, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '14px 20px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--fg-subtle)' }}>COACHING BUDGET</span>
                    <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', color: budget.feasible ? 'var(--sev-low)' : 'var(--sev-high)' }}>{budget.feasible ? `~${Math.round(budget.totalHours)}h free` : '0h'}</span>
                    <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{budget.feasible ? (budget.deferredFromIdx != null && budget.deferredFromIdx > 0 ? `Opens ${days[budget.deferredFromIdx].label} once the surge clears` : 'Spare mentor time, all deadlines safe') : 'Deadlines at risk — clear them first (weekend OT)'}</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--fg-subtle)' }}>SUGGESTED</span>
                    <span style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--fg)' }}>{suggestedTotal}h</span>
                    <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>~1h/day per analyst who needs help</span>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                    <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--fg-subtle)' }}>DEDICATED · PER MENTEE / DAY</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => this.setCoaching(s.coachingHoursPerDay - 0.5)} className="dc-pill-hover" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 16, cursor: 'pointer' }}>−</button>
                      <span style={{ fontSize: 18, fontWeight: 500, minWidth: 54, textAlign: 'center' }}>{s.coachingHoursPerDay}h</span>
                      <button onClick={() => this.setCoaching(s.coachingHoursPerDay + 0.5)} className="dc-pill-hover" style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--fg)', fontSize: 16, cursor: 'pointer' }}>+</button>
                    </div>
                    <span style={{ fontSize: 12, color: reservedTotal > 0.5 ? 'var(--cobalt-blue)' : 'var(--fg-subtle)' }}>{reservedTotal > 0.5 ? `${Math.round(reservedTotal)}h reserved in the plan` : 'Not reserved yet'}</span>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  {coachingRows.map((c, i) => (
                    <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', display: 'flex', gap: 14 }}>
                      <div style={{ width: 36, height: 36, flexShrink: 0, borderRadius: 10, background: c.iconBg, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.iconColor }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" {...stroke}><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</span>
                          <span style={{ padding: '2px 9px', borderRadius: 999, background: c.tagBg, color: c.tagColor, fontSize: 10.5, fontWeight: 500, letterSpacing: '0.04em' }}>{c.tag}</span>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--fg-muted)' }}>{c.note}</div>
                        {c.focus && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2 }}>
                            <span style={{ padding: '3px 10px', borderRadius: 999, background: 'var(--sev-high-bg)', color: 'var(--sev-high)', fontSize: 11.5, fontWeight: 500 }}>Needs help on: {c.focus}</span>
                            {c.strong && (
                              <span style={{ padding: '3px 10px', borderRadius: 999, background: 'var(--sev-low-bg)', color: 'var(--sev-low)', fontSize: 11.5, fontWeight: 500 }}>Strong at: {c.strong}</span>
                            )}
                          </div>
                        )}
                        {c.primary && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 2 }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, background: 'var(--sev-low-bg)', color: 'var(--sev-low)', fontSize: 11.5, fontWeight: 500 }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" {...stroke}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
                              Primary coach: {c.primary}
                            </span>
                            {c.consult && (
                              <span style={{ padding: '3px 10px', borderRadius: 999, background: 'var(--icon-blue-bg)', color: 'var(--cobalt-blue)', fontSize: 11.5, fontWeight: 500 }}>Consult: {c.consult}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>

          {/* CHAT PANEL */}
          <div style={{ borderLeft: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--volt-green)', boxShadow: 'var(--shadow-dot)' }}></div>
              <span style={{ fontSize: 14, fontWeight: 500 }}>Dispatch assistant</span>
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--fg-subtle)' }}>Live on Threadr data</span>
            </div>

            <div ref={this.chatEl} style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {messageRows.map((m, i) => (
                <div key={i} style={{ alignSelf: m.align as any, maxWidth: '90%', padding: '11px 15px', borderRadius: m.radius, background: m.bg, color: m.color, fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-line' }}>{m.text}</div>
              ))}
              {s.typing && (
                <div style={{ alignSelf: 'flex-start', padding: '12px 16px', borderRadius: '14px 14px 14px 4px', background: 'var(--surface-elevated)', display: 'flex', gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--fg-muted)', animation: 'dispatchPulse 1s infinite' }}></span>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--fg-muted)', animation: 'dispatchPulse 1s infinite 0.2s' }}></span>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--fg-muted)', animation: 'dispatchPulse 1s infinite 0.4s' }}></span>
                </div>
              )}
            </div>

            <div style={{ padding: '14px 16px 18px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {presets.map((q, i) => (
                  <button key={i} onClick={() => this.sendPrompt(q.kind, q.label)} className="dc-chip" style={{ padding: '6px 13px', borderRadius: 999, background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--fg-muted)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>{q.label}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={s.input}
                  onChange={(e) => this.setState({ input: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && s.input.trim()) { this.sendPrompt('free', s.input.trim()); this.setState({ input: '' }) } }}
                  placeholder="Ask Dispatch anything…"
                  style={{ flex: 1, padding: '11px 16px', borderRadius: 999, background: 'var(--surface-elevated)', border: '1px solid var(--border)', color: 'var(--fg)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 13.5, outline: 'none' }}
                />
                <button onClick={() => { if (s.input.trim()) { this.sendPrompt('free', s.input.trim()); this.setState({ input: '' }) } }} className="dc-send" style={{ width: 42, height: 42, borderRadius: 999, background: 'var(--cobalt-fill)', border: 'none', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <svg width="17" height="17" viewBox="0 0 24 24" {...stroke}><path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path></svg>
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    )
  }
}

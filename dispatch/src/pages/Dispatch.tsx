import React from 'react'
import { Link } from 'react-router-dom'
import './dispatch.css'
import { DAYS } from '../engine/days'
import { loadDispatchData, type Analyst, type RequestRow, type Backlog } from '../data/loadCsv'
import { schedule, hoursFor, type ScheduleResult, type Session } from '../engine/schedule'
import { deriveCoaching, type CoachingSignal } from '../engine/coaching'
import { REQ_COLORS, BACKLOG_COLOR, STAGE_NAMES, STAGE_COLORS, DEFAULT_SECONDARY_SAMPLE_PCT } from '../engine/constants'

interface Msg { role: 'user' | 'ai'; text: string }
type CoachStatus = 'pending' | 'accepted' | 'dismissed' | 'scheduled'

// One ranked coach candidate for a coaching signal.
interface CoachCand {
  a: Analyst
  fit: number
  skill: number
  spec: number
  tz: number
  cap: number
  why: string
}

interface State {
  ready: boolean
  input: string
  typing: boolean
  intake: boolean
  coached: boolean
  phase: 'idle' | 'proposed'
  weekendOT: boolean
  denied: string[]
  decisions: Record<string, 'accepted' | 'denied'>
  expanded: Record<string, 'why' | 'structs' | null>
  openGroups: Record<string, boolean>
  boardOpen: boolean
  coachOpen: boolean
  reqOpen: boolean
  chartOpen: boolean
  hoverDay: number | null
  hoverStage: string | null
  hoverReq: string | null
  hoverRow: string | null
  coachSel: Record<string, string>
  coachStatus: Record<string, CoachStatus>
  sessions: Session[]
  messages: Msg[]
  result: ScheduleResult | null
}

const SAMPLE_PCT = DEFAULT_SECONDARY_SAMPLE_PCT
const SHOW_COACHING = true
const days = DAYS
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const mkInit = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

export default class Dispatch extends React.Component<{}, State> {
  chatEl = React.createRef<HTMLDivElement>()
  analysts: Analyst[] = []
  requests: RequestRow[] = []
  backlog: Backlog = { A: 0, R: 0, S: 0 }
  coaching: CoachingSignal[] = []
  _anim: Record<string, { target: number; from: number; cur: number; start: number; dur: number }> = {}
  _animRaf: number | null = null
  _prevRisk: number | undefined
  _pulseUntil = 0
  _pulseN = 0

  state: State = {
    ready: false,
    input: '',
    typing: false,
    intake: false,
    coached: false,
    phase: 'idle',
    weekendOT: false,
    denied: [],
    decisions: {},
    expanded: {},
    openGroups: {},
    boardOpen: true,
    coachOpen: true,
    reqOpen: true,
    chartOpen: true,
    hoverDay: null,
    hoverStage: null,
    hoverReq: null,
    hoverRow: null,
    coachSel: {},
    coachStatus: {},
    sessions: [],
    messages: [],
    result: null,
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

  componentWillUnmount() {
    if (this._animRaf) cancelAnimationFrame(this._animRaf)
  }

  // KPI count-up: eases the displayed number toward its target on every change.
  anim(key: string, target: number, dur = 650): number {
    const a = this._anim[key]
    if (!a || a.target !== target) {
      this._anim[key] = { target, from: a ? a.cur : 0, cur: a ? a.cur : 0, start: performance.now(), dur }
      if (!this._animRaf) {
        const tick = () => {
          const now = performance.now()
          let active = false
          Object.values(this._anim).forEach((o) => {
            const t = Math.min(1, (now - o.start) / o.dur)
            o.cur = o.from + (o.target - o.from) * (1 - Math.pow(1 - t, 3))
            if (t < 1) active = true
            else o.cur = o.target
          })
          this._animRaf = active ? requestAnimationFrame(tick) : null
          this.forceUpdate()
        }
        this._animRaf = requestAnimationFrame(tick)
      }
    }
    return Math.round(this._anim[key].cur)
  }

  reqById(id: string) { return this.requests.find((r) => r.id === id)! }
  aById(id: string) { return this.analysts.find((a) => a.id === id)! }

  runSchedule(weekendOT: boolean, denied: string[]): ScheduleResult {
    return schedule(this.analysts, this.requests, this.backlog, weekendOT, denied, SAMPLE_PCT, this.state.sessions)
  }

  // ---------- COACH MATCHING ----------
  // Rank qualified, un-flagged, active analysts as coaches for one signal:
  // strength in the weak metric, specialty overlap, timezone, spare capacity.
  rankCoaches(sig: CoachingSignal, r: ScheduleResult | null): CoachCand[] {
    const st = this.aById(sig.id)
    if (!st) return []
    const flagged = new Set(this.coaching.map((c) => c.id))
    return this.analysts
      .filter((a) => a.id !== st.id && a.status === 'active' && !flagged.has(a.id))
      .map((a) => {
        const ai = this.analysts.indexOf(a)
        const skill = sig.kind === 'acc' ? clamp((a.acc - 89) / 9) : clamp((a.rateA - 10) / 12)
        const spec = a.specialty === 'all' ? 0.9 : a.specialty === st.specialty ? 1 : st.specialty === 'general' ? 0.6 : 0.25
        const tz = a.tz === st.tz ? 1 : 0.3
        let avail = 0
        days.forEach((_, d) => (avail += hoursFor(a, d, this.state.weekendOT, this.state.sessions)))
        let load = 0
        if (r) {
          load = r.reserve[ai].reduce((n, v) => n + v, 0)
          r.draws.forEach((dr) => { if (dr.aid === a.id) load += dr.hours })
        }
        const spare = Math.max(0, avail - load)
        const cap = r ? clamp(avail > 0 ? spare / avail : 0) : clamp(a.hours / 8)
        const fit = 0.35 * skill + 0.25 * spec + 0.2 * tz + 0.2 * cap
        const specTxt = a.specialty === 'all' ? 'covers all defect classes' : a.specialty === st.specialty ? 'same ' + a.specialty.replace(/_/g, ' ') + ' specialty' : a.specialty.replace(/_/g, ' ') + ' specialist'
        const tzTxt = a.tz === st.tz ? 'same ' + a.tz + ' hours' : 'partial overlap (' + a.tz + ')'
        const why = (sig.kind === 'acc' ? a.acc.toFixed(1) + '% first-pass' : a.rateA.toFixed(0) + ' img/hr annotation pace') + ' · ' + specTxt + ' · ' + tzTxt + ' · ' + (r ? Math.round(spare) + 'h spare in window' : a.hours + 'h/day capacity')
        return { a, fit, skill, spec, tz, cap, why }
      })
      .sort((x, y) => y.fit - x.fit)
      .slice(0, 4)
  }

  // First weekday where both learner and coach still have ≥1h free.
  findSlot(strugglerId: string, coachId: string): number | null {
    const st = this.aById(strugglerId)
    const co = this.aById(coachId)
    const sti = this.analysts.indexOf(st)
    const coi = this.analysts.indexOf(co)
    const r = this.state.result
    for (let d = 1; d < days.length; d++) {
      if (days[d].isWeekend) continue
      const a = r ? r.cap[sti][d] : hoursFor(st, d, this.state.weekendOT, this.state.sessions)
      const b = r ? r.cap[coi][d] : hoursFor(co, d, this.state.weekendOT, this.state.sessions)
      if (a >= 1 && b >= 1) return d
    }
    for (let d = 1; d < days.length; d++) {
      if (!days[d].isWeekend && hoursFor(st, d, this.state.weekendOT, this.state.sessions) >= 1 && hoursFor(co, d, this.state.weekendOT, this.state.sessions) >= 1) return d
    }
    return null
  }

  slotLabel(d: number | null, strugglerId: string, coachId: string): string | null {
    if (d === null || d === undefined) return null
    const st = this.aById(strugglerId)
    const co = this.aById(coachId)
    return days[d].label + (st.tz === co.tz ? ' · 2:00 PM ' + st.tz : ' · 11:00 AM AST / 3:00 PM GMT')
  }

  pairAccept(sig: CoachingSignal, chosen: CoachCand) {
    const d = this.findSlot(sig.id, chosen.a.id)
    const slot = this.slotLabel(d, sig.id, chosen.a.id)
    this.setState((s) => ({
      coachStatus: { ...s.coachStatus, [sig.id]: 'accepted' },
      messages: [...s.messages, { role: 'user', text: 'Approve ' + chosen.a.name.split(' ')[0] + ' → ' + sig.name.split(' ')[0] + ' pairing' }],
      typing: true,
    }))
    setTimeout(() => {
      this.setState((s) => ({
        typing: false,
        messages: [...s.messages, { role: 'ai', text: 'Locked in — ' + chosen.a.name + ' coaches ' + sig.name + ' on ' + (sig.kind === 'acc' ? 'first-pass accuracy' : 'pace') + '. ' + (slot ? 'Next hour they’re both free: ' + slot + '. Book it from the panel and I’ll carve it out of both schedules.' : 'No mutual free hour in this window yet — deny a batch or authorize weekend OT to open one.') }],
      }))
    }, 700)
  }

  pairDismiss(sig: CoachingSignal) {
    this.setState((s) => ({
      coachStatus: { ...s.coachStatus, [sig.id]: 'dismissed' },
      messages: [...s.messages, { role: 'ai', text: 'Dismissed the ' + sig.name.split(' ')[0] + ' signal — I’ll re-flag it if the trend continues into next week.' }],
    }))
  }

  bookSession(sig: CoachingSignal, coachId: string) {
    const d = this.findSlot(sig.id, coachId)
    const co = this.aById(coachId)
    if (d === null) {
      this.setState((s) => ({ messages: [...s.messages, { role: 'ai', text: 'No hour where both ' + sig.name.split(' ')[0] + ' and ' + co.name.split(' ')[0] + ' are free in this window — free up capacity first.' }] }))
      return
    }
    const label = this.slotLabel(d, sig.id, coachId)
    const session: Session = { sigId: sig.id, strugglerId: sig.id, coachId, day: d, label }
    this.setState((s) => ({
      sessions: [...s.sessions, session],
      coachStatus: { ...s.coachStatus, [sig.id]: 'scheduled' },
      messages: [...s.messages, { role: 'user', text: 'Book the ' + co.name.split(' ')[0] + ' → ' + sig.name.split(' ')[0] + ' session' }],
      typing: true,
    }))
    setTimeout(() => {
      const intro = 'Booked ' + label + ' — 1h in person, ' + co.name + ' coaching ' + sig.name + ' on ' + (sig.kind === 'acc' ? 'first-pass accuracy' : 'pace') + '. The hour is blocked on both calendars and deducted from scheduler capacity.'
      if (this.state.result) {
        this.runAndStore(this.state.weekendOT, this.state.denied, this.state.decisions, (result) => this.describeResult(result, intro + ' Recomputed the plan around it:', this.state.weekendOT))
      } else {
        this.setState((s) => ({ typing: false, messages: [...s.messages, { role: 'ai', text: intro + ' When I draft the schedule, it’s already carved out.' }] }))
      }
    }, 800)
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
        const rr = this.state.result
        const pairs = this.coaching
          .filter((c) => (this.state.coachStatus[c.id] || 'pending') !== 'dismissed')
          .map((c) => {
            const cands = this.rankCoaches(c, rr)
            if (!cands.length) return c.name + ' — flagged (' + (c.kind === 'acc' ? 'accuracy dip' : 'pace drift') + '), but no qualified coach is free this window.'
            const top = cands.find((x) => x.a.id === this.state.coachSel[c.id]) || cands[0]
            return top.a.name + ' → ' + c.name + ' (' + Math.round(top.fit * 100) + '% fit, ' + (c.kind === 'acc' ? 'accuracy dip' : 'pace drift') + '): ' + top.why + '.'
          })
        const text = pairs.length
          ? 'Matched this week’s signals against the roster — scored on strength in the weak metric, specialty overlap, timezone, and spare capacity:\n\n' +
          pairs.join('\n\n') +
          '\n\nReview them in the Coaching pairings panel — accept, swap the coach, or dismiss. Accepted pairs book as 1-hour in-person sessions that come out of both schedules.'
          : 'No open coaching signals this week.'
        this.setState((s) => ({ typing: false, coached: true, messages: [...s.messages, { role: 'ai', text }] }))
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
    const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

    // ---- KPIs ----
    const acceptedImgs = proposed ? r!.batches.filter((b) => b.stage === 'A' && s.decisions[b.key] === 'accepted').reduce((n, b) => n + b.imgs, 0) : 0
    const schedImgs = proposed ? r!.batches.filter((b) => b.stage === 'A').reduce((n, b) => n + b.imgs, 0) : 0
    const riskCount = proposed ? this.requests.filter((q) => r!.reqResults[q.id].slack < 1).length : 0
    const blTotal = this.backlog.A + this.backlog.R + this.backlog.S
    // Pulse the AT RISK number whenever the count goes up; vary the duration so the animation restarts.
    if (proposed) {
      if (this._prevRisk !== undefined && riskCount > this._prevRisk) { this._pulseN += 1; this._pulseUntil = Date.now() + 1000 }
      this._prevRisk = riskCount
    } else this._prevRisk = undefined
    const riskAnim = this._pulseUntil && Date.now() < this._pulseUntil ? 'dispatchRiskPulse ' + (900 + (this._pulseN % 2)) + 'ms cubic-bezier(0.2,0.8,0.2,1)' : 'none'
    const kpiRows = [
      { delay: '0ms', anim: 'none', label: 'INCOMING VOLUME', value: s.intake ? this.anim('kTot', totImg).toLocaleString() : '—', sub: s.intake ? totStr + ' structures · 5 requests · Jul 10–18' : 'Awaiting intake — tell the assistant', color: 'var(--fg)' },
      { delay: '60ms', anim: 'none', label: 'TEAM SUPPLY', value: this.anim('kAct', this.analysts.filter((a) => a.status === 'active').length) + ' active', sub: blTotal.toLocaleString() + ' backlog imgs reserved first', color: 'var(--fg)' },
      { delay: '120ms', anim: 'none', label: 'SCHEDULED', value: proposed ? this.anim('kSched', Math.round(schedImgs)).toLocaleString() + ' / ' + totImg.toLocaleString() : '—', sub: proposed ? Math.round(acceptedImgs).toLocaleString() + ' accepted so far' : 'Ask the assistant to schedule', color: proposed && schedImgs >= totImg - 5 ? 'var(--sev-low)' : 'var(--fg)' },
      { delay: '180ms', anim: riskAnim, label: 'AT RISK', value: proposed ? String(this.anim('kRisk', riskCount)) : '—', sub: proposed ? (riskCount ? 'requests with <1 day slack' : 'all requests have slack') : 'Appears after scheduling', color: proposed ? (riskCount ? 'var(--sev-high)' : 'var(--sev-low)') : 'var(--fg)' },
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
        else if (rr.slack === 0) { slackLabel = 'No slack'; slackBg = 'var(--sev-high-bg)'; slackColor = 'var(--sev-high)' }
        else { slackLabel = 'ETA ' + days[rr.etaIdx].label; slackBg = 'var(--sev-low-bg)'; slackColor = 'var(--sev-low)' }
      }
      return {
        id: q.id, color: REQ_COLORS[q.id], title: q.id + ' · ' + q.line,
        prio: ps[0], prioBg: ps[1], prioColor: ps[2],
        volume: q.images.toLocaleString() + ' imgs · ' + q.structures + ' structures · ' + q.org.replace(/_/g, ' '),
        window: 'Lands ' + days[q.arrIdx].label + ' → due ' + (days[q.dueIdx] ? days[q.dueIdx].label : 'Jul 25'),
        slackLabel, slackBg, slackColor,
        hovered: s.hoverReq === q.id,
        enter: () => this.setState({ hoverReq: q.id }),
        leave: () => this.setState((st) => (st.hoverReq === q.id ? { hoverReq: null } : null)),
      }
    })

    // ---- Chart ----
    // Capacity line ignores coaching sessions (they show as demand, not lost supply).
    const capTotalIdle = days.map((_, i) => this.analysts.reduce((n, a) => n + hoursFor(a, i, s.weekendOT), 0))
    let chartCaption = ''
    let demand: { BL: number; A: number; R: number; S: number; CO: number }[]
    if (proposed) {
      chartCaption = 'Scheduled hours per day, stacked by stage — recomputes on every accept/deny'
      demand = days.map((_, d) => {
        const seg = { BL: 0, A: 0, R: 0, S: 0, CO: 0 }
        r!.reserve.forEach((row) => (seg.BL += row[d]))
        r!.draws.forEach((dr) => { if (dr.day === d) seg[dr.stage] += dr.hours })
        return seg
      })
      s.sessions.forEach((sn) => { if (demand[sn.day]) demand[sn.day].CO += 2 })
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
    const chartCols = days.map((dy, i) => {
      const segs = (['CO', 'S', 'R', 'A', 'BL'] as const)
        .filter((k) => demand[i][k] > 0.2)
        .map((k) => ({
          pct: ((demand[i][k] / maxV) * 100).toFixed(1) + '%', color: STAGE_COLORS[k],
          delay: i * 25 + 'ms',
          opacity: s.hoverStage && k !== s.hoverStage ? 0.15 : 1,
          tLabel: k === 'BL' ? 'Backlog' : k === 'CO' ? 'Coaching' : STAGE_NAMES[k],
          tVal: demand[i][k].toFixed(1) + 'h',
          title: (k === 'BL' ? 'Backlog' : k === 'CO' ? 'Coaching session — 1h × coach + analyst' : STAGE_NAMES[k]) + ': ' + demand[i][k].toFixed(1) + 'h',
        }))
      const tot = segTot(demand[i])
      const hovered = s.hoverDay === i
      return {
        label: dy.short, labelColor: dy.isWeekend ? 'var(--fg-subtle)' : 'var(--fg-muted)',
        bg: dy.isWeekend ? 'var(--surface-sunken)' : 'var(--surface-subtle)',
        segs,
        capPct: ((capTotalIdle[i] / maxV) * 100).toFixed(1) + '%',
        capColor: tot > capTotalIdle[i] + 0.5 ? 'var(--sev-critical)' : 'var(--fg-muted)',
        capTitle: 'Available: ' + capTotalIdle[i].toFixed(0) + 'h',
        enter: () => this.setState({ hoverDay: i }),
        leave: () => this.setState((st) => (st.hoverDay === i ? { hoverDay: null } : null)),
        colOpacity: s.hoverDay === null || hovered ? 1 : 0.5,
        showTip: hovered && segs.length > 0,
        tipTitle: dy.label + (dy.isWeekend ? ' · weekend' : ''),
        tipRows: segs.map((sg) => ({ color: sg.color, label: sg.tLabel, val: sg.tVal })),
        tipFoot: 'Available: ' + capTotalIdle[i].toFixed(0) + 'h' + (tot > capTotalIdle[i] + 0.5 ? ' — breached' : ''),
        title: dy.label + ' — demand ' + tot.toFixed(0) + 'h vs ' + capTotalIdle[i].toFixed(0) + 'h available',
      }
    })
    const chartLegend = [
      { k: 'BL', color: BACKLOG_COLOR, label: 'Backlog burn-down' },
      { k: 'A', color: '#2FBFA8', label: 'Annotation' },
      { k: 'R', color: '#E07BB2', label: 'Review' },
      { k: 'S', color: '#E0B84D', label: 'Secondary review' },
    ]
    if (s.sessions.length) chartLegend.push({ k: 'CO', color: STAGE_COLORS.CO, label: 'Coaching session (1h × both calendars)' })
    const legendRows = chartLegend.map((l) => ({
      ...l,
      enter: () => this.setState({ hoverStage: l.k }),
      leave: () => this.setState((st) => (st.hoverStage === l.k ? { hoverStage: null } : null)),
      op: s.hoverStage && s.hoverStage !== l.k ? 0.4 : 1,
    }))

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
          const segs: { pct: string; color: string; title: string; req?: string; delay?: string; opacity?: number }[] = []
          const res = r!.reserve[ai][d]
          if (res > 0.1) segs.push({ pct: Math.min(100, (res / maxH) * 100).toFixed(0) + '%', color: BACKLOG_COLOR, title: 'Backlog: ' + res.toFixed(1) + 'h' })
          const byReq: Record<string, number> = {}
          r!.draws.forEach((dr) => { if (dr.aid === a.id && dr.day === d) byReq[dr.req] = (byReq[dr.req] || 0) + dr.hours })
          Object.entries(byReq).forEach(([req, h]) => segs.push({ req, pct: Math.min(100, (h / maxH) * 100).toFixed(0) + '%', color: REQ_COLORS[req], title: 'Req ' + req + ': ' + h.toFixed(1) + 'h' }))
          s.sessions.forEach((sn) => {
            if (sn.day !== d || (sn.strugglerId !== a.id && sn.coachId !== a.id)) return
            const other = this.aById(sn.strugglerId === a.id ? sn.coachId : sn.strugglerId)
            segs.push({ pct: Math.min(100, (1 / maxH) * 100).toFixed(0) + '%', color: 'var(--volt-green)', title: 'Coaching session: 1h with ' + (other ? other.name : '') })
          })
          segs.forEach((sg) => { sg.delay = d * 16 + 'ms'; sg.opacity = s.hoverReq ? (sg.req === s.hoverReq ? 1 : 0.15) : 1 })
          return { segs, bg: dy.isWeekend ? 'var(--surface-sunken)' : 'var(--surface-subtle)', title: a.name + ' · ' + dy.label }
        })
        return {
          name: a.name, sub: (a.status === 'pto' ? 'PTO → Jul 16 · ' : '') + a.role + ' · ' + a.hours + 'h/day', cells,
          rowOpacity: s.hoverRow && s.hoverRow !== a.id ? 0.45 : 1,
          enter: () => this.setState({ hoverRow: a.id }),
          leave: () => this.setState((st) => (st.hoverRow === a.id ? { hoverRow: null } : null)),
        }
      })

    // ---- Analyst board ----
    const boardCaption = proposed
      ? 'Load = backlog reserve + scheduled batches vs available hours' + (s.weekendOT ? ' (incl. weekend OT)' : '')
      : 'Roster from analysts.csv — load fills in once a schedule is proposed'
    const analystBoardRows = this.analysts.map((a) => {
      const ai = this.analysts.indexOf(a)
      const avail = days.reduce((n, _, i) => n + hoursFor(a, i, s.weekendOT, s.sessions), 0)
      let loadH = 0
      if (proposed) {
        loadH = r!.reserve[ai].reduce((n, v) => n + v, 0)
        r!.draws.forEach((d) => { if (d.aid === a.id) loadH += d.hours })
      }
      const util = avail > 0 ? loadH / avail : 0
      const quals: string[] = []
      if (a.canA) quals.push('Annotate')
      if (a.canR) quals.push('Review')
      if (a.canS) quals.push('2nd')
      const rate = a.canA ? ((a.rateA * a.acc) / 100).toFixed(1) + ' img/hr A' : a.canR ? a.rateR.toFixed(0) + ' img/hr R' : a.rateS.toFixed(0) + ' img/hr S'
      return {
        id: a.id,
        initials: mkInit(a.name),
        name: a.name,
        sub: a.role + ' · ' + a.seniority + ' · ' + a.hours + 'h/day',
        quals,
        rate,
        acc: a.acc.toFixed(1) + '%',
        accColor: a.acc < 90 ? 'var(--sev-high)' : 'var(--fg-muted)',
        utilPct: (proposed ? Math.min(100, util * 100) : 0).toFixed(0) + '%',
        utilColor: util > 0.92 ? 'var(--sev-high)' : 'var(--cobalt-blue)',
        utilLabel: proposed ? Math.round(loadH) + 'h / ' + Math.round(avail) + 'h' : '— / ' + Math.round(avail) + 'h',
        loadTitle: proposed ? loadH.toFixed(1) + 'h load / ' + Math.round(avail) + 'h available · ' + Math.round(util * 100) + '% utilized' : Math.round(avail) + 'h available in window — no load yet',
        status: a.status === 'pto' ? 'PTO → Jul 16' : 'Active',
        statusBg: a.status === 'pto' ? 'var(--surface-subtle)' : 'var(--sev-low-bg)',
        statusColor: a.status === 'pto' ? 'var(--fg-subtle)' : 'var(--sev-low)',
      }
    })

    // ---- Coaching pairings ----
    interface PairRow {
      id: string; stName: string; stInitials: string; stSub: string
      tag: string; tagBg: string; tagColor: string; stIconBg: string; stIconColor: string
      note: string; coName: string; coInitials: string; coSub: string; fitLabel: string; why: string
      factorRows: { label: string; width: string }[]
      candChips: { label: string; chipBg: string; chipBorder: string; chipColor: string; pick: () => void }[]
      candRows: { initials: string; name: string; why: string; fitLabel: string; isChosen: boolean; notChosen: boolean; rowBorder: string; assign: () => void }[]
      isPending: boolean; isAccepted: boolean; isScheduled: boolean; canSwap: boolean
      footNote: string; sessionLabel: string
      accept: () => void; dismiss: () => void; book: () => void
    }
    const pairRows: PairRow[] = []
    if (SHOW_COACHING && s.coached) this.coaching.forEach((c) => {
      const status = s.coachStatus[c.id] || 'pending'
      if (status === 'dismissed') return
      const cands = this.rankCoaches(c, proposed ? r : null)
      if (!cands.length) return
      const chosen = cands.find((x) => x.a.id === s.coachSel[c.id]) || cands[0]
      const st = this.aById(c.id)
      const session = s.sessions.find((x) => x.sigId === c.id)
      const slot = session ? session.label : this.slotLabel(this.findSlot(c.id, chosen.a.id), c.id, chosen.a.id)
      const pctW = (v: number) => Math.round(Math.max(0.06, Math.min(1, v)) * 100) + '%'
      const factorRows = [
        { label: c.kind === 'acc' ? 'ACCURACY' : 'PACE', width: pctW(chosen.skill) },
        { label: 'SPECIALTY', width: pctW(chosen.spec) },
        { label: 'TIMEZONE', width: pctW(chosen.tz) },
        { label: 'CAPACITY', width: pctW(chosen.cap) },
      ]
      const pick = (aid: string) => this.setState((s2) => ({ coachSel: { ...s2.coachSel, [c.id]: aid }, coachStatus: { ...s2.coachStatus, [c.id]: s2.coachStatus[c.id] === 'scheduled' ? 'scheduled' : 'pending' } }))
      const candChips = cands.map((x) => ({
        label: x.a.name.split(' ')[0] + ' · ' + Math.round(x.fit * 100) + '%',
        chipBg: x.a.id === chosen.a.id ? 'var(--icon-blue-bg)' : 'transparent',
        chipBorder: x.a.id === chosen.a.id ? 'var(--cobalt-blue)' : 'var(--border-strong)',
        chipColor: x.a.id === chosen.a.id ? 'var(--cobalt-blue)' : 'var(--fg-muted)',
        pick: () => pick(x.a.id),
      }))
      const candRows = cands.map((x) => ({
        initials: mkInit(x.a.name),
        name: x.a.name,
        why: x.why,
        fitLabel: Math.round(x.fit * 100) + '%',
        isChosen: x.a.id === chosen.a.id,
        notChosen: x.a.id !== chosen.a.id,
        rowBorder: x.a.id === chosen.a.id ? 'var(--cobalt-blue)' : 'var(--border)',
        assign: () => pick(x.a.id),
      }))
      pairRows.push({
        id: c.id,
        stName: c.name,
        stInitials: mkInit(c.name),
        stSub: st ? st.seniority + ' · ' + st.specialty.replace(/_/g, ' ') + ' · ' + st.tz : '',
        tag: c.kind === 'acc' ? 'ACCURACY DIP' : 'PACE DRIFT',
        tagBg: c.kind === 'acc' ? 'var(--sev-high-bg)' : 'var(--icon-blue-bg)',
        tagColor: c.kind === 'acc' ? 'var(--sev-high)' : 'var(--cobalt-blue)',
        stIconBg: c.kind === 'acc' ? 'var(--icon-amber-bg)' : 'var(--icon-blue-bg)',
        stIconColor: c.kind === 'acc' ? 'var(--sev-high)' : 'var(--cobalt-blue)',
        note: c.note,
        coName: chosen.a.name,
        coInitials: mkInit(chosen.a.name),
        coSub: chosen.a.seniority + ' · ' + chosen.a.specialty.replace(/_/g, ' ') + ' · ' + chosen.a.tz,
        fitLabel: Math.round(chosen.fit * 100) + '% fit',
        why: chosen.why,
        factorRows, candChips, candRows,
        isPending: status === 'pending',
        isAccepted: status === 'accepted',
        isScheduled: status === 'scheduled',
        canSwap: status !== 'scheduled',
        footNote: status === 'scheduled' ? '1h off both schedules · on the timeline' : slot ? 'Next mutual free hour: ' + slot : 'No mutual free hour in window',
        sessionLabel: session ? 'Booked ' + session.label : '',
        accept: () => this.pairAccept(c, chosen),
        dismiss: () => this.pairDismiss(c),
        book: () => this.bookSession(c, chosen.a.id),
      })
    })
    const showCoachingSection = SHOW_COACHING && this.coaching.length > 0
    const coachCaption = s.coached
      ? 'Matching engine — strength in the weak metric · specialty overlap · timezone · spare capacity · max 3 pairs/week'
      : 'Signals queued — ask the assistant who should coach whom this week to run the matching engine'

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
    else if (!proposed) presets.push({ kind: 'assign', label: totImg ? `Schedule everything` : 'Schedule the incoming volume' })
    else {
      if (!s.weekendOT) presets.push({ kind: 'ot', label: 'Authorize weekend overtime for the surge' })
      presets.push({ kind: 'risk', label: "What's at risk right now?" })
    }
    if (!s.coached) presets.push({ kind: 'coach', label: 'Who should coach whom this week?' })
    if (proposed && s.weekendOT) presets.push({ kind: 'risk', label: 'Re-check deadlines' })

    const anyPending = pendingCount > 0
    const pendingLabel = pendingCount ? pendingCount + ' awaiting review' : 'all resolved'
    const acceptAll = () => {
      const decisions = { ...s.decisions }
      batchRows.forEach((b) => { if (b.isPending) decisions[b.key] = 'accepted' })
      this.setState((st) => ({ decisions, messages: [...st.messages, { role: 'ai', text: 'All batches locked in and pushed to each analyst’s Threadr queue as Assigned. I’ll alert you if anyone’s live pace puts an ETA at risk.' }] }))
    }

    const chev = (deg: string) => (
      <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} style={{ color: 'var(--fg-subtle)', flexShrink: 0, transition: 'transform 200ms cubic-bezier(0.2,0.8,0.2,1)', transform: `rotate(${deg})` }}><path d="m9 18 6-6-6-6"></path></svg>
    )
    const headerBtnStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--fg)', fontFamily: "'Instrument Sans', sans-serif", textAlign: 'left' }

    // Reusable coaching sub-blocks --------------------------------------------
    const candidateSwap = (p: PairRow) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>Coach:</span>
        {p.candChips.map((ch, i) => (
          <button key={i} onClick={ch.pick} className="dc-chip" style={{ padding: '4px 11px', borderRadius: 999, background: ch.chipBg, border: `1px solid ${ch.chipBorder}`, color: ch.chipColor, fontFamily: "'Instrument Sans', sans-serif", fontSize: 11, cursor: 'pointer' }}>{ch.label}</button>
        ))}
      </div>
    )
    const pairActions = (p: PairRow) => (
      <>
        {p.isPending && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={p.dismiss} className="dc-deny" style={{ padding: '6px 14px', borderRadius: 999, background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--fg-muted)', fontFamily: "'Instrument Sans', sans-serif", fontSize: 12.5, cursor: 'pointer' }}>Dismiss</button>
            <button onClick={p.accept} className="dc-volt" style={{ padding: '6px 14px', borderRadius: 999, background: 'var(--volt-green)', border: '1px solid var(--volt-green)', color: '#14110F', fontFamily: "'Instrument Sans', sans-serif", fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}>Accept pair</button>
          </div>
        )}
        {p.isAccepted && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--sev-low)' }}>✓ Pair locked</span>
            <button onClick={p.book} className="dc-volt" style={{ padding: '6px 14px', borderRadius: 999, background: 'var(--volt-green)', border: '1px solid var(--volt-green)', color: '#14110F', fontFamily: "'Instrument Sans', sans-serif", fontSize: 12.5, fontWeight: 500, cursor: 'pointer' }}>Book 1h session</button>
          </div>
        )}
        {p.isScheduled && (
          <span style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: 999, background: 'var(--sev-low-bg)', color: 'var(--sev-low)', fontSize: 11.5, fontWeight: 500 }}>{p.sessionLabel}</span>
        )}
      </>
    )

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
                <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 4, animation: `dispatchFadeUp 400ms cubic-bezier(0.2,0.8,0.2,1) ${k.delay} backwards` }}>
                  <span style={{ fontSize: 11, letterSpacing: '0.08em', color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{k.label}</span>
                  <span style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em', color: k.color, transformOrigin: 'left center', animation: k.anim }}>{k.value}</span>
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{k.sub}</span>
                </div>
              ))}
            </div>

            {/* Incoming requests strip */}
            {s.intake && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <button onClick={() => this.setState((st) => ({ reqOpen: !st.reqOpen }))} style={headerBtnStyle}>
                  {chev(s.reqOpen ? '90deg' : '0deg')}
                  <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Incoming requests · Jul 10–18</h2>
                </button>
                {s.reqOpen && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))', gap: 12 }}>
                    {requestRows.map((rq) => (
                      <div key={rq.id} onMouseEnter={rq.enter} onMouseLeave={rq.leave} style={{ background: 'var(--surface)', border: `1px solid ${rq.hovered ? rq.color : 'var(--border)'}`, borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8, transition: 'border-color 200ms cubic-bezier(0.2,0.8,0.2,1)' }}>
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
                )}
              </div>
            )}

            {/* Capacity vs demand chart */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button onClick={() => this.setState((st) => ({ chartOpen: !st.chartOpen }))} style={headerBtnStyle}>
                {chev(s.chartOpen ? '90deg' : '0deg')}
                <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Capacity vs demand</h2>
                <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{chartCaption}</span>
              </button>
              {s.chartOpen && (
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '20px 20px 14px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 170 }}>
                    {chartCols.map((c, i) => (
                      <div key={i} onMouseEnter={c.enter} onMouseLeave={c.leave} style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: c.bg, borderRadius: 6, opacity: c.colOpacity, transition: 'opacity 200ms cubic-bezier(0.2,0.8,0.2,1)' }} title={c.title}>
                        {c.showTip && (
                          <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translate(-50%, -8px)', background: 'var(--surface-elevated)', border: '1px solid var(--border-strong)', borderRadius: 10, padding: '10px 12px', zIndex: 6, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 158, boxShadow: '0 10px 28px rgba(0,0,0,0.5)', pointerEvents: 'none', animation: 'dispatchFadeUp 160ms cubic-bezier(0.2,0.8,0.2,1)' }}>
                            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg)', whiteSpace: 'nowrap' }}>{c.tipTitle}</span>
                            {c.tipRows.map((t, j) => (
                              <span key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}><span style={{ width: 8, height: 8, borderRadius: 2, background: t.color, flexShrink: 0 }}></span>{t.label}<span style={{ marginLeft: 'auto', paddingLeft: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--fg)' }}>{t.val}</span></span>
                            ))}
                            <span style={{ fontSize: 11, color: 'var(--fg-subtle)', whiteSpace: 'nowrap', borderTop: '1px solid var(--border)', paddingTop: 5, marginTop: 2 }}>{c.tipFoot}</span>
                          </div>
                        )}
                        {c.segs.map((sg, j) => (
                          <div key={j} style={{ height: sg.pct, background: sg.color, borderRadius: 2, margin: '0 3px 1px 3px', opacity: sg.opacity, animation: `dispatchBarGrow 520ms cubic-bezier(0.2,0.8,0.2,1) ${sg.delay} backwards`, transition: 'height 360ms cubic-bezier(0.2,0.8,0.2,1), opacity 200ms cubic-bezier(0.2,0.8,0.2,1)' }} title={sg.title}></div>
                        ))}
                        <div style={{ position: 'absolute', left: 0, right: 0, bottom: c.capPct, height: 0, borderTop: `2px dashed ${c.capColor}`, transition: 'bottom 360ms cubic-bezier(0.2,0.8,0.2,1)' }} title={c.capTitle}></div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {chartCols.map((c, i) => (
                      <span key={i} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: c.labelColor }}>{c.label}</span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                    {legendRows.map((l, i) => (
                      <span key={i} onMouseEnter={l.enter} onMouseLeave={l.leave} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-muted)', cursor: 'default', opacity: l.op, transition: 'opacity 200ms cubic-bezier(0.2,0.8,0.2,1)' }}><span style={{ width: 10, height: 10, borderRadius: 3, background: l.color }}></span>{l.label}</span>
                    ))}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--fg-muted)' }}><span style={{ width: 14, borderTop: '2px dashed var(--fg-muted)' }}></span>Available hours (after PTO, weekends, backlog reserve)</span>
                  </div>
                </div>
              )}
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
                              <div style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--fg-muted)', textWrap: 'pretty' }}>{p.reason}</div>
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
                      <div key={gi} onMouseEnter={g.enter} onMouseLeave={g.leave} style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4, opacity: g.rowOpacity, transition: 'opacity 200ms cubic-bezier(0.2,0.8,0.2,1)' }}>
                        <div style={{ width: 128, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 12.5, fontWeight: 500 }}>{g.name}</span>
                          <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>{g.sub}</span>
                        </div>
                        {g.cells.map((c, ci) => (
                          <div key={ci} style={{ flex: 1, height: 26, borderRadius: 5, background: c.bg, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' }} title={c.title}>
                            {c.segs.map((sg, si) => (<div key={si} style={{ height: sg.pct, background: sg.color, opacity: sg.opacity, animation: `dispatchBarGrow 480ms cubic-bezier(0.2,0.8,0.2,1) ${sg.delay} backwards`, transition: 'height 360ms cubic-bezier(0.2,0.8,0.2,1), opacity 200ms cubic-bezier(0.2,0.8,0.2,1)' }} title={sg.title}></div>))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Analyst board */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <button onClick={() => this.setState((st) => ({ boardOpen: !st.boardOpen }))} style={headerBtnStyle}>
                {chev(s.boardOpen ? '90deg' : '0deg')}
                <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Analyst board</h2>
                <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)' }}>{boardCaption}</span>
              </button>
              {s.boardOpen && (
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden', overflowX: 'auto' }}>
                  <div style={{ minWidth: 860 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '200px 130px 110px 90px 1fr 90px', gap: 12, alignItems: 'center', padding: '10px 20px', borderBottom: '1px solid var(--border)', fontSize: 10.5, letterSpacing: '0.08em', color: 'var(--fg-subtle)' }}>
                      <span>ANALYST</span><span>QUALIFIED</span><span>NET RATE</span><span>ACCURACY</span><span>LOAD · JUL 10–25</span><span>STATUS</span>
                    </div>
                    {analystBoardRows.map((a) => (
                      <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '200px 130px 110px 90px 1fr 90px', gap: 12, alignItems: 'center', padding: '12px 20px', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ width: 30, height: 30, borderRadius: 999, background: 'var(--surface-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 500, color: 'var(--fg-muted)', flexShrink: 0 }}>{a.initials}</div>
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap' }}>{a.name}</span>
                            <span style={{ fontSize: 11, color: 'var(--fg-subtle)', whiteSpace: 'nowrap' }}>{a.sub}</span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 5 }}>
                          {a.quals.map((q, i) => (<span key={i} style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--surface-subtle)', border: '1px solid var(--border)', fontSize: 10.5, color: 'var(--fg-muted)' }}>{q}</span>))}
                        </div>
                        <span style={{ fontSize: 12.5, color: 'var(--fg-muted)', fontVariantNumeric: 'tabular-nums' }}>{a.rate}</span>
                        <span style={{ fontSize: 12.5, color: a.accColor, fontVariantNumeric: 'tabular-nums' }}>{a.acc}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div title={a.loadTitle} className="dc-load" style={{ flex: 1, height: 7, borderRadius: 999, background: 'var(--surface-sunken)', overflow: 'hidden', transition: 'height 160ms cubic-bezier(0.2,0.8,0.2,1)' }}>
                            <div style={{ height: '100%', width: a.utilPct, background: a.utilColor, borderRadius: 999, animation: 'dispatchBarGrowW 520ms cubic-bezier(0.2,0.8,0.2,1) backwards', transition: 'width 360ms cubic-bezier(0.2,0.8,0.2,1)' }}></div>
                          </div>
                          <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums', width: 76, flexShrink: 0 }}>{a.utilLabel}</span>
                        </div>
                        <span style={{ justifySelf: 'start', padding: '3px 10px', borderRadius: 999, background: a.statusBg, color: a.statusColor, fontSize: 11, fontWeight: 500 }}>{a.status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Coaching pairings */}
            {showCoachingSection && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <button onClick={() => this.setState((st) => ({ coachOpen: !st.coachOpen }))} style={headerBtnStyle}>
                  {chev(s.coachOpen ? '90deg' : '0deg')}
                  <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Coaching pairings</h2>
                  <span style={{ fontSize: 12.5, color: 'var(--fg-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{coachCaption}</span>
                </button>

                {s.coachOpen && (
                  <>
                    {/* Skeleton placeholders — filled in when the assistant is asked who should coach whom */}
                    {!s.coached && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
                        {this.coaching.map((c) => (
                          <div key={c.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 13 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span className="dc-skel" style={{ width: 34, height: 34, borderRadius: 999, flexShrink: 0 }}></span>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                                <span className="dc-skel" style={{ width: 130, height: 11 }}></span>
                                <span className="dc-skel" style={{ width: 190, height: 8 }}></span>
                              </div>
                              <span className="dc-skel" style={{ width: 46, height: 16, margin: '0 16px', flexShrink: 0 }}></span>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, alignItems: 'flex-end' }}>
                                <span className="dc-skel" style={{ width: 120, height: 11 }}></span>
                                <span className="dc-skel" style={{ width: 170, height: 8 }}></span>
                              </div>
                              <span className="dc-skel" style={{ width: 34, height: 34, borderRadius: 999, flexShrink: 0 }}></span>
                            </div>
                            <span className="dc-skel" style={{ width: '72%', height: 9 }}></span>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                              {[0, 1, 2, 3].map((j) => (
                                <div key={j} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                                  <span className="dc-skel" style={{ width: 52, height: 7 }}></span>
                                  <span className="dc-skel" style={{ width: '100%', height: 5 }}></span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {s.coached && pairRows.length === 0 && (
                      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 20px', fontSize: 13, color: 'var(--fg-muted)' }}>All coaching signals are resolved for this week — new pairings appear here if the daily history flags a trend.</div>
                    )}

                    {/* Pair cards */}
                    {pairRows.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
                        {pairRows.map((p) => (
                          <div key={p.id} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 13, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                              <div style={{ width: 34, height: 34, borderRadius: 999, background: p.stIconBg, color: p.stIconColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 500, flexShrink: 0 }}>{p.stInitials}</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 14, fontWeight: 500 }}>{p.stName}</span>
                                  <span style={{ padding: '2px 8px', borderRadius: 999, background: p.tagBg, color: p.tagColor, fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>{p.tag}</span>
                                </div>
                                <span style={{ fontSize: 11, color: 'var(--fg-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.stSub}</span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0, color: 'var(--fg-subtle)', padding: '0 16px' }}>
                                <svg width="26" height="10" viewBox="0 0 26 10" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M1 5h22"></path><path d="m19 1 4 4-4 4"></path></svg>
                                <span style={{ padding: '2px 9px', borderRadius: 999, background: 'var(--icon-blue-bg)', color: 'var(--cobalt-blue)', fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{p.fitLabel}</span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1, alignItems: 'flex-end' }}>
                                <span style={{ fontSize: 14, fontWeight: 500 }}>{p.coName}</span>
                                <span style={{ fontSize: 11, color: 'var(--fg-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.coSub}</span>
                              </div>
                              <div style={{ width: 34, height: 34, borderRadius: 999, background: 'var(--icon-blue-bg)', color: 'var(--cobalt-blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 500, flexShrink: 0 }}>{p.coInitials}</div>
                            </div>
                            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-muted)' }}>{p.note}</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                              {p.factorRows.map((f, i) => (
                                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                                  <span style={{ fontSize: 9, letterSpacing: '0.08em', color: 'var(--fg-subtle)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.label}</span>
                                  <div style={{ height: 5, borderRadius: 999, background: 'var(--surface-sunken)', overflow: 'hidden' }}>
                                    <div style={{ height: '100%', width: f.width, background: 'var(--cobalt-blue)', borderRadius: 999, animation: 'dispatchBarGrowW 520ms cubic-bezier(0.2,0.8,0.2,1) backwards', transition: 'width 360ms cubic-bezier(0.2,0.8,0.2,1)' }}></div>
                                  </div>
                                </div>
                              ))}
                            </div>
                            {p.canSwap && candidateSwap(p)}
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 'auto' }}>
                              <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{p.footNote}</span>
                              {pairActions(p)}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
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
                <div key={i} style={{ alignSelf: m.align as any, maxWidth: '90%', padding: '11px 15px', borderRadius: m.radius, background: m.bg, color: m.color, fontSize: 13.5, lineHeight: 1.5, textWrap: 'pretty', whiteSpace: 'pre-line' }}>{m.text}</div>
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

import { idxOf } from '../engine/days'

export interface Analyst {
  id: string
  name: string
  role: string
  canA: boolean
  canR: boolean
  canS: boolean
  rateA: number
  rateR: number
  rateS: number
  acc: number
  hours: number
  status: string
  seniority: string
  specialty: string
  tz: string
}

export interface RequestRow {
  id: string
  org: string
  line: string
  structures: number
  images: number
  priority: string
  notes: string
  arrIdx: number
  dueIdx: number
}

export interface Backlog {
  A: number
  R: number
  S: number
}

export type ThroughputRow = Record<string, string>

export interface DispatchData {
  analysts: Analyst[]
  requests: RequestRow[]
  backlog: Backlog
  throughput: ThroughputRow[]
}

// Minimal CSV parser — port of the design's parseCSV (comma-split, trimmed).
export function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/)
  const keys = lines[0].split(',')
  return lines.slice(1).map((l) => {
    const v = l.split(',')
    const o: Record<string, string> = {}
    keys.forEach((k, i) => (o[k] = (v[i] ?? '').trim()))
    return o
  })
}

export async function loadDispatchData(): Promise<DispatchData> {
  const get = (p: string) => fetch(p).then((r) => r.text())
  const [an, inc, bl, th] = await Promise.all([
    get('data/analysts.csv'),
    get('data/incoming_volume_scenario.csv'),
    get('data/structures_backlog.csv'),
    get('data/throughput_history.csv'),
  ])
  const A = parseCSV(an)
  const I = parseCSV(inc)
  const B = parseCSV(bl)
  const T = parseCSV(th)

  const analysts: Analyst[] = A.map((r) => ({
    id: r.analyst_id,
    name: r.display_name,
    role: r.role,
    canA: r.can_annotate === 'True',
    canR: r.can_review === 'True',
    canS: r.can_secondary_review === 'True',
    rateA: parseFloat(r.annotation_img_per_hr) || 0,
    rateR: parseFloat(r.review_img_per_hr) || 0,
    rateS: parseFloat(r.secondary_review_img_per_hr) || 0,
    acc: parseFloat(r.accuracy_pct_not_returned) || 90,
    hours: parseFloat(r.daily_capacity_hours) || 0,
    status: r.status,
    seniority: r.seniority,
    specialty: r.specialty,
    tz: r.timezone,
  }))

  const requests: RequestRow[] = I.map((r) => ({
    id: r.incoming_request_id,
    org: r.org_name,
    line: r.powerline_name,
    structures: +r.structure_count,
    images: +r.image_count,
    priority: r.priority,
    notes: r.notes,
    arrIdx: idxOf(r.arrival_date),
    dueIdx: idxOf(r.due_date),
  }))

  const backlog: Backlog = { A: 0, R: 0, S: 0 }
  B.forEach((s) => {
    const n = +s.image_count
    if (s.current_stage === 'not_started' || s.current_stage === 'annotation') backlog.A += n
    else if (s.current_stage === 'review') backlog.R += n
    else if (s.current_stage === 'secondary_review') backlog.S += n
  })

  return { analysts, requests, backlog, throughput: T }
}

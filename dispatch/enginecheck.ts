import { readFileSync } from 'fs'
import { parseCSV, type Analyst, type RequestRow, type Backlog } from './src/data/loadCsv'
import { idxOf } from './src/engine/days'
import { schedule } from './src/engine/schedule'
import { deriveCoaching } from './src/engine/coaching'

const D = 'public/data/'
const rd = (f: string) => readFileSync(D + f, 'utf8')
const A = parseCSV(rd('analysts.csv'))
const I = parseCSV(rd('incoming_volume_scenario.csv'))
const B = parseCSV(rd('structures_backlog.csv'))
const T = parseCSV(rd('throughput_history.csv'))

console.log('row counts:', { analysts: A.length, incoming: I.length, backlog: B.length, throughput: T.length })

const analysts: Analyst[] = A.map((r) => ({
  id: r.analyst_id, name: r.display_name, role: r.role,
  canA: r.can_annotate === 'True', canR: r.can_review === 'True', canS: r.can_secondary_review === 'True',
  rateA: parseFloat(r.annotation_img_per_hr) || 0, rateR: parseFloat(r.review_img_per_hr) || 0, rateS: parseFloat(r.secondary_review_img_per_hr) || 0,
  acc: parseFloat(r.accuracy_pct_not_returned) || 90, hours: parseFloat(r.daily_capacity_hours) || 0,
  status: r.status, seniority: r.seniority, specialty: r.specialty, tz: r.timezone,
}))
const requests: RequestRow[] = I.map((r) => ({
  id: r.incoming_request_id, org: r.org_name, line: r.powerline_name,
  structures: +r.structure_count, images: +r.image_count, priority: r.priority, notes: r.notes,
  arrIdx: idxOf(r.arrival_date), dueIdx: idxOf(r.due_date),
}))
const backlog: Backlog = { A: 0, R: 0, S: 0 }
B.forEach((s) => { const n = +s.image_count
  if (s.current_stage === 'not_started' || s.current_stage === 'annotation') backlog.A += n
  else if (s.current_stage === 'review') backlog.R += n
  else if (s.current_stage === 'secondary_review') backlog.S += n })
console.log('backlog imgs by stage:', backlog)

for (const ot of [false, true]) {
  const r = schedule(analysts, requests, backlog, ot, [], 20)
  console.log(`\n=== weekendOT=${ot} — ${r.batches.length} batches ===`)
  requests.forEach((q) => {
    const rr = r.reqResults[q.id]
    console.log(` req${q.id} ${q.line} (${q.priority}): eta=${rr.etaIdx} slack=${rr.slack} unfinished=${rr.unfinished}`)
  })
}
console.log('\ncoaching signals:', deriveCoaching(T).map((c) => `${c.name}:${c.kind}`))

// Fixed 16-day planning window: Fri Jul 10 2026 .. Sat Jul 25 2026.
// Mirrors the design (frozen "today" = Jul 10, day index 0).
export interface Day {
  iso: string
  label: string
  short: string
  isWeekend: boolean
}

export const DAYS: Day[] = (() => {
  const out: Day[] = []
  for (let i = 0; i < 16; i++) {
    const dt = new Date(Date.UTC(2026, 6, 10 + i))
    const dow = dt.getUTCDay()
    out.push({
      iso: dt.toISOString().slice(0, 10),
      label: 'Jul ' + (10 + i),
      short: String(10 + i),
      isWeekend: dow === 0 || dow === 6,
    })
  }
  return out
})()

export const N_DAYS = DAYS.length

// Map an ISO date to its index in the window (day 0 = Jul 10).
export function idxOf(iso: string): number {
  const d = new Date(iso + 'T00:00:00Z').getTime()
  return Math.round((d - Date.UTC(2026, 6, 10)) / 86400000)
}

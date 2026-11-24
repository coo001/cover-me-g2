// Reads a private iCal address (Google Calendar "secret address in iCal format" or any .ics URL)
// and answers one question: which meeting is on now or comes next.
// The address is a secret: it is never logged and never sent to the glasses.

function tzOffsetMs(epoch, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(epoch)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(epoch / 1000) * 1000
}
// Wall clock time in a zone -> epoch ms. tz null = already UTC.
function wallToEpoch(w, tz) {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  if (!tz) return guess
  try {
    const first = guess - tzOffsetMs(guess, tz)
    return guess - tzOffsetMs(first, tz)
  } catch { return guess } // unknown zone name: read it as UTC rather than crash
}
function parseStamp(value, params, defaultTz) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  if (m[4] == null) return { allDay: true }
  const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] }
  const tz = m[7] ? null : (params.TZID ?? defaultTz)
  return { wall, tz, epoch: wallToEpoch(wall, tz) }
}
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const addDays = (w, n) => {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + n))
  return { ...w, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() }
}
const weekday = w => DAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]

export function parseIcs(text, systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const rows = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  let defaultTz = systemTz
  const events = []
  let ev = null
  for (const row of rows) {
    if (row === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue }
    if (row === 'END:VEVENT') { if (ev?.start && !ev.start.allDay && ev.status !== 'CANCELLED') events.push(ev); ev = null; continue }
    const i = row.indexOf(':')
    if (i < 0) continue
    const [name, ...ps] = row.slice(0, i).split(';')
    const value = row.slice(i + 1)
    const params = Object.fromEntries(ps.map(p => { const k = p.indexOf('='); return [p.slice(0, k).toUpperCase(), p.slice(k + 1).replace(/^"|"$/g, '')] }))
    if (!ev) { if (name === 'X-WR-TIMEZONE') defaultTz = value.trim(); continue }
    if (name === 'DTSTART') ev.start = parseStamp(value, params, defaultTz)
    else if (name === 'DTEND') ev.end = parseStamp(value, params, defaultTz)
    else if (name === 'SUMMARY') ev.title = value.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ')
    else if (name === 'UID') ev.uid = value
    else if (name === 'STATUS') ev.status = value.trim().toUpperCase()
    else if (name === 'RRULE') ev.rrule = Object.fromEntries(value.split(';').map(kv => kv.split('=')))
    else if (name === 'EXDATE') for (const v of value.split(',')) { const s = parseStamp(v, params, defaultTz); if (s?.epoch) ev.exdates.push(s.epoch) }
    else if (name === 'RECURRENCE-ID') ev.recurrenceId = parseStamp(value, params, defaultTz)?.epoch
  }
  // A moved single instance replaces the one the series would have produced.
  for (const e of events) if (e.recurrenceId != null) for (const s of events) if (s !== e && s.uid === e.uid && s.rrule) s.exdates.push(e.recurrenceId)
  return events
}

// Every occurrence that ends after `from` and starts before `to`, sorted by start.
export function occurrences(events, from, to) {
  const out = []
  for (const e of events) {
    const dur = (e.end?.epoch ?? e.start.epoch) - e.start.epoch
    if (dur <= 0) continue
    const add = start => { if (start + dur > from && start < to && !e.exdates.includes(start)) out.push({ title: e.title ?? '(no title)', start, end: start + dur }) }
    const r = e.rrule
    if (!r || (r.FREQ !== 'DAILY' && r.FREQ !== 'WEEKLY')) { add(e.start.epoch); continue } // other repeat rules: first one only
    const every = Math.max(1, Number(r.INTERVAL ?? 1))
    const count = r.COUNT ? Number(r.COUNT) : Infinity
    const until = r.UNTIL ? (parseStamp(r.UNTIL, {}, e.start.tz)?.epoch ?? Date.UTC(+r.UNTIL.slice(0, 4), +r.UNTIL.slice(4, 6) - 1, +r.UNTIL.slice(6, 8), 23, 59, 59)) : Infinity
    const byday = r.FREQ === 'WEEKLY' && r.BYDAY ? r.BYDAY.split(',') : null
    const firstWeekStart = addDays(e.start.wall, -DAYS.indexOf(weekday(e.start.wall)))
    let n = 0
    for (let k = 0; k < 3700 && n < count; k++) {
      const w = addDays(e.start.wall, k)
      if (r.FREQ === 'DAILY' && k % every) continue
      if (r.FREQ === 'WEEKLY') {
        const weeks = Math.floor((Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(firstWeekStart.y, firstWeekStart.mo - 1, firstWeekStart.d)) / (7 * 86400000))
        if (weeks % every) continue
        if (byday ? !byday.includes(weekday(w)) : k % 7) continue
      }
      const start = wallToEpoch(w, e.start.tz)
      if (start > until || start >= to) break
      n++
      add(start)
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

export async function fetchEvents(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('not an iCal file')
  return parseIcs(text)
}

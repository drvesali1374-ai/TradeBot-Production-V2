/**
 * Cycle ID — the owner's readable format:
 *   {SYMBOL}_{YYYYMMDD}_{HHMMSS}   e.g. DOT_14050730_103126
 * (DOT on 1405/07/30 at 10:31:26). Date/time parts come from the
 * Jalali (Persian) calendar in the Asia/Tehran timezone with ASCII
 * digits. When no symbol is known yet (early exits before selection)
 * the prefix CYCLE is used: CYCLE_14050730_103126.
 *
 * Robustness: parts are extracted from formatToParts by TYPE (never by
 * slicing the formatted string — field order varies across ICU builds
 * and locales). Some ICU builds emit hour "24" with hour12:false;
 * that is normalized to "00" (Tehran midnight belongs to the SAME day,
 * so no date rollover is needed — the formatter already rolled it).
 */

const TEHRAN_JALALI = new Intl.DateTimeFormat('en-US-u-ca-persian', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Symbol → ID-safe prefix: uppercase, keep [A-Z0-9] only; empty → CYCLE. */
function symbolPrefix(symbol: string | null | undefined): string {
  const cleaned = (symbol ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  return cleaned || 'CYCLE'
}

function pad(value: string | undefined, length: number): string {
  return (value ?? '').padStart(length, '0')
}

/**
 * Build a cycle id in the owner's format for the given instant.
 * @param symbol short symbol name (e.g. "DOT"); null/undefined/empty → "CYCLE"
 * @param at    epoch-ms timestamp (default: now)
 */
export function makeCycleId(symbol: string | null | undefined, at: number = Date.now()): string {
  const fields: Record<string, string> = {}
  for (const part of TEHRAN_JALALI.formatToParts(new Date(at))) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  let hour = fields.hour ?? '00'
  if (hour === '24') hour = '00' // h23 guard (see header note)
  const date = `${pad(fields.year, 4)}${pad(fields.month, 2)}${pad(fields.day, 2)}`
  const time = `${pad(hour, 2)}${pad(fields.minute, 2)}${pad(fields.second, 2)}`
  return `${symbolPrefix(symbol)}_${date}_${time}`
}

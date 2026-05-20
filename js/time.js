// ────────────────────────────────────────────────────────────────────────────
// time.js — date-key + duration formatting helpers.
//
// ⚠ All per-day storage keys (state.data, intervalTasks, completedHistory.day,
//   diceLastFireDay, flow.dayKey, …) MUST go through localDateKey() so midnight
//   rollovers happen at midnight in the USER's local timezone — never in UTC.
//   Format: "YYYY-MM-DD".
// ────────────────────────────────────────────────────────────────────────────

/** Local-time date key for a given Date (defaults to now). Returns "YYYY-MM-DD". */
export function localDateKey(d){
  const date = (d instanceof Date) ? d : new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Today's local date key. */
export function todayISO(){
  return localDateKey(new Date());
}

/** Yesterday's local date key (24h before today, then truncated). */
export function yesterdayISO(){
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateKey(d);
}

/** Format seconds → "MM:SS" (no hour rollover). */
export function fmtTime(sec){
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Alias used by the Flow renderer; identical format. */
export const fmtTimeFlow = fmtTime;

/** Format minutes → "Xh YYm" when ≥ 60 min, else "Ym". */
export function fmtHoursFromMinutes(mins){
  const m = Math.max(0, Math.floor(mins));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if(h <= 0) return `${r}m`;
  return `${h}h ${String(r).padStart(2, "0")}m`;
}

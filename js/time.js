// ────────────────────────────────────────────────────────────────────────────
// time.js — date-key + duration formatting helpers.
//
// ⚠ All per-day storage keys (state.data, intervalTasks, completedHistory.day,
//   diceLastFireDay, flow.dayKey, …) MUST go through localDateKey() so midnight
//   rollovers happen at midnight in the USER's local timezone — never in UTC.
//   Format: "YYYY-MM-DD".
// ────────────────────────────────────────────────────────────────────────────

// The "study day" rolls over at this local hour, NOT at midnight. A session
// finished at 00:30 still counts toward the previous day, and the daily reset
// (intervals, progress, streak window) happens at this hour so a late-night
// learner is never interrupted. Change this single constant to move the cutoff.
export const DAY_CUTOFF_HOUR = 1;

/**
 * "Now" shifted back by the cutoff so the logical study-day boundary sits at
 * DAY_CUTOFF_HOUR instead of midnight. Use this for every "what day is it now?"
 * question (today/yesterday keys, streak/heatmap/week anchors). Do NOT use it to
 * key an explicit historical Date — pass those straight to localDateKey().
 */
export function logicalNow(){
  return new Date(Date.now() - DAY_CUTOFF_HOUR * 3600 * 1000);
}

/** Local-time date key for a given Date (defaults to logical now). Returns "YYYY-MM-DD". */
export function localDateKey(d){
  const date = (d instanceof Date) ? d : logicalNow();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Today's local study-day key (rolls over at DAY_CUTOFF_HOUR). */
export function todayISO(){
  return localDateKey(logicalNow());
}

/** Yesterday's local study-day key (24h before logical now, then truncated). */
export function yesterdayISO(){
  const d = logicalNow();
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

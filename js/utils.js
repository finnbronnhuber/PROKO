// ────────────────────────────────────────────────────────────────────────────
// utils.js — small, pure helpers with no app-state dependencies.
// Safe to import from anywhere; never imports anything from the app.
// ────────────────────────────────────────────────────────────────────────────

/** Shorthand for document.getElementById. */
export const el = (id) => document.getElementById(id);

/** Shallow-safe deep clone for plain JSON-compatible structures. */
export function deepClone(obj){
  return JSON.parse(JSON.stringify(obj));
}

/** Clamp n into [min, max]. */
export function clamp(n, min, max){
  return Math.max(min, Math.min(max, n));
}

/** Generate a short, sortable-ish template ID. */
export function genTemplateId(){
  return "tmpl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
}

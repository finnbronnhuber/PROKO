// ────────────────────────────────────────────────────────────────────────────
// constants.js — every magic-number and palette in one place.
// No state, no DOM, no side effects. Safe to import everywhere.
// ────────────────────────────────────────────────────────────────────────────

// ── Storage keys ────────────────────────────────────────────────────────────
export const STORAGE_KEY        = "lernplan_browser_v1"; // legacy / unused
export const LOCAL_FALLBACK_KEY = "lernplan_pending_v2";
export const PERSIST_INTERVAL   = 5000;                  // throttled persist (ms)

// ── Streaks / learning ─────────────────────────────────────────────────────
export const STREAK_THRESHOLD_MIN = 30;
export const DICE_TIMER_TOTAL_SEC = 1800;  // 30 min

// ── Session / template caps ─────────────────────────────────────────────────
export const MAX_SESSIONS  = 16;
export const MAX_TEMPLATES = 10;

// ── To-Do / Tasks ──────────────────────────────────────────────────────────
export const TASK_MAX    = 10;       // per interval session
export const INBOX_MAX   = 50;       // unsorted inbox capacity
export const INBOX_KEY   = "inbox";  // sentinel session-key
export const SUBTASK_MAX = 20;

// ── Flow mode ──────────────────────────────────────────────────────────────
export const FLOW_PROMPT_WINDOW_SEC = 30;     // (legacy) 30-sec window after every 10-min mark
export const FLOW_MIN_INTERVAL_SEC  = 60;     // a learning block counts as an interval after 1 min;
                                              // pausing/ending is allowed any time past this mark
export const FLOW_AUTO_FIRST_SEC    = 3600;   // first auto-prompt (recommendation) at 60 min
export const FLOW_AUTO_INTERVAL_SEC = 1800;   // every 30 min after that
export const FLOW_BREAK_DEFAULT_MIN = 10;

// ── Dice game (Casino) balance ──────────────────────────────────────────────
// "exact" base is OVERWRITTEN at runtime to sides × 0.9 (kept here so the
// settings UI still has a sensible default before the casino UI initializes).
export const DICE_BALANCE = {
  exact: { base: 5.4,  streakBonus: 0.15 },
  oe:    { base: 1.85, streakBonus: 0.10 },
};

// ── Dice catalog (Würfel-Shop) ──────────────────────────────────────────────
export const DICE_TYPES  = ["d4", "d6", "d8", "d10", "d12", "d20"];
export const DICE_SIDES  = { d4:4, d6:6, d8:8, d10:10, d12:12, d20:20 };
export const DICE_PRICES = { d4:0, d6:100, d8:1000, d10:10000, d12:100000, d20:1000000 };
export const DICE_LABELS = { d4:"W4", d6:"W6", d8:"W8", d10:"W10", d12:"W12", d20:"W20" };

// ── Würfel-Skins & Lootboxen ────────────────────────────────────────────────
// Farben in ABSTEIGENDER Ziehungs-Wahrscheinlichkeit (Index-paralleles Gewichts-Array).
export const SKIN_COLORS        = ["yellow", "red", "blue", "green", "orange", "violet"];
export const SKIN_COLOR_WEIGHTS = [40, 25, 15, 10, 6, 4]; // Summe = 100
export const SKIN_COLOR_HEX = {
  yellow: "#F5C542",
  red:    "#E94560",
  blue:   "#2196F3",
  green:  "#3DC061",
  orange: "#F97316",
  violet: "#8B5CF6",
};
export const SKIN_COLOR_NAMES_DE = {
  yellow: "Gelb",
  red:    "Rot",
  blue:   "Blau",
  green:  "Grün",
  orange: "Orange",
  violet: "Violett",
};
// Skin-Code-Buchstaben = englische Anfangsbuchstaben der Farbe (yellow→y, red→r, …).
// Der Code ist der "Name" eines Skins: "#" + ein Buchstabe pro Würfelseite (Seite 1 zuerst).
export const SKIN_COLOR_LETTERS = {
  yellow: "y",
  red:    "r",
  blue:   "b",
  green:  "g",
  orange: "o",
  violet: "v",
};
export const LOOTBOX_PRICE = 10;   // Punkte pro Lootbox
export const MAX_SKINS     = 200;  // Sammlungs-Limit (neue Ziehungen werden blockiert)

// ── Color palettes ──────────────────────────────────────────────────────────
export const HEAT_LIGHT = ["#F0F0EC", "#D8D8D0", "#A8A8A0", "#707068", "#383838", "#111111"];
export const HEAT_DARK  = ["#1C1C1B", "#3A3A38", "#5A5A56", "#8A8A85", "#C0C0BB", "#FAFAF7"];

export const CONFETTI_COLORS = [
  "#111111","#444444","#777777","#AAAAAA",
  "#1F7A3A","#E94560","#F5A623","#2196F3",
];

// Shared palette used by both project colors AND profile avatars.
export const PROJECT_COLOR_PALETTE = [
  "#3DC061", "#E94560", "#F5A623", "#2196F3",
  "#8B5CF6", "#EC4899", "#14B8A6", "#F97316",
];
export const AVATAR_COLOR_OPTIONS = [
  "#3DC061","#E94560","#F5A623","#2196F3",
  "#8B5CF6","#EC4899","#14B8A6","#F97316",
];

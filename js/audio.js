// ────────────────────────────────────────────────────────────────────────────
// audio.js — Web Audio engine + UI/game sound effects + iOS unlock handler.
//
// ⚠ iOS / Safari REQUIRES that the AudioContext is resumed synchronously
//   inside a real user-gesture handler, and a 1-sample silent buffer needs
//   to be played to fully wake the audio pipeline. Both happen automatically
//   on first touch/click/keydown thanks to the side-effect listeners below.
//
// Volume coupling: this module deliberately does NOT import the app state.
// Instead, the host (script.js) registers a callback via setVolumeProvider()
// that returns the current [0..1] master volume. Default = 1 (full volume).
// ────────────────────────────────────────────────────────────────────────────

let audioCtx = null;
let audioUnlocked = false;

// ── Volume bridge ──────────────────────────────────────────────────────────
let _volumeProvider = () => 1;
/**
 * Register a function that returns the effective master-volume multiplier
 * in the range [0..1]. Returning 0 silences all sounds.
 */
export function setVolumeProvider(fn){
  if(typeof fn === "function") _volumeProvider = fn;
}
function effectiveVolumeMult(){
  const v = _volumeProvider();
  if(!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// ── iOS unlock ──────────────────────────────────────────────────────────────
function unlockAudioGesture(){
  try{
    if(!audioCtx){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return;
      audioCtx = new AC();
    }
    if(audioCtx.state === "suspended"){
      const p = audioCtx.resume();
      if(p && typeof p.then === "function") p.catch(() => {});
    }
    // Silent priming buffer — required on iOS to fully unlock playback
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    if(typeof src.start === "function") src.start(0);
    else if(typeof src.noteOn === "function") src.noteOn(0);
    audioUnlocked = (audioCtx.state === "running");
    if(audioUnlocked) detachAudioUnlock();
  }catch(_){ /* will retry on next gesture */ }
}
function detachAudioUnlock(){
  document.removeEventListener("touchend",    unlockAudioGesture, true);
  document.removeEventListener("touchstart",  unlockAudioGesture, true);
  document.removeEventListener("pointerdown", unlockAudioGesture, true);
  document.removeEventListener("mousedown",   unlockAudioGesture, true);
  document.removeEventListener("keydown",     unlockAudioGesture, true);
  document.removeEventListener("click",       unlockAudioGesture, true);
}

// Attach in capture phase so we run before any app listeners
document.addEventListener("touchend",    unlockAudioGesture, true);
document.addEventListener("touchstart",  unlockAudioGesture, true);
document.addEventListener("pointerdown", unlockAudioGesture, true);
document.addEventListener("mousedown",   unlockAudioGesture, true);
document.addEventListener("keydown",     unlockAudioGesture, true);
document.addEventListener("click",       unlockAudioGesture, true);

// Re-resume after visibility changes (iOS sometimes suspends on tab hide).
// Note: script.js may also do this for Flow-mode reasons; both are idempotent.
document.addEventListener("visibilitychange", () => {
  if(document.visibilityState === "visible" && audioCtx && audioCtx.state === "suspended"){
    try{ const p = audioCtx.resume(); if(p && p.then) p.catch(() => {}); }catch(_){}
  }
});

// ── Engine primitives ──────────────────────────────────────────────────────
export function getCtx(){
  if(!audioCtx){
    try{
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }catch(_){ audioCtx = null; }
  }
  if(audioCtx && audioCtx.state === "suspended"){
    // resume() is async; we don't await it because tones are scheduled ahead
    // via ctx.currentTime + delay and will play once it transitions to "running".
    try{ const p = audioCtx.resume(); if(p && p.then) p.catch(() => {}); }catch(_){}
  }
  return audioCtx;
}

export function playTone(freq, type, duration, volume = 0.3, delay = 0){
  const mult = effectiveVolumeMult();
  if(mult <= 0) return;
  const ctx = getCtx(); if(!ctx) return;
  try{
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = type;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(Math.max(volume * mult, 0.0002), ctx.currentTime + delay + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration + 0.05);
  }catch(_){}
}

export function playNoise(duration, volume = 0.12, delay = 0, filterFreq = 800, filterQ = 0.5){
  const mult = effectiveVolumeMult();
  if(mult <= 0) return;
  const ctx = getCtx(); if(!ctx) return;
  try{
    const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * duration), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const gain = ctx.createGain();
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass"; filt.frequency.value = filterFreq; filt.Q.value = filterQ;
    src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(Math.max(volume * mult, 0.0002), ctx.currentTime + delay + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
    src.start(ctx.currentTime + delay);
    src.stop(ctx.currentTime + delay + duration + 0.05);
  }catch(_){}
}

// ── Subtle UI sounds (navigation, settings, etc.) ──────────────────────────
export function uiTabSwitch(){ playTone(720, "sine", 0.05, 0.07); playTone(960, "sine", 0.04, 0.045, 0.04); }
export function uiSoftClick(){ playTone(880, "sine", 0.04, 0.06); }
export function uiToggle(){    playTone(560, "sine", 0.06, 0.08); playTone(740, "sine", 0.05, 0.055, 0.05); }
export function uiStepper(up){
  if(up){ playTone(900, "sine", 0.04, 0.055); playTone(1150, "sine", 0.03, 0.04, 0.03); }
  else  { playTone(720, "sine", 0.04, 0.055); playTone(560,  "sine", 0.04, 0.04, 0.03); }
}
export function uiSave(){  playTone(640, "sine", 0.07, 0.10); playTone(960, "sine", 0.10, 0.08, 0.08); playTone(1280, "sine", 0.12, 0.06, 0.18); }
export function uiError(){ playTone(380, "sine", 0.07, 0.10); playTone(280, "sine", 0.10, 0.10, 0.08); }

// ── Reward dice (rolling for points after a session) ───────────────────────
export function rewardRollStart(){
  for(let i = 0; i < 8; i++){
    const d = i * 0.06;
    playNoise(0.03, 0.10, d, 1000, 0.6);
    playTone(220 + Math.random() * 220, "square", 0.025, 0.07, d + 0.005);
  }
}
export function rewardLand(roll){
  playNoise(0.10, 0.20, 0, 600, 0.4);
  playTone(140, "sine", 0.18, 0.22);
  const top = 660 + roll * 90;     // Higher rolls = brighter chime
  playTone(top,        "sine", 0.18, 0.18, 0.10);
  playTone(top * 1.5,  "sine", 0.14, 0.10, 0.18);
}

// ── Dice GAME sounds (more pronounced, playful) ────────────────────────────
export function diceGameClick(){ playTone(620, "sine", 0.07, 0.18); }
export function diceSelect(){    playTone(880, "sine", 0.06, 0.25); playTone(1180, "sine", 0.06, 0.18, 0.06); }
export function diceClose(){     playTone(700, "sine", 0.07, 0.18); playTone(500,  "sine", 0.07, 0.18, 0.07); }
export function diceTickRoll(){  playNoise(0.025, 0.10, 0, 900, 0.5); playTone(250 + Math.random()*150, "square", 0.022, 0.07); }
export function diceLand(){      playNoise(0.12, 0.30, 0, 500, 0.4); playTone(120, "sawtooth", 0.15, 0.22); playTone(80, "sine", 0.20, 0.16, 0.05); }
export function diceRollStart(){
  for(let i = 0; i < 10; i++){
    const d = i * 0.08;
    playNoise(0.04, 0.16, d, 800, 0.5);
    playTone(200 + Math.random() * 200, "square", 0.03, 0.08, d + 0.01);
  }
}
export function diceWin(isStreak){
  const notes = isStreak ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
  notes.forEach((f, i) => playTone(f, "sine", 0.25, 0.32, i * 0.12));
  playTone(2093, "sine", 0.15, 0.13, notes.length * 0.12);
  if(isStreak) playTone(2637, "sine", 0.15, 0.16, notes.length * 0.12 + 0.12);
}
export function diceStreakUp(){
  playTone(1200, "sine", 0.06, 0.22);
  playTone(1600, "sine", 0.08, 0.18, 0.07);
  playTone(2000, "sine", 0.10, 0.13, 0.15);
}

// ── Soft, less painful lose / game-over sounds ─────────────────────────────
export function diceLose(){
  playTone(330, "sine", 0.18, 0.16, 0);     // E4
  playTone(247, "sine", 0.22, 0.16, 0.16);  // B3
  playTone(196, "sine", 0.40, 0.13, 0.36);  // G3
  playTone(98,  "sine", 0.55, 0.06, 0.10);  // G2 sub-rumble
}
export function diceGameOver(){
  playTone(440, "sine", 0.32, 0.18, 0.00);  // A4
  playTone(349, "sine", 0.36, 0.16, 0.20);  // F4
  playTone(262, "sine", 0.42, 0.14, 0.45);  // C4
  playTone(196, "sine", 0.60, 0.12, 0.70);  // G3
  playTone(131, "sine", 1.10, 0.10, 0.95);  // C3
  playTone(65,  "sine", 1.50, 0.05, 0.30);  // C2 pad
  playNoise(1.20, 0.02, 0.20, 250, 0.7);    // atmosphere
}

// ── Tiny single-tone helper used by the timer alarm in script.js ──────────
// (script.js still owns the alarm interval + state, but plays via this.)
export function alarmTone(){ playTone(880, "square", 0.12, 0.05); }

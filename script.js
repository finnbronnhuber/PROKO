    (() => {
      let TOTAL_SESSIONS = 8; // recomputed from settings (goal_min ÷ learn_min)
      const DEFAULT_SETTINGS = {
        goal_value: 4,
        goal_unit: "h",
        learn_min: 30,
        break_odd_min: 5,
        break_even_min: 10,
        big_break_enabled: true,
        big_break_after: 4,
        big_break_min: 180,
      };
      const HEAT_LIGHT = ["#F0F0EC", "#D8D8D0", "#A8A8A0", "#707068", "#383838", "#111111"];
      const HEAT_DARK  = ["#1C1C1B", "#3A3A38", "#5A5A56", "#8A8A85", "#C0C0BB", "#FAFAF7"];
      const CONFETTI_COLORS = ["#111111","#444444","#777777","#AAAAAA","#1F7A3A","#E94560","#F5A623","#2196F3"];
      const STORAGE_KEY = "lernplan_browser_v1"; // legacy / unused — kept for backwards compat
      // ════════════════════════════════════════════════════════════
      //   SUPABASE CLIENT  (cloud sync + auth)
      // ════════════════════════════════════════════════════════════
      const SUPABASE_URL = "https://pmohhvonilbhovlyemxa.supabase.co";
      const SUPABASE_KEY = "sb_publishable_wBu1RLh7OqFl-cPhyxqf7g_Q4DV2wl3";
      const sb = (window.supabase && typeof window.supabase.createClient === "function")
        ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: true, autoRefreshToken: true }
          })
        : null;
      let currentUser = null;
      let guestMode = false;       // true → app runs without auth, nothing is persisted
      let appBootstrapped = false; // init() ran once
      let recoveryMode = false;    // true while user is in password-reset flow (post email-link)
      const DICE_BALANCE = {
        exact: { base: 5.4,  streakBonus: 0.15 },
        oe:    { base: 1.85, streakBonus: 0.10 }
      };

      const el = id => document.getElementById(id);

      // ════════════════════════════════════════════════════════════
      //   SOUND ENGINE  (consolidated, with subtle UI sounds + new
      //   softer lose / game-over sounds for the dice game)
      // ════════════════════════════════════════════════════════════
      let audioCtx = null;
      function getCtx(){
        if(!audioCtx){
          try{ const AC = window.AudioContext || window.webkitAudioContext; audioCtx = new AC(); }catch(e){ audioCtx = null; }
        }
        if(audioCtx && audioCtx.state === "suspended"){ try{ audioCtx.resume(); }catch(e){} }
        return audioCtx;
      }
      function playTone(freq, type, duration, volume = 0.3, delay = 0){
        if(!state.soundEnabled) return;
        const ctx = getCtx(); if(!ctx) return;
        try{
          const osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.type = type;
          osc.connect(gain); gain.connect(ctx.destination);
          osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
          gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0002), ctx.currentTime + delay + 0.005);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
          osc.start(ctx.currentTime + delay);
          osc.stop(ctx.currentTime + delay + duration + 0.05);
        }catch(e){}
      }
      function playNoise(duration, volume = 0.12, delay = 0, filterFreq = 800, filterQ = 0.5){
        if(!state.soundEnabled) return;
        const ctx = getCtx(); if(!ctx) return;
        try{
          const buf = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * duration), ctx.sampleRate);
          const d = buf.getChannelData(0);
          for(let i=0;i<d.length;i++) d[i] = Math.random()*2 - 1;
          const src = ctx.createBufferSource(); src.buffer = buf;
          const gain = ctx.createGain();
          const filt = ctx.createBiquadFilter();
          filt.type = "bandpass"; filt.frequency.value = filterFreq; filt.Q.value = filterQ;
          src.connect(filt); filt.connect(gain); gain.connect(ctx.destination);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
          gain.gain.exponentialRampToValueAtTime(Math.max(volume, 0.0002), ctx.currentTime + delay + 0.003);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + duration);
          src.start(ctx.currentTime + delay);
          src.stop(ctx.currentTime + delay + duration + 0.05);
        }catch(e){}
      }

      // ── Subtle UI sounds (PROKO navigation, settings, etc.) ──
      function uiTabSwitch(){ playTone(720, "sine", 0.05, 0.07); playTone(960, "sine", 0.04, 0.045, 0.04); }
      function uiSoftClick(){ playTone(880, "sine", 0.04, 0.06); }
      function uiToggle(){ playTone(560, "sine", 0.06, 0.08); playTone(740, "sine", 0.05, 0.055, 0.05); }
      function uiStepper(up){
        if(up){ playTone(900, "sine", 0.04, 0.055); playTone(1150, "sine", 0.03, 0.04, 0.03); }
        else { playTone(720, "sine", 0.04, 0.055); playTone(560, "sine", 0.04, 0.04, 0.03); }
      }
      function uiSave(){ playTone(640, "sine", 0.07, 0.10); playTone(960, "sine", 0.10, 0.08, 0.08); playTone(1280, "sine", 0.12, 0.06, 0.18); }
      function uiError(){ playTone(380, "sine", 0.07, 0.10); playTone(280, "sine", 0.10, 0.10, 0.08); }

      // ── Reward dice (rolling for points after a session) ──
      function rewardRollStart(){
        for(let i=0;i<8;i++){
          const d = i * 0.06;
          playNoise(0.03, 0.10, d, 1000, 0.6);
          playTone(220 + Math.random()*220, "square", 0.025, 0.07, d + 0.005);
        }
      }
      function rewardLand(roll){
        playNoise(0.10, 0.20, 0, 600, 0.4);
        playTone(140, "sine", 0.18, 0.22);
        // Higher rolls = brighter little chime
        const top = 660 + roll * 90;
        playTone(top, "sine", 0.18, 0.18, 0.10);
        playTone(top * 1.5, "sine", 0.14, 0.10, 0.18);
      }

      // ── Dice GAME sounds (more pronounced, playful) ──
      function diceGameClick(){ playTone(620, "sine", 0.07, 0.18); }
      function diceSelect(){ playTone(880, "sine", 0.06, 0.25); playTone(1180, "sine", 0.06, 0.18, 0.06); }
      function diceClose(){ playTone(700, "sine", 0.07, 0.18); playTone(500, "sine", 0.07, 0.18, 0.07); }
      function diceTickRoll(){ playNoise(0.025, 0.10, 0, 900, 0.5); playTone(250 + Math.random()*150, "square", 0.022, 0.07); }
      function diceLand(){ playNoise(0.12, 0.30, 0, 500, 0.4); playTone(120, "sawtooth", 0.15, 0.22); playTone(80, "sine", 0.20, 0.16, 0.05); }
      function diceRollStart(){
        for(let i=0;i<10;i++){
          const d = i * 0.08;
          playNoise(0.04, 0.16, d, 800, 0.5);
          playTone(200 + Math.random()*200, "square", 0.03, 0.08, d + 0.01);
        }
      }
      function diceWin(isStreak){
        const notes = isStreak ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
        notes.forEach((f, i) => playTone(f, "sine", 0.25, 0.32, i * 0.12));
        playTone(2093, "sine", 0.15, 0.13, notes.length * 0.12);
        if(isStreak) playTone(2637, "sine", 0.15, 0.16, notes.length * 0.12 + 0.12);
      }
      function diceStreakUp(){ playTone(1200, "sine", 0.06, 0.22); playTone(1600, "sine", 0.08, 0.18, 0.07); playTone(2000, "sine", 0.10, 0.13, 0.15); }

      // ── NEW soft, less painful lose / game-over sounds ──
      function diceLose(){
        // Gentle minor descent — sine only, low volume, soft body
        playTone(330, "sine", 0.18, 0.16, 0);     // E4
        playTone(247, "sine", 0.22, 0.16, 0.16);  // B3
        playTone(196, "sine", 0.40, 0.13, 0.36);  // G3
        // soft sub-rumble for body
        playTone(98,  "sine", 0.55, 0.06, 0.10);  // G2
      }
      function diceGameOver(){
        // Cinematic, warm fade — only sine, no sawtooth screech
        playTone(440, "sine", 0.32, 0.18, 0.00);  // A4
        playTone(349, "sine", 0.36, 0.16, 0.20);  // F4
        playTone(262, "sine", 0.42, 0.14, 0.45);  // C4
        playTone(196, "sine", 0.60, 0.12, 0.70);  // G3
        playTone(131, "sine", 1.10, 0.10, 0.95);  // C3
        // subtle pad / weight
        playTone(65,  "sine", 1.50, 0.05, 0.30);  // C2
        // tiny bit of soft noise for atmosphere (low filter, very quiet)
        playNoise(1.20, 0.02, 0.20, 250, 0.7);
      }

      // Timer alarm (used by PROKO, kept compatible)
      let alarmInterval = null;
      function stopAlarm(){ if(alarmInterval){ clearInterval(alarmInterval); alarmInterval = null; } state.alarmActive = false; }
      function startAlarm(){
        if(alarmInterval) return;
        state.alarmActive = true; updateTimerUI();
        alarmInterval = setInterval(() => {
          if(!state.alarmActive) return;
          if(state.soundEnabled) playTone(880, "square", 0.12, 0.05);
        }, 1000);
      }
      function dismissAlarm(){ stopAlarm(); if(state.phase === "done") showFinish(); else { state.running = false; updateTimerUI(); } persist(); }

      // ════════════════════════════════════════════════════════════
      //   STATE
      // ════════════════════════════════════════════════════════════
      function deepClone(obj){ return JSON.parse(JSON.stringify(obj)); }
      function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
      // ── Local-time date keys ──────────────────────────────────────────
      // All per-day storage keys (state.data, intervalTasks, completedHistory.day,
      // diceLastFireDay, …) use this format. Always derived from the user's LOCAL
      // wall-clock so midnight rollovers happen at midnight in the user's timezone.
      // Format: "YYYY-MM-DD".
      function localDateKey(d){
        const date = (d instanceof Date) ? d : new Date();
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${dd}`;
      }
      function todayISO(){ return localDateKey(new Date()); }
      function yesterdayISO(){
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return localDateKey(d);
      }
      function getMin(dateKey){ return Number(state.data[dateKey]) || 0; }
      const STREAK_THRESHOLD_MIN = 30;
      // Consecutive days (going back from today) with >= 30 min logged.
      // If today < threshold, streak still counts back from yesterday (today is "in progress").
      function computeStreak(){
        let count = 0;
        const today = getMin(todayISO());
        if(today >= STREAK_THRESHOLD_MIN) count = 1;
        const d = new Date(); d.setDate(d.getDate() - 1);
        for(let i=0; i<3650; i++){
          const key = localDateKey(d);
          const m = getMin(key);
          if(m >= STREAK_THRESHOLD_MIN){ count++; d.setDate(d.getDate() - 1); }
          else break;
        }
        return count;
      }
      function isLearningActive(){ return state.phase === "learning"; }
      // ════════════════════════════════════════════════════════════
      //   INTERVAL TASKS  (per-day, per-session to-do lists)
      // ════════════════════════════════════════════════════════════
      const TASK_MAX = 10;
      const TASK_REMOVE_DELAY_MS = 3000;
      function getTaskList(sessionIdx){
        const day = todayISO();
        if(!state.intervalTasks || typeof state.intervalTasks !== "object") state.intervalTasks = {};
        if(!state.intervalTasks[day]) state.intervalTasks[day] = {};
        const key = String(sessionIdx);
        if(!Array.isArray(state.intervalTasks[day][key])) state.intervalTasks[day][key] = [];
        return state.intervalTasks[day][key];
      }
      function addTask(sessionIdx, text){
        const list = getTaskList(sessionIdx);
        if(list.length >= TASK_MAX) return false;
        const t = (text || "").trim();
        if(!t) return false;
        list.push({ id: "t" + Date.now() + "_" + Math.floor(Math.random()*1e6), text: t.slice(0, 120), done: false, doneAt: 0 });
        persist();
        return true;
      }
      function removeTaskById(sessionIdx, taskId){
        const list = getTaskList(sessionIdx);
        const idx = list.findIndex(x => x.id === taskId);
        if(idx >= 0){ list.splice(idx, 1); persist(); return true; }
        return false;
      }
      function pushCompletedHistory(taskObj, sessionIdx){
        if(!Array.isArray(state.completedHistory)) state.completedHistory = [];
        state.completedHistory.push({
          id: taskObj.id,
          text: taskObj.text,
          sessionIdx,
          day: todayISO(),
          completedAt: Date.now(),
        });
        // Cap at 500 entries
        if(state.completedHistory.length > 500){
          state.completedHistory.splice(0, state.completedHistory.length - 500);
        }
      }
      function archiveAndRemoveTask(sessionIdx, taskId){
        const list = getTaskList(sessionIdx);
        const t = list.find(x => x.id === taskId);
        if(!t) return false;
        pushCompletedHistory(t, sessionIdx);
        return removeTaskById(sessionIdx, taskId);
      }
      function deleteCompletedHistoryEntry(entryId){
        if(!Array.isArray(state.completedHistory)) return false;
        const idx = state.completedHistory.findIndex(e => e.id === entryId);
        if(idx >= 0){ state.completedHistory.splice(idx, 1); persist(); return true; }
        return false;
      }

      // ════════════════════════════════════════════════════════════
      //   TO-DO VIEW  (overview tab)
      // ════════════════════════════════════════════════════════════
      function fmtClock(ms){
        const d = new Date(ms);
        return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
      }
      function renderTodoView(){
        if(!dom.todoPlannedList) return;
        const day = todayISO();
        const dayMap = (state.intervalTasks && state.intervalTasks[day]) || {};
        // ── Summary pills ──
        let openCount = 0, doneCount = 0;
        for(const k of Object.keys(dayMap)){
          for(const t of (dayMap[k] || [])){
            if(t.done) doneCount++; else openCount++;
          }
        }
        const archivedToday = (state.completedHistory || []).filter(e => e.day === day).length;
        const sumWrap = dom.todoSummary;
        while(sumWrap.firstChild) sumWrap.removeChild(sumWrap.firstChild);
        const mk = (label, val) => {
          const p = document.createElement("div");
          p.className = "pillBox";
          const lb = document.createElement("span"); lb.className = "pillLbl"; lb.textContent = label + ":";
          const vv = document.createElement("span"); vv.className = "pillVal"; vv.textContent = String(val);
          p.appendChild(lb); p.appendChild(vv);
          return p;
        };
        sumWrap.appendChild(mk("Offen", openCount));
        sumWrap.appendChild(mk("Erledigt", doneCount + archivedToday));

        // ── Interval dropdown ──
        const sel = dom.todoAddInterval;
        const prev = sel.value;
        while(sel.firstChild) sel.removeChild(sel.firstChild);
        for(let i=0; i<TOTAL_SESSIONS; i++){
          const opt = document.createElement("option");
          opt.value = String(i);
          const isCurrent = state.phase === "learning" && state.sessionIdx === i;
          opt.textContent = `Lerneinheit ${i + 1}${isCurrent ? " (aktiv)" : ""}`;
          sel.appendChild(opt);
        }
        if(prev !== "" && Number(prev) < TOTAL_SESSIONS) sel.value = prev;
        else {
          // Default: current session if learning, otherwise first non-done
          let defaultIdx = state.phase === "learning" ? state.sessionIdx : 0;
          for(let i=0; i<TOTAL_SESSIONS; i++){
            if(!state.sessionsDone[i]){ defaultIdx = i; break; }
          }
          sel.value = String(defaultIdx);
        }

        // ── Planned list (today's tasks per interval) ──
        const planned = dom.todoPlannedList;
        while(planned.firstChild) planned.removeChild(planned.firstChild);
        let anyPlanned = false;
        for(let i=0; i<TOTAL_SESSIONS; i++){
          const list = (dayMap[String(i)] || []);
          if(!list.length) continue;
          anyPlanned = true;
          // Order: starred first, then array order
          const starred = list.find(t => t.star && !t.done);
          const others = list.filter(t => t !== starred);
          const display = starred ? [starred, ...others] : others;
          // Card
          const card = document.createElement("div");
          card.className = "todoIntervalCard";
          const lbl = document.createElement("div");
          lbl.className = "todoIntervalLabel";
          const title = document.createElement("span");
          title.textContent = `Lerneinheit ${i + 1}`;
          lbl.appendChild(title);
          const isCurrent = state.phase === "learning" && state.sessionIdx === i;
          if(isCurrent){
            const b = document.createElement("span"); b.className = "badge active"; b.textContent = "AKTIV";
            lbl.appendChild(b);
          }
          if(state.sessionsDone[i]){
            const b = document.createElement("span"); b.className = "badge"; b.textContent = "fertig";
            lbl.appendChild(b);
          }
          const openLeft = list.filter(t => !t.done).length;
          const cnt = document.createElement("span");
          cnt.className = "badge";
          cnt.textContent = `${openLeft} offen · ${list.length} gesamt`;
          lbl.appendChild(cnt);
          card.appendChild(lbl);
          // Tasks
          for(const t of display){
            const row = document.createElement("div");
            row.className = "todoTaskRow" + (t.done ? " done" : "") + (t.star && !t.done ? " starred" : "");
            row.dataset.taskId = t.id;
            row.dataset.sessionIdx = String(i);
            // Star indicator
            if(t.star && !t.done){
              const s = document.createElement("span"); s.className = "star"; s.textContent = "★";
              row.appendChild(s);
            }
            // Check
            const chk = document.createElement("button");
            chk.className = "check" + (t.done ? " checked" : "");
            chk.type = "button";
            chk.dataset.action = "todoToggle";
            chk.dataset.taskId = t.id;
            chk.dataset.sessionIdx = String(i);
            chk.setAttribute("aria-label", t.done ? "Wieder öffnen" : "Erledigt");
            row.appendChild(chk);
            // Text
            const text = document.createElement("span");
            text.className = "todoTaskText";
            text.textContent = t.text;
            row.appendChild(text);
            // Delete
            const del = document.createElement("button");
            del.className = "del";
            del.type = "button";
            del.dataset.action = "todoDelete";
            del.dataset.taskId = t.id;
            del.dataset.sessionIdx = String(i);
            del.textContent = "✕";
            del.setAttribute("aria-label", "Aufgabe löschen");
            row.appendChild(del);
            card.appendChild(row);
          }
          planned.appendChild(card);
        }
        if(!anyPlanned){
          const empty = document.createElement("div");
          empty.className = "todoEmpty";
          empty.textContent = "Noch nichts geplant — füge oben Aufgaben hinzu.";
          planned.appendChild(empty);
        }

        // ── Completed list (today's archive) ──
        const completedWrap = dom.todoCompletedList;
        while(completedWrap.firstChild) completedWrap.removeChild(completedWrap.firstChild);
        const todayArchive = (state.completedHistory || []).filter(e => e.day === day).slice().sort((a,b) => b.completedAt - a.completedAt);
        if(todayArchive.length === 0){
          const empty = document.createElement("div");
          empty.className = "todoEmpty";
          empty.textContent = "Noch keine Aufgabe heute abgeschlossen.";
          completedWrap.appendChild(empty);
        } else {
          const card = document.createElement("div");
          card.className = "todoIntervalCard";
          for(const e of todayArchive){
            const row = document.createElement("div");
            row.className = "todoCompletedRow";
            row.dataset.entryId = e.id;
            const text = document.createElement("span");
            text.className = "text";
            text.textContent = e.text;
            const meta = document.createElement("span");
            meta.className = "meta";
            meta.textContent = `LE ${e.sessionIdx + 1} · ${fmtClock(e.completedAt)}`;
            const del = document.createElement("button");
            del.className = "del";
            del.type = "button";
            del.dataset.action = "todoHistoryDelete";
            del.dataset.entryId = e.id;
            del.textContent = "✕";
            del.setAttribute("aria-label", "Eintrag löschen");
            row.appendChild(text); row.appendChild(meta); row.appendChild(del);
            card.appendChild(row);
          }
          completedWrap.appendChild(card);
        }
      }
      function todoHandleAddSubmit(){
        const idxStr = dom.todoAddInterval.value;
        const idx = parseInt(idxStr, 10);
        if(!Number.isInteger(idx) || idx < 0 || idx >= TOTAL_SESSIONS){ uiError(); return; }
        const text = dom.todoAddInput.value;
        if(!text.trim()){ uiError(); return; }
        if(addTask(idx, text)){
          dom.todoAddInput.value = "";
          renderTodoView();
          updateCompactStar();
          uiSoftClick();
        } else {
          uiError();
        }
        dom.todoAddInput.focus();
      }
      function todoHandleListClick(e){
        const btn = e.target.closest("[data-action]");
        if(!btn) return;
        const action = btn.dataset.action;
        if(action === "todoToggle"){
          const taskId = btn.dataset.taskId;
          const sessionIdx = Number(btn.dataset.sessionIdx);
          const list = getTaskList(sessionIdx);
          const t = list.find(x => x.id === taskId);
          if(!t) return;
          if(t.done){
            // Un-check: cancel pending auto-archive in popover (if any) and re-open
            cancelTaskRemoval(taskId);
            setTaskDone(sessionIdx, taskId, false);
            renderTodoView();
            uiSoftClick();
          } else {
            // Check + immediately archive (no 3s delay on To-Do view)
            setTaskDone(sessionIdx, taskId, true);
            archiveAndRemoveTask(sessionIdx, taskId);
            cancelTaskRemoval(taskId);
            renderTodoView();
            updateCompactStar();
            uiSave();
          }
        } else if(action === "todoDelete"){
          const taskId = btn.dataset.taskId;
          const sessionIdx = Number(btn.dataset.sessionIdx);
          cancelTaskRemoval(taskId);
          removeTaskById(sessionIdx, taskId);
          renderTodoView();
          updateCompactStar();
          uiSoftClick();
        } else if(action === "todoHistoryDelete"){
          deleteCompletedHistoryEntry(btn.dataset.entryId);
          renderTodoView();
          uiSoftClick();
        }
      }
      function setTaskDone(sessionIdx, taskId, done){
        const list = getTaskList(sessionIdx);
        const t = list.find(x => x.id === taskId);
        if(!t) return;
        t.done = !!done;
        t.doneAt = done ? Date.now() : 0;
        if(done && t.star) t.star = false; // completed task loses its star
        persist();
      }
      function setTaskStar(sessionIdx, taskId, on){
        const list = getTaskList(sessionIdx);
        if(on){
          // Only one starred task per session
          for(const t of list) t.star = (t.id === taskId);
        } else {
          const t = list.find(x => x.id === taskId);
          if(t) t.star = false;
        }
        persist();
      }
      function getStarredTask(sessionIdx){
        const list = getTaskList(sessionIdx);
        return list.find(t => t.star && !t.done) || null;
      }
      // Move unfinished tasks from sessionIdx → sessionIdx+1 (clearing stars on the move)
      function carryOverTasks(fromIdx){
        const day = todayISO();
        if(!state.intervalTasks || !state.intervalTasks[day]) return;
        const fromKey = String(fromIdx), toKey = String(fromIdx + 1);
        const fromList = state.intervalTasks[day][fromKey];
        if(!Array.isArray(fromList) || fromList.length === 0) return;
        if(fromIdx + 1 >= TOTAL_SESSIONS) return; // no next session
        if(!state.intervalTasks[day][toKey]) state.intervalTasks[day][toKey] = [];
        const toList = state.intervalTasks[day][toKey];
        const stayBehind = [];
        for(const t of fromList){
          if(!t.done){
            if(toList.length < TASK_MAX){
              toList.push({ id: t.id, text: t.text, done: false, doneAt: 0, star: false });
            }
            // else: drop overflow silently
          } else {
            // Done tasks remain in the source session (may already be auto-removing)
            stayBehind.push(t);
          }
        }
        state.intervalTasks[day][fromKey] = stayBehind;
      }
      // Reorder tasks within a session: move srcId to position before destId.
      // Star-pinned tasks cannot be moved or used as destination.
      function reorderTasks(sessionIdx, srcId, destId){
        if(srcId === destId) return false;
        const list = getTaskList(sessionIdx);
        const srcIdx = list.findIndex(x => x.id === srcId);
        const destIdx = list.findIndex(x => x.id === destId);
        if(srcIdx < 0 || destIdx < 0) return false;
        if(list[srcIdx].star || list[destIdx].star) return false;
        const [item] = list.splice(srcIdx, 1);
        const newDestIdx = srcIdx < destIdx ? destIdx - 1 : destIdx;
        list.splice(newDestIdx, 0, item);
        persist();
        return true;
      }

      // ── Popover state ──
      let popHoveredSessionIdx = -1; // session whose tasks are currently shown
      let popHideTimer = null;
      let popPinned = false; // mouse is inside popover → don't auto-hide
      const popPendingRemoveTimers = new Map(); // taskId → timeoutId

      function clearPopHide(){ if(popHideTimer){ clearTimeout(popHideTimer); popHideTimer = null; } }
      function schedulePopHide(){
        clearPopHide();
        popHideTimer = setTimeout(() => {
          if(!popPinned) hideTaskPopover();
        }, 180);
      }
      function hideTaskPopover(immediate){
        clearPopHide();
        popHoveredSessionIdx = -1;
        popPinned = false;
        if(dom.taskPopover){
          dom.taskPopover.classList.remove("show");
          // After fade-out, set display:none so layout doesn't catch hover
          if(immediate){ dom.taskPopover.style.display = "none"; }
          else setTimeout(() => {
            if(!dom.taskPopover.classList.contains("show")) dom.taskPopover.style.display = "none";
          }, 160);
        }
      }
      function positionPopover(box){
        // box is in canvas coordinates; convert to viewport
        const rect = dom.trackCanvas.getBoundingClientRect();
        const sxScale = rect.width / dom.trackCanvas.width;
        const syScale = rect.height / dom.trackCanvas.height;
        const cx = rect.left + ((box.x1 + box.x2) / 2) * sxScale;
        const topY = rect.top + box.y1 * syScale;
        const botY = rect.top + box.y2 * syScale;
        const pop = dom.taskPopover;
        // Force layout to measure
        pop.style.display = "block";
        const ph = pop.offsetHeight, pw = pop.offsetWidth;
        // Default: above the box
        let above = (topY - ph - 14) > 8;
        let py = above ? (topY - ph - 10) : (botY + 10);
        // Clamp horizontally so popover stays on screen
        const half = pw / 2;
        const minX = half + 8, maxX = window.innerWidth - half - 8;
        const px = Math.max(minX, Math.min(maxX, cx));
        pop.classList.toggle("below", !above);
        pop.style.left = px + "px";
        pop.style.top = py + "px";
      }
      function renderTaskPopover(){
        if(popHoveredSessionIdx < 0) return;
        const sessionIdx = popHoveredSessionIdx;
        const list = getTaskList(sessionIdx);
        const isCurrent = state.phase === "learning" && state.sessionIdx === sessionIdx;
        dom.taskPopHeader.textContent = `Lerneinheit ${sessionIdx + 1} · Aufgaben${isCurrent ? "  ·  aktiv" : ""}`;
        // Display order: starred first, rest preserves array order
        const starred = list.find(t => t.star && !t.done);
        const others = list.filter(t => t !== starred);
        const display = starred ? [starred, ...others] : others;
        const ul = dom.taskList;
        while(ul.firstChild) ul.removeChild(ul.firstChild);
        const frag = document.createDocumentFragment();
        for(const t of display){
          const li = document.createElement("li");
          li.className = "taskItem" + (t.done ? " done" : "") + (t.star && !t.done ? " starred" : "");
          li.dataset.taskId = t.id;
          if(!t.star && !t.done) li.draggable = true;
          // Drag handle
          const drag = document.createElement("span");
          drag.className = "taskDragHandle";
          drag.textContent = "⋮⋮";
          drag.title = "Ziehen zum Umsortieren";
          // Check
          const chk = document.createElement("button");
          chk.className = "taskCheck" + (t.done ? " checked" : "");
          chk.type = "button";
          chk.setAttribute("aria-label", t.done ? "Aufgabe wieder öffnen" : "Aufgabe als erledigt markieren");
          chk.dataset.taskId = t.id;
          chk.dataset.action = "toggle";
          // Text
          const txt = document.createElement("span");
          txt.className = "taskText";
          txt.textContent = t.text;
          // Star (only enabled on the active interval)
          const star = document.createElement("button");
          star.className = "taskStarBtn" + (t.star ? " starred" : "");
          star.type = "button";
          star.textContent = t.star ? "★" : "☆";
          star.setAttribute("aria-label", t.star ? "Stern entfernen" : "Als aktive Aufgabe markieren");
          star.dataset.taskId = t.id;
          star.dataset.action = "star";
          if(!isCurrent || t.done){
            star.disabled = true;
            star.title = isCurrent ? "Erledigte Aufgabe kann nicht aktiv sein" : "Stern nur im aktiven Lernintervall verfügbar";
          } else {
            star.title = t.star ? "Stern entfernen" : "Als aktive Aufgabe markieren";
          }
          // Delete
          const del = document.createElement("button");
          del.className = "taskDelBtn";
          del.type = "button";
          del.textContent = "✕";
          del.setAttribute("aria-label", "Aufgabe löschen");
          del.dataset.taskId = t.id;
          del.dataset.action = "delete";
          li.appendChild(drag);
          li.appendChild(chk);
          li.appendChild(txt);
          li.appendChild(star);
          li.appendChild(del);
          frag.appendChild(li);
        }
        ul.appendChild(frag);
        dom.taskEmpty.style.display = list.length === 0 ? "block" : "none";
        const atMax = list.length >= TASK_MAX;
        dom.taskInput.disabled = atMax;
        dom.taskAddBtn.disabled = atMax;
        dom.taskInput.placeholder = atMax ? "Maximum erreicht" : "Aufgabe…";
        dom.taskHint.textContent = `${list.length} / ${TASK_MAX} Aufgaben`;
      }
      function showTaskPopover(sessionIdx, box){
        clearPopHide();
        const changed = popHoveredSessionIdx !== sessionIdx;
        popHoveredSessionIdx = sessionIdx;
        if(changed){
          // Reset input when switching sessions
          dom.taskInput.value = "";
          renderTaskPopover();
        }
        dom.taskPopover.style.display = "block";
        positionPopover(box);
        // Trigger transition by toggling class on next frame
        requestAnimationFrame(() => dom.taskPopover.classList.add("show"));
      }
      function scheduleTaskRemoval(sessionIdx, taskId){
        // Clear any existing timer for this task
        const existing = popPendingRemoveTimers.get(taskId);
        if(existing) clearTimeout(existing);
        const tid = setTimeout(() => {
          popPendingRemoveTimers.delete(taskId);
          // Animate the row out, then archive + remove from state
          if(popHoveredSessionIdx === sessionIdx && dom.taskPopover.classList.contains("show")){
            const li = dom.taskList.querySelector(`[data-task-id="${taskId}"]`);
            if(li){
              li.classList.add("removing");
              setTimeout(() => {
                if(archiveAndRemoveTask(sessionIdx, taskId)){
                  if(popHoveredSessionIdx === sessionIdx) renderTaskPopover();
                }
              }, 240);
              return;
            }
          }
          // Popover not open for this session — archive + remove silently
          archiveAndRemoveTask(sessionIdx, taskId);
        }, TASK_REMOVE_DELAY_MS);
        popPendingRemoveTimers.set(taskId, tid);
      }
      function cancelTaskRemoval(taskId){
        const t = popPendingRemoveTimers.get(taskId);
        if(t){ clearTimeout(t); popPendingRemoveTimers.delete(taskId); }
      }

      // ════════════════════════════════════════════════════════════
      //   DICE TIMER  (decoupled from session length — 30 min slice → 1 roll)
      // ════════════════════════════════════════════════════════════
      const DICE_TIMER_TOTAL_SEC = 1800; // 30 minutes
      let diceTimerAnchor = null; // {wallStart, secondsAtStart} — set only while learning + running

      function diceTrackingStart(){
        if(diceTimerAnchor) return;
        diceTimerAnchor = { wallStart: Date.now(), secondsAtStart: state.diceTimerLeft };
      }
      function diceTrackingStop(){
        if(!diceTimerAnchor) return;
        const elapsed = (Date.now() - diceTimerAnchor.wallStart) / 1000;
        state.diceTimerLeft = Math.max(0, diceTimerAnchor.secondsAtStart - Math.floor(elapsed));
        diceTimerAnchor = null;
      }
      function fireDiceRoll(){
        const today = todayISO();
        if(state.diceLastFireDay !== today){
          state.diceLearnedTodayMin = 0;
          state.diceLastFireDay = today;
        }
        const yesterdayMin = getMin(yesterdayISO());
        const priorMin = state.diceLearnedTodayMin;
        const newMin = priorMin + 30;
        const streakBonus = priorMin === 0 && yesterdayMin >= STREAK_THRESHOLD_MIN;
        const surpassBonus = yesterdayMin > 0 && priorMin <= yesterdayMin && newMin > yesterdayMin;
        state.diceLearnedTodayMin = newMin;
        grantRewardRoll(streakBonus, surpassBonus);
        state.diceTimerLeft = DICE_TIMER_TOTAL_SEC;
      }
      function diceTimerTick(){
        // Called from onWorkerTick; only does work when learning is currently being tracked.
        if(!diceTimerAnchor) return;
        const elapsed = (Date.now() - diceTimerAnchor.wallStart) / 1000;
        const newLeft = Math.max(0, diceTimerAnchor.secondsAtStart - Math.floor(elapsed));
        if(newLeft !== state.diceTimerLeft){
          state.diceTimerLeft = newLeft;
          if(dom.dicePopover && dom.dicePopover.classList.contains("show")) renderDicePopover();
        }
        if(newLeft === 0){
          fireDiceRoll();
          // Re-anchor for the next 30-min slice (still in learning if we got here)
          diceTimerAnchor = { wallStart: Date.now(), secondsAtStart: DICE_TIMER_TOTAL_SEC };
          if(dom.dicePopover && dom.dicePopover.classList.contains("show")) renderDicePopover();
        }
      }
      function getDiceTimerDisplaySec(){
        if(!diceTimerAnchor) return state.diceTimerLeft;
        const elapsed = (Date.now() - diceTimerAnchor.wallStart) / 1000;
        return Math.max(0, diceTimerAnchor.secondsAtStart - Math.floor(elapsed));
      }
      function renderDicePopover(){
        const sec = getDiceTimerDisplaySec();
        const m = Math.floor(sec / 60), s = sec % 60;
        dom.dicePopTime.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
        const pct = Math.round((1 - sec / DICE_TIMER_TOTAL_SEC) * 1000) / 10;
        dom.dicePopFill.style.width = pct + "%";
        const running = !!diceTimerAnchor;
        dom.dicePopState.textContent = running ? "Läuft synchron mit Lernintervall" : (state.phase === "learning" ? "Lerntimer pausiert" : "Pausiert (kein Lernintervall)");
        dom.dicePopState.classList.toggle("running", running);
      }
      function showDicePopover(){
        renderDicePopover();
        const rect = dom.rewardDiceBtn.getBoundingClientRect();
        const pop = dom.dicePopover;
        pop.style.display = "block";
        const ph = pop.offsetHeight, pw = pop.offsetWidth;
        const cx = rect.left + rect.width / 2;
        const above = (rect.top - ph - 14) > 8;
        const py = above ? (rect.top - ph - 10) : (rect.bottom + 10);
        const half = pw / 2;
        const px = Math.max(half + 8, Math.min(window.innerWidth - half - 8, cx));
        pop.classList.toggle("below", !above);
        pop.style.left = px + "px";
        pop.style.top = py + "px";
        requestAnimationFrame(() => pop.classList.add("show"));
      }
      function hideDicePopover(){
        dom.dicePopover.classList.remove("show");
        setTimeout(() => {
          if(!dom.dicePopover.classList.contains("show")) dom.dicePopover.style.display = "none";
        }, 160);
      }
      // ── Variable interval setup ──
      function computeGoalMin(s){
        const v = Math.max(1, Math.floor(Number(s.goal_value) || 0));
        return s.goal_unit === "h" ? v * 60 : v;
      }
      const MAX_SESSIONS = 16;
      function recomputeTotalSessions(){
        // Per-day override beats the template-computed value (set by add/remove on the timer page).
        if(Number.isFinite(state.totalSessionsOverride) && state.totalSessionsOverride > 0){
          TOTAL_SESSIONS = clamp(state.totalSessionsOverride, 1, MAX_SESSIONS);
          return;
        }
        const s = state.settings;
        const goalMin = computeGoalMin(s);
        const raw = Math.max(1, Math.round(goalMin / Math.max(1, s.learn_min)));
        TOTAL_SESSIONS = Math.min(MAX_SESSIONS, raw);
      }
      // Per-session learning duration in MINUTES. Honors session-length overrides.
      function effectiveLearnMin(idx){
        if(!Number.isFinite(idx)) idx = state.sessionIdx;
        const arr = state.sessionLengthOverrides;
        if(Array.isArray(arr) && idx >= 0 && idx < arr.length){
          const v = arr[idx];
          if(Number.isFinite(v) && v > 0) return v;
        }
        return state.settings.learn_min;
      }
      function effectiveLearnSec(idx){ return effectiveLearnMin(idx) * 60; }
      // Reset all timer-side overrides (called when switching templates).
      function resetTimerOverrides(){
        state.sessionLengthOverrides = [];
        state.breakLengthOverrides = [];
        state.totalSessionsOverride = null;
      }
      function reconcileSessionArrays(){
        // Resize sessionsDone / breaksDone to match TOTAL_SESSIONS, preserving existing flags
        while(state.sessionsDone.length < TOTAL_SESSIONS) state.sessionsDone.push(false);
        if(state.sessionsDone.length > TOTAL_SESSIONS) state.sessionsDone.length = TOTAL_SESSIONS;
        const breaksTarget = Math.max(0, TOTAL_SESSIONS - 1);
        while(state.breaksDone.length < breaksTarget) state.breaksDone.push(false);
        if(state.breaksDone.length > breaksTarget) state.breaksDone.length = breaksTarget;
        if(state.sessionIdx > TOTAL_SESSIONS) state.sessionIdx = TOTAL_SESSIONS;
        if(state.curBreak >= breaksTarget) state.curBreak = -1;
      }
      // Break i (0-indexed) is between session i and session i+1 (1-indexed: break number i+1).
      function breakKindAt(i){
        const num = i + 1;
        const s = state.settings;
        if(s.big_break_enabled && s.big_break_after > 0 && num % s.big_break_after === 0) return "big";
        return (num % 2 === 1) ? "odd" : "even";
      }
      function breakMinAt(i){
        // Per-day override (carry-over from skipped previous break, etc.) wins.
        const arr = state.breakLengthOverrides;
        if(Array.isArray(arr) && i >= 0 && i < arr.length){
          const v = arr[i];
          if(Number.isFinite(v) && v > 0) return v;
        }
        const k = breakKindAt(i);
        const s = state.settings;
        if(k === "big") return s.big_break_min;
        return k === "odd" ? s.break_odd_min : s.break_even_min;
      }
      function formatGoalLabel(s){
        if(s.goal_unit === "h"){
          if(Number.isInteger(s.goal_value)) return `${s.goal_value} Stunden`;
          return `${s.goal_value}h`;
        }
        return `${s.goal_value} Min`;
      }
      // Toggle dice game lock UI based on whether a learning interval is in progress.
      // Important: never use `disabled = locked || disabled` (sticky-bug). Always re-evaluate.
      function applyDiceLockState(){
        const locked = isLearningActive();
        const hint = document.getElementById("diceLockedHint");
        const wrap = document.getElementById("diceGameWrap");
        if(hint) hint.style.display = locked ? "block" : "none";
        if(wrap) wrap.style.display = locked ? "none" : "";
        const rb = document.getElementById("rollGameBtn");
        const gb = document.getElementById("guessButton");
        const bet = document.getElementById("bet");
        if(locked){
          // Force-disable while a learning interval is running
          if(rb) rb.disabled = true;
          if(gb) gb.disabled = true;
          if(bet) bet.disabled = true;
        } else if(typeof diceRolling !== "undefined" && !diceRolling){
          // Re-enable based on current points/state. Skip while a roll is in progress
          // (rollDiceGame manages those buttons itself during the animation).
          const enabled = state.points > 0;
          if(rb) rb.disabled = !enabled;
          if(gb) gb.disabled = !enabled;
          if(bet) bet.disabled = !enabled;
        }
        // Reward dice button in timer header
        const rdb = document.getElementById("rewardDiceBtn");
        if(rdb){
          rdb.disabled = locked;
          rdb.title = locked ? "Während des Lernintervalls gesperrt" : "Belohnungs-Würfel";
        }
      }

      // Returns a fresh default state object (used both as initial value
      // and as a reset target on logout / progress reset).
      function getDefaultState(){
        return {
          theme: "dark",
          settings: deepClone(DEFAULT_SETTINGS),
          data: {},
          sessionIdx: 0, phase: "idle",
          timeLeft: DEFAULT_SETTINGS.learn_min * 60,
          sessionsDone: Array(TOTAL_SESSIONS).fill(false),
          breaksDone: Array(TOTAL_SESSIONS - 1).fill(false),
          curBreak: -1, running: false, alarmActive: false, compact: false,
          points: 0,
          pendingRolls: 0,
          pendingRollBonuses: [],
          diceStreak: 0,
          soundEnabled: true,
          intervalTasks: {},
          completedHistory: [],
          diceTimerLeft: 1800,
          diceLearnedTodayMin: 0,
          diceLastFireDay: "",
          // First-run onboarding flag (true once the user has seen / dismissed the welcome tour)
          onboardingDone: false,
          // Initial questionnaire flag (true once the user filled or skipped the questionnaire)
          questionnaireDone: false,
          // Interval templates (max 10). First template is auto-created on first run.
          // Shape: [{ id, name, settings: { goal_value, goal_unit, learn_min, break_odd_min,
          //   break_even_min, big_break_enabled, big_break_after, big_break_min } }, ...]
          templates: [],
          activeTemplateId: "",
          // Per-day timer-side overrides: empty/null entries mean "use template default"
          // sessionLengthOverrides[i] = custom minutes for session i (null = template's learn_min)
          // breakLengthOverrides[i]   = custom minutes for break i   (null = breakMinAt(i) default)
          // totalSessionsOverride     = custom session count        (null = computed from template)
          sessionLengthOverrides: [],
          breakLengthOverrides: [],
          totalSessionsOverride: null,
          // Transient — loaded fresh from `usernames` table on each sign-in (not persisted in app_state)
          username: "",
          // Avatar — { type: "emoji"|"initial"|"image", value: "<emoji>"|"#hex"|"data:image/…" }
          //   emoji   → value is a unicode emoji (default fallback)
          //   initial → value is a hex color (initials are derived from username/email)
          //   image   → value is a data-URL (≤ ~40 KB after client-side resize)
          avatar: { type: "initial", value: "#3DC061" },
        };
      }
      const AVATAR_EMOJI_OPTIONS = ["🦊","🐻","🐼","🐱","🐶","🐯","🦁","🐸","🦉","🐧","🐵","🐰","🦄","🐲","🌟","🚀","🎯","📚","☕","🍀","⚡","🔥","🎨","🧠"];
      const AVATAR_COLOR_OPTIONS = ["#3DC061","#E94560","#F5A623","#2196F3","#8B5CF6","#EC4899","#14B8A6","#F97316"];
      function isValidAvatar(a){
        if(!a || typeof a !== "object" || typeof a.type !== "string" || typeof a.value !== "string") return false;
        if(a.type === "emoji")   return a.value.length > 0 && a.value.length <= 8;
        if(a.type === "initial") return /^#[0-9a-fA-F]{6}$/.test(a.value);
        if(a.type === "image")   return a.value.startsWith("data:image/") && a.value.length < 200000;
        return false;
      }
      const MAX_TEMPLATES = 10;
      function genTemplateId(){ return "tmpl_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7); }
      function snapshotSettingsForTemplate(){
        const s = state.settings;
        return {
          goal_value: s.goal_value, goal_unit: s.goal_unit,
          learn_min: s.learn_min,
          break_odd_min: s.break_odd_min, break_even_min: s.break_even_min,
          big_break_enabled: s.big_break_enabled,
          big_break_after: s.big_break_after, big_break_min: s.big_break_min,
        };
      }
      // Synchronous loadState: returns defaults; cloud state is merged after auth.
      function loadState(){ return getDefaultState(); }
      // Merge a saved app_state (from Supabase, or any stored snapshot) INTO an existing target object.
      // This is the same migration / clamp logic that previously lived in loadState().
      function applySavedStateInto(base, p){
        if(!p || typeof p !== "object") return;
        if(p.theme === "light" || p.theme === "dark") base.theme = p.theme;
        if(p.settings && typeof p.settings === "object"){
          const ps = p.settings;
          if(Number.isFinite(ps.short_break_min) && !Number.isFinite(ps.break_odd_min)) ps.break_odd_min = ps.short_break_min;
          if(Number.isFinite(ps.long_break_min) && !Number.isFinite(ps.break_even_min)) ps.break_even_min = ps.long_break_min;
          const numClamps = {
            goal_value: [1, 1440],
            learn_min: [5, 240],
            break_odd_min: [1, 120],
            break_even_min: [1, 120],
            big_break_after: [1, 50],
            big_break_min: [5, 480],
          };
          for(const k of Object.keys(numClamps)){
            const v = ps[k];
            if(Number.isFinite(v)){
              const [mn, mx] = numClamps[k];
              base.settings[k] = clamp(Math.floor(v), mn, mx);
            }
          }
          if(ps.goal_unit === "h" || ps.goal_unit === "min") base.settings.goal_unit = ps.goal_unit;
          if(typeof ps.big_break_enabled === "boolean") base.settings.big_break_enabled = ps.big_break_enabled;
        }
        if(p.data && typeof p.data === "object") base.data = p.data;
        if(Number.isFinite(p.sessionIdx)) base.sessionIdx = p.sessionIdx;
        if(typeof p.phase === "string") base.phase = p.phase;
        if(Number.isFinite(p.timeLeft)) base.timeLeft = p.timeLeft;
        if(Array.isArray(p.sessionsDone)) base.sessionsDone = p.sessionsDone.slice(0, TOTAL_SESSIONS).map(Boolean).concat(Array(Math.max(0,TOTAL_SESSIONS - p.sessionsDone.length)).fill(false)).slice(0,TOTAL_SESSIONS);
        if(Array.isArray(p.breaksDone)) base.breaksDone = p.breaksDone.slice(0, TOTAL_SESSIONS - 1).map(Boolean).concat(Array(Math.max(0,(TOTAL_SESSIONS-1) - p.breaksDone.length)).fill(false)).slice(0,TOTAL_SESSIONS-1);
        if(Number.isFinite(p.curBreak)) base.curBreak = p.curBreak;
        if(typeof p.running === "boolean") base.running = p.running;
        if(typeof p.alarmActive === "boolean") base.alarmActive = p.alarmActive;
        if(typeof p.compact === "boolean") base.compact = p.compact;
        if(Number.isFinite(p.points)) base.points = Math.max(0, Math.floor(p.points));
        if(Number.isFinite(p.pendingRolls)) base.pendingRolls = Math.max(0, Math.floor(p.pendingRolls));
        if(Array.isArray(p.pendingRollBonuses)){
          base.pendingRollBonuses = p.pendingRollBonuses.map(b => ({
            streak: !!(b && b.streak),
            surpass: !!(b && b.surpass),
          }));
        }
        while(base.pendingRollBonuses.length < base.pendingRolls) base.pendingRollBonuses.push({ streak:false, surpass:false });
        if(base.pendingRollBonuses.length > base.pendingRolls) base.pendingRollBonuses.length = base.pendingRolls;
        if(Number.isFinite(p.diceStreak)) base.diceStreak = Math.max(0, Math.floor(p.diceStreak));
        if(typeof p.soundEnabled === "boolean") base.soundEnabled = p.soundEnabled;
        if(p.intervalTasks && typeof p.intervalTasks === "object") base.intervalTasks = p.intervalTasks;
        if(Array.isArray(p.completedHistory)) base.completedHistory = p.completedHistory.slice(-500);
        if(Number.isFinite(p.diceTimerLeft)) base.diceTimerLeft = clamp(Math.floor(p.diceTimerLeft), 0, 1800);
        if(Number.isFinite(p.diceLearnedTodayMin)) base.diceLearnedTodayMin = Math.max(0, Math.floor(p.diceLearnedTodayMin));
        if(typeof p.diceLastFireDay === "string") base.diceLastFireDay = p.diceLastFireDay;
        if(typeof p.onboardingDone === "boolean") base.onboardingDone = p.onboardingDone;
        if(typeof p.questionnaireDone === "boolean") base.questionnaireDone = p.questionnaireDone;
        if(Array.isArray(p.templates)){
          base.templates = p.templates
            .filter(t => t && typeof t === "object" && typeof t.id === "string" && typeof t.name === "string" && t.settings)
            .slice(0, MAX_TEMPLATES);
        }
        if(typeof p.activeTemplateId === "string") base.activeTemplateId = p.activeTemplateId;
        if(Array.isArray(p.sessionLengthOverrides)){
          base.sessionLengthOverrides = p.sessionLengthOverrides.map(v => Number.isFinite(v) ? clamp(Math.floor(v), 1, 240) : null);
        }
        if(Array.isArray(p.breakLengthOverrides)){
          base.breakLengthOverrides = p.breakLengthOverrides.map(v => Number.isFinite(v) ? clamp(Math.floor(v), 1, 480) : null);
        }
        if(Number.isFinite(p.totalSessionsOverride)){
          base.totalSessionsOverride = clamp(Math.floor(p.totalSessionsOverride), 1, 16);
        }
        if(p.avatar && isValidAvatar(p.avatar)){
          base.avatar = { type: p.avatar.type, value: p.avatar.value };
        }
      }
      // Build the JSON payload that gets uploaded to Supabase.
      function buildStateSnapshot(){
        return {
          theme: state.theme, settings: state.settings, data: state.data,
          sessionIdx: state.sessionIdx, phase: state.phase, timeLeft: state.timeLeft,
          sessionsDone: state.sessionsDone, breaksDone: state.breaksDone, curBreak: state.curBreak,
          running: state.running, alarmActive: state.alarmActive, compact: state.compact,
          points: state.points, pendingRolls: state.pendingRolls, pendingRollBonuses: state.pendingRollBonuses, diceStreak: state.diceStreak,
          soundEnabled: state.soundEnabled,
          intervalTasks: state.intervalTasks,
          completedHistory: state.completedHistory,
          diceTimerLeft: state.diceTimerLeft,
          diceLearnedTodayMin: state.diceLearnedTodayMin,
          diceLastFireDay: state.diceLastFireDay,
          onboardingDone: state.onboardingDone,
          questionnaireDone: state.questionnaireDone,
          templates: state.templates,
          activeTemplateId: state.activeTemplateId,
          sessionLengthOverrides: state.sessionLengthOverrides,
          breakLengthOverrides: state.breakLengthOverrides,
          totalSessionsOverride: state.totalSessionsOverride,
          avatar: state.avatar,
        };
      }
      // ════════════════════════════════════════════════════════════
      //   ROBUST SAVE PIPELINE
      //   - debounced cloud upsert via SDK
      //   - synchronous localStorage fallback after every persist()
      //   - keepalive-fetch on visibilitychange / pagehide / beforeunload
      //   - exponential backoff on network failures
      //   - autosave watchdog (30 s) for continuous-activity sessions
      //   - online-event retry
      //   - cached access token so unload-flush is fully synchronous
      // ════════════════════════════════════════════════════════════
      const SAVE_DEBOUNCE_MS  = 600;
      const SAVE_AUTOSAVE_MS  = 30000;
      const SAVE_BACKOFF_MIN  = 1000;
      const SAVE_BACKOFF_MAX  = 60000;
      const LOCAL_FALLBACK_KEY = "lernplan_pending_v2";

      let dirty = false;                       // Pending changes since last successful cloud save
      let cachedAccessToken = null;            // Synchronously available auth token for unload-flush
      let saveDebounceTimer = null;
      let saveBackoffTimer = null;
      let saveBackoffMs = SAVE_BACKOFF_MIN;
      let saveInFlight = false;
      let saveAgainAfter = false;
      let autosaveInterval = null;

      // Synchronously snapshot to localStorage as a safety net
      // (covers: keepalive-fetch dropped, network down, browser killed mid-flight, etc.).
      function writeLocalFallback(){
        if(!currentUser) return;
        try{
          localStorage.setItem(LOCAL_FALLBACK_KEY, JSON.stringify({
            userId: currentUser.id,
            savedAt: Date.now(),
            app_state: buildStateSnapshot(),
          }));
        }catch(_){ /* quota / private mode — non-fatal */ }
      }
      function readLocalFallback(){
        try{
          const raw = localStorage.getItem(LOCAL_FALLBACK_KEY);
          if(!raw) return null;
          const obj = JSON.parse(raw);
          return (obj && obj.userId && obj.app_state) ? obj : null;
        }catch(_){ return null; }
      }
      function clearLocalFallback(){
        try{ localStorage.removeItem(LOCAL_FALLBACK_KEY); }catch(_){}
      }

      // Public API: marks state as dirty, persists locally immediately, schedules cloud save.
      // Cheap + synchronous for the caller. All existing call sites stay unchanged.
      // In guest mode this is a strict no-op — neither localStorage nor cloud is touched.
      function persist(){
        if(guestMode) return;
        if(!currentUser) return;
        dirty = true;
        writeLocalFallback();              // ← always written sync, even if cloud later fails
        scheduleDebouncedSave();
      }
      function scheduleDebouncedSave(){
        if(saveDebounceTimer) clearTimeout(saveDebounceTimer);
        saveDebounceTimer = setTimeout(saveToCloud, SAVE_DEBOUNCE_MS);
      }

      async function saveToCloud(){
        if(!sb || !currentUser || !dirty) return;
        if(saveInFlight){ saveAgainAfter = true; return; }
        saveInFlight = true;
        if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
        try{
          const { error } = await sb.from("user_profiles").upsert({
            id: currentUser.id,
            app_state: buildStateSnapshot(),
            // updated_at is set by the DB trigger (server-trusted)
          });
          if(error) throw error;
          // Success
          dirty = false;
          saveBackoffMs = SAVE_BACKOFF_MIN;
          if(saveBackoffTimer){ clearTimeout(saveBackoffTimer); saveBackoffTimer = null; }
          clearLocalFallback();
        }catch(err){
          console.warn("[save] failed, retrying in", saveBackoffMs, "ms:", (err && err.message) || err);
          // Schedule retry with exponential backoff (capped at 60 s)
          if(saveBackoffTimer) clearTimeout(saveBackoffTimer);
          saveBackoffTimer = setTimeout(() => {
            saveBackoffTimer = null;
            if(dirty) saveToCloud();
          }, saveBackoffMs);
          saveBackoffMs = Math.min(saveBackoffMs * 2, SAVE_BACKOFF_MAX);
        }finally{
          saveInFlight = false;
          if(saveAgainAfter){
            saveAgainAfter = false;
            // New changes came in during the request → save again right away
            scheduleDebouncedSave();
          }
        }
      }

      // Synchronous, fire-and-forget save for unload-style events.
      // Uses fetch+keepalive with a pre-cached access token so there is NO async wait inside
      // the event handler — the request is queued by the browser and survives the page going away.
      // Body limit for keepalive is ~64 KB per origin; our app_state is well under that.
      function flushSyncOnUnload(){
        if(!currentUser || !dirty) return;
        // Even if the keepalive request fails, the localStorage fallback (written by persist())
        // will be picked up on the next sign-in.
        if(!cachedAccessToken) return;
        if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
        const body = JSON.stringify({
          id: currentUser.id,
          app_state: buildStateSnapshot(),
        });
        try{
          fetch(SUPABASE_URL + "/rest/v1/user_profiles", {
            method: "POST",
            keepalive: true,
            headers: {
              "apikey": SUPABASE_KEY,
              "Authorization": "Bearer " + cachedAccessToken,
              "Content-Type": "application/json",
              "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            body,
          }).catch(() => {});
        }catch(_){}
        // Optimistic: assume the keepalive will deliver. If it doesn't, the local fallback survives.
      }

      // Cache token for synchronous use by flushSyncOnUnload()
      function cacheAccessToken(session){
        cachedAccessToken = (session && session.access_token) ? session.access_token : null;
      }

      // Detect & recover unsynced local changes from a previous tab/session.
      // Returns the recovered app_state if local was newer than cloud, else null.
      async function recoverLocalFallback(userId){
        const fallback = readLocalFallback();
        if(!fallback || fallback.userId !== userId){
          clearLocalFallback();
          return null;
        }
        // Compare server-trusted updated_at against the local savedAt timestamp
        let cloudUpdatedAt = 0;
        try{
          const { data } = await sb.from("user_profiles").select("updated_at").maybeSingle();
          if(data && data.updated_at) cloudUpdatedAt = new Date(data.updated_at).getTime();
        }catch(_){}
        if(fallback.savedAt > cloudUpdatedAt){
          // Local snapshot is newer — push to cloud as authoritative
          try{
            const { error } = await sb.from("user_profiles").upsert({
              id: userId,
              app_state: fallback.app_state,
            });
            if(!error){
              clearLocalFallback();
              return fallback.app_state;
            }
            // Upload failed → keep fallback for next attempt
            return null;
          }catch(_){ return null; }
        }
        // Cloud is newer or equal → discard stale local snapshot
        clearLocalFallback();
        return null;
      }

      function startAutosave(){
        if(autosaveInterval) return;
        autosaveInterval = setInterval(() => {
          if(dirty && navigator.onLine !== false) saveToCloud();
        }, SAVE_AUTOSAVE_MS);
      }
      function stopAutosave(){
        if(autosaveInterval){ clearInterval(autosaveInterval); autosaveInterval = null; }
      }
      function setupSaveLifecycleHooks(){
        // visibilitychange — primary trigger; fires when user switches tabs, minimizes,
        // or (on mobile) backgrounds the browser. More reliable than beforeunload on iOS/Android.
        document.addEventListener("visibilitychange", () => {
          if(document.visibilityState === "hidden"){
            enforceAntiFarmingReset();        // ← reset learning interval (breaks are exempt)
            flushSyncOnUnload();
          } else if(document.visibilityState === "visible" && dirty){
            // Returned to foreground; try a normal save (network may have come back)
            saveToCloud();
          }
        });
        // pagehide — covers BFCache navigation and iOS/Safari unload scenarios
        // where beforeunload does NOT fire reliably.
        window.addEventListener("pagehide", () => {
          enforceAntiFarmingReset();
          flushSyncOnUnload();
        });
        // beforeunload — desktop legacy fallback (last resort).
        window.addEventListener("beforeunload", () => {
          enforceAntiFarmingReset();
          flushSyncOnUnload();
        });
        // online — retry pending saves when connectivity is back
        window.addEventListener("online", () => {
          if(dirty){
            // Reset backoff on reconnect so we save immediately
            saveBackoffMs = SAVE_BACKOFF_MIN;
            if(saveBackoffTimer){ clearTimeout(saveBackoffTimer); saveBackoffTimer = null; }
            saveToCloud();
          }
        });
      }
      async function fetchCloudState(userId){
        if(!sb) return null;
        try{
          const { data, error } = await sb.from("user_profiles").select("app_state").eq("id", userId).maybeSingle();
          if(error){ console.warn("[fetchCloudState]", error.message || error); return null; }
          return data ? data.app_state : null;
        }catch(e){
          console.warn("[fetchCloudState] exception", e);
          return null;
        }
      }
      function resetStateToDefaults(){
        const d = getDefaultState();
        for(const k of Object.keys(state)) delete state[k];
        Object.assign(state, d);
      }

      const state = loadState();

      const dom = {
        themeBtn: el("themeBtn"), soundBtn: el("soundBtn"),
        tabs: [...document.querySelectorAll(".tab")],
        views: { timer: el("timerView"), dice: el("diceView"), stats: el("statsView"), todo: el("todoView"), settings: el("settingsView") },
        topInfo: el("topInfo"), timerText: el("timerText"), compactTimer: el("compactTimer"),
        statusText: el("statusText"), compactStatus: el("compactStatus"),
        phaseFill: el("phaseFill"), progressText: el("progressText"),
        startBtn: el("startBtn"), skipBtn: el("skipBtn"), resetBtn: el("resetBtn"), celebrateBtn: el("celebrateBtn"),
        finishBox: el("finishBox"), compactOpen: el("compactOpen"), compactOverlay: el("compactOverlay"),
        compactWin: el("compactWin"), compactToggle: el("compactToggle"), compactExit: el("compactExit"), compactClose: el("compactClose"),
        trackCanvas: el("trackCanvas"), heatCanvas: el("heatCanvas"), tooltip: el("tooltip"), summaryGrid: el("summaryGrid"),
        learnNum: el("learn_min_num"),
        oddNum: el("break_odd_min_num"), evenNum: el("break_even_min_num"),
        bigAfterNum: el("big_break_after_num"), bigMinNum: el("big_break_min_num"),
        intervalsNum: el("intervals_num"), intervalsExplain: el("intervals_explain"),
        goalInput: el("goal_value_input"), goalUnitToggle: el("goal_unit_toggle"),
        bigBreakToggle: el("bigBreakToggle"),
        bigBreakRowAfter: el("bigBreakRowAfter"), bigBreakRowMin: el("bigBreakRowMin"),
        totalInfo: el("totalInfo"), savedMsg: el("savedMsg"), confetti: el("confetti"),
        legendLearn: el("legendLearn"), legendShort: el("legendShort"), legendLong: el("legendLong"),
        legendBig: el("legendBig"), legendBigItem: el("legendBigItem"),
        // Reward dice
        rewardDiceBtn: el("rewardDiceBtn"), rewardBadge: el("rewardBadge"),
        rewardModal: el("rewardModal"), rewardSub: el("rewardSub"),
        rewardDie: el("rewardDie"), rewardRolls: el("rewardRolls"), rewardEarned: el("rewardEarned"),
        rewardRollBtn: el("rewardRollBtn"), rewardCloseBtn: el("rewardCloseBtn"),
        // Points top pill
        pointsValTop: el("pointsValTop"),
        // Dice game
        modeExact: el("modeExact"), modeOE: el("modeOE"),
        diceScore: el("diceScore"), streakBox: el("streakBox"), streakVal: el("streakVal"),
        streakBonus: el("streakBonus"), multBase: el("multBase"), bonusTag: el("bonusTag"),
        diceSubtitle: el("diceSubtitle"), guessButton: el("guessButton"),
        guessLabel: el("guessLabel"), guessValue: el("guessValue"),
        bet: el("bet"), rollGameBtn: el("rollGameBtn"), gameDie: el("gameDie"),
        diceMessage: el("diceMessage"), diceSmall: el("diceSmall"),
        restartBtn: el("restartBtn"), needPointsHint: el("needPointsHint"),
        exactModal: el("exactModal"), oeModal: el("oeModal"),
        diceLockedHint: el("diceLockedHint"), diceGameWrap: el("diceGameWrap"),
        closeExact: el("closeExact"), closeOE: el("closeOE"),
        saveSettingsBtn: el("saveSettingsBtn"), defaultsBtn: el("defaultsBtn"),
        resetProgressBtn: el("resetProgressBtn"),
        confirmResetModal: el("confirmResetModal"),
        confirmResetYes: el("confirmResetYes"), confirmResetCancel: el("confirmResetCancel"),
        // Task popover
        taskPopover: el("taskPopover"), taskPopHeader: el("taskPopHeader"),
        taskList: el("taskList"), taskEmpty: el("taskEmpty"),
        taskInput: el("taskInput"), taskAddBtn: el("taskAddBtn"), taskHint: el("taskHint"),
        // Compact starred task
        compactStar: el("compactStar"), compactStarText: el("compactStarText"),
        // Dice timer popover
        dicePopover: el("dicePopover"), dicePopTime: el("dicePopTime"),
        dicePopFill: el("dicePopFill"), dicePopState: el("dicePopState"),
        // Console
        commandInput: el("commandInput"), commandSubmit: el("commandSubmit"), commandFeedback: el("commandFeedback"),
        // To-Do view
        todoSummary: el("todoSummary"),
        todoAddInterval: el("todoAddInterval"), todoAddInput: el("todoAddInput"), todoAddBtn: el("todoAddBtn"),
        todoPlannedList: el("todoPlannedList"), todoCompletedList: el("todoCompletedList"),
      };
      const ctxTrack = dom.trackCanvas.getContext("2d");
      const ctxHeat = dom.heatCanvas.getContext("2d");

      let tickTimer = null, compactDragging = false, dragOffset = {x:0,y:0}, confettiTimer = null;
      let timerWorker = null;
      let tickAnchor = null; // {wallStart, secondsAtStart}
      // Dirty-cache for DOM writes (avoids redundant text/style assignments every second)
      const lastWritten = {
        timerText: "", compactTimer: "", phaseFillW: -1, progressText: "",
        statusText: "", topInfo: "", legendLearn: "", legendShort: "", legendLong: "",
        startBtn: "", compactToggle: "", startDisabled: null, compactToggleDisabled: null,
        skipDisabled: null, skipText: "", finishDisplay: "", celebrateText: "", celebrateDisabled: null,
        learnNum: "", shortNum: "", longNum: "", totalInfo: "",
        pointsTop: "", diceScore: "", rewardBadgeText: "", rewardBadgeShown: null,
        compactStatus: "",
        compactStarText: "", compactStarVisible: null,
      };
      function setText(node, key, value){
        if(!node) return;
        if(lastWritten[key] !== value){ lastWritten[key] = value; node.textContent = value; }
      }
      function setBoolProp(node, key, prop, value){
        if(!node) return;
        if(lastWritten[key] !== value){ lastWritten[key] = value; node[prop] = value; }
      }

      // ── Timer worker (runs in its own thread → no jank from animations / GC ──
      function startTimerWorker(){
        if(timerWorker) return;
        const src = "let id=null;onmessage=e=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage('t'),250);}else if(e.data==='stop'){clearInterval(id);id=null;}};";
        const blob = new Blob([src], { type: "application/javascript" });
        try{
          timerWorker = new Worker(URL.createObjectURL(blob));
          timerWorker.onmessage = onWorkerTick;
        }catch(e){ timerWorker = null; }
      }
      function workerStart(){ startTimerWorker(); if(timerWorker) timerWorker.postMessage("start"); else { tickTimer = setTimeout(fallbackTick, 250); } }
      function workerStop(){ if(timerWorker) timerWorker.postMessage("stop"); if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; } }
      function fallbackTick(){ onWorkerTick(); if(state.running) tickTimer = setTimeout(fallbackTick, 250); }
      // Dice game transient state
      let diceGameMode = "exact";
      let diceSelection = null;
      let diceRolling = false;
      // Reward dice transient state
      let rewardRolling = false;
      let rewardSessionEarned = 0;


      // ════════════════════════════════════════════════════════════
      //   TIMER LOGIC  (PROKO core, with hooks for reward rolls)
      // ════════════════════════════════════════════════════════════
      // ── Pure helpers (no DOM access, no side effects) ─────────────────
      // Returns a localized label for a break kind. `headline=true` capitalizes
      // (used in primary status). Otherwise lowercase variants for inline text.
      function breakLabel(kind, headline){
        if(kind === "big") return headline ? "Große Pause" : "große Pause";
        if(kind === "odd") return headline ? "Pause (ungerade)" : "ungerade Pause";
        return headline ? "Pause (gerade)" : "gerade Pause";
      }
      // Status text shown above the timer (and mirrored to compactStatus).
      function computeStatusText(){
        if(state.phase === "learning"){
          return `Lerneinheit ${state.sessionIdx + 1} von ${TOTAL_SESSIONS}`;
        }
        if(state.phase === "break"){
          const k = breakKindAt(state.curBreak);
          return `${breakLabel(k, true)} — ${breakMinAt(state.curBreak)} Minuten`;
        }
        if(state.phase === "idle"){
          const done = state.sessionsDone.filter(Boolean).length;
          const [k, i] = nextTarget();
          if(k === "session"){
            return done > 0
              ? `Bereit — Einheit ${i + 1} von ${TOTAL_SESSIONS}`
              : `Bereit — Lerneinheit 1 von ${TOTAL_SESSIONS}`;
          }
          if(k === "break"){
            return `Bereit — ${breakLabel(breakKindAt(i), false)} (${breakMinAt(i)} Min)`;
          }
          return "Alle Einheiten erledigt";
        }
        return `Tagesziel erreicht! (${formatGoalLabel(state.settings)})`;
      }
      // Headline above the timer ("4h  ·  8 Einheiten à 30 Min").
      function computeTopInfoText(){
        const totalMin = TOTAL_SESSIONS * state.settings.learn_min;
        const h = Math.floor(totalMin / 60), m = totalMin % 60;
        const totalStr = m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h} Stunden`;
        return `${totalStr}  ·  ${TOTAL_SESSIONS} Einheiten à ${state.settings.learn_min} Min`;
      }
      // Settings-page note about how the configured intervals compare to the daily goal.
      function computeTotalInfoText(){
        const totalMin = TOTAL_SESSIONS * state.settings.learn_min;
        const h = Math.floor(totalMin / 60), m = totalMin % 60;
        const goalMin = computeGoalMin(state.settings);
        const goalStr = formatGoalLabel(state.settings);
        const diff = totalMin - goalMin;
        const note = diff === 0
          ? `= ${goalStr}-Tagesziel`
          : (diff < 0
            ? `(${-diff} Min unter dem ${goalStr}-Ziel)`
            : `(${diff} Min über dem ${goalStr}-Ziel)`);
        return `${TOTAL_SESSIONS} Einheiten ergeben ${h}h ${String(m).padStart(2, "0")}m Lernzeit  ${note}`;
      }
      // Start/Pause/Resume button label depends on alarm + running + phase.
      function computeStartButtonText(){
        if(state.alarmActive) return "🔔  Alarm aus";
        if(state.running)     return "⏸  Pause";
        if(state.phase === "done") return "✓  Fertig";
        return "▶  Start";
      }
      function computeCompactToggleText(){
        if(state.alarmActive) return "🔔";
        if(state.running)     return "⏸";
        if(state.phase === "done") return "✓";
        return "▶";
      }
      function computeStartDisabled(){
        return state.phase === "done" && !state.alarmActive;
      }

      // ── DOM renderers (each touches one UI region; all use cached setText/setBoolProp) ──
      function renderLegends(){
        const s = state.settings;
        setText(dom.legendLearn, "legendLearn", `Lernen ${s.learn_min} Min`);
        setText(dom.legendShort, "legendShort", `Ungerade Pause ${s.break_odd_min} Min`);
        setText(dom.legendLong,  "legendLong",  `Gerade Pause ${s.break_even_min} Min`);
        if(!dom.legendBigItem) return;
        if(s.big_break_enabled){
          dom.legendBigItem.style.display = "";
          setText(dom.legendBig, "legendBig", `Große Pause ${s.big_break_min} Min`);
        } else {
          dom.legendBigItem.style.display = "none";
        }
      }
      function nextTarget(){
        for(let i=0;i<TOTAL_SESSIONS;i++){
          if(!state.sessionsDone[i]) return ["session", i];
          if(i<TOTAL_SESSIONS-1 && !state.breaksDone[i]) return ["break", i];
        }
        return [null, null];
      }
      function lastDone(){
        for(let i=TOTAL_SESSIONS-1;i>=0;i--){
          if(state.sessionsDone[i]) return ["session", i];
          if(i>0 && state.breaksDone[i-1]) return ["break", i-1];
        }
        return [null, null];
      }
      function phaseTotalSec(){
        if(state.phase === "learning") return effectiveLearnSec(state.sessionIdx);
        if(state.phase === "break"){
          return breakMinAt(state.curBreak >= 0 ? state.curBreak : 0) * 60;
        }
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") return effectiveLearnSec(i);
          if(k === "break") return breakMinAt(i) * 60;
        }
        return effectiveLearnSec(state.sessionIdx);
      }
      function currentProgress(){
        if(state.phase === "done") return 1;
        const total = phaseTotalSec();
        return total <= 0 ? 0 : Math.max(0, Math.min(1, 1 - state.timeLeft / total));
      }
      function fmtTime(sec){
        sec = Math.max(0, Math.floor(sec));
        const m = Math.floor(sec / 60), s = sec % 60;
        return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
      }
      function progressText(){
        // Source of truth: actually-logged minutes for today (state.data[today]).
        // This correctly handles per-session length overrides, template switches,
        // and partial sessions added via the timer page.
        const doneMin = getMin(todayISO());
        const h = Math.floor(doneMin / 60), m = doneMin % 60;
        const goalMin = computeGoalMin(state.settings);
        const goalStr = formatGoalLabel(state.settings);
        if(doneMin === 0) return `0h 00m / ${goalStr}`;
        if(doneMin >= goalMin) return `${h}h ${String(m).padStart(2,"0")}m / ${goalStr} ✓`;
        return `${h}h ${String(m).padStart(2,"0")}m / ${goalStr}`;
      }
      function renderTopInfo(){
        setText(dom.topInfo, "topInfo", computeTopInfoText());
      }
      function renderStatus(){
        const s = computeStatusText();
        setText(dom.statusText, "statusText", s);
        setText(dom.compactStatus, "compactStatus", s);
      }
      function renderTimerControls(){
        const startDisabled = computeStartDisabled();
        // MP3-player main button: pure icon (▶ / ⏸ / 🔔 / ✓).
        const mainIcon = computeCompactToggleText();
        setText(dom.startBtn,      "startBtn",      mainIcon);
        setText(dom.compactToggle, "compactToggle", mainIcon);
        setBoolProp(dom.startBtn,      "startDisabled",         "disabled", startDisabled);
        setBoolProp(dom.compactToggle, "compactToggleDisabled", "disabled", startDisabled);
        // Skip is ONLY usable during breaks (no skipping learning intervals — anti-farming rule).
        const skipDisabled = state.phase !== "break";
        setBoolProp(dom.skipBtn, "skipDisabled", "disabled", skipDisabled);
        setText(dom.skipBtn, "skipText", "⏭");
        // Reset is always available (rewinds current phase to its full duration).
        setBoolProp(dom.resetBtn, "resetDisabled", "disabled", state.phase === "done");
        const finishDisp = state.phase === "done" ? "flex" : "none";
        if(lastWritten.finishDisplay !== finishDisp){
          lastWritten.finishDisplay = finishDisp;
          dom.finishBox.style.display = finishDisp;
        }
      }
      function renderCelebrateButton(){
        const celebrated = !!state.data[`${todayISO()}_celebrated`];
        setText(dom.celebrateBtn, "celebrateText",
          celebrated ? "Heute bereits abgeschlossen ✓" : "Ja, fertig mit Lernen für heute!");
        setBoolProp(dom.celebrateBtn, "celebrateDisabled", "disabled", celebrated);
      }
      function renderSettingsNumbers(){
        const s = state.settings;
        if(dom.learnNum)     setText(dom.learnNum,     "learnNum",     String(s.learn_min));
        if(dom.oddNum)       setText(dom.oddNum,       "oddNum",       String(s.break_odd_min));
        if(dom.evenNum)      setText(dom.evenNum,      "evenNum",      String(s.break_even_min));
        if(dom.bigAfterNum)  setText(dom.bigAfterNum,  "bigAfterNum",  String(s.big_break_after));
        if(dom.bigMinNum)    setText(dom.bigMinNum,    "bigMinNum",    String(s.big_break_min));
        if(dom.intervalsNum) setText(dom.intervalsNum, "intervalsNum", String(TOTAL_SESSIONS));
      }
      function renderTotalInfo(){
        setText(dom.totalInfo, "totalInfo", computeTotalInfoText());
      }
      function updateRewardBadge(pulse=false){
        const n = state.pendingRolls;
        if(n > 0){
          setText(dom.rewardBadge, "rewardBadgeText", String(n));
          if(lastWritten.rewardBadgeShown !== true){ lastWritten.rewardBadgeShown = true; dom.rewardBadge.classList.add("show"); }
          if(pulse){
            dom.rewardBadge.classList.remove("pulse");
            void dom.rewardBadge.offsetWidth;
            dom.rewardBadge.classList.add("pulse");
          }
        }else{
          if(lastWritten.rewardBadgeShown !== false){ lastWritten.rewardBadgeShown = false; dom.rewardBadge.classList.remove("show", "pulse"); }
        }
      }
      function updatePointsDisplay(){
        const v = String(state.points);
        setText(dom.pointsValTop, "pointsTop", v);
        if(dom.diceScore) setText(dom.diceScore, "diceScore", v);
      }
      function updateCompactStar(){
        if(!dom.compactStar) return;
        const starred = state.phase === "learning" ? getStarredTask(state.sessionIdx) : null;
        const text = starred ? starred.text : "";
        const visible = !!starred;
        if(lastWritten.compactStarVisible !== visible){
          lastWritten.compactStarVisible = visible;
          dom.compactStar.style.display = visible ? "block" : "none";
        }
        if(visible) setText(dom.compactStarText, "compactStarText", text);
      }
      // ── Light, every-tick UI update: only timer text + progress fill ──
      function updateTimerTickUI(){
        const t = fmtTime(state.timeLeft);
        setText(dom.timerText, "timerText", t);
        setText(dom.compactTimer, "compactTimer", t);
        const pct = Math.round(currentProgress() * 1000) / 10; // 0.1% precision
        if(lastWritten.phaseFillW !== pct){
          lastWritten.phaseFillW = pct;
          dom.phaseFill.style.width = pct + "%";
        }
      }
      // ── Heavy, full UI update: orchestrates all timer-page renderers ──
      // Each renderer is independent + cache-aware, so calling them all is cheap.
      // Use updateTimerTickUI() alone for the per-second tick to avoid touching unchanged regions.
      function updateTimerUI(){
        updateTimerTickUI();
        setText(dom.progressText, "progressText", progressText());
        renderTopInfo();
        renderLegends();
        updateRewardBadge();
        updatePointsDisplay();
        updateCompactStar();
        renderStatus();
        renderTimerControls();
        renderCelebrateButton();
        renderSettingsNumbers();
        renderTotalInfo();
        applyDiceLockState();
      }

      function recordSession(minutes){
        const key = todayISO();
        state.data[key] = Math.max(0, getMin(key) + minutes);
      }
      function unrecordSession(minutes){
        const key = todayISO();
        const next = Math.max(0, getMin(key) - minutes);
        if(next <= 0) delete state.data[key]; else state.data[key] = next;
      }
      function updateDataFromToday(){
        const todayMin = Number(state.data[todayISO()]) || 0;
        const n = Math.min(Math.floor(todayMin / state.settings.learn_min), TOTAL_SESSIONS);
        state.sessionsDone = Array(TOTAL_SESSIONS).fill(false);
        state.breaksDone = Array(TOTAL_SESSIONS - 1).fill(false);
        for(let i=0;i<n;i++) state.sessionsDone[i] = true;
        for(let i=0;i<Math.min(n-1, TOTAL_SESSIONS-1); i++) state.breaksDone[i] = true;
        state.sessionIdx = n;
        if(n >= TOTAL_SESSIONS){ state.phase = "done"; state.timeLeft = 0; }
      }
      function setupNextPhase(){
        const [k, i] = nextTarget();
        state.running = false; state.alarmActive = false; stopAlarm();
        if(k === null){ state.phase = "done"; state.timeLeft = 0; return; }
        state.phase = "idle";
        if(k === "session"){ state.sessionIdx = i; state.curBreak = -1; state.timeLeft = effectiveLearnSec(i); }
        else{ state.curBreak = i; state.timeLeft = breakMinAt(i) * 60; }
      }
      function showFinish(){ state.phase = "done"; state.timeLeft = 0; stopAlarm(); state.running = false; updateTimerUI(); drawTrack(); persist(); }

      // ── HOOK: every completed learning session grants 1 reward roll ──
      function grantRewardRoll(streakBonus=false, surpassBonus=false){
        state.pendingRollBonuses.push({ streak: !!streakBonus, surpass: !!surpassBonus });
        state.pendingRolls = state.pendingRollBonuses.length;
        updateRewardBadge(true);
      }
      // Compute the bonuses that the upcoming reward roll for an interval should carry.
      // Must be called BEFORE recordSession() updates today's minutes.
      function computeIntervalBonuses(){
        const todayKey = todayISO(), yKey = yesterdayISO();
        const yesterdayMin = getMin(yKey);
        const todayMinBefore = getMin(todayKey);
        const todayMinAfter = todayMinBefore + state.settings.learn_min;
        const isFirstToday = todayMinBefore === 0;
        // Streak: yesterday was a real learn day (>= 30 min) AND this is the very first interval today
        const streakBonus = isFirstToday && yesterdayMin >= STREAK_THRESHOLD_MIN;
        // Surpass: yesterday > 0 AND this interval pushes today's total strictly above yesterday's
        const surpassBonus = yesterdayMin > 0 && todayMinBefore <= yesterdayMin && todayMinAfter > yesterdayMin;
        return { streakBonus, surpassBonus };
      }

      function complete(silent=false){
        const endedPhase = state.phase;     // remember for notification
        state.running = false;
        workerStop();
        tickAnchor = null;
        diceTrackingStop();
        releaseWakeLock();                  // free screen when phase ends
        if(state.phase === "learning"){
          state.sessionsDone[state.sessionIdx] = true;
          recordSession(effectiveLearnMin(state.sessionIdx));
          // Carry unfinished tasks to the next interval (if any)
          carryOverTasks(state.sessionIdx);
          // NOTE: rolls are now granted by the decoupled dice timer (every 30 min of active learning),
          // not by session completion.
          if(state.sessionIdx === TOTAL_SESSIONS - 1){
            state.phase = "done"; state.timeLeft = 0; updateTimerUI(); drawTrack();
            if(silent) showFinish(); else { state.alarmActive = true; updateTimerUI(); startAlarm(); }
            if(!silent) notifyPhaseEnd("done");
            persist(); return;
          }
          state.curBreak = state.sessionIdx;
          state.phase = "break";
          state.timeLeft = breakMinAt(state.curBreak) * 60;
        }else if(state.phase === "break"){
          state.breaksDone[state.curBreak] = true;
          state.sessionIdx += 1;
          state.phase = "learning";
          state.timeLeft = effectiveLearnSec(state.sessionIdx);
        }else return;
        updateTimerUI(); drawTrack(); persist();
        if(!silent){
          state.alarmActive = true;
          startAlarm();
          notifyPhaseEnd(endedPhase);       // browser notification when tab is hidden
        }
      }
      // Persist throttle: only write to localStorage at most every PERSIST_INTERVAL ms during ticking
      const PERSIST_INTERVAL = 5000;
      let lastPersist = 0;
      function persistThrottled(){
        const now = Date.now();
        if(now - lastPersist >= PERSIST_INTERVAL){ lastPersist = now; persist(); }
      }
      // Drift-free tick: timeLeft is recomputed from wall-clock anchor
      function onWorkerTick(){
        if(!state.running || tickAnchor === null) return;
        const elapsed = (Date.now() - tickAnchor.wallStart) / 1000;
        const newLeft = Math.max(0, tickAnchor.secondsAtStart - Math.floor(elapsed));
        if(newLeft !== state.timeLeft){
          state.timeLeft = newLeft;
          updateTimerTickUI();
          persistThrottled();
        }
        // Dice timer slice (only advances while learning + running, via diceTimerAnchor)
        diceTimerTick();
        if(newLeft <= 0){
          workerStop();
          persist();
          complete(false);
        }
      }
      function startTickAnchor(){
        tickAnchor = { wallStart: Date.now(), secondsAtStart: state.timeLeft };
      }
      function tick(){ /* legacy entry */ if(!state.running) return; startTickAnchor(); workerStart(); }
      function startOrPause(){
        if(state.alarmActive){ dismissAlarm(); return; }
        if(state.phase === "done") return;
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === null) return;
          if(k === "session"){ state.phase = "learning"; state.sessionIdx = i; state.timeLeft = effectiveLearnSec(i); }
          else { state.phase = "break"; state.curBreak = i; state.timeLeft = breakMinAt(i) * 60; }
          updateTimerUI();
        }
        state.running = !state.running;
        if(state.running){
          startTickAnchor();
          workerStart();
          if(state.phase === "learning"){
            diceTrackingStart();
            requestWakeLock();                  // keep screen on while learning
            ensureNotificationPermission();     // ask for permission on first start
          }
        } else {
          workerStop();
          tickAnchor = null;
          diceTrackingStop();
          releaseWakeLock();                    // free screen when paused
        }
        persist(); updateTimerUI();
      }
      // Carry the remaining time of the CURRENT break over to the NEXT break (rounded up to min).
      // Returns the number of bonus minutes that were transferred (0 if no next break exists).
      function transferBreakRemainderToNext(){
        if(state.phase !== "break") return 0;
        const remainSec = Math.max(0, state.timeLeft | 0);
        if(remainSec <= 0) return 0;
        const nextBreakIdx = state.curBreak + 1;
        // Break i sits between session i and session i+1, so it exists for i in [0 .. TOTAL_SESSIONS - 2].
        if(nextBreakIdx > TOTAL_SESSIONS - 2) return 0;
        const bonusMin = Math.max(1, Math.round(remainSec / 60));
        if(!Array.isArray(state.breakLengthOverrides)) state.breakLengthOverrides = [];
        while(state.breakLengthOverrides.length <= nextBreakIdx) state.breakLengthOverrides.push(null);
        const baseMin = breakMinAt(nextBreakIdx); // resolves either existing override or template default
        state.breakLengthOverrides[nextBreakIdx] = baseMin + bonusMin;
        return bonusMin;
      }
      function skipPhase(){
        if(state.phase !== "break") return;
        transferBreakRemainderToNext();
        stopAlarm();
        state.timeLeft = 0;
        complete(true);
      }
      // /skip command: skips either learning interval or break by triggering completion now.
      // Only break-skips trigger the carry-over (learning skips don't get bonus added anywhere).
      function skipAny(){
        if(state.phase !== "break" && state.phase !== "learning") return false;
        if(state.phase === "break") transferBreakRemainderToNext();
        stopAlarm(); state.timeLeft = 0; complete(true);
        return true;
      }
      function resetAll(){
        stopAlarm(); workerStop(); tickAnchor = null; diceTrackingStop();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        state.running = false; state.alarmActive = false; state.sessionIdx = 0; state.phase = "idle"; state.timeLeft = state.settings.learn_min * 60; state.sessionsDone = Array(TOTAL_SESSIONS).fill(false); state.breaksDone = Array(TOTAL_SESSIONS - 1).fill(false); state.curBreak = -1; updateTimerUI(); drawTrack(); persist();
      }
      // Reset the current phase (learning OR break) back to its full duration. Does NOT change
      // sessionsDone/breaksDone — only the in-progress phase is rewound.
      function resetCurrentInterval(){
        workerStop(); diceTrackingStop();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        tickAnchor = null;
        state.running = false;
        state.alarmActive = false; stopAlarm();
        state.timeLeft = phaseTotalSec();
        releaseWakeLock();
        updateTimerUI();
        persist();
      }
      // Anti-farming guard: when the tab closes / is hidden, a running learning interval is
      // pulled back to the start of the interval so leaving the tab open passively can't
      // count as learning. Break phases are exempt — they're allowed to count down.
      function enforceAntiFarmingReset(){
        if(state.phase !== "learning") return;
        workerStop(); diceTrackingStop();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        tickAnchor = null;
        state.running = false;
        state.timeLeft = phaseTotalSec();
        releaseWakeLock();
        // Mark dirty so the flushSyncOnUnload following this call uploads the reset state.
        if(currentUser){ dirty = true; writeLocalFallback(); }
        // Update UI so users returning to the tab see the reset state.
        try{ updateTimerUI(); }catch(_){}
      }

      const clickBoxes = [];
      function circSizeForBreak(i){
        const k = breakKindAt(i);
        if(k === "big") return 48;
        if(k === "even") return 38;
        return 24;
      }
      function drawTrack(){
        const canvas = dom.trackCanvas, ctx = ctxTrack;
        const numRows = TOTAL_SESSIONS > 8 ? 2 : 1;
        const targetH = numRows === 2 ? 200 : 120;
        if(canvas.height !== targetH) canvas.height = targetH;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        // Cache CSS variables once
        const s = getComputedStyle(document.body);
        const COL = {
          text: s.getPropertyValue("--text").trim(),
          textDim: s.getPropertyValue("--text-dim").trim(),
          btnNeutral: s.getPropertyValue("--btn-neutral").trim(),
          boxBorder: s.getPropertyValue("--box-border").trim(),
          accent: s.getPropertyValue("--accent").trim(),
          card: s.getPropertyValue("--card").trim(),
          boxActiveFg: s.getPropertyValue("--box-active-fg").trim(),
        };
        const BOX_S = 50, SLOT_GAP = 14, ROW_GAP = 22;
        const PCY_ROW0 = numRows === 2 ? 42 : 60;
        const PCY_ROW1 = PCY_ROW0 + BOX_S + ROW_GAP;
        clickBoxes.length = 0;
        const [nextKind, nextIdx] = nextTarget();

        // Column-aligned layout: session N+8 (row 2) sits at the same x as session N (row 1).
        // For each column slot c (between session c and c+1), use the larger break circle size
        // from the two rows so both rows align identically.
        const colCount = Math.min(8, TOTAL_SESSIONS); // sessions on row 1
        const r2Count = Math.max(0, TOTAL_SESSIONS - 8);
        const hasTrailing = TOTAL_SESSIONS > 8; // break #8 (between session 8 and 9) on row 1

        const breakSlotW = []; // uniform slot width for break-column c (0..colCount-2)
        for(let c=0; c<colCount-1; c++){
          let sz = circSizeForBreak(c); // row 1: break index c
          const r2BreakIdx = c + 8;
          if(r2BreakIdx < TOTAL_SESSIONS - 1){
            // row 2 has a break in this column
            sz = Math.max(sz, circSizeForBreak(r2BreakIdx));
          }
          breakSlotW.push(sz);
        }
        const trailingSize = hasTrailing ? circSizeForBreak(7) : 0;

        // Compute row 1 visual width
        let row1Width = colCount * BOX_S;
        for(const w of breakSlotW) row1Width += w;
        if(hasTrailing) row1Width += trailingSize;
        const itemsInRow1 = colCount + (colCount - 1) + (hasTrailing ? 1 : 0);
        row1Width += Math.max(0, itemsInRow1 - 1) * SLOT_GAP;

        const startX = Math.max(0, (W - row1Width) / 2);

        // Cache session x-positions per column (used by both rows)
        const sessionX = [];
        let cursorX = startX;
        for(let c=0; c<colCount; c++){
          sessionX.push(cursorX);
          cursorX += BOX_S;
          if(c < colCount - 1){
            cursorX += SLOT_GAP + breakSlotW[c] + SLOT_GAP;
          }
        }
        // Trailing break x (row 1 only)
        const trailingX = hasTrailing ? (sessionX[colCount-1] + BOX_S + SLOT_GAP) : 0;

        function fontSizeForCirc(csz, labelLen){
          if(csz >= 48) return labelLen >= 3 ? 11 : 13;
          if(csz >= 38) return labelLen >= 3 ? 7 : 10;
          return labelLen >= 3 ? 5 : 9;
        }
        function drawSession(i, cx, pcy){
          const done = state.sessionsDone[i];
          const active = state.phase === "learning" && state.sessionIdx === i && !done;
          const focused = !done && !active && nextKind === "session" && nextIdx === i;
          const x1 = cx, y1 = pcy - BOX_S/2, x2 = cx + BOX_S, y2 = pcy + BOX_S/2;
          if(active){
            ctx.fillStyle = COL.accent; ctx.fillRect(x1,y1,BOX_S,BOX_S);
            ctx.fillStyle = COL.boxActiveFg; ctx.font = 'bold 16px "Segoe UI", sans-serif';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(String(i+1), (x1+x2)/2, (y1+y2)/2);
          } else if(focused){
            ctx.fillStyle = COL.card; ctx.fillRect(x1,y1,BOX_S,BOX_S);
            ctx.strokeStyle = COL.text; ctx.lineWidth = 2; ctx.strokeRect(x1+1,y1+1,BOX_S-2,BOX_S-2);
            ctx.fillStyle = COL.text; ctx.font = 'bold 15px "Segoe UI", sans-serif';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(String(i+1), (x1+x2)/2, (y1+y2)/2);
          } else if(done){
            ctx.fillStyle = COL.card; ctx.fillRect(x1,y1,BOX_S,BOX_S);
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.strokeRect(x1+0.5,y1+0.5,BOX_S-1,BOX_S-1);
            ctx.strokeStyle = COL.text; ctx.lineWidth = 3; ctx.beginPath();
            ctx.moveTo(x1+11,y1+11); ctx.lineTo(x2-11,y2-11);
            ctx.moveTo(x2-11,y1+11); ctx.lineTo(x1+11,y2-11); ctx.stroke();
          } else {
            ctx.fillStyle = COL.btnNeutral; ctx.fillRect(x1,y1,BOX_S,BOX_S);
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.strokeRect(x1+0.5,y1+0.5,BOX_S-1,BOX_S-1);
            ctx.fillStyle = COL.textDim; ctx.font = '13px "Segoe UI", sans-serif';
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(String(i+1), (x1+x2)/2, (y1+y2)/2);
          }
          clickBoxes.push({kind:"session", idx:i, x1, y1, x2, y2});
        }
        function drawBreak(i, cx, pcy){
          const csz = circSizeForBreak(i);
          const isBig = breakKindAt(i) === "big";
          const mins = breakMinAt(i);
          const label = String(mins);
          const fs = fontSizeForCirc(csz, label.length);
          const bDone = state.breaksDone[i];
          const bActive = state.phase === "break" && state.curBreak === i && !bDone;
          const bFocus = !bDone && !bActive && nextKind === "break" && nextIdx === i;
          const bx1 = cx, by1 = pcy - csz/2, bx2 = cx + csz, by2 = pcy + csz/2;
          ctx.beginPath(); ctx.arc((bx1+bx2)/2, (by1+by2)/2, csz/2, 0, Math.PI*2);
          if(bActive){
            ctx.fillStyle = COL.accent; ctx.fill();
            ctx.fillStyle = COL.boxActiveFg;
            ctx.font = `bold ${fs}px "Segoe UI", sans-serif`;
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(label, (bx1+bx2)/2, (by1+by2)/2);
          } else if(bFocus){
            ctx.fillStyle = COL.card; ctx.fill();
            ctx.strokeStyle = COL.text; ctx.lineWidth = 2; ctx.stroke();
            ctx.fillStyle = COL.text;
            ctx.font = `bold ${fs}px "Segoe UI", sans-serif`;
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(label, (bx1+bx2)/2, (by1+by2)/2);
          } else if(bDone){
            ctx.fillStyle = COL.card; ctx.fill();
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.stroke();
            ctx.strokeStyle = COL.text; ctx.lineWidth = 2; ctx.beginPath();
            ctx.moveTo((bx1+bx2)/2 - 5, (by1+by2)/2 - 5); ctx.lineTo((bx1+bx2)/2 + 5, (by1+by2)/2 + 5);
            ctx.moveTo((bx1+bx2)/2 + 5, (by1+by2)/2 - 5); ctx.lineTo((bx1+bx2)/2 - 5, (by1+by2)/2 + 5); ctx.stroke();
          } else {
            ctx.fillStyle = COL.btnNeutral; ctx.fill();
            ctx.strokeStyle = isBig ? COL.text : COL.boxBorder;
            ctx.lineWidth = isBig ? 1.5 : 1;
            ctx.stroke();
            ctx.fillStyle = COL.textDim;
            ctx.font = `${fs}px "Segoe UI", sans-serif`;
            ctx.textAlign='center'; ctx.textBaseline='middle';
            ctx.fillText(label, (bx1+bx2)/2, (by1+by2)/2);
          }
          clickBoxes.push({kind:"break", idx:i, x1:bx1, y1:by1, x2:bx2, y2:by2});
        }
        // Row 1 sessions
        for(let c=0; c<colCount; c++){
          drawSession(c, sessionX[c], PCY_ROW0);
        }
        // Row 1 internal breaks (centered in their column slot so row 1 + row 2 align)
        for(let c=0; c<colCount-1; c++){
          const breakIdx = c;
          const slotW = breakSlotW[c];
          const actualSz = circSizeForBreak(breakIdx);
          const slotStartX = sessionX[c] + BOX_S + SLOT_GAP;
          const breakX = slotStartX + (slotW - actualSz) / 2;
          drawBreak(breakIdx, breakX, PCY_ROW0);
        }
        // Trailing break on row 1 (between session 8 and 9)
        if(hasTrailing){
          drawBreak(7, trailingX, PCY_ROW0);
        }
        // Row 2: aligned to row 1's session x-positions
        if(numRows === 2){
          for(let c=0; c<r2Count; c++){
            drawSession(8 + c, sessionX[c], PCY_ROW1);
          }
          for(let c=0; c<r2Count-1; c++){
            const breakIdx = 8 + c;
            const slotW = breakSlotW[c];
            const actualSz = circSizeForBreak(breakIdx);
            const slotStartX = sessionX[c] + BOX_S + SLOT_GAP;
            const breakX = slotStartX + (slotW - actualSz) / 2;
            drawBreak(breakIdx, breakX, PCY_ROW1);
          }
        }
        // If track-hover buttons are currently visible, reposition them to the new last box.
        if(typeof positionTrackOverlayForLast === "function" && trackOverlay && (
           (trackOverlay.removeBtn && trackOverlay.removeBtn.style.display !== "none") ||
           (trackOverlay.addBtn    && trackOverlay.addBtn.style.display    !== "none"))){
          positionTrackOverlayForLast();
        }
      }
      function inBox(x,y,b){ return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2; }
      function setTooltip(text,x,y){ dom.tooltip.textContent = text; dom.tooltip.style.left = x + "px"; dom.tooltip.style.top = y + "px"; dom.tooltip.style.display = "block"; }
      function hideTooltip(){ dom.tooltip.style.display = "none"; }
      function handleTrackClick(ev){
        if(state.running || state.alarmActive) return;
        const rect = dom.trackCanvas.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (dom.trackCanvas.width / rect.width), y = (ev.clientY - rect.top) * (dom.trackCanvas.height / rect.height);
        if(state.phase !== "done"){
          const [nk, ni] = nextTarget();
          const target = clickBoxes.find(b => b.kind === nk && b.idx === ni && inBox(x, y, b));
          if(target){ markDone(target.kind, target.idx); return; }
        }
        const [lk, li] = lastDone();
        const last = clickBoxes.find(b => b.kind === lk && b.idx === li && inBox(x, y, b));
        if(last) unmarkDone(last.kind, last.idx);
      }
      // Track-overlay state (remove + add buttons positioned over the last session box)
      const trackOverlay = {
        wrap: document.getElementById("trackWrap"),
        removeBtn: document.getElementById("trackRemoveBtn"),
        addBtn:    document.getElementById("trackAddBtn"),
        hideTimer: null,
      };
      function hideTrackOverlayButtons(){
        if(trackOverlay.removeBtn) trackOverlay.removeBtn.style.display = "none";
        if(trackOverlay.addBtn)    trackOverlay.addBtn.style.display    = "none";
      }
      function scheduleHideTrackButtons(){
        if(trackOverlay.hideTimer) clearTimeout(trackOverlay.hideTimer);
        trackOverlay.hideTimer = setTimeout(hideTrackOverlayButtons, 180);
      }
      function cancelHideTrackButtons(){
        if(trackOverlay.hideTimer){ clearTimeout(trackOverlay.hideTimer); trackOverlay.hideTimer = null; }
      }
      // Convert canvas-local coords (cx, cy) into CSS pixels inside trackWrap.
      function canvasToWrap(cx, cy){
        const canvas = dom.trackCanvas, wrap = trackOverlay.wrap;
        if(!wrap || !canvas) return { x: 0, y: 0 };
        const cRect = canvas.getBoundingClientRect();
        const wRect = wrap.getBoundingClientRect();
        const sx = cRect.width / canvas.width;
        const sy = cRect.height / canvas.height;
        return {
          x: (cRect.left - wRect.left) + cx * sx,
          y: (cRect.top  - wRect.top)  + cy * sy,
        };
      }
      // Hit-zone for the "+" button: empty area to the right of the last session, on its row.
      // Returns the box (or null if there's no usable space / running / etc.)
      function getLastSessionBox(){
        // Last session = highest idx. To be removable it must NOT be done.
        if(TOTAL_SESSIONS <= 0) return null;
        const last = TOTAL_SESSIONS - 1;
        return clickBoxes.find(b => b.kind === "session" && b.idx === last) || null;
      }
      function isOverAddZone(x, y){
        // The "+" zone sits right of the last session box, on its row, ~60 px wide.
        const last = getLastSessionBox();
        if(!last) return false;
        const PAD_RIGHT = 70;
        return x > last.x2 && x < last.x2 + PAD_RIGHT && y >= last.y1 - 6 && y <= last.y2 + 6;
      }
      function canRemoveLastInterval(){
        if(state.running || state.alarmActive) return false;
        if(TOTAL_SESSIONS <= 1) return false;          // keep at least one
        const last = TOTAL_SESSIONS - 1;
        if(state.sessionsDone[last]) return false;     // only undone last
        return true;
      }
      function canAddInterval(){
        if(state.running || state.alarmActive) return false;
        return TOTAL_SESSIONS < MAX_SESSIONS;
      }
      function positionTrackOverlayForLast(){
        const last = getLastSessionBox();
        if(!last){ hideTrackOverlayButtons(); return; }
        // Remove button: centered BELOW the last box (the task popover sits above it, so we
        // tuck the remove button underneath to avoid the two overlapping on hover).
        if(trackOverlay.removeBtn){
          if(canRemoveLastInterval()){
            const center = canvasToWrap((last.x1 + last.x2) / 2, last.y2);
            trackOverlay.removeBtn.style.left = center.x + "px";
            trackOverlay.removeBtn.style.top  = center.y + "px";
            trackOverlay.removeBtn.style.display = "block";
          } else {
            trackOverlay.removeBtn.style.display = "none";
          }
        }
        // Add button: centered in the empty area right of the last box
        if(trackOverlay.addBtn){
          if(canAddInterval()){
            const center = canvasToWrap(last.x2 + 36, (last.y1 + last.y2) / 2);
            trackOverlay.addBtn.style.left = center.x + "px";
            trackOverlay.addBtn.style.top  = center.y + "px";
            trackOverlay.addBtn.style.display = "flex";
          } else {
            trackOverlay.addBtn.style.display = "none";
          }
        }
      }

      function handleTrackMove(ev){
        const rect = dom.trackCanvas.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (dom.trackCanvas.width / rect.width);
        const y = (ev.clientY - rect.top) * (dom.trackCanvas.height / rect.height);
        // Always-on: task popover when hovering any session box (incomplete or done; even while running)
        const sessionBox = clickBoxes.find(b => b.kind === "session" && inBox(x, y, b));
        if(sessionBox){
          showTaskPopover(sessionBox.idx, sessionBox);
        } else {
          schedulePopHide();
        }
        // Track add/remove overlay: only when NOT running/alarming.
        if(!state.running && !state.alarmActive){
          const lastBox = getLastSessionBox();
          const overLast = lastBox && inBox(x, y, lastBox) && lastBox.idx === TOTAL_SESSIONS - 1;
          const overAddZone = isOverAddZone(x, y);
          if(overLast || overAddZone){
            cancelHideTrackButtons();
            positionTrackOverlayForLast();
          } else {
            scheduleHideTrackButtons();
          }
        } else {
          hideTrackOverlayButtons();
        }
        // Cursor + tooltip: only when interactive (not running, not alarm)
        if(state.running || state.alarmActive){
          hideTooltip();
          dom.trackCanvas.style.cursor = "default";
          return;
        }
        const candidates = [];
        if(state.phase !== "done"){ const [nk, ni] = nextTarget(); if(nk !== null) candidates.push({kind:nk, idx:ni}); }
        const [lk, li] = lastDone(); if(lk !== null) candidates.push({kind:lk, idx:li});
        const found = candidates.map(c => clickBoxes.find(b => b.kind === c.kind && b.idx === c.idx)).find(b => b && inBox(x,y,b));
        if(found){
          // Sessions: popover covers info (no click action). Breaks: tooltip only.
          dom.trackCanvas.style.cursor = "default";
          if(found.kind === "session"){
            hideTooltip();
          } else {
            const text = `${breakKindAt(found.idx) === "big" ? "Große Pause" : "Pause"} ${breakMinAt(found.idx)} Min`;
            setTooltip(text, ev.clientX + 14, ev.clientY - 12);
          }
        }else{
          dom.trackCanvas.style.cursor = "default";
          hideTooltip();
        }
      }

      // ── Add / remove last interval ────────────────────────────────
      function removeLastInterval(){
        if(!canRemoveLastInterval()) return;
        const lastIdx = TOTAL_SESSIONS - 1;
        // 1) Reduce total via override
        state.totalSessionsOverride = TOTAL_SESSIONS - 1;
        // 2) Pop overrides for the removed slot
        if(Array.isArray(state.sessionLengthOverrides) && state.sessionLengthOverrides.length > lastIdx){
          state.sessionLengthOverrides.splice(lastIdx, 1);
        }
        // The break BEFORE this session (index lastIdx - 1) is also removed.
        const lastBreakIdx = lastIdx - 1;
        if(lastBreakIdx >= 0 && Array.isArray(state.breakLengthOverrides) && state.breakLengthOverrides.length > lastBreakIdx){
          state.breakLengthOverrides.splice(lastBreakIdx, 1);
        }
        // 3) Recompute TOTAL_SESSIONS + reconcile sessionsDone / breaksDone
        recomputeTotalSessions();
        reconcileSessionArrays();
        // 4) If we were idle pointing at the removed slot, shift back
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = effectiveLearnSec(i);
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
          else if(k === null){ state.phase = "done"; state.timeLeft = 0; }
        }
        hideTrackOverlayButtons();
        updateTimerUI(); drawTrack();
        // Re-position buttons (mouse may still be over the new last box)
        positionTrackOverlayForLast();
        persist();
        uiSoftClick();
      }
      function addIntervalWithMinutes(mins){
        if(!canAddInterval()) return;
        const m = clamp(Math.floor(mins), 5, 240);
        if(!Number.isFinite(m) || m < 5) return;
        const newIdx = TOTAL_SESSIONS;       // 0-based index of the new session
        // Ensure override arrays are long enough
        if(!Array.isArray(state.sessionLengthOverrides)) state.sessionLengthOverrides = [];
        while(state.sessionLengthOverrides.length < newIdx) state.sessionLengthOverrides.push(null);
        state.sessionLengthOverrides[newIdx] = m;
        // The new break BETWEEN the previous last session and the new one uses the template's
        // rhythm (odd/even/big based on its index) — we just leave breakLengthOverrides null for it.
        state.totalSessionsOverride = TOTAL_SESSIONS + 1;
        recomputeTotalSessions();
        reconcileSessionArrays();
        // If we were idle and pointing at the END (done), re-seed phase to idle/next
        if(state.phase === "done"){
          state.phase = "idle";
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = effectiveLearnSec(i);
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
        } else if(state.phase === "idle"){
          // refresh timeLeft for the upcoming phase (might be the new break / session)
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = effectiveLearnSec(i);
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
        }
        hideTrackOverlayButtons();
        updateTimerUI(); drawTrack();
        positionTrackOverlayForLast();
        persist();
        uiSave();
      }

      // ── Interval-length prompt modal (used by the "+" track button) ──
      const intervalPromptDom = {
        modal:  document.getElementById("intervalPromptModal"),
        input:  document.getElementById("intervalPromptInput"),
        ok:     document.getElementById("intervalPromptOk"),
        cancel: document.getElementById("intervalPromptCancel"),
      };
      function openIntervalPrompt(){
        if(!intervalPromptDom.modal) return;
        intervalPromptDom.input.value = String(state.settings.learn_min || 30);
        intervalPromptDom.modal.classList.add("show");
        intervalPromptDom.modal.setAttribute("aria-hidden", "false");
        setTimeout(() => { try{ intervalPromptDom.input.focus(); intervalPromptDom.input.select(); }catch(_){} }, 50);
      }
      function closeIntervalPrompt(){
        if(!intervalPromptDom.modal) return;
        intervalPromptDom.modal.classList.remove("show");
        intervalPromptDom.modal.setAttribute("aria-hidden", "true");
      }
      function bindTrackOverlayEvents(){
        if(trackOverlay.removeBtn){
          trackOverlay.removeBtn.addEventListener("mouseenter", cancelHideTrackButtons);
          trackOverlay.removeBtn.addEventListener("mouseleave", scheduleHideTrackButtons);
          trackOverlay.removeBtn.addEventListener("click", removeLastInterval);
        }
        if(trackOverlay.addBtn){
          trackOverlay.addBtn.addEventListener("mouseenter", cancelHideTrackButtons);
          trackOverlay.addBtn.addEventListener("mouseleave", scheduleHideTrackButtons);
          trackOverlay.addBtn.addEventListener("click", () => {
            cancelHideTrackButtons();
            openIntervalPrompt();
          });
        }
        if(intervalPromptDom.ok) intervalPromptDom.ok.addEventListener("click", () => {
          const v = parseInt(intervalPromptDom.input.value, 10);
          if(Number.isFinite(v) && v >= 5){
            addIntervalWithMinutes(v);
            closeIntervalPrompt();
          } else {
            uiError();
          }
        });
        if(intervalPromptDom.cancel) intervalPromptDom.cancel.addEventListener("click", closeIntervalPrompt);
        if(intervalPromptDom.input) intervalPromptDom.input.addEventListener("keydown", (e) => {
          if(e.key === "Enter"){ e.preventDefault(); intervalPromptDom.ok && intervalPromptDom.ok.click(); }
          else if(e.key === "Escape"){ e.preventDefault(); closeIntervalPrompt(); }
        });
        if(intervalPromptDom.modal) intervalPromptDom.modal.addEventListener("click", (e) => {
          if(e.target === intervalPromptDom.modal) closeIntervalPrompt();
        });
      }
      function markDone(kind, idx){
        if(kind === "session"){
          state.sessionsDone[idx] = true; state.sessionIdx = idx;
          recordSession(effectiveLearnMin(idx));
          carryOverTasks(idx);
        } else {
          state.breaksDone[idx] = true;
        }
        if(state.sessionsDone.every(Boolean)){ state.phase = "done"; state.timeLeft = 0; state.running = false; stopAlarm(); showFinish(); drawTrack(); persist(); return; }
        setupNextPhase(); updateTimerUI(); drawTrack(); persist();
      }
      function unmarkDone(kind, idx){
        if(kind === "session"){
          state.sessionsDone[idx] = false;
          unrecordSession(effectiveLearnMin(idx));
          // ★ Take back a pending roll IF it hasn't been used yet.
          if(state.pendingRolls > 0){
            state.pendingRollBonuses.pop();
            state.pendingRolls = state.pendingRollBonuses.length;
          }
        } else {
          state.breaksDone[idx] = false;
        }
        setupNextPhase(); updateTimerUI(); drawTrack(); persist();
      }
      function updateStats(){
        const today = new Date();
        const weekMonday = new Date(today); weekMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
        const todayMin = Number(state.data[todayISO()]) || 0;
        let weekMin = 0;
        for(let d=0; d<7; d++){ const dt = new Date(weekMonday); dt.setDate(weekMonday.getDate() + d); weekMin += Number(state.data[localDateKey(dt)]) || 0; }
        const totalMin = Object.entries(state.data).filter(([k,v]) => typeof v === "number" && !k.startsWith("_") && !k.endsWith("_celebrated")).reduce((a, [,v]) => a + v, 0);
        const streak = computeStreak();
        const streakLabel = streak === 1 ? "Lern-Streak (1 Tag)" : `Lern-Streak (${streak} Tage)`;
        const cards = [["Heute", todayMin], ["Diese Woche", weekMin], ["Gesamt", totalMin], [streakLabel, null, "streak", streak]];
        // Replace children without using innerHTML
        while(dom.summaryGrid.firstChild) dom.summaryGrid.removeChild(dom.summaryGrid.firstChild);
        const frag = document.createDocumentFragment();
        for(const entry of cards){
          const [label, mins, kind, streakCount] = entry;
          const wrap = document.createElement("div"); wrap.className = "summaryCardOuter";
          const card = document.createElement("div"); card.className = "summaryCard";
          let val;
          if(kind === "streak"){
            val = streakCount > 0 ? `🔥 ${streakCount}` : "—";
          }else{
            const h = Math.floor(mins / 60), m = mins % 60;
            val = mins ? (h ? `${h}h ${String(m).padStart(2,"0")}m` : `${m}m`) : "—";
          }
          const valDiv = document.createElement("div"); valDiv.className = "summaryVal"; valDiv.textContent = val;
          const lblDiv = document.createElement("div"); lblDiv.className = "summaryLbl"; lblDiv.textContent = label;
          card.appendChild(valDiv); card.appendChild(lblDiv);
          wrap.appendChild(card); frag.appendChild(wrap);
        }
        dom.summaryGrid.appendChild(frag);
      }
      function heatColor(minutes){ const heat = state.theme === "light" ? HEAT_LIGHT : HEAT_DARK; if(minutes <= 0) return heat[0]; if(minutes < 60) return heat[1]; if(minutes < 120) return heat[2]; if(minutes < 180) return heat[3]; if(minutes < 240) return heat[4]; return heat[5]; }
      function drawHeatmap(){
        const canvas = dom.heatCanvas, ctx = ctxHeat, W = canvas.width, H = canvas.height;
        ctx.clearRect(0,0,W,H);
        const s = getComputedStyle(document.body), textDim = s.getPropertyValue("--text-dim").trim(), text = s.getPropertyValue("--text").trim(), cardBorder = s.getPropertyValue("--card-border").trim();
        const CELL = 13, PITCH = 15, LM = 30, TM = 22;
        const today = new Date(); const weekMonday = new Date(today); weekMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7)); const startMonday = new Date(weekMonday); startMonday.setDate(weekMonday.getDate() - 7*52);
        const cells = [];
        for(let d = new Date(startMonday); d <= today; d.setDate(d.getDate() + 1)){
          const week = Math.floor((d - startMonday) / (7*24*3600*1000));
          const row = (d.getDay() + 6) % 7;
          cells.push({date:new Date(d), col:week, row});
        }
        const rows = ["Mo","","Mi","","Fr","","So"];
        ctx.fillStyle = textDim;
        rows.forEach((r, idx) => { if(r){ ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillText(r, LM - 6, TM + idx * PITCH + CELL/2); } });
        const seenMonths = new Set();
        for(const cell of cells){
          const d = cell.date;
          if(cell.row === 0 && !seenMonths.has(d.getMonth())){
            const monthNames = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];
            ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = textDim; ctx.fillText(monthNames[d.getMonth()], LM + cell.col * PITCH, TM - 8);
            seenMonths.add(d.getMonth());
          }
        }
        const cellMap = [];
        for(const cell of cells){
          const d = cell.date, mins = Number(state.data[localDateKey(d)]) || 0, x1 = LM + cell.col * PITCH, y1 = TM + cell.row * PITCH;
          ctx.fillStyle = heatColor(mins); ctx.fillRect(x1, y1, CELL, CELL); ctx.strokeStyle = cardBorder; ctx.lineWidth = 1; ctx.strokeRect(x1 + 0.5, y1 + 0.5, CELL - 1, CELL - 1);
          cellMap.push({x1,y1,x2:x1+CELL,y2:y1+CELL,date:d,mins});
        }
        const todayCell = cells.find(c => localDateKey(c.date) === todayISO());
        if(todayCell){ const x1 = LM + todayCell.col * PITCH, y1 = TM + todayCell.row * PITCH; ctx.strokeStyle = text; ctx.lineWidth = 2; ctx.strokeRect(x1 - 0.5, y1 - 0.5, CELL + 1, CELL + 1); }
        canvas._heatCells = cellMap;
      }
      function drawHeatTooltip(ev){
        const cells = dom.heatCanvas._heatCells || [];
        const rect = dom.heatCanvas.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (dom.heatCanvas.width / rect.width), y = (ev.clientY - rect.top) * (dom.heatCanvas.height / rect.height);
        const cell = cells.find(c => x >= c.x1 && x <= c.x2 && y >= c.y1 && y <= c.y2);
        if(!cell){ hideTooltip(); return; }
        const d = cell.date, h = Math.floor(cell.mins / 60), m = cell.mins % 60;
        const timeStr = cell.mins > 0 ? `${h}h ${String(m).padStart(2,"0")}m gelernt` : "Nicht gelernt";
        const label = `${d.getDate()}. ${["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"][d.getMonth()]} ${d.getFullYear()} — ${timeStr}`;
        setTooltip(label, ev.clientX + 14, ev.clientY - 10);
      }
      function updateSettingsView(){
        const s = state.settings;
        if(dom.learnNum) dom.learnNum.textContent = s.learn_min;
        if(dom.oddNum) dom.oddNum.textContent = s.break_odd_min;
        if(dom.evenNum) dom.evenNum.textContent = s.break_even_min;
        if(dom.bigAfterNum) dom.bigAfterNum.textContent = s.big_break_after;
        if(dom.bigMinNum) dom.bigMinNum.textContent = s.big_break_min;
        if(dom.intervalsNum) dom.intervalsNum.textContent = TOTAL_SESSIONS;
        if(dom.intervalsExplain){
          const goalMin = computeGoalMin(s);
          const raw = Math.max(1, Math.round(goalMin / Math.max(1, s.learn_min)));
          dom.intervalsExplain.textContent = raw > MAX_SESSIONS
            ? `${goalMin} Min ÷ ${s.learn_min} Min ≈ ${raw} (begrenzt auf ${MAX_SESSIONS})`
            : `${goalMin} Min ÷ ${s.learn_min} Min = ${TOTAL_SESSIONS}`;
        }
        // Goal input + unit toggle
        if(dom.goalInput && document.activeElement !== dom.goalInput){
          dom.goalInput.value = String(s.goal_value);
        }
        if(dom.goalUnitToggle){
          dom.goalUnitToggle.querySelectorAll("button").forEach(b => {
            b.classList.toggle("active", b.dataset.unit === s.goal_unit);
          });
        }
        // Big break toggle + disabled state for sub-rows
        if(dom.bigBreakToggle){
          dom.bigBreakToggle.setAttribute("aria-pressed", String(!!s.big_break_enabled));
        }
        if(dom.bigBreakRowAfter) dom.bigBreakRowAfter.classList.toggle("disabled", !s.big_break_enabled);
        if(dom.bigBreakRowMin) dom.bigBreakRowMin.classList.toggle("disabled", !s.big_break_enabled);
        // Total info note
        const totalMin = TOTAL_SESSIONS * s.learn_min, h = Math.floor(totalMin / 60), m = totalMin % 60;
        const goalMin = computeGoalMin(s);
        const goalStr = formatGoalLabel(s);
        const diff = totalMin - goalMin;
        const note = diff === 0 ? `= ${goalStr}-Tagesziel` : (diff < 0 ? `(${-diff} Min unter dem ${goalStr}-Ziel)` : `(${diff} Min über dem ${goalStr}-Ziel)`);
        if(dom.totalInfo) dom.totalInfo.textContent = `${TOTAL_SESSIONS} Einheiten ergeben ${h}h ${String(m).padStart(2,"0")}m Lernzeit  ${note}`;
      }
      function saveSettings(){
        dom.savedMsg.textContent = "✓ Einstellungen gespeichert";
        uiSave();
        persist(); updateTimerUI(); drawTrack(); drawHeatmap();
        setTimeout(() => { dom.savedMsg.textContent = ""; }, 2500);
      }
      function resetDefaults(){
        state.settings = deepClone(DEFAULT_SETTINGS);
        recomputeTotalSessions();
        reconcileSessionArrays();
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = state.settings.learn_min * 60;
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
        }
        updateSettingsView(); updateTimerUI(); drawTrack(); drawHeatmap();
        uiSoftClick();
        persist();
      }
      function openResetConfirm(){
        uiSoftClick();
        dom.confirmResetModal.classList.add("show");
        dom.confirmResetModal.setAttribute("aria-hidden", "false");
      }
      function closeResetConfirm(){
        dom.confirmResetModal.classList.remove("show");
        dom.confirmResetModal.setAttribute("aria-hidden", "true");
      }
      function performProgressReset(){
        // Stop anything running
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        workerStop(); tickAnchor = null;
        stopAlarm();
        // Wipe all progress fields, keep settings + theme + soundEnabled
        state.data = {};
        state.sessionIdx = 0;
        state.phase = "idle";
        state.timeLeft = state.settings.learn_min * 60;
        state.sessionsDone = Array(TOTAL_SESSIONS).fill(false);
        state.breaksDone = Array(TOTAL_SESSIONS - 1).fill(false);
        state.curBreak = -1;
        state.running = false;
        state.alarmActive = false;
        state.points = 0;
        state.pendingRolls = 0;
        state.pendingRollBonuses = [];
        state.diceStreak = 0;
        state.intervalTasks = {};
        state.completedHistory = [];
        state.diceTimerLeft = DICE_TIMER_TOTAL_SEC;
        state.diceLearnedTodayMin = 0;
        state.diceLastFireDay = "";
        diceTimerAnchor = null;
        // Cancel any pending task auto-removals
        for(const [id, tid] of popPendingRemoveTimers){ clearTimeout(tid); }
        popPendingRemoveTimers.clear();
        hideTaskPopover(true);
        hideDicePopover();
        // Close any open modals/overlays
        if(state.compact) toggleCompact(false);
        if(dom.finishBox) dom.finishBox.style.display = "none";
        if(dom.rewardModal && dom.rewardModal.classList.contains("show")) closeRewardModal();
        if(dom.exactModal && dom.exactModal.classList.contains("show")) closeChoiceModal(dom.exactModal);
        if(dom.oeModal && dom.oeModal.classList.contains("show")) closeChoiceModal(dom.oeModal);
        // Reset transient dice state
        diceSelection = null;
        diceRolling = false;
        // Refresh entire UI
        drawEverything();
        setTab("timer");
        setDiceMessage("Noch nicht gewürfelt.", "");
        dom.diceSmall.textContent = "Wähle Modus, tippe eine Zahl und gib deinen Einsatz ein.";
        // Visual confirmation in settings
        dom.savedMsg.textContent = "Fortschritt wurde zurückgesetzt.";
        dom.savedMsg.style.opacity = "1";
        setTimeout(() => { dom.savedMsg.style.opacity = "0"; }, 2200);
        persist();
      }
      function applySettingChange(){
        // After any setting change: recompute totals, reconcile arrays, refresh idle timer, redraw
        recomputeTotalSessions();
        reconcileSessionArrays();
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = state.settings.learn_min * 60;
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
          else if(k === null){ state.phase = "done"; state.timeLeft = 0; }
        }
        // Keep the active interval template in sync with what the user just edited.
        if(typeof syncActiveTemplateFromSettings === "function") syncActiveTemplateFromSettings();
        updateSettingsView();
        if(typeof renderTemplatesList === "function") renderTemplatesList();
        updateTimerUI();
        drawTrack();
        persist();
      }
      function renderSettingsButtons(){
        const settingsView = dom.views.settings;
        const limits = {
          learn_min: [5, 240],
          break_odd_min: [1, 120],
          break_even_min: [1, 120],
          big_break_after: [1, 50],
          big_break_min: [5, 480],
        };
        // Stepper delegation
        settingsView.addEventListener("click", (e) => {
          const btn = e.target.closest(".stepper button");
          if(!btn || !settingsView.contains(btn)) return;
          const key = btn.dataset.key;
          if(!key || !(key in limits)) return;
          // Skip clicks inside disabled big-break rows
          const row = btn.closest(".bigBreakRow");
          if(row && row.classList.contains("disabled")) return;
          const delta = parseInt(btn.dataset.delta, 10);
          const [min, max] = limits[key];
          state.settings[key] = clamp((state.settings[key] || DEFAULT_SETTINGS[key]) + delta, min, max);
          uiStepper(delta > 0);
          applySettingChange();
        });
        // Goal value input
        if(dom.goalInput){
          dom.goalInput.addEventListener("input", () => {
            const v = parseFloat(dom.goalInput.value);
            if(Number.isFinite(v) && v > 0){
              state.settings.goal_value = Math.max(1, Math.floor(v));
              applySettingChange();
            }
          });
          dom.goalInput.addEventListener("blur", () => {
            // Snap displayed value to clamped value
            updateSettingsView();
          });
        }
        // Unit toggle
        if(dom.goalUnitToggle){
          dom.goalUnitToggle.addEventListener("click", (e) => {
            const b = e.target.closest("button");
            if(!b || !b.dataset.unit) return;
            if(state.settings.goal_unit === b.dataset.unit) return;
            state.settings.goal_unit = b.dataset.unit;
            uiSoftClick();
            applySettingChange();
          });
        }
        // Big break toggle
        if(dom.bigBreakToggle){
          dom.bigBreakToggle.addEventListener("click", () => {
            state.settings.big_break_enabled = !state.settings.big_break_enabled;
            uiToggle();
            applySettingChange();
          });
        }
      }
      function setTab(name){
        // Hide task popover + track overlay buttons on tab change
        hideTaskPopover(true);
        if(typeof hideTrackOverlayButtons === "function") hideTrackOverlayButtons();
        dom.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
        Object.entries(dom.views).forEach(([k,v]) => v.classList.toggle("active", k === name));
        if(name === "stats"){ updateStats(); drawHeatmap(); }
        if(name === "dice"){ updateDiceGameUI(); refreshNeedPointsHint(); applyDiceLockState(); }
        if(name === "todo"){ renderTodoView(); }
        if(name === "settings"){
          // Always land on the Intervall-Einstellungen sub-tab when opening Settings.
          if(typeof resetSettingsSubTab === "function") resetSettingsSubTab();
          if(typeof renderTemplatesList === "function") renderTemplatesList();
        }
      }
      function toggleCompact(open){ state.compact = open; dom.compactOverlay.style.display = open ? "block" : "none"; persist(); }
      function celebrate(){ state.data[`${todayISO()}_celebrated`] = true; persist(); dom.celebrateBtn.textContent = "Heute bereits abgeschlossen ✓"; dom.celebrateBtn.disabled = true; toggleCompact(false); triggerConfetti(); }
      function triggerConfetti(){
        const host = dom.confetti; host.innerHTML = ""; host.style.display = "block";
        const count = 110;
        for(let i=0;i<count;i++){
          const p = document.createElement("div"); p.className = "particle"; p.style.left = Math.random() * 100 + "vw"; p.style.top = (-10 - Math.random() * 20) + "px"; p.style.background = CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]; p.style.borderRadius = Math.random() < 0.4 ? "50%" : "2px"; host.appendChild(p);
          const startX = (Math.random() - 0.5) * 200; const endY = window.innerHeight + 40 + Math.random() * 120; const dur = 1800 + Math.random() * 1500; const rot = Math.random() * 720 - 360;
          p.animate([{ transform:`translate(0,0) rotate(0deg)`, opacity:1 }, { transform:`translate(${startX}px, ${endY}px) rotate(${rot}deg)`, opacity:.95 }], { duration: dur, easing: "cubic-bezier(.12,.8,.2,1)", fill: "forwards" });
        }
        clearTimeout(confettiTimer);
        confettiTimer = setTimeout(() => { host.style.display = "none"; host.innerHTML = ""; }, 4200);
      }


      // ════════════════════════════════════════════════════════════
      //   REWARD DICE  (rolling for points after a session)
      // ════════════════════════════════════════════════════════════
      function showDiceFace(dieEl, value){
        const faces = {
          1: ["c"], 2: ["tl","br"], 3: ["tl","c","br"],
          4: ["tl","tr","bl","br"], 5: ["tl","tr","c","bl","br"],
          6: ["tl","tr","ml","mr","bl","br"]
        };
        const pips = dieEl.querySelectorAll(".pip");
        pips.forEach(p => p.classList.remove("show"));
        (faces[value] || []).forEach(cls => {
          const p = dieEl.querySelector("." + cls);
          if(p) p.classList.add("show");
        });
      }
      function describeNextRollBonuses(){
        const next = state.pendingRollBonuses[0];
        if(!next || (!next.streak && !next.surpass)) return "";
        const tags = [];
        if(next.streak) tags.push("🔥 Streak ×2");
        if(next.surpass) tags.push("📈 Übertroffen ×2");
        return tags.join("  ·  ");
      }
      function openRewardModal(){
        if(state.pendingRolls <= 0){
          // No pending rolls — show info
          dom.rewardSub.textContent = "Schließe eine Lerneinheit ab, um zu würfeln.";
          dom.rewardRolls.textContent = "Verbleibende Würfe: 0";
          dom.rewardEarned.textContent = `Aktuelle Punkte: ${state.points}`;
          dom.rewardEarned.classList.remove("big");
          dom.rewardRollBtn.disabled = true;
          rewardSessionEarned = 0;
        }else{
          dom.rewardSub.textContent = "Würfle für deine Punkte!";
          dom.rewardRolls.textContent = `Verbleibende Würfe: ${state.pendingRolls}`;
          dom.rewardEarned.textContent = "\u00A0";
          dom.rewardEarned.classList.remove("big");
          dom.rewardRollBtn.disabled = false;
          rewardSessionEarned = 0;
        }
        // Override behavior if learning active or with active bonuses
        if(isLearningActive()){
          dom.rewardSub.textContent = "W\u00E4hrend eines Lernintervalls gesperrt.";
          dom.rewardRolls.textContent = `Verbleibende W\u00FCrfe: ${state.pendingRolls}`;
          dom.rewardEarned.textContent = "Pausiere oder beende die Lerneinheit, um zu w\u00FCrfeln.";
          dom.rewardEarned.classList.remove("big");
          dom.rewardRollBtn.disabled = true;
        }else if(state.pendingRolls > 0){
          const bonusStr = describeNextRollBonuses();
          if(bonusStr) dom.rewardSub.textContent = "Bonus aktiv: " + bonusStr;
        }
        showDiceFace(dom.rewardDie, 1);
        dom.rewardModal.classList.add("show");
        dom.rewardModal.setAttribute("aria-hidden", "false");
        diceGameClick();
      }
      function closeRewardModal(){
        dom.rewardModal.classList.remove("show");
        dom.rewardModal.setAttribute("aria-hidden", "true");
        rewardRolling = false;
        diceClose();
      }
      function rollRewardDice(){
        if(rewardRolling) return;
        if(state.pendingRolls <= 0) return;
        if(isLearningActive()){
          dom.rewardSub.textContent = "Während eines Lernintervalls gesperrt.";
          dom.rewardRollBtn.disabled = true;
          uiError();
          return;
        }
        rewardRolling = true;
        dom.rewardRollBtn.disabled = true;
        dom.rewardCloseBtn.disabled = true;
        dom.rewardEarned.textContent = " ";
        rewardRollStart();
        dom.rewardDie.classList.remove("rolling");
        void dom.rewardDie.offsetWidth;
        dom.rewardDie.classList.add("rolling");
        // Clean up the rolling class once the keyframe animation (800 ms) has finished, so
        // re-showing the modal later does NOT replay the animation automatically.
        setTimeout(() => dom.rewardDie.classList.remove("rolling"), 850);
        let count = 0;
        const interval = setInterval(() => {
          showDiceFace(dom.rewardDie, Math.floor(Math.random() * 6) + 1);
          count++;
          if(count >= 8){
            clearInterval(interval);
            const result = Math.floor(Math.random() * 6) + 1;
            showDiceFace(dom.rewardDie, result);
            setTimeout(() => {
              rewardLand(result);
              // Consume the current roll's bonuses (if any). Re-roll on original 6 keeps a fresh, no-bonus slot.
              const bonus = state.pendingRollBonuses.shift() || { streak:false, surpass:false };
              state.pendingRolls = state.pendingRollBonuses.length;
              const bonusRoll = result === 6; // ★ based on RAW result, not multiplied
              let multiplier = 1;
              if(bonus.streak) multiplier *= 2;
              if(bonus.surpass) multiplier *= 2;
              const earned = result * multiplier;
              if(bonusRoll){
                // Refund a roll without bonuses for the re-roll
                state.pendingRollBonuses.unshift({ streak:false, surpass:false });
                state.pendingRolls = state.pendingRollBonuses.length;
              }
              state.points += earned;
              rewardSessionEarned += earned;
              updateRewardBadge();
              updatePointsDisplay();
              persist();
              dom.rewardRolls.textContent = `Verbleibende Würfe: ${state.pendingRolls}`;
              const bonusInfo = (multiplier > 1)
                ? ` (Würfel ${result} ×${multiplier})`
                : "";
              if(rewardSessionEarned > 0){
                dom.rewardEarned.classList.add("big");
                dom.rewardEarned.textContent = bonusRoll
                  ? `+${earned} Punkte${bonusInfo}  →  Gesamt: ${state.points} · Wurf zurück!`
                  : `+${earned} Punkte${bonusInfo}  →  Gesamt: ${state.points}`;
              }
              if(bonusRoll){
                dom.rewardSub.textContent = "6 gewürfelt — du bekommst den Wurf zurück!";
                dom.rewardRollBtn.disabled = false;
              }else if(state.pendingRolls <= 0){
                dom.rewardRollBtn.disabled = true;
                dom.rewardSub.textContent = "Alle Würfe verbraucht. Lerne weiter, um neue zu sammeln!";
              }else{
                // Show next bonus info if there's another bonus-laden roll queued
                const nextBonus = describeNextRollBonuses();
                dom.rewardSub.textContent = nextBonus ? ("Nächster Bonus: " + nextBonus) : "Würfle für deine Punkte!";
                dom.rewardRollBtn.disabled = false;
              }
              dom.rewardCloseBtn.disabled = false;
              rewardRolling = false;
            }, 120);
          }
        }, 80);
      }

      // ════════════════════════════════════════════════════════════
      //   DICE GAME  (Würfelspiel tab)
      // ════════════════════════════════════════════════════════════
      function getDiceMultiplier(){
        const b = DICE_BALANCE[diceGameMode];
        const bonus = Math.min(state.diceStreak, 5) * b.streakBonus;
        return b.base * (1 + bonus);
      }
      function getDiceBonusPct(){
        const b = DICE_BALANCE[diceGameMode];
        return Math.min(state.diceStreak, 5) * b.streakBonus * 100;
      }
      function setDiceMessage(text, type = ""){
        dom.diceMessage.textContent = text;
        dom.diceMessage.className = "diceMessage" + (type ? " " + type : "");
      }
      function clearDiceHighlight(){ dom.gameDie.classList.remove("evenHl", "oddHl"); }
      function resetDiceSelection(){
        diceSelection = null;
        dom.guessLabel.textContent = "Kein Tipp";
        dom.guessValue.textContent = "";
        clearDiceHighlight();
      }
      function refreshNeedPointsHint(){
        const locked = isLearningActive();
        const hasPoints = state.points > 0;
        dom.needPointsHint.style.display = hasPoints ? "none" : "block";
        if(locked){
          dom.rollGameBtn.disabled = true;
          dom.guessButton.disabled = true;
          dom.bet.disabled = true;
          return;
        }
        if(diceRolling) return; // animation manages its own state
        const disabled = !hasPoints;
        dom.rollGameBtn.disabled = disabled;
        dom.guessButton.disabled = disabled; // ★ also re-enable guess button (was sticky-disabled after game over)
        dom.bet.disabled = disabled;
      }
      function updateDiceGameUI(){
        dom.diceScore.textContent = String(state.points);
        dom.streakVal.textContent = String(state.diceStreak);
        dom.streakBox.classList.toggle("glow", state.diceStreak >= 2);

        const pct = getDiceBonusPct();
        const mult = getDiceMultiplier();

        if(diceGameMode === "exact"){
          dom.multBase.textContent = "5.4×";
          dom.diceSubtitle.textContent = "Triff die genaue Zahl → Einsatz × " + mult.toFixed(2) + " zurück.";
        }else{
          dom.multBase.textContent = "1.85×";
          dom.diceSubtitle.textContent = "Gerade oder Ungerade? → Einsatz × " + mult.toFixed(2) + " zurück.";
        }
        if(state.diceStreak > 0){
          dom.bonusTag.textContent = "+" + pct.toFixed(0) + "%";
          dom.bonusTag.classList.add("active");
          dom.streakBonus.textContent = "(×" + mult.toFixed(2) + ")";
        }else{
          dom.bonusTag.textContent = "+0%";
          dom.bonusTag.classList.remove("active");
          dom.streakBonus.textContent = "";
        }
        // Cap input to current points
        if(state.points > 0) dom.bet.max = state.points;
        refreshNeedPointsHint();
      }

      function openChoiceModal(modal){ diceGameClick(); modal.classList.add("show"); modal.setAttribute("aria-hidden", "false"); }
      function closeChoiceModal(modal){ diceClose(); modal.classList.remove("show"); modal.setAttribute("aria-hidden", "true"); }

      function validateDiceInputs(){
        const bet = Number(dom.bet.value);
        if(diceSelection === null){
          uiError(); setDiceMessage("Bitte erst einen Tipp abgeben.", "fail");
          dom.diceSmall.textContent = ""; return null;
        }
        if(!Number.isInteger(bet) || bet < 1){
          uiError(); setDiceMessage("Bitte einen gültigen Einsatz eingeben.", "fail");
          dom.diceSmall.textContent = ""; return null;
        }
        if(bet > state.points){
          uiError(); setDiceMessage("Nicht genug Punkte für diesen Einsatz.", "fail");
          dom.diceSmall.textContent = ""; return null;
        }
        return { bet };
      }

      function rollDiceGame(){
        if(isLearningActive()){
          uiError();
          setDiceMessage("Während eines Lernintervalls gesperrt.", "fail");
          dom.diceSmall.textContent = "Beende oder pausiere die Lerneinheit.";
          return;
        }
        const data = validateDiceInputs();
        if(!data) return;
        const { bet } = data;
        diceRolling = true;
        state.points -= bet;
        updateDiceGameUI();
        updatePointsDisplay();
        persist();

        dom.rollGameBtn.disabled = true;
        dom.guessButton.disabled = true;
        dom.bet.disabled = true;

        setDiceMessage("Der Würfel rollt...");
        dom.diceSmall.textContent = "";
        clearDiceHighlight();

        diceRollStart();
        dom.gameDie.classList.remove("rolling");
        void dom.gameDie.offsetWidth;
        dom.gameDie.classList.add("rolling");
        // Strip the rolling class after the keyframe finishes (see comment in rollRewardDice).
        setTimeout(() => dom.gameDie.classList.remove("rolling"), 850);

        let count = 0;
        const interval = setInterval(() => {
          showDiceFace(dom.gameDie, Math.floor(Math.random() * 6) + 1);
          diceTickRoll();
          count++;
          if(count >= 10){
            clearInterval(interval);
            const result = Math.floor(Math.random() * 6) + 1;
            showDiceFace(dom.gameDie, result);
            setTimeout(() => {
              diceLand();
              setTimeout(() => {
                let won = false;
                if(diceGameMode === "exact"){
                  won = (result === diceSelection);
                }else{
                  const isEven = result % 2 === 0;
                  won = (diceSelection === "even" && isEven) || (diceSelection === "odd" && !isEven);
                }
                // Restore odd/even highlight visually
                if(diceGameMode === "oe"){
                  if(diceSelection === "even") dom.gameDie.classList.add("evenHl");
                  else if(diceSelection === "odd") dom.gameDie.classList.add("oddHl");
                }

                if(won){
                  const mult = getDiceMultiplier();
                  const prevStreak = state.diceStreak;
                  state.diceStreak++;
                  const winnings = Math.round(bet * mult);
                  state.points += winnings;
                  updateDiceGameUI();
                  updatePointsDisplay();
                  persist();
                  diceWin(state.diceStreak > 1);
                  if(state.diceStreak > 1){
                    diceStreakUp();
                    dom.streakBox.classList.add("streak-pop");
                    setTimeout(() => dom.streakBox.classList.remove("streak-pop"), 400);
                    setDiceMessage(`🔥 Streak ×${state.diceStreak}! Gewürfelt: ${result}`, "success");
                    dom.diceSmall.textContent = `+${winnings} Punkte (×${mult.toFixed(2)} wegen Streak ${prevStreak}→${state.diceStreak})`;
                  }else{
                    setDiceMessage(`Gewonnen! Gewürfelt: ${result}`, "success");
                    dom.diceSmall.textContent = `+${winnings} Punkte (×${mult.toFixed(2)})`;
                  }
                }else{
                  state.diceStreak = 0;
                  updateDiceGameUI();
                  persist();
                  diceLose();
                  const modeName = diceGameMode === "exact" ? String(diceSelection) : (diceSelection === "even" ? "Gerade" : "Ungerade");
                  setDiceMessage(`Verloren. Gewürfelt: ${result}`, "fail");
                  dom.diceSmall.textContent = `Tipp war ${modeName}. Einsatz (${bet}) weg. Streak auf 0.`;
                }
                diceRolling = false;

                if(state.points <= 0){
                  state.points = 0;
                  state.diceStreak = 0;
                  updateDiceGameUI();
                  updatePointsDisplay();
                  persist();
                  setTimeout(diceGameOver, 380);
                  dom.rollGameBtn.disabled = true;
                  dom.guessButton.disabled = true;
                  dom.bet.disabled = true;
                  dom.restartBtn.style.display = "none";
                  setDiceMessage("Game Over 💀", "fail");
                  dom.diceSmall.textContent = "Sammle neue Punkte über den Belohnungs-Würfel.";
                  refreshNeedPointsHint();
                }else{
                  dom.rollGameBtn.disabled = false;
                  dom.guessButton.disabled = false;
                  dom.bet.disabled = false;
                  dom.bet.max = state.points;
                }
              }, 150);
            }, 80);
          }
        }, 80);
      }

      function bindDiceGameEvents(){
        dom.modeExact.addEventListener("click", () => {
          if(diceRolling) return;
          diceGameClick();
          diceGameMode = "exact";
          dom.modeExact.classList.add("active");
          dom.modeOE.classList.remove("active");
          resetDiceSelection();
          updateDiceGameUI();
          setDiceMessage("Modus: Exakt. Wähle eine Zahl.", "");
          dom.diceSmall.textContent = "Klicke auf den Tipp-Button und wähle eine Zahl 1–6.";
        });
        dom.modeOE.addEventListener("click", () => {
          if(diceRolling) return;
          diceGameClick();
          diceGameMode = "oe";
          dom.modeOE.classList.add("active");
          dom.modeExact.classList.remove("active");
          resetDiceSelection();
          updateDiceGameUI();
          setDiceMessage("Modus: Gerade / Ungerade. Wähle deine Seite.", "");
          dom.diceSmall.textContent = "Klicke auf den Tipp-Button und wähle Gerade oder Ungerade.";
        });
        dom.guessButton.addEventListener("click", () => {
          if(diceRolling) return;
          if(state.points <= 0){ uiError(); return; }
          if(diceGameMode === "exact") openChoiceModal(dom.exactModal);
          else openChoiceModal(dom.oeModal);
        });
        dom.closeExact.addEventListener("click", () => closeChoiceModal(dom.exactModal));
        dom.closeOE.addEventListener("click", () => closeChoiceModal(dom.oeModal));
        dom.exactModal.addEventListener("click", e => { if(e.target === dom.exactModal) closeChoiceModal(dom.exactModal); });
        dom.oeModal.addEventListener("click", e => { if(e.target === dom.oeModal) closeChoiceModal(dom.oeModal); });

        // Event delegation for dice options (1-6) and odd/even
        dom.exactModal.addEventListener("click", (e) => {
          const btn = e.target.closest(".diceOption");
          if(!btn) return;
          diceSelection = Number(btn.dataset.value);
          diceSelect();
          dom.guessLabel.textContent = "Gewählt:";
          dom.guessValue.textContent = "⚀⚁⚂⚃⚄⚅".charAt(diceSelection - 1) + " (" + diceSelection + ")";
          clearDiceHighlight();
          closeChoiceModal(dom.exactModal);
          setDiceMessage("Tipp: " + diceSelection + ". Jetzt Einsatz eingeben.", "");
          dom.diceSmall.textContent = "Multiplikator bei Gewinn: ×" + getDiceMultiplier().toFixed(2);
        });
        dom.oeModal.addEventListener("click", (e) => {
          const btn = e.target.closest(".oeOption");
          if(!btn) return;
          diceSelection = btn.dataset.value;
          diceSelect();
          if(diceSelection === "even"){
            dom.guessLabel.textContent = "Gewählt:";
            dom.guessValue.textContent = "Gerade (2·4·6)";
            dom.gameDie.classList.remove("oddHl");
            dom.gameDie.classList.add("evenHl");
          }else{
            dom.guessLabel.textContent = "Gewählt:";
            dom.guessValue.textContent = "Ungerade (1·3·5)";
            dom.gameDie.classList.remove("evenHl");
            dom.gameDie.classList.add("oddHl");
          }
          closeChoiceModal(dom.oeModal);
          setDiceMessage("Tipp: " + (diceSelection === "even" ? "Gerade" : "Ungerade") + ". Einsatz eingeben.", "");
          dom.diceSmall.textContent = "Multiplikator bei Gewinn: ×" + getDiceMultiplier().toFixed(2);
        });
        dom.rollGameBtn.addEventListener("click", rollDiceGame);
        dom.restartBtn.addEventListener("click", () => {
          state.diceStreak = 0;
          resetDiceSelection();
          updateDiceGameUI();
          persist();
          dom.restartBtn.style.display = "none";
          dom.bet.value = "";
          setDiceMessage("Streak zurückgesetzt. Wähle neuen Tipp.", "");
          dom.diceSmall.textContent = "";
          showDiceFace(dom.gameDie, 1);
          uiSoftClick();
        });
      }

      // ════════════════════════════════════════════════════════════
      //   INIT + GLOBAL EVENT BINDINGS
      // ════════════════════════════════════════════════════════════
      function drawEverything(){
        document.body.classList.toggle("light", state.theme === "light");
        dom.themeBtn.textContent = state.theme === "light" ? "☾" : "☀";
        dom.soundBtn.textContent = state.soundEnabled ? "🔊" : "🔇";
        renderLegends(); updateSettingsView(); updateTimerUI(); drawTrack(); updateStats(); drawHeatmap();
        updateDiceGameUI();
        updateCompactStar();
        if(typeof renderAvatarsEverywhere === "function") renderAvatarsEverywhere();
        // initialize dice faces
        showDiceFace(dom.gameDie, 1);
        showDiceFace(dom.rewardDie, 1);
      }
      // One-time setup: event listeners, initial render. Runs once even across logins.
      function init(){
        renderSettingsButtons();
        bindDiceGameEvents();
        bindTemplateListEvents();
        bindSubTabSwitch();
        bindQuestionnaireEvents();
        bindUsernameRequiredModal();
        bindProfileUsernameEvents();
        bindAvatarPicker();
        bindEmailChangeEvents();
        bindPasswordChangeEvents();
        applyLoadedState();
        appBootstrapped = true;
      }
      // Re-render UI + resume timers based on current `state`. Called after cloud-load and after logout.
      function applyLoadedState(){
        // Stop anything that may still be running from a previous session
        workerStop(); diceTrackingStop(); stopAlarm();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        // Ensure at least one template exists; auto-create "Standard" from current settings if needed.
        ensureAtLeastOneTemplate();
        recomputeTotalSessions();
        reconcileSessionArrays();
        updateDataFromToday();
        updateSettingsView();
        renderTemplatesList();
        drawEverything();
        setTab("timer");
        if(state.compact) toggleCompact(true); else toggleCompact(false);
        if(state.alarmActive) startAlarm();
        if(state.running && state.phase !== "done"){
          startTickAnchor();
          workerStart();
          if(state.phase === "learning") diceTrackingStart();
        }
        if(dom.finishBox) dom.finishBox.style.display = state.phase === "done" ? "flex" : "none";
        setDiceMessage("Noch nicht gewürfelt.", "");
        if(dom.diceSmall) dom.diceSmall.textContent = "Wähle Modus, tippe eine Zahl und gib deinen Einsatz ein.";
      }

      // Theme + sound buttons
      dom.themeBtn.addEventListener("click", () => {
        state.theme = state.theme === "dark" ? "light" : "dark";
        uiToggle();
        drawEverything();
        persist();
      });
      dom.soundBtn.addEventListener("click", () => {
        state.soundEnabled = !state.soundEnabled;
        dom.soundBtn.textContent = state.soundEnabled ? "🔊" : "🔇";
        if(state.soundEnabled) uiSoftClick(); // confirmation tick when re-enabled
        persist();
      });

      // Tabs
      dom.tabs.forEach(btn => btn.addEventListener("click", () => { uiTabSwitch(); setTab(btn.dataset.tab); }));

      // Timer buttons
      dom.startBtn.addEventListener("click", () => { uiSoftClick(); startOrPause(); });
      dom.skipBtn.addEventListener("click", () => { uiSoftClick(); skipPhase(); });
      dom.resetBtn.addEventListener("click", () => { uiSoftClick(); resetCurrentInterval(); });
      dom.celebrateBtn.addEventListener("click", () => { uiSave(); celebrate(); });

      // Compact mode
      dom.compactOpen.addEventListener("click", () => { uiSoftClick(); toggleCompact(true); });
      dom.compactExit.addEventListener("click", () => { uiSoftClick(); toggleCompact(false); });
      dom.compactClose.addEventListener("click", () => { uiSoftClick(); toggleCompact(false); });
      dom.compactToggle.addEventListener("click", () => { uiSoftClick(); startOrPause(); });
      dom.compactWin.addEventListener("mousedown", (e) => { compactDragging = true; const r = dom.compactWin.getBoundingClientRect(); dragOffset.x = e.clientX - r.left; dragOffset.y = e.clientY - r.top; }, { passive: true });
      // Drag uses rAF to avoid layout thrashing on every mousemove
      let dragRAF = 0, dragX = 0, dragY = 0;
      window.addEventListener("mousemove", (e) => {
        if(!compactDragging) return;
        dragX = e.clientX; dragY = e.clientY;
        if(dragRAF) return;
        dragRAF = requestAnimationFrame(() => {
          dragRAF = 0;
          const w = dom.compactWin.offsetWidth, h = dom.compactWin.offsetHeight;
          const x = clamp(dragX - dragOffset.x, 0, window.innerWidth - w);
          const y = clamp(dragY - dragOffset.y, 0, window.innerHeight - h);
          dom.compactWin.style.transform = "translate(" + x + "px," + y + "px)";
          dom.compactWin.style.left = "0";
          dom.compactWin.style.top = "0";
        });
      }, { passive: true });
      window.addEventListener("mouseup", () => compactDragging = false, { passive: true });

      // Track + heatmap (passive: pure read, no preventDefault)
      dom.trackCanvas.style.cursor = "default";
      dom.trackCanvas.addEventListener("mousemove", handleTrackMove, { passive: true });
      dom.trackCanvas.addEventListener("mouseleave", () => { hideTooltip(); schedulePopHide(); scheduleHideTrackButtons(); }, { passive: true });
      // Add/remove track overlay buttons + interval-prompt modal
      bindTrackOverlayEvents();
      // Note: click-to-complete on intervals/breaks is intentionally disabled.
      // Intervals can only be ended by the timer running out (or via the /skip command).
      dom.heatCanvas.addEventListener("mousemove", drawHeatTooltip, { passive: true });
      dom.heatCanvas.addEventListener("mouseleave", hideTooltip, { passive: true });

      // Task popover wiring
      dom.taskPopover.addEventListener("mouseenter", () => { popPinned = true; clearPopHide(); });
      dom.taskPopover.addEventListener("mouseleave", () => { popPinned = false; schedulePopHide(); });
      // Add task
      function submitNewTask(){
        if(popHoveredSessionIdx < 0) return;
        const txt = dom.taskInput.value;
        if(addTask(popHoveredSessionIdx, txt)){
          dom.taskInput.value = "";
          renderTaskPopover();
          uiSoftClick();
        } else {
          uiError();
        }
        dom.taskInput.focus();
      }
      dom.taskAddBtn.addEventListener("click", submitNewTask);
      dom.taskInput.addEventListener("keydown", (e) => {
        if(e.key === "Enter"){ e.preventDefault(); submitNewTask(); }
        else if(e.key === "Escape"){ dom.taskInput.blur(); hideTaskPopover(); }
      });
      dom.taskInput.addEventListener("focus", () => { popPinned = true; clearPopHide(); });
      // Delegate clicks on toggle / delete inside the list
      dom.taskList.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if(!btn) return;
        const taskId = btn.dataset.taskId;
        const sessionIdx = popHoveredSessionIdx;
        if(sessionIdx < 0 || !taskId) return;
        if(btn.dataset.action === "toggle"){
          const list = getTaskList(sessionIdx);
          const t = list.find(x => x.id === taskId);
          if(!t) return;
          if(t.done){
            // Un-check: cancel scheduled removal, refresh
            cancelTaskRemoval(taskId);
            setTaskDone(sessionIdx, taskId, false);
            renderTaskPopover();
            uiSoftClick();
          } else {
            setTaskDone(sessionIdx, taskId, true);
            renderTaskPopover();
            uiSave();
            scheduleTaskRemoval(sessionIdx, taskId);
          }
        } else if(btn.dataset.action === "delete"){
          cancelTaskRemoval(taskId);
          removeTaskById(sessionIdx, taskId);
          renderTaskPopover();
          uiSoftClick();
        } else if(btn.dataset.action === "star"){
          if(btn.disabled) return;
          const list = getTaskList(sessionIdx);
          const t = list.find(x => x.id === taskId);
          if(!t) return;
          setTaskStar(sessionIdx, taskId, !t.star);
          renderTaskPopover();
          updateCompactStar();
          uiSoftClick();
        }
      });
      // Drag-and-drop reordering for tasks (HTML5 DnD)
      let dragSrcId = null;
      dom.taskList.addEventListener("dragstart", (e) => {
        const li = e.target.closest(".taskItem");
        if(!li || !li.draggable){ e.preventDefault(); return; }
        dragSrcId = li.dataset.taskId;
        li.classList.add("dragging");
        try{ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragSrcId); }catch(_){}
      });
      dom.taskList.addEventListener("dragend", (e) => {
        const li = e.target.closest(".taskItem");
        if(li) li.classList.remove("dragging");
        dom.taskList.querySelectorAll(".dropTarget").forEach(n => n.classList.remove("dropTarget"));
        dragSrcId = null;
      });
      dom.taskList.addEventListener("dragover", (e) => {
        if(!dragSrcId) return;
        const li = e.target.closest(".taskItem");
        if(!li || li.dataset.taskId === dragSrcId) return;
        if(li.classList.contains("starred")) return;
        e.preventDefault();
        try{ e.dataTransfer.dropEffect = "move"; }catch(_){}
        dom.taskList.querySelectorAll(".dropTarget").forEach(n => { if(n !== li) n.classList.remove("dropTarget"); });
        li.classList.add("dropTarget");
      });
      dom.taskList.addEventListener("dragleave", (e) => {
        const li = e.target.closest(".taskItem");
        if(li) li.classList.remove("dropTarget");
      });
      dom.taskList.addEventListener("drop", (e) => {
        e.preventDefault();
        if(!dragSrcId) return;
        const li = e.target.closest(".taskItem");
        if(!li || li.dataset.taskId === dragSrcId || li.classList.contains("starred")) return;
        const destId = li.dataset.taskId;
        const sessionIdx = popHoveredSessionIdx;
        if(sessionIdx >= 0 && reorderTasks(sessionIdx, dragSrcId, destId)){
          renderTaskPopover();
          uiSoftClick();
        }
        dragSrcId = null;
      });
      // Close popover on Escape
      document.addEventListener("keydown", (e) => {
        if(e.key === "Escape" && dom.taskPopover.classList.contains("show")){
          if(document.activeElement === dom.taskInput){
            dom.taskInput.blur();
          }
          hideTaskPopover();
        }
      });

      // Reward dice
      dom.rewardDiceBtn.addEventListener("click", () => {
        if(isLearningActive()){ uiError(); return; }
        openRewardModal();
      });
      // Dice timer popover (hover preview of the 30-min slice)
      dom.rewardDiceBtn.addEventListener("mouseenter", showDicePopover);
      dom.rewardDiceBtn.addEventListener("mouseleave", hideDicePopover);
      dom.rewardDiceBtn.addEventListener("focus", showDicePopover);
      dom.rewardDiceBtn.addEventListener("blur", hideDicePopover);

      // ── Console commands (developer) ──
      function setCommandFeedback(msg, kind){
        dom.commandFeedback.textContent = msg || "";
        dom.commandFeedback.className = "commandFeedback" + (kind ? " " + kind : "");
      }
      function execCommand(rawText){
        const text = (rawText || "").trim();
        if(!text) return;
        if(!text.startsWith("/")){
          setCommandFeedback("Commands müssen mit / beginnen.", "err");
          uiError();
          return;
        }
        const parts = text.slice(1).split(/\s+/).filter(Boolean);
        const cmd = (parts[0] || "").toLowerCase();
        const args = parts.slice(1);
        if(cmd === "set"){
          const key = (args[0] || "").toLowerCase();
          const valStr = args[1];
          const n = parseInt(valStr, 10);
          if(!key){ setCommandFeedback("Syntax: /set <key> <zahl>", "err"); uiError(); return; }
          if(!Number.isFinite(n) || n < 0){ setCommandFeedback("Ungültige Zahl: " + valStr, "err"); uiError(); return; }
          if(key === "points"){
            state.points = n;
            updatePointsDisplay();
            updateDiceGameUI();
            refreshNeedPointsHint();
            persist();
            setCommandFeedback(`✓ Punkte auf ${n} gesetzt.`, "ok");
            uiSave();
            return;
          }
          if(key === "litters" || key === "rolls"){
            // Reconcile pendingRollBonuses to length n
            while(state.pendingRollBonuses.length > n) state.pendingRollBonuses.pop();
            while(state.pendingRollBonuses.length < n) state.pendingRollBonuses.push({ streak:false, surpass:false });
            state.pendingRolls = state.pendingRollBonuses.length;
            updateRewardBadge(true);
            persist();
            setCommandFeedback(`✓ Würfe auf ${n} gesetzt.`, "ok");
            uiSave();
            return;
          }
          if(key === "streak"){
            // Backfill state.data so computeStreak() returns exactly n.
            // Set today + previous (n-1) days to >= 30 min each; clear day n days ago to break further extension.
            for(let i = 0; i < n; i++){
              const d = new Date(); d.setDate(d.getDate() - i);
              const dKey = localDateKey(d);
              const cur = Number(state.data[dKey]) || 0;
              if(cur < STREAK_THRESHOLD_MIN) state.data[dKey] = STREAK_THRESHOLD_MIN;
            }
            // Break the streak just before the target window
            const breakD = new Date(); breakD.setDate(breakD.getDate() - n);
            delete state.data[localDateKey(breakD)];
            updateStats();
            drawHeatmap();
            persist();
            setCommandFeedback(`✓ Lern-Streak auf ${n} Tage gesetzt.`, "ok");
            uiSave();
            return;
          }
          setCommandFeedback(`Unbekannter Schlüssel: ${key}. Verfügbar: points, litters, rolls, streak`, "err");
          uiError();
          return;
        }
        if(cmd === "skip"){
          if(skipAny()){
            setCommandFeedback(`✓ ${state.phase === "break" ? "Pause" : "Intervall"} übersprungen.`, "ok");
            uiSave();
          } else {
            setCommandFeedback("Aktuell gibt es nichts zum Überspringen.", "err");
            uiError();
          }
          return;
        }
        setCommandFeedback(`Unbekannter Command: /${cmd}`, "err");
        uiError();
      }
      function submitCommand(){
        const t = dom.commandInput.value;
        execCommand(t);
        dom.commandInput.value = "";
      }
      dom.commandSubmit.addEventListener("click", submitCommand);
      dom.commandInput.addEventListener("keydown", (e) => {
        if(e.key === "Enter"){ e.preventDefault(); submitCommand(); }
      });

      // ── To-Do view ──
      if(dom.todoAddBtn){
        dom.todoAddBtn.addEventListener("click", todoHandleAddSubmit);
        dom.todoAddInput.addEventListener("keydown", (e) => {
          if(e.key === "Enter"){ e.preventDefault(); todoHandleAddSubmit(); }
        });
        dom.todoPlannedList.addEventListener("click", todoHandleListClick);
        dom.todoCompletedList.addEventListener("click", todoHandleListClick);
      }
      dom.rewardRollBtn.addEventListener("click", rollRewardDice);
      dom.rewardCloseBtn.addEventListener("click", closeRewardModal);
      dom.rewardModal.addEventListener("click", (e) => { if(e.target === dom.rewardModal && !rewardRolling) closeRewardModal(); });

      // Settings save/defaults
      dom.saveSettingsBtn.addEventListener("click", saveSettings);
      dom.defaultsBtn.addEventListener("click", resetDefaults);

      // Reset progress (danger zone)
      dom.resetProgressBtn.addEventListener("click", openResetConfirm);
      dom.confirmResetCancel.addEventListener("click", () => { uiSoftClick(); closeResetConfirm(); });
      dom.confirmResetYes.addEventListener("click", () => {
        uiToggle();
        closeResetConfirm();
        performProgressReset();
      });
      dom.confirmResetModal.addEventListener("click", (e) => {
        if(e.target === dom.confirmResetModal) closeResetConfirm();
      });

      document.addEventListener("keydown", e => {
        if(e.key === "Escape"){
          if(dom.confirmResetModal.classList.contains("show")) closeResetConfirm();
          else if(dom.rewardModal.classList.contains("show") && !rewardRolling) closeRewardModal();
          else if(dom.exactModal.classList.contains("show")) closeChoiceModal(dom.exactModal);
          else if(dom.oeModal.classList.contains("show")) closeChoiceModal(dom.oeModal);
          else if(dom.compactOverlay.style.display === "block") toggleCompact(false);
        }
      });
      // ════════════════════════════════════════════════════════════
      //   AUTH + APP BOOTSTRAP  (Supabase email/password)
      // ════════════════════════════════════════════════════════════
      const authDom = {
        modal: document.getElementById("authModal"),
        tabLogin: document.getElementById("authTabLogin"),
        tabRegister: document.getElementById("authTabRegister"),
        title: document.getElementById("authTitle"),
        sub: document.getElementById("authSub"),
        email: document.getElementById("authEmail"),
        password: document.getElementById("authPassword"),
        error: document.getElementById("authError"),
        note: document.getElementById("authNote"),
        submit: document.getElementById("authSubmit"),
        busy: document.getElementById("authBusy"),
        guestBtn: document.getElementById("authGuestBtn"),
        // Username (register-mode field + login-mode hint label)
        usernameField: document.getElementById("authUsernameField"),
        username: document.getElementById("authUsername"),
        usernameHint: document.getElementById("authUsernameHint"),
        emailLabel: document.getElementById("authEmailLabel"),
        // Username-required modal
        usrReqModal:  document.getElementById("usernameReqModal"),
        usrReqInput:  document.getElementById("usernameReqInput"),
        usrReqError:  document.getElementById("usernameReqError"),
        usrReqBusy:   document.getElementById("usernameReqBusy"),
        usrReqSubmit: document.getElementById("usernameReqSubmit"),
        // Profile username controls
        profileUsernameInput: document.getElementById("profileUsernameInput"),
        profileUsernameSave:  document.getElementById("profileUsernameSave"),
        profileUsernameMsg:   document.getElementById("profileUsernameMsg"),
        profileUsernameSub:   document.getElementById("profileUsernameSub"),
        loading: document.getElementById("loadingOverlay"),
        loadingText: document.getElementById("loadingText"),
        logoutBtn: document.getElementById("logoutBtn"),
        appRoot: document.querySelector(".app"),
        forgotLink: document.getElementById("authForgotLink"),
        // Legal / account / onboarding
        imprintModal: document.getElementById("imprintModal"),
        imprintOpen: document.getElementById("openImprintBtn"),
        imprintClose: document.getElementById("closeImprintBtn"),
        privacyModal: document.getElementById("privacyModal"),
        privacyOpen: document.getElementById("openPrivacyBtn"),
        privacyClose: document.getElementById("closePrivacyBtn"),
        deleteAccountBtn: document.getElementById("deleteAccountBtn"),
        deleteModal: document.getElementById("deleteAccountModal"),
        deletePassword: document.getElementById("deleteAccountPassword"),
        deleteError: document.getElementById("deleteAccountError"),
        deleteBusy: document.getElementById("deleteAccountBusy"),
        deleteCancel: document.getElementById("deleteAccountCancel"),
        deleteConfirm: document.getElementById("deleteAccountConfirm"),
        onboardModal: document.getElementById("onboardModal"),
        onboardDots: document.getElementById("onboardDots"),
        onboardSkip: document.getElementById("onboardSkip"),
        onboardBack: document.getElementById("onboardBack"),
        onboardNext: document.getElementById("onboardNext"),
      };
      // login | register | forgot | reset
      let authMode = "login";
      function blockApp(){ authDom.appRoot && authDom.appRoot.classList.add("blocked"); }
      function unblockApp(){ authDom.appRoot && authDom.appRoot.classList.remove("blocked"); }
      function showAuthModal(){
        if(!authDom.modal) return;
        authDom.modal.classList.add("show");
        authDom.modal.setAttribute("aria-hidden", "false");
        authClearMessages();
        setTimeout(() => { try{ authDom.email && authDom.email.focus(); }catch(_){} }, 60);
      }
      function hideAuthModal(){
        if(!authDom.modal) return;
        authDom.modal.classList.remove("show");
        authDom.modal.setAttribute("aria-hidden", "true");
      }
      function showLoading(text){
        if(!authDom.loading) return;
        if(authDom.loadingText) authDom.loadingText.textContent = text || "Lade…";
        authDom.loading.classList.add("show");
        authDom.loading.setAttribute("aria-hidden", "false");
      }
      function hideLoading(){
        if(!authDom.loading) return;
        authDom.loading.classList.remove("show");
        authDom.loading.setAttribute("aria-hidden", "true");
      }
      function setAuthMode(mode){
        authMode = mode;
        const isLogin = mode === "login";
        const isReg   = mode === "register";
        const isForgot = mode === "forgot";
        const isReset  = mode === "reset";
        // Tabs only visible for login/register (forgot/reset have no tab semantics)
        const tabsVisible = isLogin || isReg;
        authDom.tabLogin.style.display    = tabsVisible ? "" : "none";
        authDom.tabRegister.style.display = tabsVisible ? "" : "none";
        authDom.tabLogin.classList.toggle("active", isLogin);
        authDom.tabRegister.classList.toggle("active", isReg);
        // Title / subtitle / button label per mode
        if(isLogin){
          authDom.title.textContent = "Willkommen zurück";
          authDom.sub.textContent = "Melde dich an, um deinen Fortschritt überall zu sehen.";
          authDom.submit.textContent = "Einloggen";
        } else if(isReg){
          authDom.title.textContent = "Account erstellen";
          authDom.sub.textContent = "Erstelle ein Konto, damit deine Daten sicher in der Cloud bleiben.";
          authDom.submit.textContent = "Account erstellen";
        } else if(isForgot){
          authDom.title.textContent = "Passwort zurücksetzen";
          authDom.sub.textContent = "Wir senden dir einen Link zum Setzen eines neuen Passworts.";
          authDom.submit.textContent = "Reset-Link senden";
        } else if(isReset){
          authDom.title.textContent = "Neues Passwort setzen";
          authDom.sub.textContent = "Wähle ein neues Passwort für deinen Account.";
          authDom.submit.textContent = "Passwort speichern";
        }
        // Field visibility
        // forgot mode: only email; reset mode: only password (new). Otherwise: both.
        const emailField = authDom.email.closest(".authField");
        const pwField    = authDom.password.closest(".authField");
        if(emailField) emailField.style.display = isReset ? "none" : "";
        if(pwField)    pwField.style.display    = isForgot ? "none" : "";
        // Username field: only shown in register mode
        if(authDom.usernameField) authDom.usernameField.style.display = isReg ? "" : "none";
        // E-Mail label flexes between "E-Mail" (register/forgot/reset) and
        // "E-Mail oder Nutzername" (login).
        if(authDom.emailLabel){
          authDom.emailLabel.textContent = isLogin ? "E-Mail oder Nutzername" : "E-Mail";
        }
        if(authDom.email){
          authDom.email.placeholder = isLogin ? "du@beispiel.de oder Nutzername" : "du@beispiel.de";
          authDom.email.setAttribute("autocomplete", isLogin ? "username" : "email");
          authDom.email.type = isLogin ? "text" : "email";
        }
        // Autocomplete hints
        authDom.password.setAttribute("autocomplete", (isReg || isReset) ? "new-password" : "current-password");
        authDom.password.placeholder = isReset ? "Neues Passwort (mind. 6 Zeichen)" : "Mindestens 6 Zeichen";
        // Forgot link visibility
        if(authDom.forgotLink) authDom.forgotLink.style.display = isLogin ? "block" : "none";
        // Guest button only on login/register (not during forgot/reset flows)
        if(authDom.guestBtn){
          const guestParent = authDom.guestBtn.parentElement;
          // Hide the divider + guest button + note in forgot/reset
          const hideAll = isForgot || isReset;
          authDom.guestBtn.style.display = hideAll ? "none" : "";
          const divider = guestParent && guestParent.querySelector(".authDivider");
          const note = guestParent && guestParent.querySelector(".authGuestNote");
          if(divider) divider.style.display = hideAll ? "none" : "";
          if(note) note.style.display = hideAll ? "none" : "";
        }
        authClearMessages();
      }
      function authClearMessages(){
        if(authDom.error) authDom.error.textContent = "";
        if(authDom.note) authDom.note.textContent = "";
      }
      function setAuthError(msg){ if(authDom.error) authDom.error.textContent = msg || ""; if(authDom.note) authDom.note.textContent = ""; }
      function setAuthNote(msg){ if(authDom.note) authDom.note.textContent = msg || ""; if(authDom.error) authDom.error.textContent = ""; }
      function setAuthBusy(busy){
        if(!authDom.busy) return;
        authDom.busy.style.display = busy ? "flex" : "none";
        authDom.submit.disabled = busy;
        authDom.email.disabled = busy;
        authDom.password.disabled = busy;
        authDom.tabLogin.disabled = busy;
        authDom.tabRegister.disabled = busy;
        if(authDom.guestBtn) authDom.guestBtn.disabled = busy;
      }
      // Translate Supabase auth errors into user-friendly German messages
      function translateAuthError(err){
        const m = (err && err.message ? err.message : String(err || "")).toLowerCase();
        if(m.includes("invalid login")) return "E-Mail oder Passwort falsch.";
        if(m.includes("email not confirmed")) return "Bitte bestätige zuerst deine E-Mail.";
        if(m.includes("user already") || m.includes("already registered")) return "Diese E-Mail wird bereits verwendet.";
        if(m.includes("password should be at least")) return "Passwort zu kurz (mindestens 6 Zeichen).";
        if(m.includes("invalid email") || m.includes("unable to validate email")) return "Bitte gib eine gültige E-Mail-Adresse ein.";
        if(m.includes("network") || m.includes("fetch")) return "Netzwerkfehler. Verbindung prüfen.";
        if(m.includes("rate limit")) return "Zu viele Versuche. Bitte später erneut probieren.";
        return err && err.message ? err.message : "Unbekannter Fehler.";
      }
      // ── Username helpers ──────────────────────────────────────────
      const USERNAME_REGEX = /^[a-zA-Z]{4,10}$/;
      function validateUsernameLocal(u){
        if(!u) return "Bitte Nutzernamen eingeben.";
        if(u.length < 4) return "Nutzername zu kurz (mindestens 4 Buchstaben).";
        if(u.length > 10) return "Nutzername zu lang (maximal 10 Buchstaben).";
        if(!USERNAME_REGEX.test(u)) return "Nur Buchstaben a–z und A–Z erlaubt — keine Zahlen oder Sonderzeichen.";
        return null;
      }
      // True if the input looks like an email address (contains '@').
      function looksLikeEmail(s){ return typeof s === "string" && s.indexOf("@") >= 0; }
      // Look up the email behind a username (or null). Used for username-based login.
      async function emailForUsername(uname){
        if(!sb) return null;
        try{
          const { data, error } = await sb.rpc("email_for_username", { uname });
          if(error){ console.warn("[emailForUsername]", error); return null; }
          return (typeof data === "string" && data) ? data : null;
        } catch(_){ return null; }
      }
      // Check if a username is already taken (case-insensitive). Returns the email or null.
      // Used before signUp to give the user fast feedback.
      async function isUsernameTaken(uname){
        // Reuses the same RPC: if it returns an email, the username is taken.
        const email = await emailForUsername(uname);
        return !!email;
      }
      // Fetch current user's username row (or null if not set yet)
      async function fetchOwnUsernameRow(userId){
        if(!sb || !userId) return null;
        try{
          const { data, error } = await sb.from("usernames")
            .select("username, last_changed_at")
            .eq("user_id", userId)
            .maybeSingle();
          if(error){ console.warn("[fetchOwnUsernameRow]", error); return null; }
          return data || null;
        } catch(_){ return null; }
      }
      // Insert or update the current user's username.
      // Returns { ok:bool, code?:"taken"|"cooldown"|"format"|"unknown", cooldownUntil?:Date }
      async function persistUsername(uname, opts){
        if(!sb || !currentUser) return { ok:false, code:"unknown" };
        const err = validateUsernameLocal(uname);
        if(err) return { ok:false, code:"format", message:err };
        const isInsert = !!(opts && opts.isInsert);
        try{
          let res;
          if(isInsert){
            res = await sb.from("usernames").insert({ user_id: currentUser.id, username: uname });
          } else {
            res = await sb.from("usernames").update({ username: uname }).eq("user_id", currentUser.id);
          }
          if(res.error){
            const m = (res.error.message || "").toLowerCase();
            const detail = (res.error.details || res.error.hint || "").toLowerCase();
            if(m.includes("username_change_too_soon") || (res.error.details || "").toLowerCase().includes("username_change_too_soon")){
              // Trigger raised this; the detail carries the unlock timestamp.
              let until = null;
              try{ until = new Date(res.error.details); }catch(_){}
              return { ok:false, code:"cooldown", cooldownUntil: until };
            }
            if(m.includes("duplicate") || m.includes("unique") || detail.includes("unique") || res.error.code === "23505"){
              return { ok:false, code:"taken" };
            }
            if(m.includes("username_format") || detail.includes("username_format") || res.error.code === "23514"){
              return { ok:false, code:"format" };
            }
            return { ok:false, code:"unknown", message: res.error.message };
          }
          return { ok:true };
        } catch(e){
          return { ok:false, code:"unknown", message: e && e.message };
        }
      }

      async function authSubmitHandler(){
        if(!sb){ setAuthError("Supabase wurde nicht geladen."); return; }
        const email = (authDom.email.value || "").trim();
        const password = authDom.password.value || "";
        // Field validation depends on mode
        if(authMode === "forgot"){
          if(!email){ setAuthError("Bitte E-Mail eingeben."); return; }
        } else if(authMode === "reset"){
          if(!password){ setAuthError("Bitte neues Passwort eingeben."); return; }
          if(password.length < 6){ setAuthError("Passwort zu kurz (mindestens 6 Zeichen)."); return; }
        } else {
          if(!email || !password){ setAuthError("Bitte E-Mail und Passwort eingeben."); return; }
          if(password.length < 6){ setAuthError("Passwort zu kurz (mindestens 6 Zeichen)."); return; }
        }
        setAuthBusy(true);
        authClearMessages();
        try{
          if(authMode === "login"){
            // Login accepts EITHER an email address OR a username.
            // If no "@" → treat as username, resolve via RPC, then sign in with the email.
            let loginEmail = email;
            if(!looksLikeEmail(email)){
              const fmtErr = validateUsernameLocal(email);
              if(fmtErr){
                // Format invalid → generic error to avoid leaking enumeration info
                throw { message: "invalid login credentials" };
              }
              const resolved = await emailForUsername(email);
              if(!resolved){
                throw { message: "invalid login credentials" };
              }
              loginEmail = resolved;
            }
            const { error } = await sb.auth.signInWithPassword({ email: loginEmail, password });
            if(error) throw error;
          } else if(authMode === "register"){
            // Username is required for registration.
            const desiredUsername = (authDom.username.value || "").trim();
            const fmtErr = validateUsernameLocal(desiredUsername);
            if(fmtErr){ setAuthError(fmtErr); setAuthBusy(false); return; }
            // Pre-check uniqueness (race-condition: the unique index ultimately enforces it)
            if(await isUsernameTaken(desiredUsername)){
              setAuthError("Dieser Nutzername ist bereits vergeben.");
              setAuthBusy(false);
              return;
            }
            // Email must be a real email for sign-up
            if(!looksLikeEmail(email)){
              setAuthError("Bitte eine gültige E-Mail-Adresse eingeben.");
              setAuthBusy(false);
              return;
            }
            const { data, error } = await sb.auth.signUp({ email, password });
            if(error) throw error;
            // Helper: persists the desired username right after auth, with cleanup-on-failure
            const finalizeWithUsername = async (sessionUser) => {
              const wasUser = currentUser;
              currentUser = sessionUser; // temporary so persistUsername can use auth.uid()
              const res = await persistUsername(desiredUsername, { isInsert: true });
              currentUser = wasUser;
              if(!res.ok){
                // Unwind: delete the just-created account so the user can pick a different name.
                try{ await sb.rpc("delete_user_account"); }catch(_){}
                try{ await sb.auth.signOut(); }catch(_){}
                if(res.code === "taken") setAuthError("Dieser Nutzername wurde gerade vergeben — bitte einen anderen wählen.");
                else if(res.code === "format") setAuthError(res.message || "Nutzername ist ungültig.");
                else setAuthError("Account konnte nicht angelegt werden. Bitte erneut versuchen.");
                return false;
              }
              return true;
            };
            // If the project has email-confirmation DISABLED, signUp returns a session immediately.
            if(data && data.session){
              // Persist the username NOW (we have an active session, RLS allows the insert).
              const ok = await finalizeWithUsername(data.session.user);
              if(!ok) return;
              // onAuthStateChange will run handleSignedIn for the new session.
            } else {
              // No session returned. Two possibilities:
              //  (a) Email confirmation is OFF but the SDK simply didn't auto-sign-in →
              //      we try a direct password sign-in right away, then persist the username.
              //  (b) Email confirmation is ON → that sign-in will fail with "Email not confirmed"
              //      and we show the appropriate notice. The username insert is skipped
              //      (user will be prompted via the required-modal after their first login).
              try{
                const { data: signInData, error: signInErr } = await sb.auth.signInWithPassword({ email, password });
                if(signInErr) throw signInErr;
                if(signInData && signInData.user){
                  await finalizeWithUsername(signInData.user);
                }
              } catch(signInFailure){
                const msg = (signInFailure && signInFailure.message || "").toLowerCase();
                if(msg.includes("email not confirmed") || msg.includes("not confirmed")){
                  setAuthNote("Account erstellt. Bitte bestätige zuerst deine E-Mail und melde dich danach an.");
                } else {
                  setAuthNote("Account erstellt. Bitte melde dich jetzt an.");
                }
                setAuthMode("login");
              }
            }
          } else if(authMode === "forgot"){
            // Pre-flight check: file:// URLs cannot be used as redirect targets by Supabase.
            // Surface this clearly instead of letting the user puzzle over a broken email link.
            if(window.location.protocol === "file:"){
              setAuthError("Passwort-Reset funktioniert nur über http(s)-URLs. Öffne die App über einen lokalen Server oder dein Hosting, nicht direkt als file://.");
              setAuthBusy(false);
              return;
            }
            // The redirectTo URL must be whitelisted in the Supabase Dashboard:
            // Authentication → URL Configuration → Redirect URLs.
            const redirectTo = window.location.origin + window.location.pathname;
            const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
            if(error) throw error;
            setAuthNote("Wenn diese Adresse registriert ist, erhältst du gleich eine E-Mail mit einem Link.");
            // Stay in forgot mode so the user sees the confirmation
          } else if(authMode === "reset"){
            const { error } = await sb.auth.updateUser({ password });
            if(error) throw error;
            setAuthNote("Passwort gespeichert. Du kannst dich jetzt anmelden.");
            recoveryMode = false;
            // Sign out the recovery session and return to login screen
            try{ await sb.auth.signOut(); }catch(_){}
            // Strip the recovery hash from the URL so it doesn't trigger again on reload
            try{ history.replaceState(null, "", window.location.pathname + window.location.search); }catch(_){}
            setAuthMode("login");
          }
        } catch(err){
          setAuthError(translateAuthError(err));
        } finally {
          setAuthBusy(false);
        }
      }
      async function logout(){
        // Guest mode: just exit guest mode and return to the auth modal — no cloud call needed.
        if(guestMode){
          exitGuestMode();
          return;
        }
        if(!sb) return;
        showLoading("Abmelden…");
        try{
          // Flush any pending changes synchronously before signing out
          if(currentUser && dirty){
            if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
            await saveToCloud();
          }
          await sb.auth.signOut();
        } catch(e){
          console.warn("[logout]", e);
        } finally {
          hideLoading();
        }
      }
      // Enter guest mode: app is fully usable but nothing is persisted (no cloud, no localStorage).
      // Triggered by the "Ohne Anmeldung fortfahren" button.
      function enterGuestMode(){
        guestMode = true;
        currentUser = null;
        cachedAccessToken = null;
        // Make sure no leftover save timers fire (defensive — they're guarded but be explicit).
        if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
        if(saveBackoffTimer){ clearTimeout(saveBackoffTimer); saveBackoffTimer = null; }
        stopAutosave();
        dirty = false;
        // Always start guests with a clean default state — no recovery, no localStorage read.
        clearLocalFallback();
        resetStateToDefaults();
        if(!appBootstrapped) init();
        else applyLoadedState();
        hideAuthModal();
        unblockApp();
        hideLoading();
        // Logout button stays available so the user can return to the login screen.
        if(authDom.logoutBtn){
          authDom.logoutBtn.disabled = false;
          authDom.logoutBtn.title = "Zurück zur Anmeldung";
        }
        // Guests get the questionnaire every visit (state isn't persisted for them).
        maybeShowQuestionnaire();
      }
      // Exit guest mode: discard all in-memory progress (per user spec) and show the auth modal.
      function exitGuestMode(){
        guestMode = false;
        // Stop everything driven by guest state
        workerStop(); diceTrackingStop(); stopAlarm();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        // Discard guest progress entirely — nothing is or was persisted.
        resetStateToDefaults();
        if(appBootstrapped) applyLoadedState();
        blockApp();
        showAuthModal();
        if(authDom.logoutBtn){
          authDom.logoutBtn.disabled = true;
          authDom.logoutBtn.title = "Abmelden";
        }
      }
      async function handleSignedIn(user){
        // Logging in always supersedes guest mode and discards any in-memory guest state.
        guestMode = false;
        currentUser = user;
        if(authDom.logoutBtn){
          authDom.logoutBtn.disabled = false;
          authDom.logoutBtn.title = "Abmelden";
        }
        showLoading("Daten werden geladen…");
        // 1) Recover any unsynced local changes from a previous session/tab
        const recovered = await recoverLocalFallback(user.id);
        if(recovered){
          applySavedStateInto(state, recovered);
        } else {
          const cloud = await fetchCloudState(user.id);
          if(cloud) applySavedStateInto(state, cloud);
        }
        // Reset save-pipeline flags for the new user
        dirty = false;
        saveBackoffMs = SAVE_BACKOFF_MIN;
        if(!appBootstrapped) init();
        else applyLoadedState();
        startAutosave();
        hideAuthModal();
        unblockApp();
        hideLoading();
        // If no row existed yet, write the (default or carried) state so the row is created
        persist();
        // First-time onboarding: welcome tour first, then questionnaire.
        // If both have been completed before, neither will show again.
        if(!state.onboardingDone){
          maybeShowOnboarding();
          // Questionnaire will fire automatically after the user closes the tour (see closeOnboardingTour).
        } else {
          maybeShowQuestionnaire();
        }
        // Make sure the user has a username — required for the app. Older accounts get prompted.
        enforceUsernamePostLogin();
      }
      function handleSignedOut(){
        currentUser = null;
        cachedAccessToken = null;
        // Stop everything driven by old user's state
        workerStop(); diceTrackingStop(); stopAlarm();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
        if(saveBackoffTimer){ clearTimeout(saveBackoffTimer); saveBackoffTimer = null; }
        stopAutosave();
        dirty = false;
        // Reset to defaults and re-render
        resetStateToDefaults();
        if(appBootstrapped) applyLoadedState();
        blockApp();
        showAuthModal();
        if(authDom.logoutBtn) authDom.logoutBtn.disabled = true;
      }

      // ════════════════════════════════════════════════════════════
      //   LEGAL MODALS (Impressum / Datenschutz)
      // ════════════════════════════════════════════════════════════
      function openLegalModal(modal){
        if(!modal) return;
        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
      }
      function closeLegalModal(modal){
        if(!modal) return;
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
      }

      // ════════════════════════════════════════════════════════════
      //   ACCOUNT DELETION  (two-step confirmation: open modal + password re-auth)
      // ════════════════════════════════════════════════════════════
      function openDeleteAccountModal(){
        if(!authDom.deleteModal) return;
        if(guestMode || !currentUser){
          // In guest mode there's nothing to delete; just nudge to log in first.
          return;
        }
        authDom.deletePassword.value = "";
        if(authDom.deleteError) authDom.deleteError.textContent = "";
        if(authDom.deleteBusy) authDom.deleteBusy.style.display = "none";
        authDom.deleteModal.classList.add("show");
        authDom.deleteModal.setAttribute("aria-hidden", "false");
        setTimeout(() => { try{ authDom.deletePassword.focus(); }catch(_){} }, 60);
      }
      function closeDeleteAccountModal(){
        if(!authDom.deleteModal) return;
        authDom.deleteModal.classList.remove("show");
        authDom.deleteModal.setAttribute("aria-hidden", "true");
      }
      async function performAccountDeletion(){
        if(!sb || !currentUser) return;
        const password = authDom.deletePassword.value || "";
        if(!password){
          authDom.deleteError.textContent = "Bitte Passwort zur Bestätigung eingeben.";
          return;
        }
        authDom.deleteError.textContent = "";
        authDom.deleteBusy.style.display = "flex";
        authDom.deleteConfirm.disabled = true;
        authDom.deleteCancel.disabled = true;
        authDom.deletePassword.disabled = true;
        try{
          // Step 1: Re-verify password (prevents accidental/forced deletion from a hijacked session)
          const email = currentUser.email;
          if(!email) throw new Error("Account hat keine E-Mail.");
          const { error: reauthErr } = await sb.auth.signInWithPassword({ email, password });
          if(reauthErr){
            authDom.deleteError.textContent = "Passwort falsch. Bitte erneut versuchen.";
            uiError();
            return;
          }
          // Step 2: Call the server-side RPC that deletes auth.users (cascades to user_profiles).
          //         The RPC `delete_user_account` runs with SECURITY DEFINER and reads auth.uid()
          //         from the JWT — there is no client-side way to delete an auth.users row directly.
          //         If the RPC isn't installed yet, we fall back to deleting only the profile row
          //         and signing out, so the local app behaves correctly even before the DB
          //         migration is applied.
          let rpcOk = false;
          try{
            const { error: rpcErr } = await sb.rpc("delete_user_account");
            if(rpcErr) throw rpcErr;
            rpcOk = true;
          } catch(rpcEx){
            console.warn("[deleteAccount] RPC delete_user_account failed:", rpcEx && rpcEx.message || rpcEx);
            // Fallback: at minimum wipe the profile data so no app_state survives
            try{
              const { error: delErr } = await sb.from("user_profiles").delete().eq("id", currentUser.id);
              if(delErr) console.warn("[deleteAccount] fallback profile delete:", delErr.message || delErr);
            }catch(_){}
          }
          // Clear any local fallback so it doesn't get re-uploaded on next login
          clearLocalFallback();
          // Cancel pending save attempts
          if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
          if(saveBackoffTimer){ clearTimeout(saveBackoffTimer); saveBackoffTimer = null; }
          dirty = false;
          // Sign out (which triggers handleSignedOut → reset state + show auth modal)
          try{ await sb.auth.signOut(); }catch(_){}
          closeDeleteAccountModal();
          if(rpcOk){
            setAuthNote("Dein Account und alle zugehörigen Daten wurden vollständig gelöscht.");
          } else {
            setAuthNote("Daten wurden gelöscht. Der Account-Eintrag konnte serverseitig nicht entfernt werden — bitte SQL-Migration anwenden (delete_user_account).");
          }
          uiSave();
        } catch(err){
          console.warn("[deleteAccount]", err);
          authDom.deleteError.textContent = "Löschen fehlgeschlagen: " + ((err && err.message) || "Unbekannter Fehler");
          uiError();
        } finally {
          authDom.deleteBusy.style.display = "none";
          authDom.deleteConfirm.disabled = false;
          authDom.deleteCancel.disabled = false;
          authDom.deletePassword.disabled = false;
        }
      }

      // ════════════════════════════════════════════════════════════
      //   ONBOARDING TOUR (4 slides, persisted via state.onboardingDone)
      // ════════════════════════════════════════════════════════════
      let onboardStepIdx = 0;
      const ONBOARD_TOTAL_STEPS = 4;
      function renderOnboardingStep(){
        if(!authDom.onboardModal) return;
        const slides = authDom.onboardModal.querySelectorAll(".onboardSlide");
        slides.forEach((s, i) => { s.style.display = (i === onboardStepIdx) ? "" : "none"; });
        // Dots
        if(authDom.onboardDots){
          while(authDom.onboardDots.firstChild) authDom.onboardDots.removeChild(authDom.onboardDots.firstChild);
          for(let i=0; i<ONBOARD_TOTAL_STEPS; i++){
            const d = document.createElement("span");
            d.className = "onboardDot" + (i === onboardStepIdx ? " active" : "");
            authDom.onboardDots.appendChild(d);
          }
        }
        // Buttons
        if(authDom.onboardBack) authDom.onboardBack.style.display = onboardStepIdx > 0 ? "" : "none";
        if(authDom.onboardNext) authDom.onboardNext.textContent = onboardStepIdx === ONBOARD_TOTAL_STEPS - 1 ? "Los geht's!" : "Weiter";
      }
      function openOnboardingTour(){
        if(!authDom.onboardModal) return;
        onboardStepIdx = 0;
        renderOnboardingStep();
        authDom.onboardModal.classList.add("show");
        authDom.onboardModal.setAttribute("aria-hidden", "false");
      }
      function closeOnboardingTour(markDone){
        if(!authDom.onboardModal) return;
        authDom.onboardModal.classList.remove("show");
        authDom.onboardModal.setAttribute("aria-hidden", "true");
        if(markDone){
          state.onboardingDone = true;
          if(currentUser) persist();
          // Chain into the initial questionnaire (only if not done yet)
          setTimeout(() => { if(!state.questionnaireDone) maybeShowQuestionnaire(); }, 200);
        }
      }
      function maybeShowOnboarding(){
        // Show only for logged-in users who haven't seen it yet. Guests skip.
        if(guestMode) return;
        if(!currentUser) return;
        if(state.onboardingDone) return;
        // Defer slightly so the just-loaded UI is visible behind it
        setTimeout(openOnboardingTour, 350);
      }

      // ════════════════════════════════════════════════════════════
      //   SCREEN WAKE LOCK  (keep screen on during active learning)
      // ════════════════════════════════════════════════════════════
      let wakeLockSentinel = null;
      async function requestWakeLock(){
        if(!("wakeLock" in navigator)) return;
        if(wakeLockSentinel) return;
        try{
          wakeLockSentinel = await navigator.wakeLock.request("screen");
          wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = null; });
        }catch(e){ /* user gesture required / denied — silently ignore */ }
      }
      function releaseWakeLock(){
        if(!wakeLockSentinel) return;
        try{ wakeLockSentinel.release(); }catch(_){}
        wakeLockSentinel = null;
      }
      // Chrome auto-releases wake lock when the tab is hidden. Re-acquire when visible again.
      document.addEventListener("visibilitychange", () => {
        if(document.visibilityState === "visible" && state.running && state.phase === "learning"){
          requestWakeLock();
        }
      });

      // ════════════════════════════════════════════════════════════
      //   WEB NOTIFICATIONS  (phase-end alerts when tab is hidden)
      // ════════════════════════════════════════════════════════════
      async function ensureNotificationPermission(){
        if(!("Notification" in window)) return false;
        if(Notification.permission === "granted") return true;
        if(Notification.permission === "denied") return false;
        try{
          const result = await Notification.requestPermission();
          return result === "granted";
        }catch(_){ return false; }
      }
      function notifyPhaseEnd(kind){
        if(!("Notification" in window)) return;
        if(Notification.permission !== "granted") return;
        // Skip the notification when the page is already visible — alarm sound + UI is enough.
        if(document.visibilityState === "visible") return;
        let title, body;
        if(kind === "learning"){
          title = "Lerneinheit beendet";
          body  = "Zeit für eine Pause!";
        } else if(kind === "break"){
          title = "Pause vorbei";
          body  = "Bereit für die nächste Lerneinheit?";
        } else if(kind === "done"){
          title = "Tagesziel erreicht!";
          body  = "Du hast alle Einheiten geschafft.";
        } else {
          title = "Proko";
          body  = "Phase beendet";
        }
        try{ new Notification(title, { body, tag: "lernplan-phase", silent: false }); }catch(_){}
      }

      // ════════════════════════════════════════════════════════════
      //   USERNAME UX  (required-modal + profile section)
      // ════════════════════════════════════════════════════════════
      function fmtDateLocal(d){
        if(!(d instanceof Date) || isNaN(d.getTime())) return "";
        const day = String(d.getDate()).padStart(2, "0");
        const mon = String(d.getMonth() + 1).padStart(2, "0");
        const yr  = d.getFullYear();
        return `${day}.${mon}.${yr}`;
      }
      function describeUsernameError(res){
        if(!res || res.ok) return "";
        if(res.code === "taken") return "Dieser Nutzername ist bereits vergeben.";
        if(res.code === "format") return res.message || "Nur Buchstaben a–z und A–Z, 4–10 Zeichen.";
        if(res.code === "cooldown"){
          const until = res.cooldownUntil instanceof Date ? res.cooldownUntil : null;
          if(until) return `Du kannst deinen Nutzernamen erst am ${fmtDateLocal(until)} wieder ändern.`;
          return "Du kannst deinen Nutzernamen aktuell nicht ändern (Cooldown aktiv).";
        }
        return res.message || "Speichern fehlgeschlagen.";
      }

      // ── Username-required modal (existing accounts without a username) ──
      function openUsernameRequiredModal(){
        if(!authDom.usrReqModal) return;
        if(authDom.usrReqInput) authDom.usrReqInput.value = "";
        if(authDom.usrReqError) authDom.usrReqError.textContent = "";
        if(authDom.usrReqBusy)  authDom.usrReqBusy.style.display = "none";
        authDom.usrReqModal.classList.add("show");
        authDom.usrReqModal.setAttribute("aria-hidden", "false");
        setTimeout(() => { try{ authDom.usrReqInput && authDom.usrReqInput.focus(); }catch(_){} }, 60);
      }
      function closeUsernameRequiredModal(){
        if(!authDom.usrReqModal) return;
        authDom.usrReqModal.classList.remove("show");
        authDom.usrReqModal.setAttribute("aria-hidden", "true");
      }
      async function submitRequiredUsername(){
        if(!currentUser){ closeUsernameRequiredModal(); return; }
        const uname = (authDom.usrReqInput.value || "").trim();
        const fmtErr = validateUsernameLocal(uname);
        if(fmtErr){ authDom.usrReqError.textContent = fmtErr; uiError(); return; }
        authDom.usrReqError.textContent = "";
        authDom.usrReqBusy.style.display = "flex";
        authDom.usrReqSubmit.disabled = true;
        authDom.usrReqInput.disabled = true;
        // First check availability fast (UX), but rely on DB unique-index for atomic guarantee.
        if(await isUsernameTaken(uname)){
          authDom.usrReqError.textContent = "Dieser Nutzername ist bereits vergeben.";
          authDom.usrReqBusy.style.display = "none";
          authDom.usrReqSubmit.disabled = false;
          authDom.usrReqInput.disabled = false;
          uiError();
          return;
        }
        const res = await persistUsername(uname, { isInsert: true });
        if(res.ok){
          state.username = uname;
          closeUsernameRequiredModal();
          renderProfileUsernameRow(state.username, null);
          uiSave();
        } else {
          authDom.usrReqError.textContent = describeUsernameError(res);
          authDom.usrReqBusy.style.display = "none";
          authDom.usrReqSubmit.disabled = false;
          authDom.usrReqInput.disabled = false;
          uiError();
        }
      }
      function bindUsernameRequiredModal(){
        if(!authDom.usrReqModal) return;
        if(authDom.usrReqSubmit) authDom.usrReqSubmit.addEventListener("click", submitRequiredUsername);
        if(authDom.usrReqInput) authDom.usrReqInput.addEventListener("keydown", (e) => {
          if(e.key === "Enter"){ e.preventDefault(); submitRequiredUsername(); }
        });
        // No backdrop-close: required modal must be answered before proceeding.
      }

      // ── Profile-page username row ──
      function renderProfileUsernameRow(username, lastChangedAt){
        if(!authDom.profileUsernameInput) return;
        // Avoid clobbering an in-progress edit
        if(document.activeElement !== authDom.profileUsernameInput){
          authDom.profileUsernameInput.value = username || "";
        }
        authDom.profileUsernameInput.placeholder = username ? "" : "—";
        // Cooldown check (1 change per 7 days)
        let cooldownActive = false;
        let unlockDate = null;
        if(lastChangedAt instanceof Date && !isNaN(lastChangedAt.getTime())){
          unlockDate = new Date(lastChangedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
          cooldownActive = unlockDate.getTime() > Date.now();
        }
        authDom.profileUsernameInput.disabled = cooldownActive;
        authDom.profileUsernameSave.disabled = cooldownActive;
        if(authDom.profileUsernameSub){
          authDom.profileUsernameSub.textContent = cooldownActive
            ? `Änderung erst wieder am ${fmtDateLocal(unlockDate)} möglich (1 × pro Woche).`
            : "4–10 Buchstaben. Änderungen sind nur einmal pro Woche möglich.";
        }
        if(authDom.profileUsernameMsg) authDom.profileUsernameMsg.textContent = "";
      }
      async function loadAndRenderProfileUsername(){
        if(!currentUser){
          renderProfileUsernameRow("", null);
          return;
        }
        const row = await fetchOwnUsernameRow(currentUser.id);
        const last = row && row.last_changed_at ? new Date(row.last_changed_at) : null;
        const uname = row && row.username || "";
        state.username = uname;
        renderProfileUsernameRow(uname, last);
      }
      async function handleProfileUsernameSave(){
        if(!currentUser) return;
        const uname = (authDom.profileUsernameInput.value || "").trim();
        const fmtErr = validateUsernameLocal(uname);
        const msg = authDom.profileUsernameMsg;
        if(fmtErr){
          if(msg){ msg.textContent = fmtErr; msg.className = "profileUsernameMsg err"; }
          uiError();
          return;
        }
        if(uname.toLowerCase() === (state.username || "").toLowerCase()){
          if(msg){ msg.textContent = "Das ist bereits dein aktueller Nutzername."; msg.className = "profileUsernameMsg muted"; }
          return;
        }
        // Pre-check uniqueness (race-condition: DB unique index has the final say)
        if(await isUsernameTaken(uname)){
          if(msg){ msg.textContent = "Dieser Nutzername ist bereits vergeben."; msg.className = "profileUsernameMsg err"; }
          uiError();
          return;
        }
        authDom.profileUsernameSave.disabled = true;
        authDom.profileUsernameInput.disabled = true;
        // Does the user already have a row? If not, insert; else update.
        const existing = await fetchOwnUsernameRow(currentUser.id);
        const res = await persistUsername(uname, { isInsert: !existing });
        if(res.ok){
          state.username = uname;
          if(msg){ msg.textContent = "✓ Gespeichert. Nächste Änderung in 7 Tagen möglich."; msg.className = "profileUsernameMsg ok"; }
          uiSave();
          // Refresh cooldown info from server (last_changed_at is now-ish, set by trigger)
          await loadAndRenderProfileUsername();
        } else {
          if(msg){ msg.textContent = describeUsernameError(res); msg.className = "profileUsernameMsg err"; }
          authDom.profileUsernameSave.disabled = false;
          authDom.profileUsernameInput.disabled = false;
          uiError();
        }
      }
      function bindProfileUsernameEvents(){
        if(authDom.profileUsernameSave){
          authDom.profileUsernameSave.addEventListener("click", handleProfileUsernameSave);
        }
        if(authDom.profileUsernameInput){
          authDom.profileUsernameInput.addEventListener("keydown", (e) => {
            if(e.key === "Enter"){ e.preventDefault(); handleProfileUsernameSave(); }
          });
        }
      }
      // ════════════════════════════════════════════════════════════
      //   AVATAR  (emoji / initial / image — rendered in topbar + profile)
      // ════════════════════════════════════════════════════════════
      const avatarDom = {
        topbarBtn: document.getElementById("topbarAvatarBtn"),
        profileBig: document.getElementById("profileAvatarBig"),
        profileChangeBtn: document.getElementById("profileAvatarChangeBtn"),
        // Picker modal
        modal: document.getElementById("avatarModal"),
        closeBtn: document.getElementById("avatarCloseBtn"),
        cancelBtn: document.getElementById("avatarCancelBtn"),
        saveBtn: document.getElementById("avatarSaveBtn"),
        tabEmoji: document.getElementById("avatarTabEmoji"),
        tabInitial: document.getElementById("avatarTabInitial"),
        tabImage: document.getElementById("avatarTabImage"),
        paneEmoji: document.getElementById("avatarPaneEmoji"),
        paneInitial: document.getElementById("avatarPaneInitial"),
        paneImage: document.getElementById("avatarPaneImage"),
        initialPreview: document.getElementById("avatarInitialPreview"),
        colorGrid: document.getElementById("avatarColorGrid"),
        uploadPreview: document.getElementById("avatarUploadPreview"),
        pickFileBtn: document.getElementById("avatarPickFileBtn"),
        fileInput: document.getElementById("avatarFileInput"),
        uploadError: document.getElementById("avatarUploadError"),
      };
      // Live picker state — applied only on "Speichern"
      let pickerAvatar = null;
      function avatarInitialChar(){
        const src = (state.username || (currentUser && currentUser.email) || "?");
        const trimmed = String(src).trim();
        if(!trimmed) return "?";
        // Single uppercase letter (first non-whitespace alpha char)
        const m = trimmed.match(/[A-Za-zÄÖÜäöüß]/);
        return (m ? m[0] : trimmed.charAt(0)).toUpperCase();
      }
      // Render an avatar into a host element. `size` is informational
      // (the host CSS controls actual dimensions); we just set inner content + bg.
      function renderAvatarInto(host, avatar){
        if(!host) return;
        const a = (avatar && isValidAvatar(avatar)) ? avatar : state.avatar;
        // Reset
        while(host.firstChild) host.removeChild(host.firstChild);
        host.style.background = "";
        if(a.type === "emoji"){
          host.textContent = a.value;
          host.style.background = "var(--btn-neutral)";
        } else if(a.type === "initial"){
          const wrap = document.createElement("div");
          wrap.className = "avatarInitial";
          wrap.style.background = a.value;
          wrap.textContent = avatarInitialChar();
          host.appendChild(wrap);
          host.style.background = a.value;
        } else if(a.type === "image"){
          const img = document.createElement("img");
          img.alt = "Profilbild";
          img.src = a.value;
          host.appendChild(img);
          host.style.background = "transparent";
        }
      }
      function renderAvatarsEverywhere(){
        renderAvatarInto(avatarDom.topbarBtn,  state.avatar);
        renderAvatarInto(avatarDom.profileBig, state.avatar);
      }
      // Client-side image resize → JPEG data-URL (≤ 256 × 256, ~quality 0.82)
      async function resizeImageToDataURL(file, maxDim){
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("decode_failed"));
            img.onload = () => {
              const w = img.naturalWidth, h = img.naturalHeight;
              const target = maxDim || 256;
              const scale = Math.min(1, target / Math.max(w, h));
              const dw = Math.max(1, Math.round(w * scale));
              const dh = Math.max(1, Math.round(h * scale));
              const c = document.createElement("canvas");
              c.width = dw; c.height = dh;
              const ctx = c.getContext("2d");
              // Cover-style square crop: paint resized image, then crop center to dw×dw
              ctx.drawImage(img, 0, 0, dw, dh);
              // Now crop to a square (smaller dimension)
              const side = Math.min(dw, dh);
              const sx = Math.round((dw - side) / 2);
              const sy = Math.round((dh - side) / 2);
              const c2 = document.createElement("canvas");
              c2.width = side; c2.height = side;
              c2.getContext("2d").drawImage(c, sx, sy, side, side, 0, 0, side, side);
              try{ resolve(c2.toDataURL("image/jpeg", 0.82)); }
              catch(e){ reject(e); }
            };
            img.src = reader.result;
          };
          reader.readAsDataURL(file);
        });
      }
      // ── Picker UI ──
      function openAvatarPicker(){
        if(!avatarDom.modal) return;
        // Initialize picker state from current avatar
        pickerAvatar = { type: state.avatar.type, value: state.avatar.value };
        renderAvatarPicker();
        avatarDom.modal.classList.add("show");
        avatarDom.modal.setAttribute("aria-hidden", "false");
      }
      function closeAvatarPicker(){
        if(!avatarDom.modal) return;
        avatarDom.modal.classList.remove("show");
        avatarDom.modal.setAttribute("aria-hidden", "true");
        if(avatarDom.uploadError) avatarDom.uploadError.textContent = "";
        if(avatarDom.fileInput) avatarDom.fileInput.value = "";
      }
      function setPickerTab(which){
        const tabs = { emoji: avatarDom.tabEmoji, initial: avatarDom.tabInitial, image: avatarDom.tabImage };
        const panes = { emoji: avatarDom.paneEmoji, initial: avatarDom.paneInitial, image: avatarDom.paneImage };
        for(const k of Object.keys(tabs)){
          if(tabs[k]) tabs[k].classList.toggle("active", k === which);
          if(panes[k]) panes[k].style.display = (k === which) ? "" : "none";
        }
      }
      function renderAvatarPicker(){
        // Emoji grid
        if(avatarDom.paneEmoji){
          const grid = avatarDom.paneEmoji;
          while(grid.firstChild) grid.removeChild(grid.firstChild);
          grid.className = "avatarEmojiGrid";
          for(const e of AVATAR_EMOJI_OPTIONS){
            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "avatarEmojiCell" + (pickerAvatar.type === "emoji" && pickerAvatar.value === e ? " selected" : "");
            cell.textContent = e;
            cell.addEventListener("click", () => {
              pickerAvatar = { type: "emoji", value: e };
              renderAvatarPicker();
            });
            grid.appendChild(cell);
          }
        }
        // Initial preview + color grid
        if(avatarDom.initialPreview){
          const color = (pickerAvatar.type === "initial") ? pickerAvatar.value : (state.avatar.type === "initial" ? state.avatar.value : AVATAR_COLOR_OPTIONS[0]);
          avatarDom.initialPreview.style.background = color;
          avatarDom.initialPreview.textContent = avatarInitialChar();
          avatarDom.initialPreview.style.color = "#fff";
        }
        if(avatarDom.colorGrid){
          const grid = avatarDom.colorGrid;
          while(grid.firstChild) grid.removeChild(grid.firstChild);
          for(const c of AVATAR_COLOR_OPTIONS){
            const cell = document.createElement("button");
            cell.type = "button";
            cell.className = "avatarColorCell" + (pickerAvatar.type === "initial" && pickerAvatar.value.toLowerCase() === c.toLowerCase() ? " selected" : "");
            cell.style.background = c;
            cell.setAttribute("aria-label", "Farbe " + c);
            cell.addEventListener("click", () => {
              pickerAvatar = { type: "initial", value: c };
              renderAvatarPicker();
            });
            grid.appendChild(cell);
          }
        }
        // Image preview
        if(avatarDom.uploadPreview){
          while(avatarDom.uploadPreview.firstChild) avatarDom.uploadPreview.removeChild(avatarDom.uploadPreview.firstChild);
          if(pickerAvatar.type === "image"){
            const img = document.createElement("img");
            img.src = pickerAvatar.value;
            avatarDom.uploadPreview.appendChild(img);
          } else {
            avatarDom.uploadPreview.textContent = "📷";
          }
        }
      }
      function bindAvatarPicker(){
        if(!avatarDom.modal) return;
        avatarDom.topbarBtn && avatarDom.topbarBtn.addEventListener("click", () => {
          // Click on the topbar avatar opens the profile-edit jump
          setTab("settings");
          setTimeout(() => {
            // Switch to profile sub-tab
            if(tplDom && tplDom.subTabProfile){ tplDom.subTabProfile.click(); }
          }, 30);
        });
        avatarDom.profileChangeBtn && avatarDom.profileChangeBtn.addEventListener("click", openAvatarPicker);
        avatarDom.closeBtn  && avatarDom.closeBtn.addEventListener("click", closeAvatarPicker);
        avatarDom.cancelBtn && avatarDom.cancelBtn.addEventListener("click", closeAvatarPicker);
        avatarDom.modal.addEventListener("click", (e) => { if(e.target === avatarDom.modal) closeAvatarPicker(); });
        avatarDom.tabEmoji   && avatarDom.tabEmoji.addEventListener("click",   () => setPickerTab("emoji"));
        avatarDom.tabInitial && avatarDom.tabInitial.addEventListener("click", () => setPickerTab("initial"));
        avatarDom.tabImage   && avatarDom.tabImage.addEventListener("click",   () => setPickerTab("image"));
        avatarDom.pickFileBtn && avatarDom.pickFileBtn.addEventListener("click", () => avatarDom.fileInput && avatarDom.fileInput.click());
        avatarDom.fileInput && avatarDom.fileInput.addEventListener("change", async (e) => {
          const file = e.target.files && e.target.files[0];
          if(!file) return;
          avatarDom.uploadError.textContent = "";
          try{
            const dataURL = await resizeImageToDataURL(file, 256);
            if(dataURL.length > 200000){
              avatarDom.uploadError.textContent = "Bild ist zu groß nach Komprimierung. Bitte ein anderes wählen.";
              return;
            }
            pickerAvatar = { type: "image", value: dataURL };
            renderAvatarPicker();
          } catch(err){
            avatarDom.uploadError.textContent = "Konnte Bild nicht laden. Anderes Format versuchen?";
          }
        });
        avatarDom.saveBtn && avatarDom.saveBtn.addEventListener("click", () => {
          if(!pickerAvatar || !isValidAvatar(pickerAvatar)){ uiError(); return; }
          state.avatar = { type: pickerAvatar.type, value: pickerAvatar.value };
          renderAvatarsEverywhere();
          persist();
          closeAvatarPicker();
          uiSave();
        });
      }

      // ════════════════════════════════════════════════════════════
      //   EMAIL CHANGE  (re-auth + sb.auth.updateUser({email}))
      // ════════════════════════════════════════════════════════════
      const emailChangeDom = {
        modal:    document.getElementById("emailChangeModal"),
        newEmail: document.getElementById("emailChangeNew"),
        password: document.getElementById("emailChangePassword"),
        error:    document.getElementById("emailChangeError"),
        note:     document.getElementById("emailChangeNote"),
        cancel:   document.getElementById("emailChangeCancel"),
        submit:   document.getElementById("emailChangeSubmit"),
        busy:     document.getElementById("emailChangeBusy"),
      };
      function openEmailChange(){
        if(!emailChangeDom.modal || !currentUser) return;
        emailChangeDom.newEmail.value = "";
        emailChangeDom.password.value = "";
        emailChangeDom.error.textContent = "";
        emailChangeDom.note.textContent  = "";
        emailChangeDom.busy.style.display = "none";
        emailChangeDom.modal.classList.add("show");
        emailChangeDom.modal.setAttribute("aria-hidden", "false");
        setTimeout(() => { try{ emailChangeDom.newEmail.focus(); }catch(_){} }, 60);
      }
      function closeEmailChange(){
        if(!emailChangeDom.modal) return;
        emailChangeDom.modal.classList.remove("show");
        emailChangeDom.modal.setAttribute("aria-hidden", "true");
      }
      async function submitEmailChange(){
        if(!sb || !currentUser) return;
        const newEmail = (emailChangeDom.newEmail.value || "").trim();
        const password = emailChangeDom.password.value || "";
        if(!newEmail || newEmail.indexOf("@") < 0){
          emailChangeDom.error.textContent = "Bitte eine gültige E-Mail-Adresse eingeben.";
          uiError(); return;
        }
        if(!password){
          emailChangeDom.error.textContent = "Bitte aktuelles Passwort zur Bestätigung eingeben.";
          uiError(); return;
        }
        emailChangeDom.error.textContent = "";
        emailChangeDom.note.textContent  = "";
        emailChangeDom.busy.style.display = "flex";
        emailChangeDom.submit.disabled = true;
        emailChangeDom.cancel.disabled = true;
        emailChangeDom.newEmail.disabled = true;
        emailChangeDom.password.disabled = true;
        try{
          // Re-authenticate first
          const { error: reauthErr } = await sb.auth.signInWithPassword({ email: currentUser.email, password });
          if(reauthErr){
            emailChangeDom.error.textContent = "Aktuelles Passwort falsch.";
            uiError();
            return;
          }
          // Trigger email change
          const { error } = await sb.auth.updateUser({ email: newEmail });
          if(error){
            emailChangeDom.error.textContent = translateAuthError(error);
            uiError();
            return;
          }
          emailChangeDom.note.textContent = "✓ Bestätigungsmail wurde an " + newEmail + " gesendet. Bis du den Link klickst, bleibt die alte Adresse aktiv.";
          uiSave();
          setTimeout(closeEmailChange, 1800);
        } catch(e){
          emailChangeDom.error.textContent = "Unerwarteter Fehler. Bitte erneut versuchen.";
          uiError();
        } finally {
          emailChangeDom.busy.style.display = "none";
          emailChangeDom.submit.disabled = false;
          emailChangeDom.cancel.disabled = false;
          emailChangeDom.newEmail.disabled = false;
          emailChangeDom.password.disabled = false;
        }
      }
      function bindEmailChangeEvents(){
        if(!emailChangeDom.modal) return;
        const editBtn = document.getElementById("profileEmailEditBtn");
        if(editBtn) editBtn.addEventListener("click", openEmailChange);
        emailChangeDom.cancel && emailChangeDom.cancel.addEventListener("click", closeEmailChange);
        emailChangeDom.submit && emailChangeDom.submit.addEventListener("click", submitEmailChange);
        emailChangeDom.modal.addEventListener("click", (e) => { if(e.target === emailChangeDom.modal) closeEmailChange(); });
        [emailChangeDom.newEmail, emailChangeDom.password].forEach(inp => {
          if(inp) inp.addEventListener("keydown", (e) => {
            if(e.key === "Enter"){ e.preventDefault(); submitEmailChange(); }
          });
        });
      }

      // ════════════════════════════════════════════════════════════
      //   PASSWORD CHANGE  (re-auth + sb.auth.updateUser({password}))
      // ════════════════════════════════════════════════════════════
      const pwChangeDom = {
        modal:  document.getElementById("passwordChangeModal"),
        oldPw:  document.getElementById("pwChangeOld"),
        newPw:  document.getElementById("pwChangeNew"),
        newPw2: document.getElementById("pwChangeNew2"),
        error:  document.getElementById("pwChangeError"),
        note:   document.getElementById("pwChangeNote"),
        cancel: document.getElementById("pwChangeCancel"),
        submit: document.getElementById("pwChangeSubmit"),
        busy:   document.getElementById("pwChangeBusy"),
      };
      function openPasswordChange(){
        if(!pwChangeDom.modal || !currentUser) return;
        pwChangeDom.oldPw.value  = "";
        pwChangeDom.newPw.value  = "";
        pwChangeDom.newPw2.value = "";
        pwChangeDom.error.textContent = "";
        pwChangeDom.note.textContent  = "";
        pwChangeDom.busy.style.display = "none";
        pwChangeDom.modal.classList.add("show");
        pwChangeDom.modal.setAttribute("aria-hidden", "false");
        setTimeout(() => { try{ pwChangeDom.oldPw.focus(); }catch(_){} }, 60);
      }
      function closePasswordChange(){
        if(!pwChangeDom.modal) return;
        pwChangeDom.modal.classList.remove("show");
        pwChangeDom.modal.setAttribute("aria-hidden", "true");
      }
      async function submitPasswordChange(){
        if(!sb || !currentUser) return;
        const oldPw = pwChangeDom.oldPw.value || "";
        const newPw = pwChangeDom.newPw.value || "";
        const newPw2 = pwChangeDom.newPw2.value || "";
        if(!oldPw || !newPw){
          pwChangeDom.error.textContent = "Bitte alle Felder ausfüllen.";
          uiError(); return;
        }
        if(newPw.length < 6){
          pwChangeDom.error.textContent = "Neues Passwort zu kurz (mindestens 6 Zeichen).";
          uiError(); return;
        }
        if(newPw !== newPw2){
          pwChangeDom.error.textContent = "Die beiden neuen Passwörter stimmen nicht überein.";
          uiError(); return;
        }
        if(newPw === oldPw){
          pwChangeDom.error.textContent = "Neues Passwort muss sich vom alten unterscheiden.";
          uiError(); return;
        }
        pwChangeDom.error.textContent = "";
        pwChangeDom.note.textContent  = "";
        pwChangeDom.busy.style.display = "flex";
        pwChangeDom.submit.disabled = true;
        pwChangeDom.cancel.disabled = true;
        [pwChangeDom.oldPw, pwChangeDom.newPw, pwChangeDom.newPw2].forEach(i => i && (i.disabled = true));
        try{
          // Re-auth with current password
          const { error: reauthErr } = await sb.auth.signInWithPassword({ email: currentUser.email, password: oldPw });
          if(reauthErr){
            pwChangeDom.error.textContent = "Aktuelles Passwort falsch.";
            uiError();
            return;
          }
          const { error } = await sb.auth.updateUser({ password: newPw });
          if(error){
            pwChangeDom.error.textContent = translateAuthError(error);
            uiError();
            return;
          }
          pwChangeDom.note.textContent = "✓ Passwort gespeichert.";
          uiSave();
          setTimeout(closePasswordChange, 1400);
        } catch(e){
          pwChangeDom.error.textContent = "Unerwarteter Fehler. Bitte erneut versuchen.";
          uiError();
        } finally {
          pwChangeDom.busy.style.display = "none";
          pwChangeDom.submit.disabled = false;
          pwChangeDom.cancel.disabled = false;
          [pwChangeDom.oldPw, pwChangeDom.newPw, pwChangeDom.newPw2].forEach(i => i && (i.disabled = false));
        }
      }
      function bindPasswordChangeEvents(){
        if(!pwChangeDom.modal) return;
        const editBtn = document.getElementById("profilePasswordEditBtn");
        if(editBtn) editBtn.addEventListener("click", openPasswordChange);
        pwChangeDom.cancel && pwChangeDom.cancel.addEventListener("click", closePasswordChange);
        pwChangeDom.submit && pwChangeDom.submit.addEventListener("click", submitPasswordChange);
        pwChangeDom.modal.addEventListener("click", (e) => { if(e.target === pwChangeDom.modal) closePasswordChange(); });
        [pwChangeDom.oldPw, pwChangeDom.newPw, pwChangeDom.newPw2].forEach(inp => {
          if(inp) inp.addEventListener("keydown", (e) => {
            if(e.key === "Enter"){ e.preventDefault(); submitPasswordChange(); }
          });
        });
      }

      // After login: enforce username presence (existing-account upgrade path)
      async function enforceUsernamePostLogin(){
        if(guestMode || !currentUser) return;
        try{
          const row = await fetchOwnUsernameRow(currentUser.id);
          if(row && row.username){
            state.username = row.username;
            return;
          }
          // No username yet → must set one before continuing.
          openUsernameRequiredModal();
        } catch(_){}
      }

      // ════════════════════════════════════════════════════════════
      //   INTERVAL TEMPLATES  (named presets of session settings)
      // ════════════════════════════════════════════════════════════
      const tplDom = {
        // Sub-tabs
        subTabIntervals: document.getElementById("subTabIntervals"),
        subTabProfile:   document.getElementById("subTabProfile"),
        subViewIntervals: document.getElementById("subViewIntervals"),
        subViewProfile:   document.getElementById("subViewProfile"),
        // Templates
        list:        document.getElementById("templatesList"),
        addBtn:      document.getElementById("templateAddBtn"),
        hint:        document.getElementById("templatesHint"),
        nameInput:   document.getElementById("activeTemplateName"),
        // Profile sub-view
        profileEmail: document.getElementById("profileEmail"),
        replayOnboardingBtn: document.getElementById("replayOnboardingBtn"),
        // Questionnaire
        qModal:    document.getElementById("questionnaireModal"),
        qGoal:     document.getElementById("qGoalHours"),
        qLearn:    document.getElementById("qLearnMin"),
        qSmall:    document.getElementById("qBreakSmall"),
        qBig:      document.getElementById("qBreakBig"),
        qToggle:   document.getElementById("qBigBreakToggle"),
        qPreview:  document.getElementById("qPreview"),
        qError:    document.getElementById("qError"),
        qSkip:     document.getElementById("qSkipBtn"),
        qSubmit:   document.getElementById("qSubmitBtn"),
      };

      function ensureAtLeastOneTemplate(){
        if(!Array.isArray(state.templates)) state.templates = [];
        if(state.templates.length === 0){
          // Bootstrap: create a "Standard"-template from current settings (or defaults)
          state.templates.push({
            id: genTemplateId(),
            name: "Standard",
            settings: snapshotSettingsForTemplate(),
          });
        }
        // Ensure activeTemplateId points at a real one
        if(!state.activeTemplateId || !state.templates.find(t => t.id === state.activeTemplateId)){
          state.activeTemplateId = state.templates[0].id;
        }
      }
      function getActiveTemplate(){
        if(!Array.isArray(state.templates)) return null;
        return state.templates.find(t => t.id === state.activeTemplateId) || state.templates[0] || null;
      }
      // Apply a template's settings to state.settings. Timer-side overrides
      // (session/break length, total count) are wiped — switching a template means
      // "start fresh from the template's plan and re-derive how much of today
      // already counts toward it".
      function applyTemplateSettings(template){
        if(!template || !template.settings) return;
        // Stop everything that may be running with the old plan
        workerStop(); diceTrackingStop(); stopAlarm();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        tickAnchor = null;
        state.running = false;
        state.alarmActive = false;
        Object.assign(state.settings, template.settings);
        // Drop all per-day timer modifications — the template is now authoritative again.
        resetTimerOverrides();
        recomputeTotalSessions();
        reconcileSessionArrays();
        // Re-derive how many sessions of the new plan today's logged minutes already cover.
        // Example: today=60min, switching to a template with 60-min intervals → session 0 is marked done.
        updateDataFromToday();
        // Phase / timer state: if not done, go to idle and prime timeLeft for the next phase.
        if(state.phase !== "done"){
          state.phase = "idle";
          state.curBreak = -1;
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = effectiveLearnSec(i);
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
          else if(k === null){ state.phase = "done"; state.timeLeft = 0; }
        }
      }
      function setActiveTemplate(id, opts){
        const t = state.templates.find(x => x.id === id);
        if(!t) return;
        state.activeTemplateId = id;
        applyTemplateSettings(t);
        if(opts && opts.suppressUiRefresh){ /* caller will re-render */ }
        else {
          renderTemplatesList();
          updateSettingsView();
          updateTimerUI();
          drawTrack();
        }
        persist();
      }
      // Called after any setting change to keep the active template in sync.
      // (Stepper / unit toggle / big-break toggle all funnel through applySettingChange,
      //  so we just hook in there.)
      function syncActiveTemplateFromSettings(){
        const t = getActiveTemplate();
        if(!t) return;
        t.settings = snapshotSettingsForTemplate();
      }
      function createTemplate(opts){
        if(state.templates.length >= MAX_TEMPLATES) return null;
        const desiredName = (opts && opts.name) ? opts.name : ("Neue Vorlage " + (state.templates.length + 1));
        const newT = {
          id: genTemplateId(),
          name: desiredName.slice(0, 40),
          settings: (opts && opts.settings) ? Object.assign(snapshotSettingsForTemplate(), opts.settings) : snapshotSettingsForTemplate(),
        };
        state.templates.push(newT);
        if(opts && opts.activate !== false){
          state.activeTemplateId = newT.id;
          applyTemplateSettings(newT);
        }
        return newT;
      }
      function deleteTemplate(id){
        const idx = state.templates.findIndex(t => t.id === id);
        if(idx < 0) return;
        const wasActive = state.activeTemplateId === id;
        state.templates.splice(idx, 1);
        if(state.templates.length === 0){
          // No templates left → recreate a default from current settings
          const fallback = {
            id: genTemplateId(),
            name: "Standard",
            settings: snapshotSettingsForTemplate(),
          };
          state.templates.push(fallback);
          state.activeTemplateId = fallback.id;
        } else if(wasActive){
          state.activeTemplateId = state.templates[0].id;
          applyTemplateSettings(state.templates[0]);
        }
        renderTemplatesList();
        updateSettingsView();
        updateTimerUI();
        drawTrack();
        persist();
      }
      function renameActiveTemplate(newName){
        const t = getActiveTemplate();
        if(!t) return;
        const trimmed = (newName || "").trim().slice(0, 40) || t.name;
        if(trimmed === t.name) return;
        t.name = trimmed;
        renderTemplatesList();
        persist();
      }
      function templateSummary(s){
        const goalMin = s.goal_unit === "h" ? s.goal_value * 60 : s.goal_value;
        const intervals = Math.min(16, Math.max(1, Math.round(goalMin / Math.max(1, s.learn_min))));
        const goalLabel = s.goal_unit === "h" ? (s.goal_value + "h") : (s.goal_value + " min");
        return `${goalLabel} · ${intervals}×${s.learn_min}m`;
      }
      function renderTemplatesList(){
        if(!tplDom.list) return;
        const list = tplDom.list;
        while(list.firstChild) list.removeChild(list.firstChild);
        const frag = document.createDocumentFragment();
        for(const t of (state.templates || [])){
          const row = document.createElement("div");
          row.className = "templateRow" + (t.id === state.activeTemplateId ? " active" : "");
          row.dataset.id = t.id;
          // Name (click → select)
          const name = document.createElement("div");
          name.className = "templateRowName";
          name.textContent = t.name;
          name.dataset.action = "select";
          name.dataset.id = t.id;
          row.appendChild(name);
          // Meta
          const meta = document.createElement("span");
          meta.className = "templateRowMeta";
          meta.textContent = templateSummary(t.settings);
          row.appendChild(meta);
          // Active badge
          if(t.id === state.activeTemplateId){
            const badge = document.createElement("span");
            badge.className = "templateActiveBadge";
            badge.textContent = "AKTIV";
            row.appendChild(badge);
          }
          // Delete
          const del = document.createElement("button");
          del.type = "button";
          del.className = "templateDelBtn";
          del.dataset.action = "delete";
          del.dataset.id = t.id;
          del.textContent = "✕";
          del.title = "Vorlage löschen";
          // Last template cannot be deleted (UX guard — deleteTemplate would re-create a default anyway)
          if(state.templates.length <= 1) del.disabled = true;
          row.appendChild(del);
          frag.appendChild(row);
        }
        list.appendChild(frag);
        // Add-button disabled when at limit
        if(tplDom.addBtn){
          const atMax = state.templates.length >= MAX_TEMPLATES;
          tplDom.addBtn.disabled = atMax;
          tplDom.addBtn.title = atMax ? "Maximum (10 Vorlagen) erreicht" : "Neue Vorlage anlegen";
        }
        if(tplDom.hint){
          tplDom.hint.textContent = `${state.templates.length} / ${MAX_TEMPLATES} Vorlagen · Klicke einen Namen, um sie zu aktivieren.`;
        }
        // Active-template name input
        if(tplDom.nameInput){
          const active = getActiveTemplate();
          if(active && document.activeElement !== tplDom.nameInput){
            tplDom.nameInput.value = active.name;
          }
        }
      }
      // Delegate clicks inside the template list
      function bindTemplateListEvents(){
        if(!tplDom.list) return;
        tplDom.list.addEventListener("click", (e) => {
          const target = e.target.closest("[data-action]");
          if(!target) return;
          const id = target.dataset.id;
          if(target.dataset.action === "select"){
            if(id && id !== state.activeTemplateId){
              setActiveTemplate(id);
              uiSoftClick();
            }
          } else if(target.dataset.action === "delete"){
            if(target.disabled) return;
            deleteTemplate(id);
            uiSoftClick();
          }
        });
        if(tplDom.addBtn){
          tplDom.addBtn.addEventListener("click", () => {
            if(tplDom.addBtn.disabled) return;
            createTemplate({});
            renderTemplatesList();
            updateSettingsView();
            updateTimerUI();
            drawTrack();
            persist();
            uiSoftClick();
            // Focus the name input so the user can rename right away
            setTimeout(() => { try{ tplDom.nameInput && tplDom.nameInput.select(); }catch(_){} }, 50);
          });
        }
        if(tplDom.nameInput){
          tplDom.nameInput.addEventListener("input", () => {
            renameActiveTemplate(tplDom.nameInput.value);
          });
          tplDom.nameInput.addEventListener("blur", () => {
            // Snap back to clamped value
            const t = getActiveTemplate();
            if(t) tplDom.nameInput.value = t.name;
          });
        }
      }

      // ── Settings sub-tab switching ───────────────────────────────
      function bindSubTabSwitch(){
        if(!tplDom.subTabIntervals) return;
        function show(which){
          const isIntervals = which === "intervals";
          tplDom.subTabIntervals.classList.toggle("active", isIntervals);
          tplDom.subTabProfile.classList.toggle("active", !isIntervals);
          tplDom.subViewIntervals.style.display = isIntervals ? "" : "none";
          tplDom.subViewProfile.style.display  = isIntervals ? "none" : "";
          if(!isIntervals){
            // Refresh profile info on entry
            if(tplDom.profileEmail){
              tplDom.profileEmail.textContent = (currentUser && currentUser.email) ? currentUser.email : (guestMode ? "Gast-Modus" : "—");
            }
            // Avatar refresh
            renderAvatarInto(avatarDom.profileBig, state.avatar);
            // Email/password edit buttons require a logged-in account
            const emailBtn = document.getElementById("profileEmailEditBtn");
            const pwBtn    = document.getElementById("profilePasswordEditBtn");
            const isLoggedIn = !!(currentUser && !guestMode);
            if(emailBtn) emailBtn.disabled = !isLoggedIn;
            if(pwBtn)    pwBtn.disabled    = !isLoggedIn;
            if(avatarDom.profileChangeBtn) avatarDom.profileChangeBtn.disabled = false; // avatar works in guest mode (in-memory)
            // Username: fetch fresh (last_changed_at may have moved) and render.
            // In guest mode there's no row → just blank out the row.
            if(currentUser && !guestMode){
              loadAndRenderProfileUsername();
            } else {
              renderProfileUsernameRow("", null);
              if(authDom.profileUsernameInput) authDom.profileUsernameInput.disabled = true;
              if(authDom.profileUsernameSave)  authDom.profileUsernameSave.disabled = true;
              if(authDom.profileUsernameSub)   authDom.profileUsernameSub.textContent = "Nutzername wird nur für angemeldete Konten gespeichert.";
            }
          }
        }
        tplDom.subTabIntervals.addEventListener("click", () => { show("intervals"); uiTabSwitch(); });
        tplDom.subTabProfile.addEventListener("click",   () => { show("profile");  uiTabSwitch(); });
        // "Tour neu zeigen"-Button im Profil
        if(tplDom.replayOnboardingBtn){
          tplDom.replayOnboardingBtn.addEventListener("click", () => {
            openOnboardingTour();
            uiSoftClick();
          });
        }
      }
      // Ensure sub-tab returns to "intervals" each time settings is opened.
      function resetSettingsSubTab(){
        if(!tplDom.subTabIntervals) return;
        tplDom.subTabIntervals.classList.add("active");
        tplDom.subTabProfile.classList.remove("active");
        if(tplDom.subViewIntervals) tplDom.subViewIntervals.style.display = "";
        if(tplDom.subViewProfile)   tplDom.subViewProfile.style.display  = "none";
      }

      // ════════════════════════════════════════════════════════════
      //   INITIAL QUESTIONNAIRE
      // ════════════════════════════════════════════════════════════
      function openQuestionnaire(prefillFromSettings){
        if(!tplDom.qModal) return;
        // Prefill from current settings (or defaults if none yet)
        const s = state.settings;
        const goalHours = s.goal_unit === "h" ? s.goal_value : (s.goal_value / 60);
        if(tplDom.qGoal)   tplDom.qGoal.value   = String(Math.max(0.5, Math.round(goalHours * 2) / 2));
        if(tplDom.qLearn)  tplDom.qLearn.value  = String(s.learn_min);
        if(tplDom.qSmall)  tplDom.qSmall.value  = String(s.break_odd_min);
        if(tplDom.qBig)    tplDom.qBig.value    = String(s.break_even_min);
        if(tplDom.qToggle) tplDom.qToggle.setAttribute("aria-pressed", String(!!s.big_break_enabled));
        if(tplDom.qError)  tplDom.qError.textContent = "";
        renderQuestionnairePreview();
        tplDom.qModal.classList.add("show");
        tplDom.qModal.setAttribute("aria-hidden", "false");
      }
      function closeQuestionnaire(){
        if(!tplDom.qModal) return;
        tplDom.qModal.classList.remove("show");
        tplDom.qModal.setAttribute("aria-hidden", "true");
      }
      function renderQuestionnairePreview(){
        if(!tplDom.qPreview) return;
        const goalH  = parseFloat(tplDom.qGoal.value)  || 0;
        const learn  = parseFloat(tplDom.qLearn.value) || 0;
        if(goalH <= 0 || learn <= 0){ tplDom.qPreview.textContent = ""; return; }
        const goalMin = Math.round(goalH * 60);
        const intervals = Math.min(16, Math.max(1, Math.round(goalMin / learn)));
        tplDom.qPreview.innerHTML = `Daraus ergeben sich <strong>${intervals}</strong> Lernintervalle à <strong>${Math.round(learn)}</strong> Min.`;
      }
      function submitQuestionnaire(){
        // Validate
        const goalH = parseFloat(tplDom.qGoal.value);
        const learn = parseInt(tplDom.qLearn.value, 10);
        const small = parseInt(tplDom.qSmall.value, 10);
        const big   = parseInt(tplDom.qBig.value, 10);
        const bigEnabled = tplDom.qToggle.getAttribute("aria-pressed") === "true";
        if(!Number.isFinite(goalH) || goalH < 0.5){ tplDom.qError.textContent = "Lernziel muss mindestens 0,5 Stunden sein."; return; }
        if(!Number.isFinite(learn) || learn < 5){  tplDom.qError.textContent = "Intervalldauer muss mindestens 5 Minuten sein."; return; }
        if(!Number.isFinite(small) || small < 1){  tplDom.qError.textContent = "Kleine Pause muss mindestens 1 Minute sein."; return; }
        if(!Number.isFinite(big)   || big   < 1){  tplDom.qError.textContent = "Große Pause muss mindestens 1 Minute sein."; return; }
        const newSettings = {
          goal_value: goalH, goal_unit: "h",
          learn_min: clamp(learn, 5, 240),
          break_odd_min: clamp(small, 1, 120),
          break_even_min: clamp(big, 1, 120),
          big_break_enabled: !!bigEnabled,
          big_break_after: state.settings.big_break_after || 4,
          big_break_min:   state.settings.big_break_min   || 180,
        };
        // Replace ALL templates with a single fresh "Mein Plan" from the questionnaire.
        // (Existing data is meaningless on first launch — this is what the user just asked for.)
        state.templates = [];
        const created = createTemplate({ name: "Mein Plan", settings: newSettings, activate: true });
        if(created){
          applyTemplateSettings(created);
        }
        state.questionnaireDone = true;
        closeQuestionnaire();
        renderTemplatesList();
        updateSettingsView();
        updateTimerUI();
        drawTrack();
        persist();
        uiSave();
      }
      function skipQuestionnaire(){
        // User wants defaults — no new template, just keep "Standard" + mark done.
        state.questionnaireDone = true;
        ensureAtLeastOneTemplate();
        closeQuestionnaire();
        renderTemplatesList();
        updateSettingsView();
        persist();
      }
      function maybeShowQuestionnaire(){
        if(guestMode){
          // Guests get the questionnaire EVERY visit (state isn't persisted)
          setTimeout(() => openQuestionnaire(true), 200);
          return;
        }
        if(!currentUser) return;
        // Logged-in users see it only on first run (after questionnaire is filled or skipped, never again)
        if(!state.questionnaireDone){
          setTimeout(() => openQuestionnaire(true), 200);
        }
      }
      function bindQuestionnaireEvents(){
        if(!tplDom.qModal) return;
        if(tplDom.qSubmit) tplDom.qSubmit.addEventListener("click", submitQuestionnaire);
        if(tplDom.qSkip)   tplDom.qSkip.addEventListener("click", skipQuestionnaire);
        [tplDom.qGoal, tplDom.qLearn, tplDom.qSmall, tplDom.qBig].forEach(inp => {
          if(inp) inp.addEventListener("input", renderQuestionnairePreview);
        });
        if(tplDom.qToggle){
          tplDom.qToggle.addEventListener("click", () => {
            const cur = tplDom.qToggle.getAttribute("aria-pressed") === "true";
            tplDom.qToggle.setAttribute("aria-pressed", String(!cur));
            uiToggle();
          });
        }
      }

      // ════════════════════════════════════════════════════════════
      //   BETA GATE  (closed-beta paywall — shown before EVERYTHING else)
      //   Password is intentionally simple; this is UX gating, not security.
      // ════════════════════════════════════════════════════════════
      const BETA_PASSWORD = "FLOW";
      const BETA_SESSION_KEY = "proko_beta_unlocked_v1";
      function isBetaUnlocked(){
        try{ return sessionStorage.getItem(BETA_SESSION_KEY) === "true"; }
        catch(_){ return false; }
      }
      function lockBetaGate(){
        const gate = document.getElementById("betaGate");
        if(gate) gate.classList.remove("hidden");
        document.body.classList.add("beta-locked");
      }
      function unlockBetaGate(){
        try{ sessionStorage.setItem(BETA_SESSION_KEY, "true"); }catch(_){}
        const gate = document.getElementById("betaGate");
        if(gate) gate.classList.add("hidden");
        document.body.classList.remove("beta-locked");
      }
      function setupBetaGate(){
        const gate   = document.getElementById("betaGate");
        const input  = document.getElementById("betaGateInput");
        const submit = document.getElementById("betaGateSubmit");
        const err    = document.getElementById("betaGateError");
        if(!gate || !input || !submit) return Promise.resolve(true); // be defensive
        // Already unlocked in this session?
        if(isBetaUnlocked()){
          gate.classList.add("hidden");
          document.body.classList.remove("beta-locked");
          return Promise.resolve(true);
        }
        // Show + wait for correct password
        document.body.classList.add("beta-locked");
        gate.classList.remove("hidden");
        return new Promise((resolve) => {
          function tryUnlock(){
            const val = (input.value || "").trim();
            if(val.toUpperCase() === BETA_PASSWORD){
              err.textContent = "";
              unlockBetaGate();
              resolve(true);
            } else {
              err.textContent = "Falsches Passwort. Bitte erneut versuchen.";
              input.value = "";
              input.focus();
            }
          }
          submit.addEventListener("click", tryUnlock);
          input.addEventListener("keydown", (e) => {
            if(e.key === "Enter"){ e.preventDefault(); tryUnlock(); }
          });
          // Focus input right away
          setTimeout(() => { try{ input.focus(); }catch(_){} }, 60);
        });
      }

      async function bootstrap(){
        // Block EVERYTHING behind the beta gate first. If the user can't get past this,
        // no Supabase calls happen, no UI is reachable, no imprint/privacy is shown.
        await setupBetaGate();

        if(!sb){
          // No SDK → show error in modal and keep app blocked
          blockApp(); showAuthModal();
          setAuthError("Supabase-SDK konnte nicht geladen werden. Internet prüfen.");
          if(authDom.logoutBtn) authDom.logoutBtn.disabled = true;
          return;
        }
        // Wire auth UI events (idempotent, runs once)
        authDom.tabLogin.addEventListener("click", () => { if(!authDom.tabLogin.disabled) setAuthMode("login"); });
        authDom.tabRegister.addEventListener("click", () => { if(!authDom.tabRegister.disabled) setAuthMode("register"); });
        authDom.submit.addEventListener("click", authSubmitHandler);
        authDom.email.addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); authSubmitHandler(); } });
        authDom.password.addEventListener("keydown", (e) => { if(e.key === "Enter"){ e.preventDefault(); authSubmitHandler(); } });
        if(authDom.logoutBtn) authDom.logoutBtn.addEventListener("click", logout);
        if(authDom.guestBtn) authDom.guestBtn.addEventListener("click", () => {
          if(authDom.guestBtn.disabled) return;
          enterGuestMode();
        });
        // "Passwort vergessen?" link
        if(authDom.forgotLink) authDom.forgotLink.addEventListener("click", () => {
          if(authDom.forgotLink.disabled) return;
          setAuthMode("forgot");
        });
        // Legal modals (footer + close buttons + backdrop click)
        if(authDom.imprintOpen) authDom.imprintOpen.addEventListener("click", () => openLegalModal(authDom.imprintModal));
        if(authDom.imprintClose) authDom.imprintClose.addEventListener("click", () => closeLegalModal(authDom.imprintModal));
        if(authDom.imprintModal) authDom.imprintModal.addEventListener("click", (e) => { if(e.target === authDom.imprintModal) closeLegalModal(authDom.imprintModal); });
        if(authDom.privacyOpen) authDom.privacyOpen.addEventListener("click", () => openLegalModal(authDom.privacyModal));
        if(authDom.privacyClose) authDom.privacyClose.addEventListener("click", () => closeLegalModal(authDom.privacyModal));
        if(authDom.privacyModal) authDom.privacyModal.addEventListener("click", (e) => { if(e.target === authDom.privacyModal) closeLegalModal(authDom.privacyModal); });
        // Account deletion (two-step)
        if(authDom.deleteAccountBtn) authDom.deleteAccountBtn.addEventListener("click", openDeleteAccountModal);
        if(authDom.deleteCancel) authDom.deleteCancel.addEventListener("click", closeDeleteAccountModal);
        if(authDom.deleteConfirm) authDom.deleteConfirm.addEventListener("click", performAccountDeletion);
        if(authDom.deleteModal) authDom.deleteModal.addEventListener("click", (e) => { if(e.target === authDom.deleteModal) closeDeleteAccountModal(); });
        if(authDom.deletePassword) authDom.deletePassword.addEventListener("keydown", (e) => {
          if(e.key === "Enter"){ e.preventDefault(); performAccountDeletion(); }
        });
        // Onboarding controls
        if(authDom.onboardNext) authDom.onboardNext.addEventListener("click", () => {
          if(onboardStepIdx < ONBOARD_TOTAL_STEPS - 1){ onboardStepIdx++; renderOnboardingStep(); }
          else { closeOnboardingTour(true); }
        });
        if(authDom.onboardBack) authDom.onboardBack.addEventListener("click", () => {
          if(onboardStepIdx > 0){ onboardStepIdx--; renderOnboardingStep(); }
        });
        if(authDom.onboardSkip) authDom.onboardSkip.addEventListener("click", () => closeOnboardingTour(true));
        // Escape closes legal/delete/onboarding modals (without dismissing onboarding permanently)
        document.addEventListener("keydown", (e) => {
          if(e.key !== "Escape") return;
          if(authDom.imprintModal && authDom.imprintModal.classList.contains("show")){ closeLegalModal(authDom.imprintModal); return; }
          if(authDom.privacyModal && authDom.privacyModal.classList.contains("show")){ closeLegalModal(authDom.privacyModal); return; }
          if(authDom.deleteModal  && authDom.deleteModal.classList.contains("show")){ closeDeleteAccountModal(); return; }
        });
        // Detect password-recovery redirect from the email link.
        // Supabase puts `#access_token=...&type=recovery` in the URL hash.
        (function detectRecoveryHash(){
          try{
            const hash = window.location.hash || "";
            if(!hash || hash.length < 2) return;
            // Hash looks like "#access_token=...&type=recovery&..." — parse robustly.
            const params = new URLSearchParams(hash.substring(1));
            if(params.get("type") === "recovery"){
              recoveryMode = true;
              setTimeout(() => {
                blockApp();
                showAuthModal();
                setAuthMode("reset");
                hideLoading();
              }, 0);
            }
          }catch(_){}
        })();
        // React to auth state changes (login/logout, token refresh, initial restore)
        sb.auth.onAuthStateChange((event, session) => {
          // ALWAYS keep a synchronously-readable copy of the access token so unload-flush
          // works without an async getSession() round-trip.
          cacheAccessToken(session);
          // Recovery flow: when Supabase processes the recovery token, it fires PASSWORD_RECOVERY.
          if(event === "PASSWORD_RECOVERY"){
            recoveryMode = true;
            blockApp();
            showAuthModal();
            setAuthMode("reset");
            hideLoading();
            return;
          }
          if((event === "SIGNED_IN" || event === "INITIAL_SESSION") && session && session.user){
            // Don't auto-login a recovery session — the user must first set a new password.
            if(recoveryMode){
              blockApp();
              showAuthModal();
              setAuthMode("reset");
              return;
            }
            // Avoid double-handling if bootstrap() already drove the initial signed-in path
            if(!currentUser) handleSignedIn(session.user);
          } else if(event === "TOKEN_REFRESHED"){
            // Token rotated by SDK — already cached above
          } else if(event === "SIGNED_OUT"){
            handleSignedOut();
          }
        });
        // Wire one-time save-lifecycle hooks (visibilitychange / pagehide / beforeunload / online)
        setupSaveLifecycleHooks();
        // Block UI immediately, then check existing session
        blockApp();
        showLoading("Verbindung wird hergestellt…");
        if(authDom.logoutBtn) authDom.logoutBtn.disabled = true;
        try{
          const { data: { session } } = await sb.auth.getSession();
          cacheAccessToken(session);
          if(session && session.user){
            // CRITICAL: if this is a recovery session (user clicked the email link),
            // DO NOT auto-login. Show the "set new password" modal instead.
            if(recoveryMode){
              blockApp();
              showAuthModal();
              setAuthMode("reset");
              hideLoading();
            } else {
              await handleSignedIn(session.user);
            }
          } else {
            hideLoading();
            // If recoveryMode was already detected via hash but session not yet established,
            // the auth modal is already up via detectRecoveryHash() — don't overwrite it.
            if(!recoveryMode) showAuthModal();
          }
        } catch(e){
          console.warn("[bootstrap] session check failed", e);
          hideLoading();
          showAuthModal();
          setAuthError("Verbindung zur Cloud fehlgeschlagen. Bitte erneut versuchen.");
        }
      }
      // (Old beforeunload getSession()-based handler removed — replaced by setupSaveLifecycleHooks()
      //  which uses cached token + visibilitychange/pagehide/beforeunload/online.)

      // Kick off the auth flow (replaces the synchronous init() at module load)
      bootstrap();

      window.__proko = { saveSettings, resetDefaults, startOrPause, skipPhase, resetAll, state, logout, supabase: sb };
      // Backwards-compat alias — old console snippets may still reference window.__lernplan
      window.__lernplan = window.__proko;
    })();

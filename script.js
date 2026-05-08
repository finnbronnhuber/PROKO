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
      const STORAGE_KEY = "lernplan_browser_v1";
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
      function todayISO(){ return new Date().toISOString().slice(0,10); }
      function yesterdayISO(){ const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0,10); }
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
          const key = d.toISOString().slice(0,10);
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
        const s = state.settings;
        const goalMin = computeGoalMin(s);
        const raw = Math.max(1, Math.round(goalMin / Math.max(1, s.learn_min)));
        TOTAL_SESSIONS = Math.min(MAX_SESSIONS, raw);
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

      function loadState(){
        const base = {
          theme: "dark",
          settings: deepClone(DEFAULT_SETTINGS),
          data: {},
          sessionIdx: 0, phase: "idle",
          timeLeft: DEFAULT_SETTINGS.learn_min * 60,
          sessionsDone: Array(TOTAL_SESSIONS).fill(false),
          breaksDone: Array(TOTAL_SESSIONS - 1).fill(false),
          curBreak: -1, running: false, alarmActive: false, compact: false,
          // NEW fields
          points: 0,
          pendingRolls: 0,
          pendingRollBonuses: [], // [{streak:bool, surpass:bool}, ...] — same length as pendingRolls
          diceStreak: 0,
          soundEnabled: true,
          // Per-day per-session task lists: { "YYYY-MM-DD": { "0": [{id,text,done,doneAt,star},…], … } }
          intervalTasks: {},
          // Flat archive of completed tasks: [{id, text, sessionIdx, day, completedAt}, …] (max 500)
          completedHistory: [],
          // Dice timer (decoupled from session length): runs 30 min during active learning, then grants 1 roll
          diceTimerLeft: 1800,
          diceLearnedTodayMin: 0,
          diceLastFireDay: "",
        };
        try{
          const raw = localStorage.getItem(STORAGE_KEY);
          if(!raw) return base;
          const p = JSON.parse(raw);
          if(p && typeof p === "object"){
            if(p.theme === "light" || p.theme === "dark") base.theme = p.theme;
            if(p.settings && typeof p.settings === "object"){
              const ps = p.settings;
              // Migrate legacy keys
              if(Number.isFinite(ps.short_break_min) && !Number.isFinite(ps.break_odd_min)) ps.break_odd_min = ps.short_break_min;
              if(Number.isFinite(ps.long_break_min) && !Number.isFinite(ps.break_even_min)) ps.break_even_min = ps.long_break_min;
              // Numeric settings with per-key clamps
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
            // Reconcile bonuses array length with pendingRolls (older saves)
            while(base.pendingRollBonuses.length < base.pendingRolls) base.pendingRollBonuses.push({ streak:false, surpass:false });
            if(base.pendingRollBonuses.length > base.pendingRolls) base.pendingRollBonuses.length = base.pendingRolls;
            if(Number.isFinite(p.diceStreak)) base.diceStreak = Math.max(0, Math.floor(p.diceStreak));
            if(typeof p.soundEnabled === "boolean") base.soundEnabled = p.soundEnabled;
            if(p.intervalTasks && typeof p.intervalTasks === "object") base.intervalTasks = p.intervalTasks;
            if(Array.isArray(p.completedHistory)) base.completedHistory = p.completedHistory.slice(-500);
            if(Number.isFinite(p.diceTimerLeft)) base.diceTimerLeft = clamp(Math.floor(p.diceTimerLeft), 0, 1800);
            if(Number.isFinite(p.diceLearnedTodayMin)) base.diceLearnedTodayMin = Math.max(0, Math.floor(p.diceLearnedTodayMin));
            if(typeof p.diceLastFireDay === "string") base.diceLastFireDay = p.diceLastFireDay;
          }
        }catch(e){}
        return base;
      }
      function persist(){
        try{
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
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
          }));
        }catch(e){}
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
      function updateLegends(){
        dom.legendLearn.textContent = `Lernen ${state.settings.learn_min} Min`;
        dom.legendShort.textContent = `Ungerade Pause ${state.settings.break_odd_min} Min`;
        dom.legendLong.textContent = `Gerade Pause ${state.settings.break_even_min} Min`;
        if(dom.legendBigItem){
          if(state.settings.big_break_enabled){
            dom.legendBigItem.style.display = "";
            dom.legendBig.textContent = `Große Pause ${state.settings.big_break_min} Min`;
          } else {
            dom.legendBigItem.style.display = "none";
          }
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
        if(state.phase === "learning") return state.settings.learn_min * 60;
        if(state.phase === "break"){
          return breakMinAt(state.curBreak >= 0 ? state.curBreak : 0) * 60;
        }
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") return state.settings.learn_min * 60;
          if(k === "break") return breakMinAt(i) * 60;
        }
        return state.settings.learn_min * 60;
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
        const doneMin = state.sessionsDone.filter(Boolean).length * state.settings.learn_min;
        const h = Math.floor(doneMin / 60), m = doneMin % 60;
        const goalMin = computeGoalMin(state.settings);
        const goalStr = formatGoalLabel(state.settings);
        if(doneMin === 0) return `0h 00m / ${goalStr}`;
        if(doneMin >= goalMin) return `${h}h ${String(m).padStart(2,"0")}m / ${goalStr} ✓`;
        return `${h}h ${String(m).padStart(2,"0")}m / ${goalStr}`;
      }
      function updateTopInfo(){
        const totalMin = TOTAL_SESSIONS * state.settings.learn_min;
        const h = Math.floor(totalMin / 60), m = totalMin % 60;
        const totalStr = m ? `${h}h ${String(m).padStart(2,"0")}m` : `${h} Stunden`;
        dom.topInfo.textContent = `${totalStr}  ·  ${TOTAL_SESSIONS} Einheiten à ${state.settings.learn_min} Min`;
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
      // ── Heavy, full UI update: status, buttons, legends, etc. (only on phase/state change) ──
      function updateTimerUI(){
        updateTimerTickUI();
        setText(dom.progressText, "progressText", progressText());
        // Top info
        const totalMin = TOTAL_SESSIONS * state.settings.learn_min;
        const th = Math.floor(totalMin / 60), tm = totalMin % 60;
        const totalStr = tm ? `${th}h ${String(tm).padStart(2,"0")}m` : `${th} Stunden`;
        setText(dom.topInfo, "topInfo", `${totalStr}  ·  ${TOTAL_SESSIONS} Einheiten à ${state.settings.learn_min} Min`);
        // Legends
        setText(dom.legendLearn, "legendLearn", `Lernen ${state.settings.learn_min} Min`);
        setText(dom.legendShort, "legendShort", `Ungerade Pause ${state.settings.break_odd_min} Min`);
        setText(dom.legendLong, "legendLong", `Gerade Pause ${state.settings.break_even_min} Min`);
        if(dom.legendBigItem){
          if(state.settings.big_break_enabled){
            dom.legendBigItem.style.display = "";
            setText(dom.legendBig, "legendBig", `Große Pause ${state.settings.big_break_min} Min`);
          } else {
            dom.legendBigItem.style.display = "none";
          }
        }
        updateRewardBadge();
        updatePointsDisplay();
        updateCompactStar();
        // Status
        let statusStr;
        if(state.phase === "learning"){
          statusStr = `Lerneinheit ${state.sessionIdx + 1} von ${TOTAL_SESSIONS}`;
        }else if(state.phase === "break"){
          const k = breakKindAt(state.curBreak);
          const mins = breakMinAt(state.curBreak);
          const lbl = k === "big" ? "Große Pause" : (k === "odd" ? "Pause (ungerade)" : "Pause (gerade)");
          statusStr = `${lbl} — ${mins} Minuten`;
        }else if(state.phase === "idle"){
          const done = state.sessionsDone.filter(Boolean).length;
          const [k, i] = nextTarget();
          if(k === "session") statusStr = done > 0 ? `Bereit — Einheit ${i + 1} von ${TOTAL_SESSIONS}` : `Bereit — Lerneinheit 1 von ${TOTAL_SESSIONS}`;
          else if(k === "break"){
            const kind = breakKindAt(i);
            const mins = breakMinAt(i);
            const lbl = kind === "big" ? "große Pause" : (kind === "odd" ? "ungerade Pause" : "gerade Pause");
            statusStr = `Bereit — ${lbl} (${mins} Min)`;
          }else statusStr = "Alle Einheiten erledigt";
        }else{
          statusStr = `Tagesziel erreicht! (${formatGoalLabel(state.settings)})`;
        }
        setText(dom.statusText, "statusText", statusStr);
        setText(dom.compactStatus, "compactStatus", statusStr);
        // Buttons
        const startTxt = state.alarmActive ? "🔔  Alarm aus" : (state.running ? "⏸  Pause" : (state.phase === "done" ? "✓  Fertig" : "▶  Start"));
        const compactToggleTxt = state.alarmActive ? "🔔" : (state.running ? "⏸" : (state.phase === "done" ? "✓" : "▶"));
        const startDisabled = state.phase === "done" && !state.alarmActive;
        setText(dom.startBtn, "startBtn", startTxt);
        setText(dom.compactToggle, "compactToggle", compactToggleTxt);
        setBoolProp(dom.startBtn, "startDisabled", "disabled", startDisabled);
        setBoolProp(dom.compactToggle, "compactToggleDisabled", "disabled", startDisabled);
        const skipDis = state.phase !== "break";
        setBoolProp(dom.skipBtn, "skipDisabled", "disabled", skipDis);
        setText(dom.skipBtn, "skipText", state.phase === "break" ? "Pause überspringen" : "Überspringen");
        const finishDisp = state.phase === "done" ? "flex" : "none";
        if(lastWritten.finishDisplay !== finishDisp){ lastWritten.finishDisplay = finishDisp; dom.finishBox.style.display = finishDisp; }
        const today = todayISO();
        if(state.data[`${today}_celebrated`]){
          setText(dom.celebrateBtn, "celebrateText", "Heute bereits abgeschlossen ✓");
          setBoolProp(dom.celebrateBtn, "celebrateDisabled", "disabled", true);
        }else{
          setText(dom.celebrateBtn, "celebrateText", "Ja, fertig mit Lernen für heute!");
          setBoolProp(dom.celebrateBtn, "celebrateDisabled", "disabled", false);
        }
        if(dom.learnNum) setText(dom.learnNum, "learnNum", String(state.settings.learn_min));
        if(dom.oddNum) setText(dom.oddNum, "oddNum", String(state.settings.break_odd_min));
        if(dom.evenNum) setText(dom.evenNum, "evenNum", String(state.settings.break_even_min));
        if(dom.bigAfterNum) setText(dom.bigAfterNum, "bigAfterNum", String(state.settings.big_break_after));
        if(dom.bigMinNum) setText(dom.bigMinNum, "bigMinNum", String(state.settings.big_break_min));
        if(dom.intervalsNum) setText(dom.intervalsNum, "intervalsNum", String(TOTAL_SESSIONS));
        const goalMin = computeGoalMin(state.settings);
        const goalStr = formatGoalLabel(state.settings);
        const diff = totalMin - goalMin;
        const note = diff === 0 ? `= ${goalStr}-Tagesziel` : (diff < 0 ? `(${-diff} Min unter dem ${goalStr}-Ziel)` : `(${diff} Min über dem ${goalStr}-Ziel)`);
        setText(dom.totalInfo, "totalInfo", `${TOTAL_SESSIONS} Einheiten ergeben ${th}h ${String(tm).padStart(2,"0")}m Lernzeit  ${note}`);
        applyDiceLockState();
      }
      // Backwards-compat aliases (the old code calls these in places)
      function updateLegendsLite(){
        setText(dom.legendLearn, "legendLearn", `Lernen ${state.settings.learn_min} Min`);
        setText(dom.legendShort, "legendShort", `Ungerade Pause ${state.settings.break_odd_min} Min`);
        setText(dom.legendLong, "legendLong", `Gerade Pause ${state.settings.break_even_min} Min`);
      }

      function recordSession(minutes){ const key = todayISO(); state.data[key] = Math.max(0, (Number(state.data[key]) || 0) + minutes); }
      function unrecordSession(minutes){ const key = todayISO(); const next = Math.max(0, (Number(state.data[key]) || 0) - minutes); if(next <= 0) delete state.data[key]; else state.data[key] = next; }
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
        if(k === "session"){ state.sessionIdx = i; state.curBreak = -1; state.timeLeft = state.settings.learn_min * 60; }
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
        state.running = false;
        workerStop();
        tickAnchor = null;
        diceTrackingStop();
        if(state.phase === "learning"){
          state.sessionsDone[state.sessionIdx] = true;
          recordSession(state.settings.learn_min);
          // Carry unfinished tasks to the next interval (if any)
          carryOverTasks(state.sessionIdx);
          // NOTE: rolls are now granted by the decoupled dice timer (every 30 min of active learning),
          // not by session completion.
          if(state.sessionIdx === TOTAL_SESSIONS - 1){
            state.phase = "done"; state.timeLeft = 0; updateTimerUI(); drawTrack();
            if(silent) showFinish(); else { state.alarmActive = true; updateTimerUI(); startAlarm(); }
            persist(); return;
          }
          state.curBreak = state.sessionIdx;
          state.phase = "break";
          state.timeLeft = breakMinAt(state.curBreak) * 60;
        }else if(state.phase === "break"){
          state.breaksDone[state.curBreak] = true;
          state.sessionIdx += 1;
          state.phase = "learning";
          state.timeLeft = state.settings.learn_min * 60;
        }else return;
        updateTimerUI(); drawTrack(); persist();
        if(!silent){ state.alarmActive = true; startAlarm(); }
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
          if(k === "session"){ state.phase = "learning"; state.sessionIdx = i; state.timeLeft = state.settings.learn_min * 60; }
          else { state.phase = "break"; state.curBreak = i; state.timeLeft = breakMinAt(i) * 60; }
          updateTimerUI();
        }
        state.running = !state.running;
        if(state.running){
          startTickAnchor();
          workerStart();
          if(state.phase === "learning") diceTrackingStart();
        } else {
          workerStop();
          tickAnchor = null;
          diceTrackingStop();
        }
        persist(); updateTimerUI();
      }
      function skipPhase(){ if(state.phase !== "break") return; stopAlarm(); state.timeLeft = 0; complete(true); }
      // /skip command: skips either learning interval or break by triggering completion now
      function skipAny(){
        if(state.phase !== "break" && state.phase !== "learning") return false;
        stopAlarm(); state.timeLeft = 0; complete(true);
        return true;
      }
      function resetAll(){
        stopAlarm(); workerStop(); tickAnchor = null; diceTrackingStop();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        state.running = false; state.alarmActive = false; state.sessionIdx = 0; state.phase = "idle"; state.timeLeft = state.settings.learn_min * 60; state.sessionsDone = Array(TOTAL_SESSIONS).fill(false); state.breaksDone = Array(TOTAL_SESSIONS - 1).fill(false); state.curBreak = -1; updateTimerUI(); drawTrack(); persist();
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
        // Cursor + tooltip: only when interactive (not running, not alarm)
        if(state.running || state.alarmActive){
          hideTooltip();
          dom.trackCanvas.style.cursor = sessionBox ? "default" : "default";
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
      function markDone(kind, idx){
        if(kind === "session"){
          state.sessionsDone[idx] = true; state.sessionIdx = idx;
          recordSession(state.settings.learn_min);
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
          unrecordSession(state.settings.learn_min);
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
        for(let d=0; d<7; d++){ const dt = new Date(weekMonday); dt.setDate(weekMonday.getDate() + d); weekMin += Number(state.data[dt.toISOString().slice(0,10)]) || 0; }
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
          const d = cell.date, mins = Number(state.data[d.toISOString().slice(0,10)]) || 0, x1 = LM + cell.col * PITCH, y1 = TM + cell.row * PITCH;
          ctx.fillStyle = heatColor(mins); ctx.fillRect(x1, y1, CELL, CELL); ctx.strokeStyle = cardBorder; ctx.lineWidth = 1; ctx.strokeRect(x1 + 0.5, y1 + 0.5, CELL - 1, CELL - 1);
          cellMap.push({x1,y1,x2:x1+CELL,y2:y1+CELL,date:d,mins});
        }
        const todayCell = cells.find(c => c.date.toISOString().slice(0,10) === todayISO());
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
        updateSettingsView();
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
        // Hide task popover on tab change (canvas may not be visible anymore)
        hideTaskPopover(true);
        dom.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
        Object.entries(dom.views).forEach(([k,v]) => v.classList.toggle("active", k === name));
        if(name === "stats"){ updateStats(); drawHeatmap(); }
        if(name === "dice"){ updateDiceGameUI(); refreshNeedPointsHint(); applyDiceLockState(); }
        if(name === "todo"){ renderTodoView(); }
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
        updateLegends(); updateSettingsView(); updateTimerUI(); drawTrack(); updateStats(); drawHeatmap();
        updateDiceGameUI();
        updateCompactStar();
        // initialize dice faces
        showDiceFace(dom.gameDie, 1);
        showDiceFace(dom.rewardDie, 1);
      }
      function init(){
        recomputeTotalSessions();
        reconcileSessionArrays();
        updateDataFromToday();
        updateSettingsView();
        renderSettingsButtons();
        bindDiceGameEvents();
        drawEverything();
        setTab("timer");
        if(state.compact) toggleCompact(true);
        if(state.alarmActive) startAlarm();
        if(state.running && state.phase !== "done"){
          startTickAnchor();
          workerStart();
          if(state.phase === "learning") diceTrackingStart();
        }
        if(state.phase === "done") dom.finishBox.style.display = "flex";
        // Default dice subtitle / message based on current state
        setDiceMessage("Noch nicht gewürfelt.", "");
        dom.diceSmall.textContent = "Wähle Modus, tippe eine Zahl und gib deinen Einsatz ein.";
        persist();
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
      dom.resetBtn.addEventListener("click", () => { uiSoftClick(); resetAll(); });
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
      dom.trackCanvas.addEventListener("mouseleave", () => { hideTooltip(); schedulePopHide(); }, { passive: true });
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
              const dKey = d.toISOString().slice(0, 10);
              const cur = Number(state.data[dKey]) || 0;
              if(cur < STREAK_THRESHOLD_MIN) state.data[dKey] = STREAK_THRESHOLD_MIN;
            }
            // Break the streak just before the target window
            const breakD = new Date(); breakD.setDate(breakD.getDate() - n);
            delete state.data[breakD.toISOString().slice(0, 10)];
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
      window.addEventListener("beforeunload", persist);
      init();
      window.__lernplan = { saveSettings, resetDefaults, startOrPause, skipPhase, resetAll, state };
    })();

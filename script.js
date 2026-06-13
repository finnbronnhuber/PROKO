    // ── ES-module imports ─────────────────────────────────────────────────
    // These bindings are visible to the entire IIFE below.
    // ⚠ Cache-Buster (?v=…) an JEDEM lokalen Import: Browser cachen ES-Module pro URL.
    //   Ohne Buster lädt ein geänderter Submodul (z.B. constants.js) evtl. STALE → der
    //   Modul-Link bricht und das GESAMTE script.js läuft nicht. Beim Release diese Version
    //   GEMEINSAM mit dem ?v= im <script>-Tag (index.html) hochzählen — sonst greift es nicht.
    import { el, clamp, deepClone, genTemplateId } from "./js/utils.js?v=2026-06-13-luck-3";
    import {
      localDateKey, todayISO, yesterdayISO, logicalNow,
      fmtTime, fmtTimeFlow, fmtHoursFromMinutes
    } from "./js/time.js?v=2026-06-13-luck-3";
    import {
      HEAT_LIGHT, HEAT_DARK, CONFETTI_COLORS,
      STORAGE_KEY, LOCAL_FALLBACK_KEY, PERSIST_INTERVAL,
      STREAK_THRESHOLD_MIN, DICE_TIMER_TOTAL_SEC,
      MAX_SESSIONS, MAX_TEMPLATES,
      TASK_MAX, INBOX_MAX, INBOX_KEY, SUBTASK_MAX,
      FLOW_PROMPT_WINDOW_SEC, FLOW_MIN_INTERVAL_SEC, FLOW_AUTO_FIRST_SEC, FLOW_AUTO_INTERVAL_SEC, FLOW_BREAK_DEFAULT_MIN,
      DICE_BALANCE,
      DICE_TYPES, DICE_SIDES, DICE_PRICES, DICE_LABELS,
      SKIN_COLORS, SKIN_COLOR_WEIGHTS, SKIN_COLOR_NAMES_DE, SKIN_COLOR_LETTERS, LOOTBOX_PRICE, MAX_SKINS,
      ARCADE_SEC_PER_LEARN_MIN, ARCADE_GAME_AVG_MIN,
      RACE_PLAYTIME_MIN, LUCK_PLAYTIME_BASE_MIN, luckPlaytimeMin,
      LUCK_ROUNDS, LUCK_COST, LUCK_MIN_PLAYERS, LUCK_MAX_PLAYERS, LUCK_DICE, LUCK_PAYOUTS,
      PROJECT_COLOR_PALETTE, AVATAR_COLOR_OPTIONS,
    } from "./js/constants.js?v=2026-06-13-luck-3";
    import {
      setVolumeProvider,
      getCtx, playTone, playNoise, alarmTone,
      uiTabSwitch, uiSoftClick, uiToggle, uiStepper, uiSave, uiError,
      rewardRollStart, rewardLand,
      diceGameClick, diceSelect, diceClose, diceTickRoll, diceLand,
      diceRollStart, diceWin, diceStreakUp, diceLose, diceGameOver,
      raceOvershoot, raceKnockback,
    } from "./js/audio.js?v=2026-06-13-luck-3";

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

      // ── Bridge: tell the audio module how to read the master volume from state ──
      // (The audio module is intentionally state-agnostic; this is the wiring point.)
      setVolumeProvider(() => {
        if(!state || !state.soundEnabled) return 0;
        const v = Number.isFinite(state.soundVolume) ? state.soundVolume : 1;
        return Math.max(0, Math.min(1, v));
      });

      // ════════════════════════════════════════════════════════════
      //   TIMER ALARM  (state-coupled; primitives come from audio.js)
      // ════════════════════════════════════════════════════════════
      let alarmInterval = null;
      function stopAlarm(){
        if(alarmInterval){ clearInterval(alarmInterval); alarmInterval = null; }
        state.alarmActive = false;
      }
      function startAlarm(){
        if(alarmInterval) return;
        state.alarmActive = true; updateTimerUI();
        alarmInterval = setInterval(() => {
          if(!state.alarmActive) return;
          if(state.soundEnabled) alarmTone();
        }, 1000);
      }
      function dismissAlarm(){ stopAlarm(); if(state.phase === "done") showFinish(); else { state.running = false; updateTimerUI(); } persist(); }

      // ════════════════════════════════════════════════════════════
      //   STATE
      //   (clamp, deepClone, localDateKey, todayISO, yesterdayISO are
      //    imported from ./js/utils.js and ./js/time.js — see file top.)
      // ════════════════════════════════════════════════════════════
      function getMin(dateKey){ return Number(state.data[dateKey]) || 0; }
      // Consecutive days (going back from today) with >= STREAK_THRESHOLD_MIN min logged.
      // If today < threshold, streak still counts back from yesterday (today is "in progress").
      function computeStreak(){
        let count = 0;
        const today = getMin(todayISO());
        if(today >= STREAK_THRESHOLD_MIN) count = 1;
        const d = logicalNow(); d.setDate(d.getDate() - 1);
        for(let i=0; i<3650; i++){
          const key = localDateKey(d);
          const m = getMin(key);
          if(m >= STREAK_THRESHOLD_MIN){ count++; d.setDate(d.getDate() - 1); }
          else break;
        }
        return count;
      }
      function isLearningActive(){
        // Locks the dice game / reward dice ONLY while learning is in progress, so a break
        // (a "normal" pause) lets the user roll + play. The check is MODE-AWARE: in Flow mode
        // we consult ONLY flow.phase, in Pomodoro mode ONLY state.phase. (Previously Flow mode
        // also consulted the leftover Pomodoro state.phase, which could still read "learning"
        // and wrongly keep the dice locked during a Flow break.)
        if(state.mode === "flow"){
          return !!(state.flow && state.flow.phase === "learning");
        }
        return state.phase === "learning";
      }
      // ════════════════════════════════════════════════════════════
      //   INTERVAL TASKS  (per-day, per-session to-do lists)
      //   TASK_MAX / INBOX_MAX / INBOX_KEY / SUBTASK_MAX imported from constants.js
      // ════════════════════════════════════════════════════════════
      const TASK_REMOVE_DELAY_MS = 3000;
      function isInboxKey(k){ return String(k) === INBOX_KEY; }
      function getTaskList(sessionIdx){
        const day = todayISO();
        if(!state.intervalTasks || typeof state.intervalTasks !== "object") state.intervalTasks = {};
        if(!state.intervalTasks[day]) state.intervalTasks[day] = {};
        const key = String(sessionIdx);
        if(!Array.isArray(state.intervalTasks[day][key])) state.intervalTasks[day][key] = [];
        return state.intervalTasks[day][key];
      }
      // Add a task. Parses leading/inline #hashtag into projectKey, strips it from visible text.
      // sessionIdx can be a number (0..TOTAL_SESSIONS-1) OR "inbox" for the unsorted pool.
      function addTask(sessionIdx, text){
        const list = getTaskList(sessionIdx);
        const cap = isInboxKey(sessionIdx) ? INBOX_MAX : TASK_MAX;
        if(list.length >= cap) return false;
        const parsed = parseTaskInput(text);
        if(!parsed || !parsed.text) return false;
        let projectKey = null;
        if(parsed.projectKey){
          projectKey = ensureProject(parsed.projectName);
        }
        list.push({
          id: "t" + Date.now() + "_" + Math.floor(Math.random()*1e6),
          text: parsed.text.slice(0, 120),
          done: false, doneAt: 0,
          subtasks: [],

          star: false,
          projectKey: projectKey,
        });
        persist();
        return true;
      }
      function removeTaskById(sessionIdx, taskId){
        const list = getTaskList(sessionIdx);
        const idx = list.findIndex(x => x.id === taskId);
        if(idx >= 0){ list.splice(idx, 1); persist(); return true; }
        return false;
      }
      // ── Subtasks + inline edit ─────────────────────────────────────
      function findTaskAcrossDay(taskId){
        const day = todayISO();
        const dayMap = (state.intervalTasks && state.intervalTasks[day]) || {};
        for(const k of Object.keys(dayMap)){
          for(const t of (dayMap[k] || [])){
            if(t && t.id === taskId) return { task: t, sourceKey: k };
          }
        }
        return null;
      }
      function addSubtask(taskId, text){
        const hit = findTaskAcrossDay(taskId);
        if(!hit) return false;
        const t = hit.task;
        const clean = String(text || "").trim().slice(0, 120);
        if(!clean) return false;
        if(!Array.isArray(t.subtasks)) t.subtasks = [];
        if(t.subtasks.length >= SUBTASK_MAX) return false;
        t.subtasks.push({
          id: "s" + Date.now() + "_" + Math.floor(Math.random()*1e6),
          text: clean,
          done: false,
        });
        persist();
        return true;
      }
      function toggleSubtask(taskId, subId){
        const hit = findTaskAcrossDay(taskId);
        if(!hit || !Array.isArray(hit.task.subtasks)) return false;
        const s = hit.task.subtasks.find(x => x.id === subId);
        if(!s) return false;
        s.done = !s.done;
        persist();
        return true;
      }
      function removeSubtask(taskId, subId){
        const hit = findTaskAcrossDay(taskId);
        if(!hit || !Array.isArray(hit.task.subtasks)) return false;
        const i = hit.task.subtasks.findIndex(x => x.id === subId);
        if(i < 0) return false;
        hit.task.subtasks.splice(i, 1);
        persist();
        return true;
      }
      function editTaskText(taskId, newText){
        const hit = findTaskAcrossDay(taskId);
        if(!hit) return false;
        const clean = String(newText || "").trim().slice(0, 120);
        if(!clean) return false;
        // Allow hashtag re-tag during edit: if the edited text contains a #tag, update projectKey
        const parsed = parseTaskInput(clean);
        hit.task.text = parsed.text || clean;
        if(parsed && parsed.projectKey){
          hit.task.projectKey = ensureProject(parsed.projectName);
        }
        persist();
        return true;
      }
      // Move a task between containers (Inbox ↔ Interval ↔ Interval).
      // Returns true on success. Drops the task in target if the target container is full.
      function moveTask(fromKey, toKey, taskId){
        if(String(fromKey) === String(toKey)) return false;
        const src = getTaskList(fromKey);
        const dst = getTaskList(toKey);
        const cap = isInboxKey(toKey) ? INBOX_MAX : TASK_MAX;
        if(dst.length >= cap) return false;
        const idx = src.findIndex(x => x.id === taskId);
        if(idx < 0) return false;
        const [item] = src.splice(idx, 1);
        // Moving to a different interval clears the "active task star" — it only applies
        // to the interval the user is in.
        if(item.star) item.star = false;
        dst.push(item);
        persist();
        return true;
      }
      // When TOTAL_SESSIONS shrinks (template change / interval removed on track), any tasks
      // sitting in removed buckets would become unreachable. Move them to the Inbox so the
      // user can re-assign them. Returns the number of tasks migrated.
      function migrateOrphanTasksToInbox(newTotal){
        const day = todayISO();
        if(!state.intervalTasks || !state.intervalTasks[day]) return 0;
        const dayMap = state.intervalTasks[day];
        let moved = 0;
        for(const k of Object.keys(dayMap)){
          if(k === INBOX_KEY) continue;
          const idx = parseInt(k, 10);
          if(!Number.isFinite(idx)) continue;
          if(idx < newTotal) continue;     // still a valid interval
          const items = dayMap[k] || [];
          if(items.length === 0){ delete dayMap[k]; continue; }
          if(!Array.isArray(dayMap[INBOX_KEY])) dayMap[INBOX_KEY] = [];
          const inbox = dayMap[INBOX_KEY];
          for(const t of items){
            if(inbox.length >= INBOX_MAX) break;
            if(t.star) t.star = false;
            inbox.push(t);
            moved++;
          }
          delete dayMap[k];
        }
        if(moved > 0) persist();
        return moved;
      }
      // On a new local day the interval grid resets to 0 (see handleDayRollover).
      // Any unfinished tasks still sitting in a previous day's interval buckets — or
      // its own Inbox — would otherwise be stranded (the UI only ever reads today's
      // buckets). Carry every unfinished task forward into today's Inbox, drop the
      // interval assignment (clear the star), and delete the stale day buckets so
      // intervalTasks can't grow unbounded. Done tasks are not carried (they're done).
      // Idempotent: a same-day reload finds no foreign day buckets and is a no-op.
      function carryOverUnfinishedTasksToInbox(){
        if(!state.intervalTasks || typeof state.intervalTasks !== "object") return 0;
        const today = todayISO();
        const inbox = getTaskList(INBOX_KEY);   // ensures today's inbox array exists
        let moved = 0;
        for(const day of Object.keys(state.intervalTasks)){
          if(day === today) continue;
          const dayMap = state.intervalTasks[day] || {};
          for(const k of Object.keys(dayMap)){
            for(const t of (dayMap[k] || [])){
              if(!t || t.done) continue;
              if(inbox.length >= INBOX_MAX) break;
              t.star = false;
              inbox.push(t);
              moved++;
            }
          }
          delete state.intervalTasks[day];
        }
        if(moved > 0) persist();
        return moved;
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
      // ── TODO view v2: Inbox + 4-column interval grid + project overview ──
      function todoSessionKeyFromString(s){
        if(s === "inbox") return "inbox";
        const n = parseInt(s, 10);
        return Number.isInteger(n) ? n : null;
      }
      function renderTodoView(){
        const wrap = document.getElementById("todoIntervalGrid");
        if(!wrap) return;
        const day = todayISO();
        const dayMap = (state.intervalTasks && state.intervalTasks[day]) || {};

        // ── Summary pills ──
        if(dom.todoSummary){
          while(dom.todoSummary.firstChild) dom.todoSummary.removeChild(dom.todoSummary.firstChild);
          let openCount = 0, doneCount = 0;
          for(const k of Object.keys(dayMap)){
            for(const t of (dayMap[k] || [])){
              if(t.done) doneCount++; else openCount++;
            }
          }
          const archivedToday = (state.completedHistory || []).filter(e => e.day === day).length;
          const mk = (label, val) => {
            const p = document.createElement("div"); p.className = "pillBox";
            const lb = document.createElement("span"); lb.className = "pillLbl"; lb.textContent = label + ":";
            const vv = document.createElement("span"); vv.className = "pillVal"; vv.textContent = String(val);
            p.appendChild(lb); p.appendChild(vv); return p;
          };
          dom.todoSummary.appendChild(mk("Offen", openCount));
          dom.todoSummary.appendChild(mk("Erledigt", doneCount + archivedToday));
          dom.todoSummary.appendChild(mk("Projekte", Object.keys(state.projects || {}).length));
        }

        // ── Inbox ──
        renderInboxList();

        // ── Interval grid (1..TOTAL_SESSIONS, 4 per row) ──
        while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
        for(let i = 0; i < TOTAL_SESSIONS; i++){
          wrap.appendChild(buildIntervalBucket(i));
        }

        // ── Projects overview ──
        renderProjectsOverview();
      }

      function renderInboxList(){
        const list = document.getElementById("todoInboxList");
        if(!list) return;
        while(list.firstChild) list.removeChild(list.firstChild);
        const tasks = getTaskList("inbox");
        for(const t of tasks){
          list.appendChild(buildTaskItem(t, "inbox"));
        }
        // Live update of count badge
        const bucket = document.getElementById("todoInbox");
        if(bucket && !bucket.querySelector(".todoBucketLabel")){
          const lbl = document.createElement("div");
          lbl.className = "todoBucketLabel";
          const left = document.createElement("span");
          left.textContent = "Sammelt unsortierte Aufgaben";
          const cnt = document.createElement("span");
          cnt.className = "todoBucketCount";
          cnt.id = "todoInboxCount";
          cnt.textContent = tasks.length + " / " + INBOX_MAX;
          lbl.appendChild(left); lbl.appendChild(cnt);
          bucket.insertBefore(lbl, bucket.firstChild);
        } else if(bucket){
          const cnt = bucket.querySelector("#todoInboxCount");
          if(cnt) cnt.textContent = tasks.length + " / " + INBOX_MAX;
        }
        // Update input disabled state if at max
        const inp = document.getElementById("todoInboxInput");
        const btn = document.getElementById("todoInboxAddBtn");
        const atMax = tasks.length >= INBOX_MAX;
        if(inp) inp.disabled = atMax;
        if(btn) btn.disabled = atMax;
      }

      function buildIntervalBucket(i){
        const bucket = document.createElement("div");
        bucket.className = "todoBucket";
        bucket.dataset.key = String(i);
        const tasks = getTaskList(i);
        const isCurrent = state.phase === "learning" && state.sessionIdx === i;
        const isDone = !!state.sessionsDone[i];
        if(isCurrent) bucket.classList.add("activeInterval");
        if(isDone)    bucket.classList.add("doneInterval");

        // Header
        const lbl = document.createElement("div");
        lbl.className = "todoBucketLabel";
        const title = document.createElement("span");
        title.textContent = "Intervall " + (i + 1);
        lbl.appendChild(title);
        if(isCurrent){
          const b = document.createElement("span"); b.className = "todoBucketBadge"; b.textContent = "AKTIV";
          lbl.appendChild(b);
        }
        const cnt = document.createElement("span");
        cnt.className = "todoBucketCount";
        cnt.textContent = tasks.length + " / " + TASK_MAX;
        lbl.appendChild(cnt);
        bucket.appendChild(lbl);

        // Add-row
        const addRow = document.createElement("div");
        addRow.className = "todoAddRow";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "todoBucketInput";
        input.placeholder = isDone ? "(Intervall ist fertig)" : "Aufgabe… (z.B. #Mathe Übung 3)";
        input.maxLength = 120;
        input.autocomplete = "off";
        input.disabled = isDone || tasks.length >= TASK_MAX;
        input.dataset.key = String(i);
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "todoBucketAddBtn";
        addBtn.textContent = "+";
        addBtn.setAttribute("aria-label", "Aufgabe hinzufügen");
        addBtn.dataset.action = "addToBucket";
        addBtn.dataset.key = String(i);
        addBtn.disabled = isDone || tasks.length >= TASK_MAX;
        addRow.appendChild(input);
        addRow.appendChild(addBtn);
        bucket.appendChild(addRow);

        // Tasks list
        const ul = document.createElement("ul");
        ul.className = "todoBucketList";
        ul.dataset.key = String(i);
        for(const t of tasks){
          ul.appendChild(buildTaskItem(t, i));
        }
        bucket.appendChild(ul);
        return bucket;
      }

      function buildTaskItem(task, sourceKey){
        const li = document.createElement("li");
        li.className = "todoBucketItem";
        if(task.done) li.classList.add("done");
        li.draggable = !task.done;
        li.dataset.taskId = task.id;
        li.dataset.sourceKey = String(sourceKey);
        // Project color stripe
        if(task.projectKey && state.projects && state.projects[task.projectKey]){
          li.classList.add("hasProject");
          li.style.setProperty("--proj-color", state.projects[task.projectKey].color);
        }
        // Check
        const chk = document.createElement("button");
        chk.type = "button";
        chk.className = "todoBucketItemCheck" + (task.done ? " checked" : "");
        chk.dataset.action = "todoV2Toggle";
        chk.dataset.taskId = task.id;
        chk.dataset.sourceKey = String(sourceKey);
        chk.setAttribute("aria-label", task.done ? "Wieder öffnen" : "Erledigt");
        li.appendChild(chk);
        // Text (click → inline edit, double-click also enters edit)
        const txt = document.createElement("span");
        txt.className = "todoBucketItemText";
        txt.textContent = task.text;
        txt.dataset.action = "todoV2EditText";
        txt.dataset.taskId = task.id;
        txt.dataset.sourceKey = String(sourceKey);
        txt.title = "Klicken zum Bearbeiten";
        if(task.projectKey && state.projects && state.projects[task.projectKey]){
          li.title = "Projekt: " + state.projects[task.projectKey].name;
        }
        li.appendChild(txt);
        // Subtask count badge + expand toggle
        const subs = Array.isArray(task.subtasks) ? task.subtasks : [];
        const doneSubs = subs.filter(s => s.done).length;
        const expand = document.createElement("button");
        expand.type = "button";
        expand.className = "todoBucketItemExpand" + (task._uiExpanded ? " expanded" : "") + (subs.length > 0 ? " hasSubs" : "");
        expand.dataset.action = "todoV2ToggleExpand";
        expand.dataset.taskId = task.id;
        expand.dataset.sourceKey = String(sourceKey);
        expand.textContent = subs.length > 0 ? (doneSubs + "/" + subs.length) : "+ Sub";
        expand.title = subs.length > 0 ? "Unteraufgaben anzeigen" : "Unteraufgaben hinzufügen";
        expand.setAttribute("aria-label", expand.title);
        li.appendChild(expand);
        // Delete
        const del = document.createElement("button");
        del.type = "button";
        del.className = "todoBucketItemDel";
        del.textContent = "✕";
        del.dataset.action = "todoV2Delete";
        del.dataset.taskId = task.id;
        del.dataset.sourceKey = String(sourceKey);
        del.setAttribute("aria-label", "Aufgabe löschen");
        li.appendChild(del);
        // Expanded subtask panel
        if(task._uiExpanded){
          const panel = document.createElement("div");
          panel.className = "todoBucketSubPanel";
          // Subtask list
          if(subs.length > 0){
            const subUl = document.createElement("ul");
            subUl.className = "todoBucketSubList";
            for(const s of subs){
              const sli = document.createElement("li");
              sli.className = "todoBucketSubItem" + (s.done ? " done" : "");
              const schk = document.createElement("button");
              schk.type = "button";
              schk.className = "todoBucketSubCheck" + (s.done ? " checked" : "");
              schk.dataset.action = "todoV2SubToggle";
              schk.dataset.taskId = task.id;
              schk.dataset.subId = s.id;
              schk.setAttribute("aria-label", s.done ? "Wieder öffnen" : "Erledigt");
              const stx = document.createElement("span"); stx.className = "todoBucketSubText"; stx.textContent = s.text;
              const sdel = document.createElement("button");
              sdel.type = "button";
              sdel.className = "todoBucketSubDel";
              sdel.textContent = "✕";
              sdel.dataset.action = "todoV2SubDelete";
              sdel.dataset.taskId = task.id;
              sdel.dataset.subId = s.id;
              sdel.setAttribute("aria-label", "Unteraufgabe löschen");
              sli.appendChild(schk); sli.appendChild(stx); sli.appendChild(sdel);
              subUl.appendChild(sli);
            }
            panel.appendChild(subUl);
          }
          // Add-subtask input row
          const row = document.createElement("div");
          row.className = "todoBucketSubAddRow";
          const sinp = document.createElement("input");
          sinp.type = "text";
          sinp.className = "todoBucketSubInput";
          sinp.placeholder = "Unteraufgabe…";
          sinp.maxLength = 120;
          sinp.dataset.taskId = task.id;
          sinp.disabled = subs.length >= SUBTASK_MAX;
          const sbtn = document.createElement("button");
          sbtn.type = "button";
          sbtn.className = "todoBucketSubAddBtn";
          sbtn.textContent = "+";
          sbtn.dataset.action = "todoV2SubAdd";
          sbtn.dataset.taskId = task.id;
          sbtn.disabled = subs.length >= SUBTASK_MAX;
          sbtn.setAttribute("aria-label", "Unteraufgabe hinzufügen");
          row.appendChild(sinp); row.appendChild(sbtn);
          panel.appendChild(row);
          li.appendChild(panel);
          // Mark li as expanded so dragging won't grab it
          li.draggable = false;
          li.classList.add("expanded");
        }
        return li;
      }

      function renderProjectsOverview(){
        const wrap = document.getElementById("todoProjects");
        if(!wrap) return;
        while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
        const projs = state.projects || {};
        const keys = Object.keys(projs).sort((a, b) => projs[a].name.localeCompare(projs[b].name));
        if(keys.length === 0) return; // CSS empty-state takes over

        const day = todayISO();
        const dayMap = (state.intervalTasks && state.intervalTasks[day]) || {};

        // Index OPEN tasks by project (across inbox + all intervals)
        const byProject = {};
        for(const k of Object.keys(dayMap)){
          for(const t of (dayMap[k] || [])){
            if(!t.projectKey) continue;
            if(t.done) continue;
            (byProject[t.projectKey] = byProject[t.projectKey] || []).push({ t, loc: k });
          }
        }

        const frag = document.createDocumentFragment();
        for(const key of keys){
          const p = projs[key];
          const items = byProject[key] || [];
          const card = document.createElement("div");
          card.className = "projectCard";
          card.dataset.projectKey = key;
          card.style.setProperty("--proj-color", p.color);
          card.tabIndex = 0;
          card.setAttribute("role", "button");
          card.title = "Projekt öffnen: " + p.name;

          const head = document.createElement("div");
          head.className = "projectHead";

          // Color swatch button (opens picker)
          const swatch = document.createElement("button");
          swatch.type = "button";
          swatch.className = "projectColorSwatch";
          swatch.dataset.action = "projectChangeColor";
          swatch.dataset.projectKey = key;
          swatch.title = "Farbe ändern";
          swatch.setAttribute("aria-label", "Farbe ändern");

          const name = document.createElement("span"); name.className = "projectName"; name.textContent = p.name;
          const count = document.createElement("span"); count.className = "projectCount";
          count.textContent = items.length + " offen";

          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.className = "projectOpenBtn";
          openBtn.dataset.action = "projectOpen";
          openBtn.dataset.projectKey = key;
          openBtn.textContent = "Öffnen";
          openBtn.title = "Aufgaben dieses Projekts ansehen";

          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "projectDelBtn";
          delBtn.dataset.action = "projectDelete";
          delBtn.dataset.projectKey = key;
          delBtn.textContent = "✕";
          delBtn.title = "Projekt löschen";
          delBtn.setAttribute("aria-label", "Projekt löschen");

          head.appendChild(swatch);
          head.appendChild(name);
          head.appendChild(count);
          head.appendChild(openBtn);
          head.appendChild(delBtn);
          card.appendChild(head);
          if(items.length > 0){
            const ul = document.createElement("ul"); ul.className = "projectItems";
            for(const { t, loc } of items){
              const li = document.createElement("li"); li.className = "projectItem";
              const txt = document.createElement("span"); txt.className = "projectItemText"; txt.textContent = t.text;
              const locStr = document.createElement("span"); locStr.className = "projectItemLoc";
              locStr.textContent = (loc === "inbox") ? "Inbox" : ("Intervall " + (parseInt(loc, 10) + 1));
              li.appendChild(txt); li.appendChild(locStr);
              ul.appendChild(li);
            }
            card.appendChild(ul);
          }
          frag.appendChild(card);
        }
        wrap.appendChild(frag);
      }
      function deleteProject(projectKey){
        if(!state.projects || !state.projects[projectKey]) return;
        // Strip projectKey from any task that referenced it (tasks stay where they are)
        const day = todayISO();
        const dayMap = (state.intervalTasks && state.intervalTasks[day]) || {};
        for(const k of Object.keys(dayMap)){
          for(const t of (dayMap[k] || [])){
            if(t.projectKey === projectKey) delete t.projectKey;
          }
        }
        delete state.projects[projectKey];
        persist();
      }
      function setProjectColor(projectKey, color){
        if(!state.projects || !state.projects[projectKey]) return;
        if(typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
        state.projects[projectKey].color = color;
        persist();
      }
      // Pop-up color picker (anchored to a swatch button). Reused for both
      // existing-project recolors and any future palette UI.
      function openProjectColorPicker(swatchEl, projectKey){
        // Remove any existing picker first
        const existing = document.getElementById("projectColorPicker");
        if(existing) existing.remove();
        const pop = document.createElement("div");
        pop.id = "projectColorPicker";
        pop.className = "projectColorPicker";
        for(const c of PROJECT_COLOR_PALETTE){
          const cell = document.createElement("button");
          cell.type = "button";
          cell.className = "projectColorPickerCell";
          cell.style.background = c;
          cell.dataset.color = c;
          cell.title = c;
          cell.setAttribute("aria-label", "Farbe " + c);
          pop.appendChild(cell);
        }
        document.body.appendChild(pop);
        const r = swatchEl.getBoundingClientRect();
        pop.style.top = (r.bottom + window.scrollY + 6) + "px";
        pop.style.left = (r.left + window.scrollX) + "px";
        const onPick = (e) => {
          const cell = e.target.closest(".projectColorPickerCell");
          if(!cell) return;
          setProjectColor(projectKey, cell.dataset.color);
          pop.remove();
          document.removeEventListener("click", onOutside, true);
          renderTodoView();
        };
        const onOutside = (e) => {
          if(pop.contains(e.target)) return;
          pop.remove();
          document.removeEventListener("click", onOutside, true);
        };
        pop.addEventListener("click", onPick);
        // Delay so the originating click doesn't immediately close it
        setTimeout(() => document.addEventListener("click", onOutside, true), 0);
      }
      // Project detail modal: shows all open tasks of one project + add-input.
      // New tasks added here are placed into the Inbox immediately.
      let projectModalKey = null;
      function openProjectModal(projectKey){
        if(!state.projects || !state.projects[projectKey]) return;
        projectModalKey = projectKey;
        let modal = document.getElementById("projectModal");
        if(!modal){
          modal = document.createElement("div");
          modal.id = "projectModal";
          modal.className = "modal projectModal";
          modal.innerHTML = `
            <div class="modalCard projectModalCard">
              <div class="projectModalHead">
                <span class="projectModalDot"></span>
                <h2 class="projectModalTitle"></h2>
                <button type="button" class="projectModalClose" data-action="projectModalClose" aria-label="Schließen">✕</button>
              </div>
              <div class="projectModalAddRow">
                <input type="text" class="projectModalInput" placeholder="Neue Aufgabe …" maxlength="120" autocomplete="off" />
                <button type="button" class="projectModalAddBtn" data-action="projectModalAdd">Hinzufügen</button>
              </div>
              <div class="projectModalNote">Neue Aufgaben landen in der Inbox und können von dort einem Intervall zugewiesen werden.</div>
              <ul class="projectModalList"></ul>
              <div class="projectModalEmpty" style="display:none;">Noch keine offenen Aufgaben für dieses Projekt.</div>
            </div>
          `;
          document.body.appendChild(modal);
          modal.addEventListener("click", (e) => {
            if(e.target === modal){ closeProjectModal(); return; }
            const btn = e.target.closest("[data-action]");
            if(!btn) return;
            if(btn.dataset.action === "projectModalClose"){ closeProjectModal(); }
            else if(btn.dataset.action === "projectModalAdd"){ projectModalAddSubmit(); }
          });
          modal.querySelector(".projectModalInput").addEventListener("keydown", (e) => {
            if(e.key === "Enter"){ e.preventDefault(); projectModalAddSubmit(); }
            else if(e.key === "Escape"){ e.preventDefault(); closeProjectModal(); }
          });
        }
        renderProjectModal();
        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
        const inp = modal.querySelector(".projectModalInput");
        if(inp){ try{ inp.focus(); }catch(_){} }
      }
      function closeProjectModal(){
        const modal = document.getElementById("projectModal");
        if(!modal) return;
        modal.classList.remove("show");
        modal.setAttribute("aria-hidden", "true");
        projectModalKey = null;
        renderTodoView();
      }
      function renderProjectModal(){
        const modal = document.getElementById("projectModal");
        if(!modal || !projectModalKey) return;
        const p = state.projects[projectModalKey];
        if(!p){ closeProjectModal(); return; }
        modal.style.setProperty("--proj-color", p.color);
        modal.querySelector(".projectModalTitle").textContent = "#" + p.name;
        modal.querySelector(".projectModalDot").style.background = p.color;
        const day = todayISO();
        const dayMap = (state.intervalTasks && state.intervalTasks[day]) || {};
        const items = [];
        for(const k of Object.keys(dayMap)){
          for(const t of (dayMap[k] || [])){
            if(t.projectKey === projectModalKey && !t.done){
              items.push({ t, loc: k });
            }
          }
        }
        const ul = modal.querySelector(".projectModalList");
        while(ul.firstChild) ul.removeChild(ul.firstChild);
        const empty = modal.querySelector(".projectModalEmpty");
        empty.style.display = items.length === 0 ? "block" : "none";
        for(const { t, loc } of items){
          const li = document.createElement("li");
          li.className = "projectModalItem";
          const txt = document.createElement("span"); txt.className = "projectModalItemText"; txt.textContent = t.text;
          const locStr = document.createElement("span"); locStr.className = "projectModalItemLoc";
          locStr.textContent = (loc === "inbox") ? "Inbox" : ("Intervall " + (parseInt(loc, 10) + 1));
          li.appendChild(txt); li.appendChild(locStr);
          ul.appendChild(li);
        }
      }
      function projectModalAddSubmit(){
        if(!projectModalKey) return;
        const modal = document.getElementById("projectModal");
        const inp = modal && modal.querySelector(".projectModalInput");
        if(!inp) return;
        const raw = (inp.value || "").trim();
        if(!raw) return;
        const proj = state.projects[projectModalKey];
        if(!proj) return;
        // Prepend hashtag so addTask attaches projectKey via the normal parser
        const tagged = "#" + proj.name + " " + raw.replace(/^#\S+\s*/, "");
        const ok = addTask("inbox", tagged);
        if(ok){
          inp.value = "";
          renderProjectModal();
        }
      }

      // ── Click handlers for the v2 to-do view (toggle / delete / inline-add) ──
      function todoV2HandleClick(e){
        const btn = e.target.closest("[data-action]");
        if(!btn){
          // Clicking anywhere on a projectCard (but not a button inside) opens it
          const card = e.target.closest(".projectCard");
          if(card && card.dataset.projectKey){
            openProjectModal(card.dataset.projectKey);
          }
          return;
        }
        const action = btn.dataset.action;
        const taskId = btn.dataset.taskId;
        const srcRaw = btn.dataset.sourceKey;
        const srcKey = todoSessionKeyFromString(srcRaw);
        if(action === "todoV2Toggle"){
          if(srcKey === null) return;
          const list = getTaskList(srcKey);
          const t = list.find(x => x.id === taskId);
          if(!t) return;
          if(t.done){
            // Un-check
            cancelTaskRemoval(taskId);
            t.done = false; t.doneAt = 0;
            persist();
            renderTodoView();
            uiSoftClick();
          } else {
            // Inbox: just toggle done (no archive sense without an interval)
            if(srcKey === "inbox"){
              t.done = true; t.doneAt = Date.now();
              persist();
              renderTodoView();
              uiSave();
            } else {
              t.done = true; t.doneAt = Date.now();
              archiveAndRemoveTask(srcKey, taskId);
              cancelTaskRemoval(taskId);
              renderTodoView();
              updateCompactStar();
              uiSave();
            }
          }
        } else if(action === "todoV2Delete"){
          if(srcKey === null) return;
          cancelTaskRemoval(taskId);
          removeTaskById(srcKey, taskId);
          renderTodoView();
          updateCompactStar();
          uiSoftClick();
        } else if(action === "projectOpen"){
          e.stopPropagation();
          openProjectModal(btn.dataset.projectKey);
        } else if(action === "projectChangeColor"){
          e.stopPropagation();
          openProjectColorPicker(btn, btn.dataset.projectKey);
        } else if(action === "projectDelete"){
          e.stopPropagation();
          const key = btn.dataset.projectKey;
          const p = state.projects && state.projects[key];
          if(!p) return;
          if(confirm("Projekt '" + p.name + "' wirklich löschen? Die Aufgaben bleiben erhalten, verlieren aber ihre Projektzuordnung.")){
            deleteProject(key);
            renderTodoView();
            uiSoftClick();
          }
        } else if(action === "addToBucket"){
          const bucketKey = todoSessionKeyFromString(btn.dataset.key);
          if(bucketKey === null) return;
          // Find the sibling input in the same bucket
          const bucket = btn.closest(".todoBucket");
          const input = bucket && bucket.querySelector(".todoBucketInput");
          if(!input) return;
          const text = input.value;
          if(!text.trim()){ uiError(); return; }
          if(addTask(bucketKey, text)){
            input.value = "";
            renderTodoView();
            uiSoftClick();
            // re-focus the (newly-rendered) input
            const newBucket = document.querySelector(`.todoBucket[data-key="${bucket.dataset.key}"]`);
            const newInp = newBucket && newBucket.querySelector(".todoBucketInput");
            if(newInp){ try{ newInp.focus(); }catch(_){} }
          } else {
            uiError();
          }
        } else if(action === "todoV2ToggleExpand"){
          e.stopPropagation();
          const hit = findTaskAcrossDay(taskId);
          if(!hit) return;
          hit.task._uiExpanded = !hit.task._uiExpanded;
          renderTodoView();
          // Auto-focus the new subtask input
          if(hit.task._uiExpanded){
            setTimeout(() => {
              const inp = document.querySelector(`.todoBucketSubInput[data-task-id="${taskId}"]`);
              if(inp){ try{ inp.focus(); }catch(_){} }
            }, 0);
          }
          uiSoftClick();
        } else if(action === "todoV2EditText"){
          e.stopPropagation();
          const span = btn;  // the span is the data-action element
          if(span.classList.contains("editing")) return;
          const hit = findTaskAcrossDay(taskId);
          if(!hit || hit.task.done) return;
          startInlineEdit(span, taskId);
        } else if(action === "todoV2SubAdd"){
          e.stopPropagation();
          const li = btn.closest(".todoBucketItem");
          const inp = li && li.querySelector(".todoBucketSubInput");
          if(!inp) return;
          const text = (inp.value || "").trim();
          if(!text){ uiError(); return; }
          if(addSubtask(taskId, text)){
            inp.value = "";
            renderTodoView();
            uiSoftClick();
            setTimeout(() => {
              const inp2 = document.querySelector(`.todoBucketSubInput[data-task-id="${taskId}"]`);
              if(inp2){ try{ inp2.focus(); }catch(_){} }
            }, 0);
          } else {
            uiError();
          }
        } else if(action === "todoV2SubToggle"){
          e.stopPropagation();
          toggleSubtask(taskId, btn.dataset.subId);
          renderTodoView();
          uiSoftClick();
        } else if(action === "todoV2SubDelete"){
          e.stopPropagation();
          removeSubtask(taskId, btn.dataset.subId);
          renderTodoView();
          uiSoftClick();
        }
      }
      // Inline-edit a task's text: replace the span with an input, save on blur/Enter,
      // cancel on Escape. Re-renders the whole TODO view after commit.
      function startInlineEdit(spanEl, taskId){
        spanEl.classList.add("editing");
        const oldText = spanEl.textContent;
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "todoBucketItemEditInput";
        inp.value = oldText;
        inp.maxLength = 120;
        spanEl.replaceWith(inp);
        try{ inp.focus(); inp.setSelectionRange(0, inp.value.length); }catch(_){}
        let committed = false;
        const commit = () => {
          if(committed) return;
          committed = true;
          const v = inp.value;
          if(v && v.trim() && v.trim() !== oldText){
            editTaskText(taskId, v);
            renderTodoView();
          } else {
            renderTodoView();
          }
        };
        const cancel = () => {
          if(committed) return;
          committed = true;
          renderTodoView();
        };
        inp.addEventListener("blur", commit);
        inp.addEventListener("keydown", (ev) => {
          if(ev.key === "Enter"){ ev.preventDefault(); commit(); }
          else if(ev.key === "Escape"){ ev.preventDefault(); cancel(); }
        });
      }

      // Add-on-Enter for the bucket inputs (delegated so it covers newly-rendered inputs)
      function todoV2HandleKeydown(e){
        if(e.key !== "Enter") return;
        // Subtask input
        const sinp = e.target.closest(".todoBucketSubInput");
        if(sinp){
          e.preventDefault();
          const li = sinp.closest(".todoBucketItem");
          const sbtn = li && li.querySelector('[data-action="todoV2SubAdd"]');
          if(sbtn) sbtn.click();
          return;
        }
        const inp = e.target.closest(".todoBucketInput");
        if(!inp) return;
        e.preventDefault();
        const bucket = inp.closest(".todoBucket");
        const addBtn = bucket && bucket.querySelector('[data-action="addToBucket"]');
        if(addBtn){ addBtn.click(); return; }
        // Inbox uses a fixed button id
        if(inp.id === "todoInboxInput"){
          const btn = document.getElementById("todoInboxAddBtn");
          if(btn) btn.click();
        }
      }

      // Inbox-specific Add (button id is fixed in the HTML)
      function todoInboxAddSubmit(){
        const inp = document.getElementById("todoInboxInput");
        if(!inp) return;
        const text = inp.value;
        if(!text.trim()){ uiError(); return; }
        if(addTask("inbox", text)){
          inp.value = "";
          renderTodoView();
          uiSoftClick();
          try{ document.getElementById("todoInboxInput").focus(); }catch(_){}
        } else {
          uiError();
        }
      }

      // ── Drag & Drop across containers ──
      let _dragSrcTaskId = null;
      let _dragSrcKey = null;
      function todoV2DragStart(e){
        const li = e.target.closest(".todoBucketItem");
        if(!li || !li.draggable){ e.preventDefault(); return; }
        _dragSrcTaskId = li.dataset.taskId;
        _dragSrcKey = li.dataset.sourceKey;
        li.classList.add("dragging");
        try{
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", _dragSrcTaskId);
        }catch(_){}
      }
      function todoV2DragEnd(e){
        const li = e.target.closest(".todoBucketItem");
        if(li) li.classList.remove("dragging");
        document.querySelectorAll(".todoBucket.dropTarget").forEach(n => n.classList.remove("dropTarget"));
        _dragSrcTaskId = null; _dragSrcKey = null;
      }
      function todoV2DragOver(e){
        if(!_dragSrcTaskId) return;
        const bucket = e.target.closest(".todoBucket");
        if(!bucket) return;
        // Don't highlight self
        if(String(bucket.dataset.key) === String(_dragSrcKey)) return;
        e.preventDefault();
        try{ e.dataTransfer.dropEffect = "move"; }catch(_){}
        document.querySelectorAll(".todoBucket.dropTarget").forEach(n => { if(n !== bucket) n.classList.remove("dropTarget"); });
        bucket.classList.add("dropTarget");
      }
      function todoV2DragLeave(e){
        const bucket = e.target.closest(".todoBucket");
        if(bucket && !bucket.contains(e.relatedTarget)) bucket.classList.remove("dropTarget");
      }
      function todoV2Drop(e){
        e.preventDefault();
        const bucket = e.target.closest(".todoBucket");
        document.querySelectorAll(".todoBucket.dropTarget").forEach(n => n.classList.remove("dropTarget"));
        if(!bucket || !_dragSrcTaskId) return;
        const targetKey = todoSessionKeyFromString(bucket.dataset.key);
        const sourceKey = todoSessionKeyFromString(_dragSrcKey);
        if(targetKey === null || sourceKey === null) return;
        if(String(targetKey) === String(sourceKey)) return;
        if(moveTask(sourceKey, targetKey, _dragSrcTaskId)){
          renderTodoView();
          uiSoftClick();
        } else {
          uiError(); // capacity reached
        }
        _dragSrcTaskId = null; _dragSrcKey = null;
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
          // Project color stripe (if task has a project tag)
          if(t.projectKey && state.projects && state.projects[t.projectKey]){
            const proj = state.projects[t.projectKey];
            li.classList.add("hasProject");
            li.style.setProperty("--proj-color", proj.color);
            li.dataset.projectKey = t.projectKey;
            li.title = (li.title ? li.title + " · " : "") + "#" + proj.name;
          }
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
          // Inline subtasks (read-only display in the timer popover)
          const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
          if(subs.length > 0){
            const subWrap = document.createElement("ul");
            subWrap.className = "taskItemSubs";
            for(const s of subs){
              const sli = document.createElement("li");
              sli.className = "taskItemSub" + (s.done ? " done" : "");
              const dot = document.createElement("span"); dot.className = "taskItemSubDot"; dot.textContent = s.done ? "✓" : "•";
              const stx = document.createElement("span"); stx.className = "taskItemSubText"; stx.textContent = s.text;
              sli.appendChild(dot); sli.appendChild(stx);
              subWrap.appendChild(sli);
            }
            li.appendChild(subWrap);
          }
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
      //   DICE_TIMER_TOTAL_SEC imported from constants.js
      // ════════════════════════════════════════════════════════════
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
        // Sperrt die GESAMTE Arcade (Menü + alle Spiele) während eines Lernintervalls.
        const wrap = document.getElementById("arcadeWrap");
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
          // ── v3 Timer-Architektur: append-only Tages-Historie + Snapshot des laufenden Intervalls.
          //   completedIntervals["YYYY-MM-DD"] = [{ learnMin, breakMin, completedAt, kind }]
          //   activeInterval = null   ODER  {
          //     kind: "learning" | "break",
          //     startedAt: <ms wall-clock>,         // wann begonnen
          //     plannedLearnMin: <int>,             // SNAPSHOT der Settings beim Start (≠ state.settings)
          //     plannedBreakMin: <int>,             //   ┘ Setting-Änderungen modifizieren diese NIE
          //     pausedAt: null | <ms>,              // null=läuft, sonst Zeitpunkt der letzten Pause
          //     pausedElapsedMs: <int>              // bereits angesammelte Lernzeit aus früheren Resume-Zyklen
          //   }
          completedIntervals: {},
          activeInterval: null,
          points: 0,
          pendingRolls: 0,
          pendingRollBonuses: [],
          diceStreak: 0,
          soundEnabled: true,
          soundVolume: 1.0,    // 0.0 (mute) … 1.0 (max). Applies as a global multiplier to all sounds.
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
          // Timer mode + Flow state
          mode: "pomodoro",                  // "pomodoro" | "flow"
          flow: {
            elapsedSec: 0,                   // counts up during learning
            phase: "idle",                   // "idle" | "learning" | "break"
            running: false,
            breakLeftSec: 0,                  // remaining sec in current break
            breakTotalSec: 0,                 // chosen break duration (for display)
            nextAutoPromptSec: 3600,          // when the next auto-pause-prompt fires (60 min, then +30)
            sessions: [],                     // [{ learnMin, breakMin, completedAt }]
            dayKey: "",                       // local date-key of the current block; used for midnight reset
          },
          // Projects: keyed by lowercase tag (from #hashtag).
          // Each entry: { name: <display name with original casing>, color: "#rrggbb" }
          projects: {},
          // Dice collection. Every user starts with the 4-sided die. Higher-sided dice
          // are unlocked sequentially via the Würfelshop.
          dice: {
            owned: ["d4"],
            active: "d4",         // currently selected for reward rolls
            casinoActive: "d4",   // separately selectable inside the casino
          },
          // Würfel-Skins aus Lootboxen. Skins sind PERMANENT — kein Progress-Reset
          // löscht sie (weder performProgressReset noch resetTodayProgress).
          //   owned:  [{ id, dieType, faces: ["yellow",…], pulledAt }, …]  (max. MAX_SKINS)
          //   active: { "d6": "skin_…", … } — aktiver Skin pro Würfeltyp; kein Eintrag = kein Skin
          diceSkins: {
            owned: [],
            active: {},
          },
          // Arcade-Währung: erspieltes Spielzeit-Konto in SEKUNDEN. Wächst beim Lernen
          // (30 Min gelernt → 5 Min Arcade). Dauerhaft gespeichert, akkumuliert über Tage.
          // Wird vom Progress-Reset auf 0 gesetzt (ist "Fortschritt"), Skins nicht.
          arcadeTimeSec: 0,
        };
      }
      // ── Dice catalog: DICE_TYPES / DICE_SIDES / DICE_PRICES / DICE_LABELS imported from constants.js ──
      function ensureDiceState(){
        if(!state.dice || typeof state.dice !== "object"){
          state.dice = { owned: ["d4"], active: "d4", casinoActive: "d4" };
          return;
        }
        if(!Array.isArray(state.dice.owned) || state.dice.owned.length === 0){
          state.dice.owned = ["d4"];
        }
        // Filter out unknown entries, ensure d4 always present
        state.dice.owned = state.dice.owned.filter(d => DICE_TYPES.includes(d));
        if(!state.dice.owned.includes("d4")) state.dice.owned.unshift("d4");
        // De-duplicate while preserving order
        state.dice.owned = Array.from(new Set(state.dice.owned));
        if(!DICE_TYPES.includes(state.dice.active) || !state.dice.owned.includes(state.dice.active)){
          state.dice.active = state.dice.owned[state.dice.owned.length - 1] || "d4";
        }
        if(!DICE_TYPES.includes(state.dice.casinoActive) || !state.dice.owned.includes(state.dice.casinoActive)){
          state.dice.casinoActive = state.dice.active;
        }
      }
      function activeDieId(){ ensureDiceState(); return state.dice.active; }
      function activeDieSides(){ return DICE_SIDES[activeDieId()] || 4; }
      function casinoDieId(){ ensureDiceState(); return state.dice.casinoActive; }
      function casinoDieSides(){ return DICE_SIDES[casinoDieId()] || 4; }
      function ownsDie(id){ ensureDiceState(); return state.dice.owned.includes(id); }
      function canBuyDie(id){
        if(ownsDie(id)) return false;
        const idx = DICE_TYPES.indexOf(id);
        if(idx <= 0) return false; // d4 is the freebie; lower indices don't exist
        const prev = DICE_TYPES[idx - 1];
        if(!ownsDie(prev)) return false; // sequential unlock
        return (state.points || 0) >= (DICE_PRICES[id] || 0);
      }
      function nextLockedDie(){
        for(const id of DICE_TYPES){ if(!ownsDie(id)) return id; }
        return null;
      }
      function buyDie(id){
        if(!canBuyDie(id)) return false;
        state.points = (state.points || 0) - DICE_PRICES[id];
        state.dice.owned.push(id);
        persist();
        return true;
      }
      function setActiveDie(id){
        ensureDiceState();
        if(!ownsDie(id)) return false;
        state.dice.active = id;
        persist();
        return true;
      }
      function setCasinoDie(id){
        ensureDiceState();
        if(!ownsDie(id)) return false;
        state.dice.casinoActive = id;
        persist();
        return true;
      }
      // ── Würfel-Skins (Lootbox-System) ─────────────────────────────────────
      // SKIN_COLORS / SKIN_COLOR_WEIGHTS / LOOTBOX_PRICE / MAX_SKINS aus constants.js.
      function ensureSkinState(){
        if(!state.diceSkins || typeof state.diceSkins !== "object"){
          state.diceSkins = { owned: [], active: {} };
        }
        if(!Array.isArray(state.diceSkins.owned)) state.diceSkins.owned = [];
        if(!state.diceSkins.active || typeof state.diceSkins.active !== "object" || Array.isArray(state.diceSkins.active)){
          state.diceSkins.active = {};
        }
      }
      // Validiert ein (potenziell fremdes) Skin-Objekt aus dem persistierten State.
      // Gibt eine bereinigte Kopie zurück oder null.
      function sanitizeSkin(s){
        if(!s || typeof s !== "object") return null;
        if(typeof s.id !== "string" || !s.id || s.id.length > 64) return null;
        if(!DICE_TYPES.includes(s.dieType)) return null;
        const sides = DICE_SIDES[s.dieType];
        if(!Array.isArray(s.faces) || s.faces.length !== sides) return null;
        if(!s.faces.every(f => SKIN_COLORS.includes(f))) return null;
        return {
          id: s.id,
          dieType: s.dieType,
          faces: s.faces.slice(),
          pulledAt: Number.isFinite(s.pulledAt) ? Math.floor(s.pulledAt) : Date.now(),
        };
      }
      // Gewichtete Zufallsfarbe (yellow 40 % … violet 4 %).
      function rollSkinColor(){
        const total = SKIN_COLOR_WEIGHTS.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for(let i = 0; i < SKIN_COLORS.length; i++){
          r -= SKIN_COLOR_WEIGHTS[i];
          if(r < 0) return SKIN_COLORS[i];
        }
        return SKIN_COLORS[0];
      }
      // Erzeugt ein vollständiges Skin-Objekt: jede Seite UNABHÄNGIG gewürfelt.
      function generateSkin(dieType){
        const sides = DICE_SIDES[dieType] || 4;
        const faces = [];
        for(let i = 0; i < sides; i++) faces.push(rollSkinColor());
        return {
          id: "skin_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          dieType,
          faces,
          pulledAt: Date.now(),
        };
      }
      function getActiveSkin(dieType){
        ensureSkinState();
        const id = state.diceSkins.active[dieType];
        if(!id) return null;
        return state.diceSkins.owned.find(s => s.id === id && s.dieType === dieType) || null;
      }
      function setActiveSkin(dieType, skinId){
        ensureSkinState();
        const skin = state.diceSkins.owned.find(s => s.id === skinId && s.dieType === dieType);
        if(!skin) return false;
        state.diceSkins.active[dieType] = skinId;
        persist();
        return true;
      }
      function clearActiveSkin(dieType){
        ensureSkinState();
        if(!(dieType in state.diceSkins.active)) return false;
        delete state.diceSkins.active[dieType];
        persist();
        return true;
      }
      // false = Sammlung voll (MAX_SKINS) → Aufrufer informiert den Nutzer.
      function addSkinToCollection(skin){
        ensureSkinState();
        if(state.diceSkins.owned.length >= MAX_SKINS) return false;
        state.diceSkins.owned.push(skin);
        persist();
        return true;
      }
      // Entfernt einen Skin endgültig aus der Sammlung. War er aktiv, wird der Eintrag
      // gelöscht. Als Gegenwert gibt es EINEN Würfelwurf zurück (Sammlung ist auf
      // MAX_SKINS begrenzt — Löschen schafft Platz, der Wurf ist die Entschädigung).
      function deleteSkinFromCollection(skinId){
        ensureSkinState();
        const idx = state.diceSkins.owned.findIndex(s => s.id === skinId);
        if(idx < 0) return false;
        const skin = state.diceSkins.owned[idx];
        if(state.diceSkins.active[skin.dieType] === skinId){
          delete state.diceSkins.active[skin.dieType];
        }
        state.diceSkins.owned.splice(idx, 1);
        grantRewardRoll();   // ein Wurf zurück (ohne Boni)
        persist();
        return true;
      }
      // Farbhäufigkeiten eines Skins, absteigend sortiert (Gleichstand: Palette-Reihenfolge).
      function skinColorCounts(skin){
        const counts = {};
        for(const f of skin.faces) counts[f] = (counts[f] || 0) + 1;
        return Object.keys(counts)
          .map(color => ({ color, count: counts[color] }))
          .sort((a, b) => (b.count - a.count) || (SKIN_COLORS.indexOf(a.color) - SKIN_COLORS.indexOf(b.color)));
      }
      // Raritäts-Label: legendär (alles violet) > episch (violet) > selten (orange)
      // > ungewöhnlich (blue/green) > gewöhnlich (nur yellow/red).
      function skinRarity(skin){
        const f = skin.faces;
        if(f.every(c => c === "violet"))            return { key: "legendary", label: "Legendär" };
        if(f.includes("violet"))                    return { key: "epic",      label: "Episch" };
        if(f.includes("orange"))                    return { key: "rare",      label: "Selten" };
        if(f.includes("blue") || f.includes("green")) return { key: "uncommon", label: "Ungewöhnlich" };
        return { key: "common", label: "Gewöhnlich" };
      }
      // Automatische Beschreibung, z.B. "Überwiegend Gelb, 2× Rot, 1× Blau".
      function skinDescription(skin){
        const entries = skinColorCounts(skin);
        const parts = entries.map((e, i) => {
          const name = SKIN_COLOR_NAMES_DE[e.color] || e.color;
          if(i === 0 && e.count >= 2 && (entries.length === 1 || e.count > entries[1].count)){
            return "Überwiegend " + name;
          }
          return e.count + "× " + name;
        });
        return parts.join(", ");
      }
      // Skin-Code = "Name" des Würfels: "#" + ein Buchstabe pro Seite (Seite 1 = faces[0]).
      // Buchstabe = englischer Anfangsbuchstabe der Farbe. Bsp.: d4 ganz rot → "#rrrr".
      function skinCode(skin){
        return "#" + skin.faces.map(c => SKIN_COLOR_LETTERS[c] || "?").join("");
      }
      // Wahrscheinlichkeit, dass ein zufällig gezogener Skin dieses Würfeltyps GENAU diese
      // Farb-Zusammensetzung hat — also die Häufigkeiten der Farben, Reihenfolge egal.
      // Multinomialverteilung:  P = (n! / (c1!·c2!·…)) · p1^c1 · p2^c2 · …   →  Wert in [0,1].
      function skinCompositionProbability(skin){
        const counts = {};
        for(const c of skin.faces) counts[c] = (counts[c] || 0) + 1;
        const n = skin.faces.length;
        const fact = (k) => { let r = 1; for(let i = 2; i <= k; i++) r *= i; return r; };
        let coeff = fact(n);
        let p = 1;
        for(const color of SKIN_COLORS){
          const c = counts[color] || 0;
          if(c === 0) continue;
          coeff /= fact(c);
          const prob = SKIN_COLOR_WEIGHTS[SKIN_COLORS.indexOf(color)] / 100; // Gewichte summieren zu 100
          p *= Math.pow(prob, c);
        }
        return coeff * p;
      }
      // Formatiert eine Wahrscheinlichkeit (0..1) als deutsch lesbaren Prozent-String + "1 zu N".
      function formatSkinProbability(p){
        const pct = p * 100;
        let pctStr;
        if(pct >= 10)        pctStr = pct.toFixed(1);
        else if(pct >= 1)    pctStr = pct.toFixed(2);
        else if(pct >= 0.01) pctStr = pct.toFixed(3);
        else                 pctStr = pct.toPrecision(2);
        pctStr = pctStr.replace(".", ",") + "%";
        const oneIn = p > 0 ? Math.round(1 / p) : Infinity;
        const oneInStr = Number.isFinite(oneIn) ? ("1 zu " + oneIn.toLocaleString("de-DE")) : "";
        return { pctStr, oneInStr };
      }
      // Seltenheits-Stufe NUR nach Zieh-Wahrscheinlichkeit (unabhängig von der farb-basierten
      // skinRarity()). Eskaliert von "Wahrscheinlich" bis "Super selten" — siehe Info-Index im Shop.
      function skinProbTier(p){
        const pct = p * 100;
        if(pct >= 10)   return { key: "p-common",    label: "Wahrscheinlich" };
        if(pct >= 1)    return { key: "p-uncommon",  label: "Eher selten" };
        if(pct >= 0.1)  return { key: "p-rare",      label: "Selten" };
        if(pct >= 0.01) return { key: "p-veryrare",  label: "Sehr selten" };
        return { key: "p-superrare", label: "Super selten" };
      }
      // PROJECT_COLOR_PALETTE is imported from constants.js (shared with avatars).
      function pickNextProjectColor(){
        // Random pick from the palette — duplicates are allowed.
        const i = Math.floor(Math.random() * PROJECT_COLOR_PALETTE.length);
        return PROJECT_COLOR_PALETTE[i];
      }
      // Ensure a project exists. Returns the canonical key (lowercase tag).
      function ensureProject(rawTag){
        if(!rawTag) return null;
        const key = String(rawTag).toLowerCase().trim();
        if(!key) return null;
        if(!state.projects) state.projects = {};
        if(!state.projects[key]){
          state.projects[key] = {
            name: String(rawTag).trim(),       // keep first-seen casing as display name
            color: pickNextProjectColor(),
          };
        }
        return key;
      }
      // Parse a free-form task input. Extracts the FIRST #tag (anywhere in the string),
      // strips it from the visible text, and returns the project key + clean text.
      //   "#mathe Aufgabe 1"      → { projectKey:"mathe", projectName:"mathe", text:"Aufgabe 1" }
      //   "Aufgabe 1 #Mathe"      → { projectKey:"mathe", projectName:"Mathe",  text:"Aufgabe 1" }
      //   "Etwas #IT-Sec lernen"   → { projectKey:"it-sec", projectName:"IT-Sec", text:"Etwas lernen" }
      //   "Aufgabe ohne tag"        → { projectKey:null,    projectName:null,     text:"Aufgabe ohne tag" }
      //   "" / "  "                  → null
      function parseTaskInput(raw){
        if(typeof raw !== "string") return null;
        const text0 = raw.trim();
        if(!text0) return null;
        // Allow letters, digits, dash, underscore in tag names; min 2 chars.
        const m = text0.match(/#([A-Za-zÄÖÜäöüß0-9_\-]{2,30})/);
        if(m){
          const tag = m[1];
          const cleanText = text0
            .replace(m[0], "")
            .replace(/\s+/g, " ")
            .trim();
          return {
            projectKey: tag.toLowerCase(),
            projectName: tag,
            text: cleanText || "",   // empty text is allowed by caller to short-circuit
          };
        }
        return { projectKey: null, projectName: null, text: text0 };
      }
      const AVATAR_EMOJI_OPTIONS = ["🦊","🐻","🐼","🐱","🐶","🐯","🦁","🐸","🦉","🐧","🐵","🐰","🦄","🐲","🌟","🚀","🎯","📚","☕","🍀","⚡","🔥","🎨","🧠"];
      // AVATAR_COLOR_OPTIONS imported from constants.js (shared with project palette)
      function isValidAvatar(a){
        if(!a || typeof a !== "object" || typeof a.type !== "string" || typeof a.value !== "string") return false;
        if(a.type === "emoji")   return a.value.length > 0 && a.value.length <= 8;
        if(a.type === "initial") return /^#[0-9a-fA-F]{6}$/.test(a.value);
        if(a.type === "image")   return a.value.startsWith("data:image/") && a.value.length < 200000;
        return false;
      }
      // MAX_TEMPLATES and genTemplateId imported from constants.js / utils.js
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
        if(Number.isFinite(p.soundVolume)) base.soundVolume = Math.max(0, Math.min(1, p.soundVolume));
        if(p.intervalTasks && typeof p.intervalTasks === "object") base.intervalTasks = p.intervalTasks;
        if(Array.isArray(p.completedHistory)) base.completedHistory = p.completedHistory.slice(-500);
        // ── v3 Timer-State: append-only per-day history + active interval snapshot ──
        if(p.completedIntervals && typeof p.completedIntervals === "object" && !Array.isArray(p.completedIntervals)){
          base.completedIntervals = {};
          for(const dayKey of Object.keys(p.completedIntervals)){
            if(!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) continue;
            const list = p.completedIntervals[dayKey];
            if(!Array.isArray(list)) continue;
            base.completedIntervals[dayKey] = list
              .filter(e => e && Number.isFinite(e.learnMin))
              .slice(0, 64)   // safety cap
              .map(e => ({
                learnMin:    Math.max(0, Math.floor(e.learnMin)),
                breakMin:    Math.max(0, Math.floor(e.breakMin || 0)),
                completedAt: Number.isFinite(e.completedAt) ? e.completedAt : Date.now(),
                kind:        (e.kind === "session" || e.kind === "break") ? e.kind : "session",
              }));
          }
        }
        if(p.activeInterval && typeof p.activeInterval === "object"){
          const a = p.activeInterval;
          if((a.kind === "learning" || a.kind === "break") && Number.isFinite(a.startedAt)){
            base.activeInterval = {
              kind: a.kind,
              startedAt: Math.floor(a.startedAt),
              plannedLearnMin: Math.max(1, Math.floor(a.plannedLearnMin || base.settings.learn_min)),
              plannedBreakMin: Math.max(0, Math.floor(a.plannedBreakMin || 0)),
              pausedAt:        Number.isFinite(a.pausedAt) ? Math.floor(a.pausedAt) : null,
              pausedElapsedMs: Math.max(0, Math.floor(a.pausedElapsedMs || 0)),
            };
          }
        }
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
        if(p.mode === "pomodoro" || p.mode === "flow") base.mode = p.mode;
        if(p.projects && typeof p.projects === "object"){
          base.projects = {};
          for(const k of Object.keys(p.projects)){
            const proj = p.projects[k];
            if(proj && typeof proj === "object" && typeof proj.name === "string"){
              const color = typeof proj.color === "string" && /^#[0-9a-fA-F]{6}$/.test(proj.color)
                ? proj.color
                : PROJECT_COLOR_PALETTE[0];
              base.projects[String(k).toLowerCase()] = { name: proj.name, color };
            }
          }
        }
        if(p.dice && typeof p.dice === "object"){
          if(!base.dice) base.dice = { owned: ["d4"], active: "d4", casinoActive: "d4" };
          if(Array.isArray(p.dice.owned)){
            const valid = p.dice.owned.filter(d => DICE_TYPES.includes(d));
            base.dice.owned = Array.from(new Set(["d4", ...valid]));
          }
          if(typeof p.dice.active === "string" && DICE_TYPES.includes(p.dice.active)){
            base.dice.active = p.dice.active;
          }
          if(typeof p.dice.casinoActive === "string" && DICE_TYPES.includes(p.dice.casinoActive)){
            base.dice.casinoActive = p.dice.casinoActive;
          }
        }
        // ── Würfel-Skins: jede Eintragung wird einzeln validiert (kein blindes Übernehmen) ──
        if(p.diceSkins && typeof p.diceSkins === "object"){
          base.diceSkins = { owned: [], active: {} };
          if(Array.isArray(p.diceSkins.owned)){
            const seenIds = new Set();
            for(const raw of p.diceSkins.owned){
              if(base.diceSkins.owned.length >= MAX_SKINS) break;
              const skin = sanitizeSkin(raw);
              if(skin && !seenIds.has(skin.id)){
                seenIds.add(skin.id);
                base.diceSkins.owned.push(skin);
              }
            }
          }
          if(p.diceSkins.active && typeof p.diceSkins.active === "object" && !Array.isArray(p.diceSkins.active)){
            for(const dt of DICE_TYPES){
              const id = p.diceSkins.active[dt];
              if(typeof id === "string" && base.diceSkins.owned.some(s => s.id === id && s.dieType === dt)){
                base.diceSkins.active[dt] = id;
              }
            }
          }
        }
        if(Number.isFinite(p.arcadeTimeSec)) base.arcadeTimeSec = Math.max(0, Math.floor(p.arcadeTimeSec));
        if(p.flow && typeof p.flow === "object"){
          const f = p.flow;
          if(Number.isFinite(f.elapsedSec))      base.flow.elapsedSec = Math.max(0, Math.floor(f.elapsedSec));
          if(typeof f.phase === "string" && ["idle","learning","break"].indexOf(f.phase) >= 0) base.flow.phase = f.phase;
          if(typeof f.running === "boolean")     base.flow.running = f.running;
          if(Number.isFinite(f.breakLeftSec))    base.flow.breakLeftSec = Math.max(0, Math.floor(f.breakLeftSec));
          if(Number.isFinite(f.breakTotalSec))   base.flow.breakTotalSec = Math.max(0, Math.floor(f.breakTotalSec));
          if(Number.isFinite(f.nextAutoPromptSec)) base.flow.nextAutoPromptSec = Math.max(60, Math.floor(f.nextAutoPromptSec));
          if(typeof f.dayKey === "string")        base.flow.dayKey = f.dayKey;
          if(Array.isArray(f.sessions)){
            base.flow.sessions = f.sessions
              .filter(s => s && Number.isFinite(s.learnMin))
              .slice(0, 64)
              .map(s => ({
                learnMin: Math.max(0, Math.floor(s.learnMin)),
                breakMin: Math.max(0, Math.floor(s.breakMin || 0)),
                completedAt: Number.isFinite(s.completedAt) ? s.completedAt : Date.now(),
              }));
          }
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
          soundVolume: state.soundVolume,
          intervalTasks: state.intervalTasks,
          completedHistory: state.completedHistory,
          completedIntervals: state.completedIntervals,
          activeInterval: state.activeInterval,
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
          mode: state.mode,
          flow: state.flow,
          projects: state.projects,
          dice: state.dice,
          diceSkins: state.diceSkins,
          arcadeTimeSec: state.arcadeTimeSec,
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
      // LOCAL_FALLBACK_KEY imported from constants.js

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
        // ── v3: Timer-Pause-Semantik ──
        //   • Lernen läuft im Hintergrund DURCH (Tab-Wechsel, Fenster verschoben).
        //   • Nur beim ECHTEN Schließen (pagehide / beforeunload) schreiben wir pausedAt,
        //     damit nach Wieder-Öffnen exakt an gleicher Stelle weitergemacht werden kann.
        //   • Pausen-Intervalle laufen IMMER per Wall-Clock weiter (kein pausedAt schreiben).
        document.addEventListener("visibilitychange", () => {
          if(document.visibilityState === "hidden"){
            // KEIN Reset mehr — der Wall-Clock-Anker übersteht Hintergrund-Throttling.
            flushSyncOnUnload();
          } else if(document.visibilityState === "visible"){
            // Bei Rückkehr: Tick neu seeden (falls Worker während Throttling fast eingeschlafen war)
            if(state.running && tickAnchor){
              // tickAnchor.wallStart bleibt — fresh tick re-syncs timeLeft on next worker tick
            }
            if(dirty) saveToCloud();
          }
        });
        // pagehide — covers BFCache + iOS/Safari unload
        window.addEventListener("pagehide", () => {
          pauseOnUnload();
          flushSyncOnUnload();
        });
        // beforeunload — desktop legacy fallback
        window.addEventListener("beforeunload", () => {
          pauseOnUnload();
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
        views: { timer: el("timerView"), dice: el("diceView"), stats: el("statsView"), leaderboard: el("leaderboardView"), todo: el("todoView"), shop: el("shopView"), settings: el("settingsView") },
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
        skipBreakModal: el("skipBreakModal"), skipBreakText: el("skipBreakText"),
        skipBreakYes: el("skipBreakYes"), skipBreakNo: el("skipBreakNo"),
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
        // To-Do v2: dynamic — handled via document.getElementById in renderTodoView/handlers
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
        if(isFlow()){
          if(state.alarmActive) return "Pause vorbei — tippe, um den Alarm zu stoppen";
          if(state.flow.phase === "learning"){
            if(!state.flow.running) return "Pausiert — bereit, weiterzulernen";
            const min = Math.floor(state.flow.elapsedSec / 60);
            return min > 0 ? `Flow läuft — ${min} Min gelernt` : "Flow läuft — los geht's";
          }
          if(state.flow.phase === "break"){
            const total = Math.max(1, Math.round(state.flow.breakTotalSec / 60));
            return `Pause — ${total} Min Erholung`;
          }
          return "Bereit — starte deinen Flow";
        }
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
      // Headline above the timer.
      function computeTopInfoText(){
        if(isFlow()){
          const todayMin = getMin(todayISO());
          const h = Math.floor(todayMin / 60), m = todayMin % 60;
          const todayStr = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} Min`;
          const n = (state.flow.sessions || []).length;
          return `Flow-Modus  ·  Heute ${todayStr} gelernt  ·  ${n} Block${n === 1 ? "" : "s"} abgeschlossen`;
        }
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
        if(isFlow()){
          if(state.alarmActive) return "🔔  Alarm aus";
          return state.flow.running ? "⏸  Pause" : (state.flow.phase === "idle" ? "▶  Start" : "▶  Weiter");
        }
        if(state.alarmActive) return "🔔  Alarm aus";
        if(state.running)     return "⏸  Pause";
        if(state.phase === "done") return "✓  Fertig";
        return "▶  Start";
      }
      function computeCompactToggleText(){
        if(isFlow()){
          if(state.alarmActive) return "🔔";
          return state.flow.running ? "⏸" : "▶";
        }
        if(state.alarmActive) return "🔔";
        if(state.running)     return "⏸";
        if(state.phase === "done") return "✓";
        return "▶";
      }
      function computeStartDisabled(){
        if(isFlow()) return false;
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
      // fmtTime imported from time.js
      function progressText(){
        const doneMin = getMin(todayISO());
        const h = Math.floor(doneMin / 60), m = doneMin % 60;
        if(isFlow()){
          // Flow has no fixed daily goal — just show today's tally
          if(doneMin === 0) return "Heute noch nichts gelernt";
          return h > 0
            ? `Heute ${h}h ${String(m).padStart(2,"0")}m gelernt`
            : `Heute ${m} Min gelernt`;
        }
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
        const mainIcon = computeCompactToggleText();
        setText(dom.startBtn,      "startBtn",      mainIcon);
        setText(dom.compactToggle, "compactToggle", mainIcon);
        setBoolProp(dom.startBtn,      "startDisabled",         "disabled", startDisabled);
        setBoolProp(dom.compactToggle, "compactToggleDisabled", "disabled", startDisabled);
        // Skip button — different semantics per mode:
        //   • Pomodoro: only enabled during breaks (anti-farming rule)
        //   • Flow learning: enabled once the block has run ≥ 1 min (opens the pause prompt).
        //                    Visually "armed" with a soft glow.
        //   • Flow break: enabled (skips the break)
        let skipDisabled = true;
        let skipArmed = false;
        if(isFlow()){
          if(state.flow.phase === "break"){
            skipDisabled = false;
          } else if(state.flow.phase === "learning" && state.flow.running){
            if(flowPauseWindowActive()){
              skipDisabled = false;
              skipArmed = true;
            }
          }
        } else {
          skipDisabled = state.phase !== "break";
        }
        setBoolProp(dom.skipBtn, "skipDisabled", "disabled", skipDisabled);
        setText(dom.skipBtn, "skipText", "⏭");
        if(dom.skipBtn) dom.skipBtn.classList.toggle("flowArmed", skipArmed);
        // Prominent pause-choice button — visible during a running learning block once it
        // has passed the 1-min minimum. The user may pause/end at any time from here.
        const pauseBtn = document.getElementById("flowPauseChoiceBtn");
        if(pauseBtn){
          const canPause = isFlow() && state.flow.phase === "learning" && state.flow.running && flowPauseWindowActive();
          const disp = canPause ? "flex" : "none";
          if(pauseBtn.style.display !== disp) pauseBtn.style.display = disp;
        }
        // Reset is available unless we're in pomodoro-done state
        const resetDis = !isFlow() && state.phase === "done";
        setBoolProp(dom.resetBtn, "resetDisabled", "disabled", resetDis);
        const finishDisp = (!isFlow() && state.phase === "done") ? "flex" : "none";
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
        if(isFlow()){
          // Flow timer counts UP during learning, DOWN during break.
          const sec = state.flow.phase === "break" ? state.flow.breakLeftSec : state.flow.elapsedSec;
          const t = fmtTimeFlow(sec);
          setText(dom.timerText, "timerText", t);
          setText(dom.compactTimer, "compactTimer", t);
          // No progress fill in flow mode — CSS hides .progressShell via body.mode-flow
          return;
        }
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
        accrueArcadeTime(minutes);   // ← Spielzeit-Konto wächst mit der gelernten Zeit
      }
      function unrecordSession(minutes){
        const key = todayISO();
        const next = Math.max(0, getMin(key) - minutes);
        if(next <= 0) delete state.data[key]; else state.data[key] = next;
        accrueArcadeTime(-minutes);  // ← symmetrisch zurücknehmen (kein Farmen durch Undo)
      }
      // Arcade-Währung gutschreiben/abziehen: 10 Arcade-Sekunden je gelernter Minute
      // (30 Min → 5 Min). Konto bleibt ≥ 0. m kann negativ sein (Undo).
      function accrueArcadeTime(m){
        if(!Number.isFinite(m) || m === 0) return;
        const cur = Number.isFinite(state.arcadeTimeSec) ? state.arcadeTimeSec : 0;
        state.arcadeTimeSec = Math.max(0, Math.round(cur + m * ARCADE_SEC_PER_LEARN_MIN));
        if(typeof renderArcadeTime === "function") renderArcadeTime();
      }
      // Spielzeit ausgeben (Sekunden). Gibt false zurück, wenn das Konto nicht reicht
      // (es wird dann NICHTS abgezogen). Sonst abziehen, Anzeige + Persist aktualisieren.
      function spendArcadeTime(sec){
        const need = Math.max(0, Math.round(Number(sec) || 0));
        const cur = Number.isFinite(state.arcadeTimeSec) ? state.arcadeTimeSec : 0;
        if(cur < need) return false;
        state.arcadeTimeSec = Math.max(0, cur - need);
        if(typeof renderArcadeTime === "function") renderArcadeTime();
        persist();
        return true;
      }
      // Spielzeit zurückerstatten (Sekunden) — z.B. wenn ein Spiel nie zustande kam.
      function refundArcadeTime(sec){
        const add = Math.max(0, Math.round(Number(sec) || 0));
        if(add <= 0) return;
        const cur = Number.isFinite(state.arcadeTimeSec) ? state.arcadeTimeSec : 0;
        state.arcadeTimeSec = Math.max(0, cur + add);
        if(typeof renderArcadeTime === "function") renderArcadeTime();
        persist();
      }
      // Spielzeit-Konto als "Xm Ys" oder "Ys" formatieren.
      function formatArcadeTime(sec){
        const s = Math.max(0, Math.floor(Number(sec) || 0));
        const m = Math.floor(s / 60);
        const r = s % 60;
        if(m <= 0) return r + "s";
        return m + "m " + (r < 10 ? "0" + r : r) + "s";
      }
      function updateDataFromToday(){
        // ── v3: Source of truth is state.completedIntervals[today].length ──
        // (NOT todayMin ÷ learn_min — that "merged" two 30-min blocks into one
        //  60-min block when the user changed settings.)
        // For users coming from v2 (no completedIntervals yet but with state.data),
        // we fall back to the old derivation ONCE to avoid losing today's progress.
        const day = todayISO();
        let n;
        const v3List = (state.completedIntervals && Array.isArray(state.completedIntervals[day]))
          ? state.completedIntervals[day]
          : null;
        if(v3List){
          n = Math.min(v3List.length, TOTAL_SESSIONS);
        } else {
          // v2 fallback: derive once from minutes (this happens only on first load
          // after migration; subsequent days will be append-only).
          const todayMin = Number(state.data[day]) || 0;
          n = Math.min(Math.floor(todayMin / state.settings.learn_min), TOTAL_SESSIONS);
        }
        const midPhase = state.phase === "learning" || state.phase === "break";
        state.sessionsDone = Array(TOTAL_SESSIONS).fill(false);
        state.breaksDone   = Array(TOTAL_SESSIONS - 1).fill(false);
        for(let i=0;i<n;i++) state.sessionsDone[i] = true;
        for(let i=0;i<Math.min(n-1, TOTAL_SESSIONS-1); i++) state.breaksDone[i] = true;
        if(!midPhase){
          state.sessionIdx = n;
          if(n >= TOTAL_SESSIONS){ state.phase = "done"; state.timeLeft = 0; }
          else if(state.phase === "done"){
            // "done" is only legitimate when ALL of today's intervals are actually
            // complete (n >= TOTAL). If we land here, the "done" state is stale —
            // it carried over from a previous day that has since reset (1 AM cutoff),
            // or a template switch added sessions. Drop it and prime a runnable idle
            // phase so the "Fertig"-Box hides and the Play button works again.
            setupNextPhase();
          }
        } else {
          // Keep the in-progress phase intact; just sanity-check the indices.
          if(state.phase === "learning"){
            if(!Number.isInteger(state.sessionIdx) || state.sessionIdx < 0 || state.sessionIdx >= TOTAL_SESSIONS){
              state.sessionIdx = n;
            }
          } else { // break
            if(!Number.isInteger(state.curBreak) || state.curBreak < 0 || state.curBreak >= TOTAL_SESSIONS - 1){
              state.curBreak = Math.max(0, n - 1);
              state.sessionIdx = state.curBreak;
            }
            if(state.sessionIdx !== state.curBreak) state.sessionIdx = state.curBreak;
          }
        }
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
          // Defense-in-depth: if sessionIdx drifted out of bounds or onto an already-done
          // session, snap to the first open session via nextTarget().
          let idx = state.sessionIdx;
          if(!Number.isInteger(idx) || idx < 0 || idx >= TOTAL_SESSIONS || state.sessionsDone[idx]){
            const [nk, ni] = nextTarget();
            if(nk === "session") idx = ni; else return;
            state.sessionIdx = idx;
          }
          // ── v3: append to today's IMMUTABLE history with the PLANNED minutes
          // (NOT current settings — keeps history correct across setting changes).
          const plannedLearn = (state.activeInterval && state.activeInterval.kind === "learning"
            && Number.isFinite(state.activeInterval.plannedLearnMin))
              ? state.activeInterval.plannedLearnMin
              : effectiveLearnMin(idx);
          const plannedBreak = (state.activeInterval && state.activeInterval.kind === "learning"
            && Number.isFinite(state.activeInterval.plannedBreakMin))
              ? state.activeInterval.plannedBreakMin
              : breakMinAt(idx);
          appendCompletedInterval({ learnMin: plannedLearn, breakMin: plannedBreak, kind: "session" });
          state.sessionsDone[idx] = true;
          recordSession(plannedLearn);      // ← use plannedLearn so today's data matches history
          carryOverTasks(idx);
          // Now move into BREAK phase. Snapshot the break duration into a fresh activeInterval.
          state.activeInterval = null;      // learning phase ended, clear snapshot
          if(idx === TOTAL_SESSIONS - 1){
            state.phase = "done"; state.timeLeft = 0; updateTimerUI(); drawTrack();
            if(silent) showFinish(); else { state.alarmActive = true; updateTimerUI(); startAlarm(); }
            if(!silent) notifyPhaseEnd("done");
            persist(); return;
          }
          state.curBreak = idx;
          state.phase = "break";
          state.timeLeft = plannedBreak * 60;   // ← use plannedBreak (= snapshot value)
          // Snapshot break-phase too — wall-clock continues even if tab is closed.
          state.activeInterval = {
            kind: "break",
            startedAt: Date.now(),
            plannedLearnMin: 0,
            plannedBreakMin: plannedBreak,
            pausedAt: null,
            pausedElapsedMs: 0,
          };
        } else if(state.phase === "break"){
          const bIdx = (Number.isInteger(state.curBreak) && state.curBreak >= 0 && state.curBreak < state.breaksDone.length)
            ? state.curBreak
            : null;
          if(bIdx !== null) state.breaksDone[bIdx] = true;
          state.activeInterval = null;      // break ended
          const [k, i] = nextTarget();
          if(k === "session"){
            state.sessionIdx = i;
            state.phase = "learning";
            state.timeLeft = effectiveLearnSec(i);
          } else if(k === "break"){
            state.curBreak = i;
            state.phase = "break";
            state.timeLeft = breakMinAt(i) * 60;
          } else {
            state.phase = "done"; state.timeLeft = 0;
          }
        } else return;
        updateTimerUI(); drawTrack(); persist();
        if(!silent){
          state.alarmActive = true;
          startAlarm();
          notifyPhaseEnd(endedPhase);
        }
      }
      // ── v3: per-day completion log helper ────────────────────────────────
      function appendCompletedInterval(entry){
        if(!state.completedIntervals || typeof state.completedIntervals !== "object"){
          state.completedIntervals = {};
        }
        const day = todayISO();
        if(!Array.isArray(state.completedIntervals[day])) state.completedIntervals[day] = [];
        state.completedIntervals[day].push({
          learnMin:    Math.max(0, Math.floor(entry.learnMin || 0)),
          breakMin:    Math.max(0, Math.floor(entry.breakMin || 0)),
          completedAt: Date.now(),
          kind:        entry.kind || "session",
        });
      }
      // Persist throttle: only write to localStorage at most every PERSIST_INTERVAL ms during ticking
      // PERSIST_INTERVAL imported from constants.js
      let lastPersist = 0;
      function persistThrottled(){
        const now = Date.now();
        if(now - lastPersist >= PERSIST_INTERVAL){ lastPersist = now; persist(); }
      }
      // Drift-free tick: timeLeft is recomputed from wall-clock anchor
      function onWorkerTick(){
        // Flow mode has its own tick driver.
        if(isFlow()){
          if(!state.flow.running || !flowTickAnchor) return;
          flowTimerTick();
          // Dice timer also advances during flow-learning (handled by diceTimerAnchor lifecycle).
          diceTimerTick();
          return;
        }
        // Pomodoro path (unchanged).
        if(!state.running || tickAnchor === null) return;
        const elapsed = (Date.now() - tickAnchor.wallStart) / 1000;
        const newLeft = Math.max(0, tickAnchor.secondsAtStart - Math.floor(elapsed));
        if(newLeft !== state.timeLeft){
          state.timeLeft = newLeft;
          updateTimerTickUI();
          persistThrottled();
        }
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
          // ── v3: snapshot interval params on transition idle/paused → running ──
          // Only re-snapshot if there's no active interval yet, OR if the active one
          // was a DIFFERENT phase. Existing snapshots are preserved across pause/resume
          // so setting changes during pause don't retroactively change the duration.
          if(!state.activeInterval || state.activeInterval.kind !== state.phase){
            state.activeInterval = {
              kind: state.phase,             // "learning" or "break"
              startedAt: Date.now(),
              plannedLearnMin: state.phase === "learning" ? effectiveLearnMin(state.sessionIdx) : 0,
              plannedBreakMin: state.phase === "break"    ? breakMinAt(state.curBreak)         : breakMinAt(state.sessionIdx),
              pausedAt: null,
              pausedElapsedMs: 0,
            };
          } else if(state.activeInterval.pausedAt){
            // Resuming after a pause: accumulate paused-elapsed and clear pausedAt.
            // We do NOT add wall-clock time during pause to elapsed; the new anchor
            // reflects "we restart counting from now with timeLeft preserved".
            state.activeInterval.pausedAt = null;
          }
          startTickAnchor();
          workerStart();
          if(state.phase === "learning"){
            diceTrackingStart();
            requestWakeLock();                  // keep screen on while learning
            ensureNotificationPermission();     // ask for permission on first start
          }
        } else {
          // ── User-pressed pause: write pausedAt so we can restore later ──
          workerStop();
          tickAnchor = null;
          diceTrackingStop();
          releaseWakeLock();                    // free screen when paused
          if(state.activeInterval && state.phase === "learning"){
            state.activeInterval.pausedAt = Date.now();
          }
        }
        persist(); updateTimerUI();
      }
      // How many minutes WOULD be carried to the next break if the current break were
      // skipped right now — without mutating anything. Returns 0 when there's nothing to
      // carry (not in a break, no time left, or no next break exists). The skip-confirm
      // dialog uses this both to decide whether to ask and to label the prompt.
      // Break i sits between session i and session i+1, so it exists for i in [0 .. TOTAL_SESSIONS - 2].
      function pendingBreakCarryMin(){
        if(state.phase !== "break") return 0;
        const remainSec = Math.max(0, state.timeLeft | 0);
        if(remainSec <= 0) return 0;
        const nextBreakIdx = state.curBreak + 1;
        if(nextBreakIdx > TOTAL_SESSIONS - 2) return 0;
        return Math.max(1, Math.round(remainSec / 60));
      }
      // Carry the remaining time of the CURRENT break over to the NEXT break (rounded to min).
      // Returns the number of bonus minutes that were transferred (0 if nothing to carry).
      function transferBreakRemainderToNext(){
        const bonusMin = pendingBreakCarryMin();
        if(bonusMin <= 0) return 0;
        const nextBreakIdx = state.curBreak + 1;
        if(!Array.isArray(state.breakLengthOverrides)) state.breakLengthOverrides = [];
        while(state.breakLengthOverrides.length <= nextBreakIdx) state.breakLengthOverrides.push(null);
        const baseMin = breakMinAt(nextBreakIdx); // resolves either existing override or template default
        state.breakLengthOverrides[nextBreakIdx] = baseMin + bonusMin;
        return bonusMin;
      }
      // Actually skip the current break. `carry` decides whether the unused minutes roll
      // into the next break (user's choice in the skip-confirm dialog).
      function performBreakSkip(carry){
        if(state.phase !== "break") return;
        if(carry) transferBreakRemainderToNext();
        stopAlarm();
        state.timeLeft = 0;
        complete(true);
      }
      // Entry point for skipping a break: if there are minutes that could be carried over,
      // ask the user (Ja/Nein) first; otherwise skip immediately. Returns "asking" when the
      // dialog was opened, "skipped" when it skipped right away, "none" when not in a break.
      function requestBreakSkip(){
        if(state.phase !== "break") return "none";
        const bonus = pendingBreakCarryMin();
        if(bonus <= 0){ performBreakSkip(false); return "skipped"; }
        openSkipBreakModal(bonus);
        return "asking";
      }
      function openSkipBreakModal(bonusMin){
        // Defensive fallback: if the modal isn't in the DOM, keep prior behaviour (carry).
        if(!dom.skipBreakModal){ performBreakSkip(true); return; }
        if(dom.skipBreakText){
          dom.skipBreakText.textContent =
            `Du hast noch ${bonusMin} Minute${bonusMin === 1 ? "" : "n"} Pause übrig. `
            + `Sollen sie zur nächsten Pause hinzugefügt werden?`;
        }
        dom.skipBreakModal.classList.add("show");
        dom.skipBreakModal.setAttribute("aria-hidden", "false");
      }
      function closeSkipBreakModal(){
        if(!dom.skipBreakModal) return;
        dom.skipBreakModal.classList.remove("show");
        dom.skipBreakModal.setAttribute("aria-hidden", "true");
      }
      function skipPhase(){
        if(state.phase !== "break") return;
        requestBreakSkip();
      }
      // /skip command: skips either learning interval or break by triggering completion now.
      // Learning skips never carry over (no bonus target); break skips go through the
      // Ja/Nein carry-over dialog via requestBreakSkip().
      function skipAny(){
        if(state.phase === "learning"){
          stopAlarm(); state.timeLeft = 0; complete(true);
          return true;
        }
        if(state.phase === "break"){
          requestBreakSkip();
          return true;
        }
        return false;
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
      // ── v3 pause-on-real-close ──
      // pagehide / beforeunload: user is closing the tab or navigating away.
      //   • LEARNING phase → freeze the timer at the current timeLeft, write pausedAt.
      //                      Browser tab is gone, no time should accumulate during absence.
      //   • BREAK phase    → write NOTHING. Wall-clock continues; on next open we
      //                      compute "have we passed plannedBreakMin?" and react.
      //   • Other phases   → noop.
      function pauseOnUnload(){
        if(state.phase === "learning" && state.running){
          state.running = false;
          if(state.activeInterval){
            state.activeInterval.pausedAt = Date.now();
          }
          // Snapshot timeLeft so resume() knows where we stopped.
          if(currentUser){ dirty = true; writeLocalFallback(); }
        }
      }
      // Legacy compatibility shim — kept as no-op so any remaining callers don't crash.
      function enforceAntiFarmingReset(){ /* removed in v3 timer architecture */ }
      // ── v3: reconcile the active interval after a reload ──────────────
      // Called from applyLoadedState() BEFORE updateDataFromToday(). Three cases:
      //   1. activeInterval is null → nothing to do.
      //   2. activeInterval.kind === "learning" → was running before user closed tab.
      //      If pausedAt is set, leave it paused (user must click Start).
      //      We do NOT advance the timer during absence — learning only counts while open.
      //   3. activeInterval.kind === "break" → break time keeps flowing while tab was closed.
      //      Compute elapsed = (now - startedAt)/1000. If >= plannedBreakMin*60, break finished
      //      during absence → complete() the break silently and move on.
      function resolveActiveIntervalOnLoad(){
        const a = state.activeInterval;
        if(!a) return;
        // Stale day check: if the interval was started on a different LOCAL day, drop it.
        // (Otherwise yesterday's mid-break could "haunt" today.)
        const startedDay = localDateKey(new Date(a.startedAt));
        if(startedDay !== todayISO()){
          state.activeInterval = null;
          return;
        }
        if(a.kind === "learning"){
          // Phase must already be "learning" — but if persisted state is missing it (edge case),
          // set it now. running=false because tab was closed.
          if(state.phase !== "learning") state.phase = "learning";
          state.running = false;
          // timeLeft was snapshotted on pauseOnUnload (or by complete()); keep it.
          // If pausedAt isn't set yet (e.g. browser crash), set it now so user is in paused-state.
          if(!a.pausedAt) a.pausedAt = Date.now();
        } else if(a.kind === "break"){
          // Wall-clock continues through tab-close. Compute elapsed in real time.
          const elapsedMs = Date.now() - a.startedAt;
          const totalMs = a.plannedBreakMin * 60 * 1000;
          if(elapsedMs >= totalMs){
            // Break is over (or already over) — promote to "ready for next session" silently.
            // Replicate the break-completion path from complete() without the alarm/sounds.
            const bIdx = state.curBreak;
            if(Number.isInteger(bIdx) && bIdx >= 0 && bIdx < state.breaksDone.length){
              state.breaksDone[bIdx] = true;
            }
            state.activeInterval = null;
            // Caller (applyLoadedState) will run updateDataFromToday(); we just need phase set up.
            state.phase = "idle";
            state.running = false;
            const [k, i] = nextTarget();
            if(k === "session"){
              state.sessionIdx = i;
              state.timeLeft = effectiveLearnSec(i);
            } else if(k === "break"){
              state.curBreak = i;
              state.phase = "break";
              state.timeLeft = breakMinAt(i) * 60;
            } else {
              state.phase = "done"; state.timeLeft = 0;
            }
          } else {
            // Still in break — recompute timeLeft so the UI reflects elapsed wall-clock.
            state.timeLeft = Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
            state.phase = "break";
            // Auto-resume the running break (no user action needed; wall-clock kept counting)
            state.running = true;
          }
        }
      }

      const clickBoxes = [];
      function circSizeForBreak(i){
        const k = breakKindAt(i);
        if(k === "big") return 48;
        if(k === "even") return 38;
        return 24;
      }
      function drawTrack(){
        // Mode-dispatch: flow uses its own renderer (organic, session-by-session)
        if(isFlow()){ drawFlowTrack(); return; }
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
      // ── Flow-mode track renderer ──────────────────────────────────
      // Renders one box-with-checkmark per completed flow session,
      // plus a circle next to it carrying the chosen break duration.
      // The currently-running learning block is also shown (open box).
      function drawFlowTrack(){
        const canvas = dom.trackCanvas, ctx = ctxTrack;
        if(canvas.height !== 120) canvas.height = 120;
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
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
        const BOX_S = 50, CIRC_S = 28, SLOT_GAP = 14, PCY = 60;
        clickBoxes.length = 0;
        const sessions = state.flow.sessions || [];
        // Show the current (open) learning block as a box from the very first second of the
        // interval — NOT only after 30s. It stays an accent box WITHOUT a checkmark while
        // learning; it only becomes a checked-off "done" flowSession once the user commits a
        // break (flowCommitPauseStart pushes it into state.flow.sessions).
        const includeOpenBlock = state.flow.phase === "learning";
        // Build item list: today's completed Pomodoro sessions FIRST (so the user sees
        // their full day's progress even after switching modes), then Flow sessions,
        // then the optional open Flow block.
        const items = [];
        const pomoDoneCount = Array.isArray(state.sessionsDone) ? state.sessionsDone.filter(Boolean).length : 0;
        for(let i = 0; i < pomoDoneCount; i++){
          items.push({ type:"pomoSession", idx:i, learnMin: effectiveLearnMin(i) });
          // Show ANY completed break that follows this session — including the one after
          // the LAST done Pomodoro session (so a finished Pomodoro pause is also visible
          // if the user later switches to Flow without starting the next Pomodoro session).
          if(i < (state.breaksDone || []).length && state.breaksDone[i]){
            items.push({ type:"pomoBreak", idx:i, breakMin: breakMinAt(i) });
          }
        }
        for(let i=0; i<sessions.length; i++){
          items.push({ type:"flowSession", idx:i });
          if(sessions[i].breakMin > 0){
            items.push({ type:"flowBreak", idx:i });
          }
        }
        if(includeOpenBlock){
          items.push({ type:"flowOpen" });
        }
        // Compute total width
        let totalW = 0;
        for(let i=0;i<items.length;i++){
          if(i > 0) totalW += SLOT_GAP;
          const t = items[i].type;
          totalW += (t === "flowBreak" || t === "pomoBreak") ? CIRC_S : BOX_S;
        }
        let cx = Math.max(0, (W - totalW) / 2);
        // If no items at all → show a hint
        if(items.length === 0){
          ctx.fillStyle = COL.textDim;
          ctx.font = '13px "Segoe UI", sans-serif';
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText("Starte den Timer, um deinen ersten Flow-Block zu beginnen.", W/2, H/2);
          return;
        }
        // Draw each item
        for(let i=0;i<items.length;i++){
          const it = items[i];
          if(it.type === "pomoSession"){
            // Same look as a completed Flow session, but with a small "P" badge to
            // signal these were done in Pomodoro mode.
            const x1 = cx, y1 = PCY - BOX_S/2, x2 = cx + BOX_S, y2 = PCY + BOX_S/2;
            ctx.fillStyle = COL.card; ctx.fillRect(x1, y1, BOX_S, BOX_S);
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.strokeRect(x1+0.5, y1+0.5, BOX_S-1, BOX_S-1);
            ctx.strokeStyle = COL.text; ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x1+11, y1+11); ctx.lineTo(x2-11, y2-11);
            ctx.moveTo(x2-11, y1+11); ctx.lineTo(x1+11, y2-11);
            ctx.stroke();
            // "P" badge in the top-left corner
            ctx.fillStyle = COL.textDim;
            ctx.font = 'bold 9px "Segoe UI", sans-serif';
            ctx.textAlign = "left"; ctx.textBaseline = "top";
            ctx.fillText("P", x1+3, y1+2);
            clickBoxes.push({ kind:"pomoSession", idx:it.idx, x1, y1, x2, y2, learnMin: it.learnMin });
            cx += BOX_S;
          } else if(it.type === "pomoBreak"){
            const bx1 = cx, by1 = PCY - CIRC_S/2, bx2 = cx + CIRC_S, by2 = PCY + CIRC_S/2;
            ctx.fillStyle = COL.btnNeutral;
            ctx.beginPath(); ctx.arc((bx1+bx2)/2, (by1+by2)/2, CIRC_S/2, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = COL.textDim;
            ctx.font = '10px "Segoe UI", sans-serif';
            ctx.textAlign="center"; ctx.textBaseline="middle";
            ctx.fillText(String(it.breakMin), (bx1+bx2)/2, (by1+by2)/2);
            clickBoxes.push({ kind:"pomoBreak", idx:it.idx, x1:bx1, y1:by1, x2:bx2, y2:by2, breakMin: it.breakMin });
            cx += CIRC_S;
          } else if(it.type === "flowSession"){
            const sess = sessions[it.idx];
            const x1 = cx, y1 = PCY - BOX_S/2, x2 = cx + BOX_S, y2 = PCY + BOX_S/2;
            // Done: filled card-bg + checkmark
            ctx.fillStyle = COL.card; ctx.fillRect(x1, y1, BOX_S, BOX_S);
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.strokeRect(x1+0.5, y1+0.5, BOX_S-1, BOX_S-1);
            ctx.strokeStyle = COL.text; ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x1+11, y1+11); ctx.lineTo(x2-11, y2-11);
            ctx.moveTo(x2-11, y1+11); ctx.lineTo(x1+11, y2-11);
            ctx.stroke();
            clickBoxes.push({ kind:"flowSession", idx:it.idx, x1, y1, x2, y2, learnMin: sess.learnMin });
            cx += BOX_S;
          } else if(it.type === "flowBreak"){
            const sess = sessions[it.idx];
            const bx1 = cx, by1 = PCY - CIRC_S/2, bx2 = cx + CIRC_S, by2 = PCY + CIRC_S/2;
            ctx.fillStyle = COL.btnNeutral;
            ctx.beginPath(); ctx.arc((bx1+bx2)/2, (by1+by2)/2, CIRC_S/2, 0, Math.PI*2); ctx.fill();
            ctx.strokeStyle = COL.boxBorder; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = COL.textDim;
            ctx.font = '10px "Segoe UI", sans-serif';
            ctx.textAlign="center"; ctx.textBaseline="middle";
            ctx.fillText(String(sess.breakMin), (bx1+bx2)/2, (by1+by2)/2);
            clickBoxes.push({ kind:"flowBreak", idx:it.idx, x1:bx1, y1:by1, x2:bx2, y2:by2, breakMin: sess.breakMin });
            cx += CIRC_S;
          } else if(it.type === "flowOpen"){
            // Currently-running block — draw as accent-colored box with the elapsed minute count
            const x1 = cx, y1 = PCY - BOX_S/2, x2 = cx + BOX_S, y2 = PCY + BOX_S/2;
            ctx.fillStyle = COL.accent; ctx.fillRect(x1, y1, BOX_S, BOX_S);
            ctx.fillStyle = COL.boxActiveFg;
            ctx.font = 'bold 16px "Segoe UI", sans-serif';
            ctx.textAlign="center"; ctx.textBaseline="middle";
            const min = Math.floor(state.flow.elapsedSec / 60);
            ctx.fillText(String(min), (x1+x2)/2, (y1+y2)/2);
            clickBoxes.push({ kind:"flowOpen", idx:-1, x1, y1, x2, y2 });
            cx += BOX_S;
          }
          if(i < items.length - 1) cx += SLOT_GAP;
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
        // Flow-mode: only tooltip + cursor (no task popover, no add/remove buttons)
        if(isFlow()){
          hideTrackOverlayButtons();
          schedulePopHide();
          const flowHit = clickBoxes.find(b => (b.kind === "flowSession" || b.kind === "flowBreak" || b.kind === "flowOpen" || b.kind === "pomoSession" || b.kind === "pomoBreak") && inBox(x, y, b));
          if(flowHit){
            dom.trackCanvas.style.cursor = "default";
            let text = "";
            if(flowHit.kind === "flowSession"){
              text = `Block: ${flowHit.learnMin} Min gelernt`;
            } else if(flowHit.kind === "flowBreak"){
              text = `Pause: ${flowHit.breakMin} Min`;
            } else if(flowHit.kind === "flowOpen"){
              const m = Math.floor(state.flow.elapsedSec / 60);
              text = `Aktuell: ${m} Min`;
            } else if(flowHit.kind === "pomoSession"){
              text = `Pomodoro-Lerneinheit ${flowHit.idx + 1}: ${flowHit.learnMin} Min`;
            } else if(flowHit.kind === "pomoBreak"){
              text = `Pomodoro-Pause: ${flowHit.breakMin} Min`;
            }
            setTooltip(text, ev.clientX + 14, ev.clientY - 12);
          } else {
            dom.trackCanvas.style.cursor = "default";
            hideTooltip();
          }
          return;
        }
        // Task popover ONLY for sessions that are still open (not done).
        // Completed sessions show their duration as a small tooltip instead.
        const sessionBox = clickBoxes.find(b => b.kind === "session" && inBox(x, y, b));
        if(sessionBox && !state.sessionsDone[sessionBox.idx]){
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
        // Tooltip handling:
        //   • Completed session → "Lerneinheit N · X Min"
        //   • Open session      → no tooltip (task popover takes over)
        //   • Break             → "Pause/Große Pause X Min"
        if(sessionBox){
          if(state.sessionsDone[sessionBox.idx]){
            const mins = effectiveLearnMin(sessionBox.idx);
            setTooltip(`Lerneinheit ${sessionBox.idx + 1} · ${mins} Min`, ev.clientX + 14, ev.clientY - 12);
          } else {
            hideTooltip();
          }
          dom.trackCanvas.style.cursor = "default";
          return;
        }
        const breakHit = clickBoxes.find(b => b.kind === "break" && inBox(x, y, b));
        if(breakHit){
          dom.trackCanvas.style.cursor = "default";
          const text = `${breakKindAt(breakHit.idx) === "big" ? "Große Pause" : "Pause"} ${breakMinAt(breakHit.idx)} Min`;
          setTooltip(text, ev.clientX + 14, ev.clientY - 12);
        } else {
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
        // Move any tasks from the now-removed bucket into the Inbox
        migrateOrphanTasksToInbox(TOTAL_SESSIONS);
        // 4) If we were idle pointing at the removed slot, shift back
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = effectiveLearnSec(i);
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
          else if(k === null){ state.phase = "done"; state.timeLeft = 0; }
        }
        hideTrackOverlayButtons();
        updateTimerUI(); drawTrack();
        if(typeof renderTodoView === "function") renderTodoView();
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
        const today = logicalNow();
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
        const today = logicalNow(); const weekMonday = new Date(today); weekMonday.setDate(today.getDate() - ((today.getDay() + 6) % 7)); const startMonday = new Date(weekMonday); startMonday.setDate(weekMonday.getDate() - 7*52);
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
        // Back to the template: drop per-day session/break/total overrides (incl. break
        // lengths carried over from skipped breaks) BEFORE sizing the arrays below, so
        // TOTAL_SESSIONS reflects the template count.
        resetTimerOverrides();
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
        // Wipe every "earned" thing: projects, dice collection, and flow history.
        // Keep settings, theme, sound, avatar, username, templates (those are
        // configuration, not progress).
        state.projects = {};
        state.dice = { owned: ["d4"], active: "d4", casinoActive: "d4" };
        // Skins werden beim Fortschritts-Reset MIT gelöscht — direktes Leeren,
        // NICHT über deleteSkinFromCollection (es gibt absichtlich KEINE Würfe zurück).
        // Nur /reset (resetTodayProgress, "heutiger Tag") lässt Skins unangetastet.
        state.diceSkins = { owned: [], active: {} };
        // Spielzeit-Konto ist erspielter Fortschritt → mit zurücksetzen.
        state.arcadeTimeSec = 0;
        if(state.flow){
          state.flow.elapsedSec = 0;
          state.flow.phase = "idle";
          state.flow.running = false;
          state.flow.breakLeftSec = 0;
          state.flow.breakTotalSec = 0;
          state.flow.nextAutoPromptSec = (typeof FLOW_AUTO_FIRST_SEC === "number") ? FLOW_AUTO_FIRST_SEC : 3600;
          state.flow.sessions = [];
          state.flow.dayKey = "";
        }
        // Stop any flow tick anchors too
        if(typeof stopFlowAnchor === "function") stopFlowAnchor();
        // Close project modal / color picker if open
        if(typeof closeProjectModal === "function" && document.getElementById("projectModal")?.classList.contains("show")){
          closeProjectModal();
        }
        const colorPicker = document.getElementById("projectColorPicker");
        if(colorPicker) colorPicker.remove();
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
        {
          const lbModal = document.getElementById("lootboxModal");
          if(lbModal && lbModal.classList.contains("show")) closeLootboxModal();
          const sdModal = document.getElementById("skinDeleteModal");
          if(sdModal && sdModal.classList.contains("show")) closeSkinDeleteConfirm();
        }
        // Laufendes Online-Rennen beenden (zählt als Aufgabe — der Gegner gewinnt)
        if(typeof raceTeardown === "function" && race){ raceTeardown(); renderRaceView(); }
        if(typeof luckTeardown === "function" && luck){ luckTeardown(); renderLuckView(); }
        // Reset transient dice state
        diceSelection = null;
        diceRolling = false;
        // Refresh entire UI (incl. TODO, Shop, Casino selector — all dependent on wiped state)
        drawEverything();
        if(typeof renderTodoView === "function") renderTodoView();
        if(typeof renderShopView === "function") renderShopView();
        if(typeof renderCasinoDieSelector === "function") renderCasinoDieSelector();
        if(typeof updateDiceGameUI === "function") updateDiceGameUI();
        setTab("timer");
        setDiceMessage("Noch nicht gewürfelt.", "");
        dom.diceSmall.textContent = "Wähle Modus, tippe eine Zahl und gib deinen Einsatz ein.";
        // Visual confirmation in settings
        dom.savedMsg.textContent = "Fortschritt wurde zurückgesetzt.";
        dom.savedMsg.style.opacity = "1";
        setTimeout(() => { dom.savedMsg.style.opacity = "0"; }, 2200);
        persist();
      }
      // ── /reset command — wipe ONLY today's interval progress ──
      // Clears today's completed intervals so it looks like "not a single minute learned
      // today yet", on BOTH the Pomodoro and the Flow timer simultaneously. Deliberately
      // KEEPS everything else: points, earned/owned dice, dice-game results, to-dos,
      // projects, settings, and the streak history of OTHER days.
      function resetTodayProgress(){
        const today = todayISO();
        // Stop anything currently running in either mode.
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        workerStop(); tickAnchor = null; stopAlarm();
        if(typeof stopFlowAnchor === "function") stopFlowAnchor();
        diceTrackingStop(); releaseWakeLock();

        // 1) Today's logged minutes + the immutable completed-interval history for today.
        delete state.data[today];
        if(state.completedIntervals) delete state.completedIntervals[today];

        // 2) Pomodoro → fresh day-0 idle timer (all interval/break dots cleared).
        state.sessionsDone = Array(TOTAL_SESSIONS).fill(false);
        state.breaksDone   = Array(Math.max(0, TOTAL_SESSIONS - 1)).fill(false);
        state.sessionIdx = 0;
        state.curBreak = -1;
        state.phase = "idle";
        state.running = false;
        state.alarmActive = false;
        state.activeInterval = null;
        state.timeLeft = effectiveLearnSec(0);
        // Drop any break-length overrides accumulated from skipped breaks (the "Minuten zur
        // nächsten Pause übertragen?" feature). After /reset the breaks must follow the
        // Pomodoro template again, not the carried-over lengths. breakMinAt() prefers this
        // array over the template, so clearing it restores the template defaults.
        state.breakLengthOverrides = [];

        // 3) Flow → wipe ALL completed blocks + reset the live block to idle.
        //    flow.sessions is purely the timer-track display (heatmap minutes live in
        //    state.data, untouched here). The track renders every entry it contains, so
        //    a day-scoped filter would strand stale blocks from earlier days that the
        //    midnight prune missed — leaving boxes the user can never clear. /reset means
        //    "clean slate on the track", so we drop the whole array.
        if(state.flow){
          state.flow.sessions = [];
          state.flow.elapsedSec = 0;
          state.flow.breakLeftSec = 0;
          state.flow.breakTotalSec = 0;
          state.flow.phase = "idle";
          state.flow.running = false;
          state.flow.nextAutoPromptSec = (typeof FLOW_AUTO_FIRST_SEC === "number") ? FLOW_AUTO_FIRST_SEC : 3600;
          state.flow.dayKey = today;
        }

        // 4) Repaint everything; today's heatmap cell + stats now read 0 again.
        if(dom.finishBox) dom.finishBox.style.display = "none";
        drawEverything();
        persist();
      }
      function applySettingChange(){
        // The user is editing the active template — per-session/per-day overrides
        // (set via track +/- buttons or /set commands) are now stale and would silently
        // mask the new settings. Drop them so the new values actually take effect.
        // Tasks scheduled for sessions that disappear are migrated to the inbox by
        // migrateOrphanTasksToInbox() below.
        const wasTotal = TOTAL_SESSIONS;
        resetTimerOverrides();
        recomputeTotalSessions();
        reconcileSessionArrays();
        if(typeof migrateOrphanTasksToInbox === "function" && TOTAL_SESSIONS < wasTotal){
          migrateOrphanTasksToInbox(TOTAL_SESSIONS);
        }
        // Refresh idle timer with the NEW effective values (via the helper so any future
        // overrides are also honored consistently).
        if(state.phase === "idle"){
          const [k, i] = nextTarget();
          if(k === "session") state.timeLeft = effectiveLearnSec(i);
          else if(k === "break") state.timeLeft = breakMinAt(i) * 60;
          else if(k === null){ state.phase = "done"; state.timeLeft = 0; }
        } else if(!state.running && state.phase === "learning"){
          // Sitting on an unstarted learning slot: also refresh so the change is visible
          state.timeLeft = effectiveLearnSec(state.sessionIdx);
        } else if(!state.running && state.phase === "break"){
          state.timeLeft = breakMinAt(state.curBreak) * 60;
        }
        // Keep the active interval template in sync with what the user just edited.
        if(typeof syncActiveTemplateFromSettings === "function") syncActiveTemplateFromSettings();
        updateSettingsView();
        if(typeof renderTemplatesList === "function") renderTemplatesList();
        updateTimerUI();
        drawTrack();
        // Refresh TODO grid since interval count may have changed
        if(typeof renderTodoView === "function") renderTodoView();
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
      // ════════════════════════════════════════════════════════════
      //   ROUTING  (Hash-based, server-config-free)
      //   - Each main tab has its own URL fragment (#/timer, #/todo, …)
      //   - Reload preserves the active tab
      //   - Aliases let us keep readable German URLs too (#/wuerfelspiel)
      // ════════════════════════════════════════════════════════════
      const ROUTE_TO_TAB = {
        "timer": "timer",
        "wuerfelspiel": "dice",
        "arcade": "dice",
        "dice": "dice",
        "stats": "stats",
        "leaderboard": "leaderboard",
        "todo": "todo",
        "shop": "shop",
        "wuerfelshop": "shop",
        "settings": "settings",
        "einstellungen": "settings",
      };
      const TAB_TO_ROUTE = {
        timer: "timer", dice: "arcade", stats: "stats",
        leaderboard: "leaderboard", todo: "todo", shop: "wuerfelshop", settings: "settings",
      };
      function parseRoute(hash){
        const h = String(hash || "").replace(/^#\/?/, "").split(/[/?]/)[0].toLowerCase();
        return ROUTE_TO_TAB[h] || null;
      }
      let suppressHashChange = false;
      function routeToHash(tabName){
        const slug = TAB_TO_ROUTE[tabName] || "timer";
        const wanted = "#/" + slug;
        if(location.hash !== wanted){
          suppressHashChange = true;
          try{ history.replaceState(null, "", wanted); }
          catch(_){ location.hash = wanted; }
          // releasing flag in next tick covers both sync paths above
          setTimeout(() => { suppressHashChange = false; }, 0);
        }
      }
      function setTab(name, opts){
        // Hide task popover + track overlay buttons on tab change
        hideTaskPopover(true);
        if(typeof hideTrackOverlayButtons === "function") hideTrackOverlayButtons();
        dom.tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
        Object.entries(dom.views).forEach(([k,v]) => v.classList.toggle("active", k === name));
        // Body class for view-specific layout (e.g. full-width TODO)
        document.body.classList.toggle("view-todo", name === "todo");
        document.body.classList.toggle("view-timer", name === "timer");
        document.body.classList.toggle("view-leaderboard", name === "leaderboard");
        if(name === "stats"){ updateStats(); drawHeatmap(); }
        if(name === "dice"){
          applyDiceLockState();
          // Läuft gerade ein Online-Rennen (Queue/Spiel), direkt dorthin; sonst ins Arcade-Menü.
          showArcadeGame(typeof raceActive === "function" && raceActive() ? "race" : "menu");
        }
        if(name === "todo"){ renderTodoView(); }
        if(name === "shop"){ renderShopView(); }
        // 3D-Würfel freigeben + Würfelspiel-Zeit abrechnen, wenn der Tab verlassen wird.
        if(name !== "dice"){ exitCasinoTime(); teardownCasinoDie3D(); }
        if(name !== "shop") teardownSkinPreviews();
        if(name === "leaderboard"){ loadLeaderboard(); }
        if(name === "settings"){
          // Always land on the Intervall-Einstellungen sub-tab when opening Settings.
          if(typeof resetSettingsSubTab === "function") resetSettingsSubTab();
          if(typeof renderTemplatesList === "function") renderTemplatesList();
        }
        // Keep URL in sync unless the call originated from a hash change itself
        if(!(opts && opts.fromHash)) routeToHash(name);
      }
      // Listen for browser back/forward + direct hash changes
      window.addEventListener("hashchange", () => {
        if(suppressHashChange) return;
        const t = parseRoute(location.hash);
        if(t) setTab(t, { fromHash: true });
      });
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
      // Pip patterns by sides + face value.
      // d4/d6/d8 → classic pips (dark dots on the white-ish die face).
      // d10/d12/d20 → big black number (since 9+ pips look chaotic).
      const PIP_PATTERNS = {
        4: {
          1: ["c"],
          2: ["tl","br"],
          3: ["tl","c","br"],
          4: ["tl","tr","bl","br"],
        },
        6: {
          1: ["c"],
          2: ["tl","br"],
          3: ["tl","c","br"],
          4: ["tl","tr","bl","br"],
          5: ["tl","tr","c","bl","br"],
          6: ["tl","tr","ml","mr","bl","br"],
        },
        8: {
          1: ["c"],
          2: ["tl","br"],
          3: ["tl","c","br"],
          4: ["tl","tr","bl","br"],
          5: ["tl","tr","c","bl","br"],
          6: ["tl","tr","ml","mr","bl","br"],
          // 7 = full corners + center column-middle + center (7 dots, symmetric)
          7: ["tl","tr","ml","c","mr","bl","br"],
          // 8 = full perimeter (no center): 4 corners + 4 mid-edges
          8: ["tl","tc","tr","ml","mr","bl","bc","br"],
        },
      };
      function showDiceFace(dieEl, value, sides){
        const pips = dieEl.querySelectorAll(".pip");
        // Numeric overlay layer (lazy-created)
        let numEl = dieEl.querySelector(".dieNum");
        if(!numEl){
          numEl = document.createElement("span");
          numEl.className = "dieNum";
          dieEl.appendChild(numEl);
        }
        const pattern = PIP_PATTERNS[sides] && PIP_PATTERNS[sides][value];
        if(pattern){
          // Pip-style (d4, d6, d8)
          numEl.style.display = "none";
          pips.forEach(p => p.classList.remove("show"));
          pattern.forEach(cls => {
            const p = dieEl.querySelector("." + cls);
            if(p) p.classList.add("show");
          });
        } else {
          // Numeric style (d10, d12, d20 — or fallback for any value outside the pip range)
          pips.forEach(p => p.classList.remove("show"));
          numEl.style.display = "flex";
          numEl.textContent = String(value);
        }
        // Side-count badge ("W20" etc.) in the corner — lazy-created.
        // We show it on every die EXCEPT the classic d6, so the player always knows
        // which die they're looking at.
        let lblEl = dieEl.querySelector(".dieSidesLbl");
        if(sides && sides !== 6){
          if(!lblEl){
            lblEl = document.createElement("span");
            lblEl.className = "dieSidesLbl";
            dieEl.appendChild(lblEl);
          }
          lblEl.textContent = "W" + sides;
          lblEl.style.display = "block";
        } else if(lblEl){
          lblEl.style.display = "none";
        }
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
        showDiceFace(dom.rewardDie, 1, activeDieSides());
        dom.rewardModal.classList.add("show");
        dom.rewardModal.setAttribute("aria-hidden", "false");
        // 3D-Würfel mit aktivem Skin (asynchron; bis dahin bleibt das 2D-Div sichtbar)
        setupRewardDie3D();
        diceGameClick();
      }
      function closeRewardModal(){
        dom.rewardModal.classList.remove("show");
        dom.rewardModal.setAttribute("aria-hidden", "true");
        teardownRewardDie3D();
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
        const sides = activeDieSides();
        // Ergebnis VOR der Animation würfeln (gleiche Verteilung) — die 3D-Animation
        // braucht den Zielwert, damit der Würfel exakt darauf landen kann.
        const result = Math.floor(Math.random() * sides) + 1;
        if(rewardDie3d && dice3dMod){
          // 3D-Pfad: 1.2-Sek-Roll, landet mit result nach oben
          dice3dMod.rollDie3D(rewardDie3d, result, () => {
            setTimeout(() => applyRewardResult(result, sides), 120);
          });
          return;
        }
        // 2D-Fallback (kein WebGL / Three.js nicht geladen)
        dom.rewardDie.classList.remove("rolling");
        void dom.rewardDie.offsetWidth;
        dom.rewardDie.classList.add("rolling");
        // Clean up the rolling class once the keyframe animation (800 ms) has finished, so
        // re-showing the modal later does NOT replay the animation automatically.
        setTimeout(() => dom.rewardDie.classList.remove("rolling"), 850);
        let count = 0;
        const interval = setInterval(() => {
          showDiceFace(dom.rewardDie, Math.floor(Math.random() * sides) + 1, sides);
          count++;
          if(count >= 8){
            clearInterval(interval);
            showDiceFace(dom.rewardDie, result, sides);
            setTimeout(() => applyRewardResult(result, sides), 120);
          }
        }, 80);
      }
      // Wendet das Wurfergebnis an (Punkte, Boni, UI). Wird vom 3D- UND vom
      // 2D-Fallback-Pfad aufgerufen, nachdem die Würfel-Animation gelandet ist.
      function applyRewardResult(result, sides){
              rewardLand(result);
              // Consume the current roll's bonuses (if any). Re-roll on the max face keeps a fresh, no-bonus slot.
              const bonus = state.pendingRollBonuses.shift() || { streak:false, surpass:false };
              state.pendingRolls = state.pendingRollBonuses.length;
              const bonusRoll = result === sides; // ★ rolling the highest face → bonus re-roll
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
                dom.rewardSub.textContent = sides + " gewürfelt — du bekommst den Wurf zurück!";
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
      }

      // ════════════════════════════════════════════════════════════
      //   DICE GAME  (Würfelspiel tab)
      // ════════════════════════════════════════════════════════════
      function getDiceMultiplier(){
        const b = DICE_BALANCE[diceGameMode];
        const bonus = Math.min(state.diceStreak, 5) * b.streakBonus;
        // For "exact" mode the base multiplier scales with sides count to keep the
        // 10%-house-edge balanced across all dice (sides × 0.9). For "oe" the base
        // is always ~1.85 because the chance is always 1/2.
        let base = b.base;
        if(diceGameMode === "exact"){
          base = casinoDieSides() * 0.9; // d4→3.6×, d6→5.4×, d8→7.2×, d10→9×, d12→10.8×, d20→18×
        }
        return base * (1 + bonus);
      }
      function getDiceBonusPct(){
        const b = DICE_BALANCE[diceGameMode];
        return Math.min(state.diceStreak, 5) * b.streakBonus * 100;
      }
      function setDiceMessage(text, type = ""){
        dom.diceMessage.textContent = text;
        dom.diceMessage.className = "diceMessage" + (type ? " " + type : "");
      }
      function clearDiceHighlight(){
        dom.gameDie.classList.remove("evenHl", "oddHl");
        const c3d = document.getElementById("gameDie3d");
        if(c3d) c3d.classList.remove("evenHl", "oddHl");
      }
      // Gerade/Ungerade-Markierung auf BEIDE Würfel-Darstellungen anwenden (2D + 3D-Container)
      function setDiceHighlight(cls){
        clearDiceHighlight();
        if(!cls) return;
        dom.gameDie.classList.add(cls);
        const c3d = document.getElementById("gameDie3d");
        if(c3d) c3d.classList.add(cls);
      }
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
        const sides = casinoDieSides();

        if(diceGameMode === "exact"){
          const baseExact = (sides * 0.9).toFixed(2).replace(/\.?0+$/, "") + "×";
          dom.multBase.textContent = baseExact;
          dom.diceSubtitle.textContent = "Triff die genaue Zahl (1–" + sides + ") → Einsatz × " + mult.toFixed(2) + " zurück.";
        }else{
          dom.multBase.textContent = "1.85×";
          dom.diceSubtitle.textContent = "Gerade oder Ungerade? → Einsatz × " + mult.toFixed(2) + " zurück.";
        }
        // Update the casino-die selector + face if present
        renderCasinoDieSelector();
        // 3D-Würfel (mit Skin) erzeugen/aktualisieren, sofern der Casino-Tab aktiv ist
        syncCasinoDie3D();
        const gameDieEl = dom.gameDie;
        if(gameDieEl && !diceRolling){
          showDiceFace(gameDieEl, 1, sides);
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

      // ── Würfel-Shop ───────────────────────────────────────────────
      function renderShopView(){
        ensureDiceState();
        const grid = document.getElementById("shopGrid");
        const ptsEl = document.getElementById("shopPoints");
        const activeLbl = document.getElementById("shopActiveDie");
        if(ptsEl) ptsEl.textContent = String(state.points || 0);
        if(activeLbl) activeLbl.textContent = DICE_LABELS[state.dice.active] || "W4";
        if(!grid) return;
        while(grid.firstChild) grid.removeChild(grid.firstChild);
        const owned = state.dice.owned;
        // Find the next locked die (sequential unlock chain)
        const nextLocked = nextLockedDie();
        for(const id of DICE_TYPES){
          const card = document.createElement("div");
          card.className = "shopCard";
          const sides = DICE_SIDES[id];
          const price = DICE_PRICES[id];
          const isOwned = owned.includes(id);
          const isActive = isOwned && state.dice.active === id;
          const isNext = id === nextLocked;
          const isLocked = !isOwned && !isNext; // can't buy yet (prior die not owned)
          card.classList.toggle("owned", isOwned);
          card.classList.toggle("active", isActive);
          card.classList.toggle("locked", isLocked);
          card.dataset.dieId = id;

          // Visual die preview (numeric, shows max face)
          const preview = document.createElement("div");
          preview.className = "shopDiePreview";
          preview.dataset.sides = String(sides);
          const num = document.createElement("span");
          num.className = "shopDieNum";
          num.textContent = String(sides);
          preview.appendChild(num);

          const title = document.createElement("div");
          title.className = "shopDieTitle";
          title.textContent = DICE_LABELS[id];

          const desc = document.createElement("div");
          desc.className = "shopDieDesc";
          desc.textContent = sides + " Seiten · max. Wurf " + sides + " gibt einen Wurf zurück";

          const priceEl = document.createElement("div");
          priceEl.className = "shopDiePrice";
          if(id === "d4"){
            priceEl.innerHTML = '<span class="shopDiePriceVal">GRATIS</span>';
          } else {
            priceEl.innerHTML = '<span class="shopDiePriceVal">' + price.toLocaleString("de-DE") + '</span> Punkte';
          }

          const actions = document.createElement("div");
          actions.className = "shopDieActions";
          if(isOwned){
            const selBtn = document.createElement("button");
            selBtn.type = "button";
            selBtn.className = "shopSelectBtn" + (isActive ? " current" : "");
            selBtn.dataset.action = "shopActivate";
            selBtn.dataset.dieId = id;
            selBtn.textContent = isActive ? "✓ Aktiv" : "Aktivieren";
            selBtn.disabled = isActive;
            actions.appendChild(selBtn);
          } else if(isNext){
            const buyBtn = document.createElement("button");
            buyBtn.type = "button";
            buyBtn.className = "shopBuyBtn";
            buyBtn.dataset.action = "shopBuy";
            buyBtn.dataset.dieId = id;
            const canAfford = (state.points || 0) >= price;
            buyBtn.disabled = !canAfford;
            buyBtn.textContent = canAfford ? "Kaufen" : "Nicht genug Punkte";
            actions.appendChild(buyBtn);
          } else {
            const lockLbl = document.createElement("div");
            lockLbl.className = "shopLockedLbl";
            lockLbl.innerHTML = "🔒 Erst " + DICE_LABELS[DICE_TYPES[DICE_TYPES.indexOf(id) - 1]] + " freischalten";
            actions.appendChild(lockLbl);
          }

          card.appendChild(preview);
          card.appendChild(title);
          card.appendChild(desc);
          card.appendChild(priceEl);
          card.appendChild(actions);
          grid.appendChild(card);
        }
        // Würfel-Skins-Bereich (Lootbox + Sammlung) unterhalb des Kauf-Grids
        renderLootboxSection();
        renderSkinCollection();
      }
      function shopHandleClick(e){
        const btn = e.target.closest("[data-action]");
        if(!btn) return;
        const action = btn.dataset.action;
        const id = btn.dataset.dieId;
        if(action === "shopActivate"){
          if(setActiveDie(id)){
            uiSoftClick();
            updatePointsDisplay();
            renderShopView();
          }
        } else if(action === "shopBuy"){
          if(buyDie(id)){
            uiSave();
            // Auto-activate the just-bought die for convenience
            setActiveDie(id);
            updatePointsDisplay();
            renderShopView();
          } else {
            uiError();
          }
        } else if(action === "lootType"){
          if(id && ownsDie(id)){
            selectedLootType = id;
            uiSoftClick();
            renderLootboxSection();
          }
        } else if(action === "lootboxOpen"){
          openLootbox(selectedLootType);
        } else if(action === "skinFilter"){
          skinFilter = btn.dataset.filter || "all";
          uiSoftClick();
          renderSkinCollection();
        } else if(action === "skinActivate"){
          const skin = state.diceSkins.owned.find(s => s.id === btn.dataset.skinId);
          if(skin && setActiveSkin(skin.dieType, skin.id)){
            uiSave();
            renderSkinCollection();
          } else {
            uiError();
          }
        } else if(action === "skinDeactivate"){
          const skin = state.diceSkins.owned.find(s => s.id === btn.dataset.skinId);
          if(skin){
            clearActiveSkin(skin.dieType);
            uiSoftClick();
            renderSkinCollection();
          }
        } else if(action === "skinDelete"){
          openSkinDeleteConfirm(btn.dataset.skinId);
        }
      }
      // Render the 1..sides number buttons inside the exact-mode choice modal,
      // matching the currently-selected casino die.
      function renderExactOptions(){
        const wrap = document.getElementById("exactDiceOptions");
        if(!wrap) return;
        const sides = casinoDieSides();
        // Preserve user's prior selection if still valid
        const prior = (diceSelection !== null && Number.isInteger(diceSelection)) ? diceSelection : null;
        while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
        for(let n = 1; n <= sides; n++){
          const b = document.createElement("button");
          b.type = "button";
          b.className = "diceOption" + (n === prior ? " selected" : "");
          b.dataset.value = String(n);
          // d1..d6 use the unicode dice glyph; higher numbers just show the number
          if(n >= 1 && n <= 6){
            const glyph = "⚀⚁⚂⚃⚄⚅".charAt(n - 1);
            b.innerHTML = `${glyph}<span>${n}</span>`;
          } else {
            b.innerHTML = `<span class="diceOptionBigNum">${n}</span>`;
          }
          wrap.appendChild(b);
        }
        // If the prior selection is no longer valid for the new die, clear it
        if(prior !== null && (prior < 1 || prior > sides)){
          diceSelection = null;
          if(dom.guessLabel) dom.guessLabel.textContent = "Kein Tipp";
          if(dom.guessValue) dom.guessValue.textContent = "";
        }
      }
      // Render the inline die-selector inside the casino (only the owned dice).
      function renderCasinoDieSelector(){
        const wrap = document.getElementById("casinoDieSelector");
        if(!wrap) return;
        ensureDiceState();
        while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
        const owned = state.dice.owned;
        const active = state.dice.casinoActive;
        for(const id of DICE_TYPES){
          if(!owned.includes(id)) continue;
          const b = document.createElement("button");
          b.type = "button";
          b.className = "casinoDieBtn" + (id === active ? " active" : "");
          b.dataset.dieId = id;
          b.setAttribute("aria-pressed", id === active ? "true" : "false");
          b.textContent = DICE_LABELS[id];
          b.title = id.toUpperCase() + " · " + DICE_SIDES[id] + " Seiten";
          wrap.appendChild(b);
        }
      }
      // ════════════════════════════════════════════════════════════
      //   3D-WÜRFEL (Three.js) — Lazy-Load + Glue-Code
      //   Das Modul js/dice3d.js wird DYNAMISCH importiert: fällt das
      //   Three.js-CDN aus, läuft die App mit den 2D-Würfeln weiter.
      // ════════════════════════════════════════════════════════════
      let dice3dMod = null;          // geladenes Modul (oder null)
      let dice3dPromise = null;      // laufender Import (de-dupliziert)
      function loadDice3D(){
        if(dice3dMod) return Promise.resolve(dice3dMod);
        if(!dice3dPromise){
          dice3dPromise = import("./js/dice3d.js?v=2026-06-13-luck-3")
            .then(mod => { dice3dMod = mod; return mod; })
            .catch(() => { dice3dPromise = null; return null; }); // nächster Versuch erlaubt
        }
        return dice3dPromise;
      }

      // ── Reward-Modal: 3D-Würfel ──
      let rewardDie3d = null;
      function setupRewardDie3D(){
        const cont = document.getElementById("rewardDie3d");
        if(!cont) return;
        teardownRewardDie3D();
        loadDice3D().then(mod => {
          if(!mod) return;                                          // CDN-Fallback: 2D bleibt sichtbar
          if(!dom.rewardModal.classList.contains("show")) return;   // Modal inzwischen zu
          if(rewardDie3d) return;
          const type = activeDieId();
          const die = mod.createDie3D(cont, type, getActiveSkin(type), { size: 220 });
          if(!die) return;                                          // kein WebGL → 2D-Fallback
          rewardDie3d = die;
          if(dom.rewardDie) dom.rewardDie.style.display = "none";
        });
      }
      function teardownRewardDie3D(){
        if(rewardDie3d){ rewardDie3d.cleanup(); rewardDie3d = null; }
        const cont = document.getElementById("rewardDie3d");
        if(cont) cont.textContent = "";
        if(dom.rewardDie) dom.rewardDie.style.display = "";
      }

      // ── Casino: 3D-Würfel (lebt solange der Würfelspiel-Tab aktiv ist) ──
      let casinoDie3d = null;
      let casinoDie3dType = null;
      function syncCasinoDie3D(){
        const cont = document.getElementById("gameDie3d");
        if(!cont) return;
        if(!dom.views.dice.classList.contains("active")) return;
        if(arcadeCurrent !== "casino") return; // Arcade-Menü/anderes Spiel offen → kein Casino-Würfel
        const type = casinoDieId();
        const skin = getActiveSkin(type);
        if(casinoDie3d && casinoDie3dType === type){
          const curId = casinoDie3d.skin ? casinoDie3d.skin.id : null;
          const newId = skin ? skin.id : null;
          if(curId !== newId && dice3dMod) dice3dMod.updateDieSkin(casinoDie3d, skin);
          return;
        }
        teardownCasinoDie3D();
        loadDice3D().then(mod => {
          if(!mod) return;
          if(!dom.views.dice.classList.contains("active")) return;
          if(casinoDie3d) return;
          const curType = casinoDieId();
          const die = mod.createDie3D(cont, curType, getActiveSkin(curType), { size: 220 });
          if(!die) return;
          casinoDie3d = die;
          casinoDie3dType = curType;
          if(dom.gameDie) dom.gameDie.style.display = "none";
        });
      }
      function teardownCasinoDie3D(){
        if(casinoDie3d){ casinoDie3d.cleanup(); casinoDie3d = null; casinoDie3dType = null; }
        const cont = document.getElementById("gameDie3d");
        if(cont){ cont.textContent = ""; cont.classList.remove("evenHl", "oddHl"); }
        if(dom.gameDie) dom.gameDie.style.display = "";
      }

      // ════════════════════════════════════════════════════════════
      //   ARCADE  (Spiele-Hub im ehemaligen Würfelspiel-Tab)
      //   Neue Spiele: Karte in #arcadeGrid (index.html) + Sub-View
      //   registrieren — showArcadeGame() schaltet zwischen ihnen um.
      // ════════════════════════════════════════════════════════════
      let arcadeCurrent = "menu"; // "menu" | "casino" | "race" | "luck"
      let arcadeNoticeMsg = "";   // Hinweis im Arcade-Menü (z.B. "keine Spielzeit")
      function showArcadeGame(which){
        // Beim Verlassen des Würfelspiels die verbrauchte Zeit abrechnen.
        if(arcadeCurrent === "casino" && which !== "casino") exitCasinoTime();
        // Eintritts-Sperre fürs Würfelspiel: ohne Spielzeit gar nicht erst rein.
        if(which === "casino" && (state.arcadeTimeSec || 0) <= 0){
          arcadeNoticeMsg = "⏳ Keine Spielzeit mehr — lerne erst, um Spielzeit zu verdienen.";
          uiError();
          showArcadeGame("menu");
          return;
        }
        if(which !== "menu") arcadeNoticeMsg = "";  // beim Spielstart Hinweis löschen
        arcadeCurrent = which;
        const menu = document.getElementById("arcadeMenu");
        const casino = document.getElementById("diceGameWrap");
        const raceEl = document.getElementById("raceGameWrap");
        const luckEl = document.getElementById("luckGameWrap");
        if(menu) menu.style.display = which === "menu" ? "" : "none";
        if(casino) casino.style.display = which === "casino" ? "" : "none";
        if(raceEl) raceEl.style.display = which === "race" ? "" : "none";
        if(luckEl) luckEl.style.display = which === "luck" ? "" : "none";
        if(which === "casino"){
          enterCasinoTime();
          updateDiceGameUI();
          refreshNeedPointsHint();
        } else {
          teardownCasinoDie3D();
        }
        if(which === "menu") renderArcadeMenu();
        if(which === "race") renderRaceView();
        if(which === "luck") renderLuckView();
      }

      // ── Würfelspiel: zeitbasierte Abrechnung ──
      // Beim Betreten wird ein Budget (= aktuelles Spielzeit-Konto) eingefroren und die
      // Verweildauer über Zeitstempel gemessen (robust gegen Tab-Throttling). Beim Verlassen
      // wird pro angebrochener Minute abgezogen (max. das Budget). Läuft das Budget während
      // des Spiels ab, wird man automatisch ins Menü zurückgeworfen.
      let casinoEnterTs = 0;
      let casinoBudgetSec = 0;
      let casinoTimeTimer = null;
      let casinoTimeActive = false;
      function enterCasinoTime(){
        if(casinoTimeActive) return;
        casinoTimeActive = true;
        casinoEnterTs = Date.now();
        casinoBudgetSec = Math.max(0, Math.floor(state.arcadeTimeSec || 0));
        renderCasinoTime();
        if(casinoTimeTimer) clearInterval(casinoTimeTimer);
        casinoTimeTimer = setInterval(casinoTimeTick, 500);
      }
      function casinoElapsedSec(){
        return Math.max(0, (Date.now() - casinoEnterTs) / 1000);
      }
      function casinoTimeTick(){
        if(!casinoTimeActive) return;
        renderCasinoTime();
        if(casinoElapsedSec() >= casinoBudgetSec){
          // Budget aufgebraucht → abrechnen und rauswerfen.
          exitCasinoTime();
          arcadeNoticeMsg = "⏳ Spielzeit aufgebraucht — du wurdest aus dem Würfelspiel geworfen.";
          uiError();
          showArcadeGame("menu");
        }
      }
      function renderCasinoTime(){
        const el = document.getElementById("casinoTimeVal");
        if(!el) return;
        const remain = casinoTimeActive ? Math.max(0, casinoBudgetSec - casinoElapsedSec()) : (state.arcadeTimeSec || 0);
        el.textContent = formatArcadeTime(remain);
        const pill = document.getElementById("casinoTimePill");
        if(pill) pill.classList.toggle("warn", remain <= 30);
      }
      function exitCasinoTime(){
        if(!casinoTimeActive) return;
        casinoTimeActive = false;
        if(casinoTimeTimer){ clearInterval(casinoTimeTimer); casinoTimeTimer = null; }
        const usedSec = casinoElapsedSec();
        // Pro angebrochener Minute abrechnen, gedeckelt durch das eingefrorene Budget.
        const chargeSec = Math.min(Math.ceil(usedSec / 60) * 60, casinoBudgetSec);
        if(chargeSec > 0) spendArcadeTime(chargeSec);
        renderArcadeTime();
      }
      // Arcade-Menü: Spielzeit-Konto + Ø-Kosten je Spiel anzeigen.
      function renderArcadeTime(){
        const el = document.getElementById("arcadeTimeVal");
        if(el) el.textContent = formatArcadeTime(state.arcadeTimeSec);
      }
      function renderArcadeMenu(){
        renderArcadeTime();
        // Echte Spielkosten je Karte anzeigen.
        const costText = {
          casino: "pro Min",
          race: RACE_PLAYTIME_MIN + " Min + " + RACE_COST + " Pkt",
          luck: "ab " + luckPlaytimeMin(LUCK_MIN_PLAYERS) + " Min + " + LUCK_COST + " Pkt",
        };
        document.querySelectorAll(".arcadeCardCost[data-game-cost]").forEach(el => {
          el.textContent = costText[el.dataset.gameCost] || "";
        });
        const notice = document.getElementById("arcadeNotice");
        if(notice) notice.textContent = arcadeNoticeMsg || "";
      }
      function bindArcadeEvents(){
        const menu = document.getElementById("arcadeMenu");
        if(menu) menu.addEventListener("click", (e) => {
          const card = e.target.closest("[data-arcade-game]");
          if(!card) return;
          uiSoftClick();
          showArcadeGame(card.dataset.arcadeGame);
        });
        const casinoBack = document.getElementById("casinoBackBtn");
        if(casinoBack) casinoBack.addEventListener("click", () => { uiSoftClick(); showArcadeGame("menu"); });
        const raceBack = document.getElementById("raceBackBtn");
        if(raceBack) raceBack.addEventListener("click", () => {
          uiSoftClick();
          // In der Warteschlange → Suche abbrechen. Laufendes Spiel bleibt im Hintergrund
          // aktiv (Karte im Menü führt zurück); Würfe des Gegners werden weiter verarbeitet.
          if(race && (race.phase === "queue" || race.phase === "starting")) raceCancelSearch();
          showArcadeGame("menu");
        });
        const luckBack = document.getElementById("luckBackBtn");
        if(luckBack) luckBack.addEventListener("click", () => {
          uiSoftClick();
          if(luck && (luck.phase === "queue" || luck.phase === "starting")) luckCancelSearch();
          showArcadeGame("menu");
        });
      }

      // ════════════════════════════════════════════════════════════
      //   ARCADE-SPIEL: WÜRFEL-RENNEN  (Online 1v1 via Supabase Realtime)
      //
      //   Matchmaking über einen Lobby-Channel mit Presence ("Queue"):
      //   alle Wartenden sortieren sich deterministisch nach Beitrittszeit;
      //   der jeweils Erste eines Paars initiiert das Match per Broadcast.
      //   Das Spiel selbst läuft über einen eigenen Game-Channel — es werden
      //   NUR Würfelwerte übertragen, beide Clients wenden dieselbe Logik an.
      //
      //   Regeln: 36 Felder, W6 (nur mit freigeschaltetem d6 spielbar),
      //   Einsatz 10 Punkte, Sieg +20. Auf dem Feld des Gegners landen →
      //   Gegner zurück zum Start. 6 gewürfelt → sofort nochmal (beliebig oft).
      // ════════════════════════════════════════════════════════════
      const RACE_GOAL = 36;
      const RACE_COST = 10;
      const RACE_WIN_POINTS = 20;
      const RACE_LOBBY_CHANNEL = "arcade-race-lobby-v1";

      let race = null;              // null = kein Rennen. Sonst { phase: "queue"|"starting"|"playing"|"done", … }
      let raceLobbyChannel = null;
      let raceGameChannel = null;
      let raceMyKey = null;         // Presence-Key dieser Sitzung
      let raceDie3d = null;         // gemeinsamer 3D-W6 ("Tisch-Würfel"), zeigt beide Würfe
      let raceIdleMsg = "";         // Status-/Fehlertext im Idle-Zustand

      function raceActive(){ return !!race; }
      function raceMyName(){ return (state.username || "").trim() || "Gast"; }
      // Eigener aktiver W6-Skin als Farb-Array (oder null) — wird per Presence an den
      // Gegner übertragen, damit dessen Tisch-Würfel bei MEINEN Würfen MEINEN Skin zeigt.
      function raceMySkinFaces(){
        const s = getActiveSkin("d6");
        return (s && Array.isArray(s.faces)) ? s.faces.slice(0, 6) : null;
      }
      // Skin-Farben aus dem Presence-Payload des Gegners validieren (fremde Daten!).
      function raceSanitizeSkinFaces(f){
        if(!Array.isArray(f) || f.length !== 6) return null;
        if(!f.every(c => SKIN_COLORS.includes(c))) return null;
        return f.slice();
      }
      // Name + Skin des Gegners aus dem Presence-State des Game-Channels lesen.
      function raceReadOpponentMeta(){
        if(!race || !raceGameChannel) return;
        const ps = raceGameChannel.presenceState();
        for(const key of Object.keys(ps)){
          if(key === raceMyKey) continue;
          const meta = (ps[key] && ps[key][0]) || {};
          if(typeof meta.name === "string" && meta.name) race.oppName = meta.name;
          const faces = raceSanitizeSkinFaces(meta.skin);
          if(faces) race.oppSkinFaces = faces;
        }
      }
      // Skin-Objekt für den Tisch-Würfel, je nachdem WER gerade würfelt (mine = ich).
      // null → kein Skin (dunkelgrau). So sieht jeder den Skin des aktiven Würflers.
      function raceSkinForRoller(mine){
        const faces = mine ? (race && race.mySkinFaces) : (race && race.oppSkinFaces);
        return faces ? { dieType: "d6", faces } : null;
      }

      function raceJoinQueue(){
        if(race) return;
        if(!sb){ raceIdleMsg = "Online-Spiele brauchen eine Server-Verbindung."; renderRaceView(); uiError(); return; }
        if(!ownsDie("d6")){ uiError(); renderRaceView(); return; }
        if((state.points || 0) < RACE_COST){ uiError(); renderRaceView(); return; }
        if((state.arcadeTimeSec || 0) < RACE_PLAYTIME_MIN * 60){
          raceIdleMsg = "Nicht genug Spielzeit — du brauchst " + RACE_PLAYTIME_MIN + " Min.";
          renderRaceView(); uiError(); return;
        }
        raceIdleMsg = "";
        raceMyKey = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        race = { phase: "queue", matchInitiated: false };
        renderRaceView();
        raceLobbyChannel = sb.channel(RACE_LOBBY_CHANNEL, { config: { presence: { key: raceMyKey } } });
        raceLobbyChannel.on("presence", { event: "sync" }, raceTryMatch);
        raceLobbyChannel.on("broadcast", { event: "match" }, ({ payload }) => raceOnMatch(payload));
        raceLobbyChannel.subscribe(async (status) => {
          if(status === "SUBSCRIBED"){
            try{ await raceLobbyChannel.track({ name: raceMyName(), joinedAt: Date.now() }); }catch(_){}
          } else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT"){
            raceFail("Verbindung fehlgeschlagen — bitte später erneut versuchen.");
          }
        });
      }
      function raceCancelSearch(){
        if(!race || (race.phase !== "queue" && race.phase !== "starting")) return;
        raceTeardown();
        raceIdleMsg = "";
        renderRaceView();
      }
      // Deterministisches Pairing: Presence-Liste nach joinedAt sortieren, Paare
      // (0,1), (2,3), … — der Erste jedes Paars initiiert und broadcastet das Match.
      function raceTryMatch(){
        if(!race || race.phase !== "queue" || race.matchInitiated || !raceLobbyChannel) return;
        const ps = raceLobbyChannel.presenceState();
        const entries = Object.keys(ps)
          .map(key => ({ key, meta: (ps[key] && ps[key][0]) || {} }))
          .sort((a, b) => ((a.meta.joinedAt || 0) - (b.meta.joinedAt || 0)) || (a.key < b.key ? -1 : 1));
        for(let i = 0; i + 1 < entries.length; i += 2){
          const a = entries[i], b = entries[i + 1];
          if(a.key === raceMyKey){
            race.matchInitiated = true;
            const gameId = "g" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            try{
              raceLobbyChannel.send({ type: "broadcast", event: "match", payload: {
                gameId, hostKey: a.key, guestKey: b.key, hostName: a.meta.name || "Gast",
              }});
            }catch(_){}
            raceEnterGame(gameId, true, b.meta.name || "Gast");
            return;
          }
          if(b.key === raceMyKey) return; // Partner (a) initiiert — auf dessen Broadcast warten
        }
      }
      function raceOnMatch(payload){
        if(!race || race.phase !== "queue" || !payload) return;
        if(payload.guestKey !== raceMyKey) return;
        raceEnterGame(payload.gameId, false, payload.hostName || "Gast");
      }

      function raceEnterGame(gameId, isHost, oppName){
        raceLeaveLobby();
        race = {
          phase: "starting", isHost, oppName, gameId,
          myPos: 0, oppPos: 0, myTurn: false,
          rolling: false, startSent: false, startTimeout: null,
          mySkinFaces: raceMySkinFaces(),   // wird per Presence an den Gegner gesendet
          oppSkinFaces: null,               // kommt per Presence vom Gegner
          dieOwner: null,                   // wessen Skin der Tisch-Würfel gerade trägt
        };
        renderRaceView();
        raceGameChannel = sb.channel("arcade-race-" + gameId, {
          config: { presence: { key: raceMyKey }, broadcast: { self: false } },
        });
        raceGameChannel.on("presence", { event: "sync" }, raceOnGamePresence);
        raceGameChannel.on("presence", { event: "leave" }, ({ key }) => raceOnOpponentLeave(key));
        raceGameChannel.on("broadcast", { event: "start" }, ({ payload }) => raceOnStart(payload));
        raceGameChannel.on("broadcast", { event: "roll" }, ({ payload }) => raceOnRemoteRoll(payload));
        raceGameChannel.on("broadcast", { event: "forfeit" }, () => raceOnOpponentForfeit());
        raceGameChannel.subscribe(async (status) => {
          if(status === "SUBSCRIBED"){
            try{ await raceGameChannel.track({ name: raceMyName(), skin: race.mySkinFaces }); }catch(_){}
          } else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT"){
            raceFail("Verbindung zum Spiel fehlgeschlagen. (Keine Punkte abgezogen.)");
          }
        });
        // Gegner erscheint nicht im Game-Channel → abbrechen, OHNE Punktabzug
        // (der Einsatz wird erst bei Spielstart in raceBegin() abgezogen).
        race.startTimeout = setTimeout(() => {
          if(race && race.phase === "starting") raceFail("Gegner nicht erreichbar — bitte erneut suchen. (Keine Punkte abgezogen.)");
        }, 12000);
      }
      function raceOnGamePresence(){
        if(!race || !raceGameChannel) return;
        // Name/Skin des Gegners übernehmen, sobald (oder sooft) Presence sie liefert
        raceReadOpponentMeta();
        if(race.phase !== "starting") return;
        const count = Object.keys(raceGameChannel.presenceState()).length;
        if(count >= 2 && race.isHost && !race.startSent){
          race.startSent = true;
          const hostStarts = Math.random() < 0.5;
          try{ raceGameChannel.send({ type: "broadcast", event: "start", payload: { hostStarts } }); }catch(_){}
          raceBegin(hostStarts);
        }
      }
      function raceOnStart(payload){
        if(!race || race.phase !== "starting") return;
        raceBegin(!!(payload && payload.hostStarts));
      }
      function raceBegin(hostStarts){
        if(race.startTimeout){ clearTimeout(race.startTimeout); race.startTimeout = null; }
        race.phase = "playing";
        // Einsatz abziehen — jeder Client zieht nur seine eigenen Punkte + Spielzeit ab.
        state.points = Math.max(0, (state.points || 0) - RACE_COST);
        state.arcadeTimeSec = Math.max(0, (state.arcadeTimeSec || 0) - RACE_PLAYTIME_MIN * 60);
        if(typeof renderArcadeTime === "function") renderArcadeTime();
        updatePointsDisplay();
        persist();
        race.myTurn = race.isHost ? hostStarts : !hostStarts;
        raceSetLog(race.myTurn ? "Du beginnst — würfle!" : race.oppName + " beginnt.");
        renderRaceView();
        raceSetupDie();
        diceGameClick();
      }

      // ── Spielzug ──
      function raceRoll(){
        if(!race || race.phase !== "playing" || !race.myTurn || race.rolling) return;
        const value = 1 + Math.floor(Math.random() * 6);
        try{ raceGameChannel.send({ type: "broadcast", event: "roll", payload: { value } }); }catch(_){}
        raceAnimateAndApply(true, value);
      }
      function raceOnRemoteRoll(payload){
        if(!race || race.phase !== "playing" || !payload) return;
        const v = Math.min(6, Math.max(1, Math.floor(payload.value) || 1));
        raceAnimateAndApply(false, v);
      }
      function raceAnimateAndApply(mine, value){
        if(!race || race.phase !== "playing") return;
        // Trifft ein Wurf ein, während noch eine Animation läuft (z.B. zwei schnelle
        // Würfe nach einer 6 + Netzwerk-Jitter), wird er eingereiht statt verworfen —
        // sonst ginge die Anwendung des ersten Wurfs verloren (Positions-Desync!).
        if(race.rolling){
          (race.pendingRollQueue = race.pendingRollQueue || []).push([mine, value]);
          return;
        }
        // Tab versteckt: Chrome drosselt Timer (nach 5 Min auf 1×/Minute) und pausiert
        // requestAnimationFrame komplett — eine animationsgebundene Anwendung würde das
        // Online-Spiel zum Stocken bringen. Wurf sofort ohne Animation anwenden.
        if(document.hidden){
          raceApplyRoll(mine, value);
          const queued = race && race.pendingRollQueue && race.pendingRollQueue.shift();
          if(queued) raceAnimateAndApply(queued[0], queued[1]);
          return;
        }
        race.rolling = true;
        race.rollingMine = mine;   // für renderRaceView: wessen Würfel rollt gerade
        renderRaceView();
        const finish = () => {
          if(!race) return;
          race.rolling = false;
          raceApplyRoll(mine, value);
          const next = race && race.pendingRollQueue && race.pendingRollQueue.shift();
          if(next) raceAnimateAndApply(next[0], next[1]);
        };
        if(raceDie3d && dice3dMod){
          // Tisch-Würfel auf den Skin des aktuell Würfelnden umstellen (nur bei Wechsel).
          // So sieht der Gegner MEINEN Skin, wenn ich würfle — und umgekehrt.
          if(race.dieOwner !== mine){
            dice3dMod.updateDieSkin(raceDie3d, raceSkinForRoller(mine));
            race.dieOwner = mine;
          }
          diceRollStart();
          dice3dMod.rollDie3D(raceDie3d, value, () => { diceLand(); setTimeout(finish, 150); });
        } else {
          setTimeout(finish, 450);
        }
      }
      // Wendet einen Wurf an — läuft IDENTISCH auf beiden Clients (nur der Wert wird übertragen).
      function raceApplyRoll(mine, value){
        if(!race || race.phase !== "playing") return;
        const from = mine ? race.myPos : race.oppPos;
        const otherPos = mine ? race.oppPos : race.myPos;
        const dest = from + value;
        let msg = (mine ? "Du würfelst eine " : race.oppName + " würfelt eine ") + value + ".";

        // Ziel nur mit EXAKTER Zahl: dest === RACE_GOAL gewinnt, dest > RACE_GOAL ist
        // "überworfen" (keine Bewegung). Bsp.: 2 Felder vor dem Ziel braucht es genau
        // eine 2 (Sieg) oder eine 1 (ein Feld vor).
        if(dest === RACE_GOAL){
          if(mine) race.myPos = RACE_GOAL; else race.oppPos = RACE_GOAL;
          raceSetLog(msg + " 🎯 Ziel genau getroffen!");
          raceFinish(mine);
          return;
        }
        if(dest > RACE_GOAL){
          const need = RACE_GOAL - from;
          msg += mine
            ? " Zu hoch! Du brauchst genau eine " + need + " ins Ziel — keine Bewegung."
            : " Zu hoch — " + race.oppName + " bleibt stehen.";
          if(mine) raceOvershoot();   // hörbares Feedback: Zahl war zu hoch (nur eigener Wurf)
          // Eine 6 erlaubt trotzdem einen erneuten Wurf; sonst ist der Gegner dran.
          if(value === 6){
            msg += mine ? " 🔁 Aber: Sechs — nochmal würfeln!" : " " + race.oppName + " darf (Sechs) nochmal.";
          } else {
            race.myTurn = !mine;
          }
          raceSetLog(msg);
          renderRaceView();
          return;
        }

        // Normaler Zug
        // Rauswerfen: auf dem Feld des Gegners gelandet → Gegner zurück zum Start
        if(dest === otherPos && dest !== 0){
          if(mine){ race.oppPos = 0; msg += " 💥 Du wirfst " + race.oppName + " zurück zum Start!"; }
          else { race.myPos = 0; msg += " 💥 Du wirst zurück zum Start geworfen!"; }
          raceKnockback();            // dumpfer Aufprall (beide Richtungen)
        }
        if(mine) race.myPos = dest; else race.oppPos = dest;
        // 6 → derselbe Spieler ist sofort nochmal dran (beliebig oft hintereinander)
        if(value === 6){
          msg += mine ? " 🔁 Nochmal würfeln!" : " " + race.oppName + " darf nochmal.";
        } else {
          race.myTurn = !mine;
        }
        raceSetLog(msg);
        renderRaceView();
      }
      function raceFinish(iWon){
        race.phase = "done";
        race.iWon = iWon;
        if(iWon){
          state.points = (state.points || 0) + RACE_WIN_POINTS;
          updatePointsDisplay();
          persist();
          diceWin(false);
        } else {
          diceLose();
        }
        renderRaceView();
        // Channel verzögert schließen: das eigene "leave" darf beim Gegner erst ankommen,
        // wenn auch dort der finale Wurf verarbeitet wurde (sonst würde sein Leave-Handler
        // fälschlich "Gegner weg → Sieg" auslösen, während seine Animation noch läuft).
        raceCloseGameChannel(4000);
      }

      // ── Aufgeben / Verbindungsabbrüche ──
      function raceForfeit(){
        if(!race) return;
        if(race.phase === "playing"){
          try{ raceGameChannel && raceGameChannel.send({ type: "broadcast", event: "forfeit", payload: {} }); }catch(_){}
          raceSetLog("Du hast aufgegeben.");
          raceFinish(false);
        } else {
          raceCancelSearch();
        }
      }
      function raceOnOpponentForfeit(){
        if(race && race.phase === "playing"){
          raceSetLog(race.oppName + " hat aufgegeben.");
          raceFinish(true);
        }
      }
      function raceOnOpponentLeave(leftKey){
        if(!race || leftKey === raceMyKey) return;
        if(race.phase === "playing"){
          raceSetLog(race.oppName + " hat das Spiel verlassen.");
          raceFinish(true);
        } else if(race.phase === "starting"){
          raceFail("Gegner hat die Verbindung verloren. (Keine Punkte abgezogen.)");
        }
      }
      function raceFail(msg){
        raceTeardown();
        raceIdleMsg = msg;
        renderRaceView();
        uiError();
      }

      // ── Aufräumen ──
      function raceLeaveLobby(){
        if(raceLobbyChannel){
          try{ sb.removeChannel(raceLobbyChannel); }catch(_){}
          raceLobbyChannel = null;
        }
      }
      function raceCloseGameChannel(delayMs){
        const ch = raceGameChannel;
        raceGameChannel = null;
        if(!ch) return;
        setTimeout(() => { try{ sb.removeChannel(ch); }catch(_){} }, delayMs || 0);
      }
      // Beendet alles Rennen-bezogene. Läuft noch ein Spiel, gilt das als Aufgabe
      // (Forfeit wird gesendet, damit der Gegner gewinnt und nicht hängen bleibt).
      function raceTeardown(){
        if(race && race.startTimeout){ clearTimeout(race.startTimeout); race.startTimeout = null; }
        if(race && race.phase === "playing" && raceGameChannel){
          try{ raceGameChannel.send({ type: "broadcast", event: "forfeit", payload: {} }); }catch(_){}
        }
        raceLeaveLobby();
        raceCloseGameChannel(300);
        if(raceDie3d){ raceDie3d.cleanup(); raceDie3d = null; }
        const dieWrap = document.getElementById("raceDie3d");
        if(dieWrap) dieWrap.textContent = "";
        race = null;
      }

      // ── Rendering ──
      function raceSetLog(msg){
        if(race) race.lastLog = msg;
        const log = document.getElementById("raceLog");
        if(log) log.textContent = msg || "";
      }
      function raceSetupDie(){
        const wrap = document.getElementById("raceDie3d");
        if(!wrap) return;
        if(raceDie3d){ raceDie3d.cleanup(); raceDie3d = null; }
        wrap.textContent = "";
        if(race) race.dieOwner = null;
        // Wer zuerst dran ist, dessen Skin liegt initial auf dem Tisch-Würfel.
        const firstMine = !!(race && race.myTurn);
        loadDice3D().then(mod => {
          if(!mod || !race || race.phase !== "playing") return;
          if(raceDie3d) return;
          const die = mod.createDie3D(wrap, "d6", raceSkinForRoller(firstMine), { size: 150 });
          if(die){ raceDie3d = die; race.dieOwner = firstMine; }
        });
      }
      function renderRaceBoard(){
        const board = document.getElementById("raceBoard");
        const startTokens = document.getElementById("raceStartTokens");
        if(!board || !race) return;
        while(board.firstChild) board.removeChild(board.firstChild);
        // 6×6-Serpentine: Feld 1 unten links, Reihe für Reihe abwechselnd nach
        // rechts/links, Feld 36 (Ziel) oben.
        for(let n = 1; n <= RACE_GOAL; n++){
          const cell = document.createElement("div");
          cell.className = "raceCell" + (n === RACE_GOAL ? " goal" : "");
          const r = Math.floor((n - 1) / 6);
          const col = (r % 2 === 0) ? ((n - 1) % 6) : (5 - ((n - 1) % 6));
          cell.style.gridRowStart = String(6 - r);
          cell.style.gridColumnStart = String(col + 1);
          const num = document.createElement("span");
          num.className = "raceCellNum";
          num.textContent = n === RACE_GOAL ? "🏁" : String(n);
          cell.appendChild(num);
          if(race.myPos === n){ const t = document.createElement("span"); t.className = "raceToken meTok"; t.title = "Du"; cell.appendChild(t); }
          if(race.oppPos === n){ const t = document.createElement("span"); t.className = "raceToken oppTok"; t.title = race.oppName; cell.appendChild(t); }
          board.appendChild(cell);
        }
        if(startTokens){
          startTokens.textContent = "";
          if(race.myPos === 0){ const t = document.createElement("span"); t.className = "raceToken meTok"; t.title = "Du"; startTokens.appendChild(t); }
          if(race.oppPos === 0){ const t = document.createElement("span"); t.className = "raceToken oppTok"; t.title = race.oppName; startTokens.appendChild(t); }
        }
      }
      function renderRaceView(){
        const idle = document.getElementById("raceIdle");
        const queue = document.getElementById("raceQueue");
        const game = document.getElementById("raceGame");
        const result = document.getElementById("raceResult");
        if(!idle) return;
        const phase = race ? race.phase : "idle";
        idle.style.display = phase === "idle" ? "" : "none";
        queue.style.display = (phase === "queue" || phase === "starting") ? "" : "none";
        game.style.display = phase === "playing" ? "" : "none";
        result.style.display = phase === "done" ? "" : "none";
        if(phase === "idle"){
          const statusEl = document.getElementById("raceIdleStatus");
          const btn = document.getElementById("raceSearchBtn");
          const hint = document.getElementById("raceIdleHint");
          const hasD6 = ownsDie("d6");
          const enough = (state.points || 0) >= RACE_COST;
          const enoughTime = (state.arcadeTimeSec || 0) >= RACE_PLAYTIME_MIN * 60;
          if(btn) btn.disabled = !sb || !hasD6 || !enough || !enoughTime;
          if(statusEl) statusEl.textContent = raceIdleMsg;
          if(hint){
            if(!sb) hint.textContent = "Online-Spiele sind gerade nicht verfügbar.";
            else if(!hasD6) hint.textContent = "🔒 Du brauchst den W6 — schalte ihn zuerst im Würfel-Shop frei.";
            else if(!enough) hint.textContent = "Nicht genug Punkte — du brauchst mindestens " + RACE_COST + ".";
            else if(!enoughTime) hint.textContent = "Nicht genug Spielzeit — du brauchst " + RACE_PLAYTIME_MIN + " Min.";
            else hint.textContent = "Kosten: " + RACE_PLAYTIME_MIN + " Min Spielzeit + " + RACE_COST + " Punkte. Dein W6-Skin wird angezeigt.";
          }
        } else if(phase === "queue" || phase === "starting"){
          const txt = document.getElementById("raceQueueText");
          if(txt) txt.textContent = phase === "queue" ? "Suche Gegner…" : "Gegner gefunden — Spiel startet…";
        } else if(phase === "playing"){
          const oppNameEl = document.getElementById("raceOppName");
          if(oppNameEl) oppNameEl.textContent = race.oppName;
          const badge = document.getElementById("raceTurnBadge");
          if(badge){
            // Beim Rollen zeigen, WESSEN Würfel (und damit Skin) gerade rollt.
            badge.textContent = race.rolling
              ? (race.rollingMine ? "🎲 Dein Wurf…" : "🎲 " + race.oppName + " würfelt…")
              : (race.myTurn ? "Du bist dran!" : race.oppName + " ist dran…");
            badge.classList.toggle("mine", !!race.myTurn && !race.rolling);
          }
          const rollBtn = document.getElementById("raceRollBtn");
          if(rollBtn) rollBtn.disabled = !race.myTurn || race.rolling;
          raceSetLog(race.lastLog || "");
          renderRaceBoard();
        } else if(phase === "done"){
          const icon = document.getElementById("raceResultIcon");
          const title = document.getElementById("raceResultTitle");
          const sub = document.getElementById("raceResultSub");
          if(icon) icon.textContent = race.iWon ? "🏆" : "💀";
          if(title) title.textContent = race.iWon ? "Gewonnen!" : "Verloren.";
          if(sub) sub.textContent = race.iWon
            ? "+" + RACE_WIN_POINTS + " Punkte (Einsatz " + RACE_COST + " → Gewinn " + (RACE_WIN_POINTS - RACE_COST) + "). Stand: " + (state.points || 0) + " Punkte."
            : "Dein Einsatz von " + RACE_COST + " Punkten ist weg. Stand: " + (state.points || 0) + " Punkte.";
        }
      }
      function bindRaceEvents(){
        const search = document.getElementById("raceSearchBtn");
        const cancel = document.getElementById("raceCancelBtn");
        const roll = document.getElementById("raceRollBtn");
        const forfeit = document.getElementById("raceForfeitBtn");
        const resultBack = document.getElementById("raceResultBackBtn");
        if(search) search.addEventListener("click", () => { uiSoftClick(); raceJoinQueue(); });
        if(cancel) cancel.addEventListener("click", () => { uiSoftClick(); raceCancelSearch(); });
        if(roll) roll.addEventListener("click", raceRoll);
        if(forfeit) forfeit.addEventListener("click", () => { uiSoftClick(); raceForfeit(); });
        if(resultBack) resultBack.addEventListener("click", () => {
          uiSoftClick();
          raceTeardown();
          renderRaceView();
          showArcadeGame("menu");
        });
      }

      // ════════════════════════════════════════════════════════════
      //   ARCADE-SPIEL: RISK & ROLL  (Push-Your-Luck, online 2–4 Spieler)
      //
      //   HOST-AUTORITATIVES Modell (robuster für N Spieler als peer-deterministisch):
      //   - Matchmaking je (Würfeltyp × Spielerzahl) über einen eigenen Lobby-Channel;
      //     Presence zeigt die Queue-Größe. Der früheste Sucher eines Batches wird HOST.
      //   - Der Host hält den kanonischen Spielstand, würfelt zentral (faire Zufallsquelle)
      //     und broadcastet nach jeder Aktion einen Snapshot. Clients senden nur ihre
      //     Aktion ("roll"/"safe") als Intent; der Host validiert (richtiger Spieler dran?).
      //   Regeln: 4 Runden, Augen aufaddieren, "sichern" bankt die Rundenpunkte; eine in
      //   derselben Runde DOPPELTE Zahl = Bust (Runde 0). Höchste Gesamtsumme gewinnt;
      //   Gleichstand → Stechen (Sudden-Death-Würfe). Einsatz 10, Auszahlung nach Platz.
      // ════════════════════════════════════════════════════════════
      const LUCK_SEAT_COLORS = ["#3DC061", "#E94560", "#2196F3", "#F5C542"];
      let luck = null;
      let luckLobbyChannel = null;
      let luckGameChannel = null;
      let luckMyKey = null;
      let luckDie3d = null;
      let luckSetupDie = "d6";       // gewählter Würfeltyp (Setup)
      let luckSetupPlayers = 2;      // gewählte Spielerzahl (Setup)
      let luckIdleMsg = "";
      let luckCountdownTimer = null; // lokaler 1s-Tick für die Zug-Countdown-Anzeige

      function luckActive(){ return !!luck; }
      function luckMyName(){ return (state.username || "").trim() || "Gast"; }
      function luckMySkinFaces(dieType){
        const s = getActiveSkin(dieType);
        return (s && Array.isArray(s.faces)) ? s.faces.slice() : null;
      }
      function luckSanitizeSkin(faces, sides){
        if(!Array.isArray(faces) || faces.length !== sides) return null;
        if(!faces.every(c => SKIN_COLORS.includes(c))) return null;
        return faces.slice();
      }
      function luckChannelName(dieType, players){ return "arcade-luck-" + dieType + "-" + players + "-v1"; }

      // ── Matchmaking ──
      function luckJoinQueue(){
        if(luck) return;
        const dieType = luckSetupDie, players = luckSetupPlayers;
        if(!sb){ luckIdleMsg = "Online-Spiele brauchen eine Server-Verbindung."; renderLuckView(); uiError(); return; }
        if(!ownsDie(dieType)){ uiError(); renderLuckView(); return; }
        if((state.points || 0) < LUCK_COST){ uiError(); renderLuckView(); return; }
        const playtimeCostSec = luckPlaytimeMin(players) * 60;
        if((state.arcadeTimeSec || 0) < playtimeCostSec){
          luckIdleMsg = "Nicht genug Spielzeit — du brauchst " + luckPlaytimeMin(players) + " Min.";
          renderLuckView(); uiError(); return;
        }
        luckIdleMsg = "";
        luckMyKey = "l_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        luck = { phase: "queue", dieType, sides: DICE_SIDES[dieType], playerCount: players, matchInitiated: false, queueCount: 1, playtimeCostSec };
        renderLuckView();
        luckLobbyChannel = sb.channel(luckChannelName(dieType, players), { config: { presence: { key: luckMyKey } } });
        luckLobbyChannel.on("presence", { event: "sync" }, luckOnLobbySync);
        luckLobbyChannel.on("broadcast", { event: "match" }, ({ payload }) => luckOnMatch(payload));
        luckLobbyChannel.subscribe(async (status) => {
          if(status === "SUBSCRIBED"){
            try{ await luckLobbyChannel.track({ name: luckMyName(), joinedAt: Date.now(), skin: luckMySkinFaces(dieType) }); }catch(_){}
          } else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT"){
            luckFail("Verbindung fehlgeschlagen — bitte später erneut versuchen.");
          }
        });
      }
      function luckCancelSearch(){
        if(!luck || (luck.phase !== "queue" && luck.phase !== "starting")) return;
        luckTeardown();
        luckIdleMsg = "";
        renderLuckView();
      }
      function luckOnLobbySync(){
        if(!luck || luck.phase !== "queue" || !luckLobbyChannel) return;
        const ps = luckLobbyChannel.presenceState();
        luck.queueCount = Object.keys(ps).length;
        renderLuckView();
        luckTryMatch();
      }
      function luckTryMatch(){
        if(!luck || luck.phase !== "queue" || luck.matchInitiated || !luckLobbyChannel) return;
        const ps = luckLobbyChannel.presenceState();
        const entries = Object.keys(ps)
          .map(key => ({ key, meta: (ps[key] && ps[key][0]) || {} }))
          .sort((a, b) => ((a.meta.joinedAt || 0) - (b.meta.joinedAt || 0)) || (a.key < b.key ? -1 : 1));
        if(entries.length < luck.playerCount) return;
        const group = entries.slice(0, luck.playerCount);
        const inGroup = group.some(e => e.key === luckMyKey);
        if(!inGroup) return;                 // nicht in diesem Batch → weiter warten
        if(group[0].key !== luckMyKey) return; // nur der Erste initiiert
        luck.matchInitiated = true;
        const gameId = "lg" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const seats = group.map(e => ({ key: e.key, name: e.meta.name || "Gast", skin: luckSanitizeSkin(e.meta.skin, luck.sides) }));
        try{ luckLobbyChannel.send({ type: "broadcast", event: "match", payload: { gameId, dieType: luck.dieType, playerCount: luck.playerCount, seats } }); }catch(_){}
        luckEnterGame(gameId, seats, true);
      }
      function luckOnMatch(payload){
        if(!luck || luck.phase !== "queue" || !payload || !Array.isArray(payload.seats)) return;
        if(!payload.seats.some(s => s.key === luckMyKey)) return;
        if(payload.seats[0] && payload.seats[0].key === luckMyKey) return; // Host ist schon drin
        luckEnterGame(payload.gameId, payload.seats, false);
      }

      function luckLeaveLobby(){
        if(luckLobbyChannel){ try{ sb.removeChannel(luckLobbyChannel); }catch(_){} luckLobbyChannel = null; }
      }
      function luckEnterGame(gameId, seats, isHost){
        luckLeaveLobby();
        const players = seats.map((s, i) => ({ key: s.key, name: s.name || "Gast", skinFaces: luckSanitizeSkin(s.skin, luck.sides), seat: i }));
        const N = players.length;
        luck = Object.assign(luck || {}, {
          phase: "starting", isHost, gameId, players, playerCount: N,
          mySeat: players.findIndex(p => p.key === luckMyKey),
          totals: Array(N).fill(0), left: Array(N).fill(false), tbTally: Array(N).fill(0),
          round: 1, turnSeat: 0,
          // Reihum-Modell: jeder Spieler hat pro Runde seinen eigenen ungesicherten Stand.
          roundSums: Array(N).fill(0), roundRolls: Array.from({length: N}, () => []),
          roundDone: Array(N).fill(false), lastActorSeat: 0, turnStartedAt: 0,
          lastRoll: null, nonce: 0, animatedNonce: 0,
          log: "", result: null, seq: 0,
          rolling: false, dieOwner: null, entryPaid: false,
          startTimeout: null, tbTimer: null, turnTimer: null,
          playtimeCostSec: (luck && luck.playtimeCostSec) || (luckPlaytimeMin(N) * 60),
        });
        renderLuckView();
        luckGameChannel = sb.channel("arcade-luck-game-" + gameId, {
          config: { presence: { key: luckMyKey }, broadcast: { self: false } },
        });
        luckGameChannel.on("presence", { event: "sync" }, luckOnGamePresence);
        luckGameChannel.on("presence", { event: "leave" }, ({ key }) => luckOnPlayerLeave(key));
        luckGameChannel.on("broadcast", { event: "state" }, ({ payload }) => luckApplySnapshot(payload));
        luckGameChannel.on("broadcast", { event: "act" }, ({ payload }) => luckHostOnAction(payload));
        luckGameChannel.subscribe(async (status) => {
          if(status === "SUBSCRIBED"){
            try{ await luckGameChannel.track({ name: luckMyName() }); }catch(_){}
          } else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT"){
            luckFail("Verbindung zum Spiel fehlgeschlagen. (Keine Punkte abgezogen.)");
          }
        });
        // Starten erst, wenn alle Sitze im Game-Channel präsent sind; sonst Timeout (kein Abzug).
        luck.startTimeout = setTimeout(() => {
          if(luck && luck.phase === "starting") luckFail("Nicht alle Mitspieler erreichbar — bitte erneut suchen. (Keine Punkte abgezogen.)");
        }, 15000);
      }
      function luckOnGamePresence(){
        if(!luck || !luckGameChannel) return;
        if(luck.phase !== "starting" || !luck.isHost) return;
        const present = luckGameChannel.presenceState();
        const allHere = luck.players.every(p => present[p.key]);
        if(allHere && !luck.startSent){
          luck.startSent = true;
          luckHostBegin();
        }
      }
      // ── Host: Spielstart + Snapshots ──
      function luckPayEntryOnce(){
        if(luck.entryPaid) return;
        luck.entryPaid = true;
        state.points = Math.max(0, (state.points || 0) - LUCK_COST);
        // Spielzeit verbuchen (Vorabkosten je Spielerzahl).
        const cost = luck.playtimeCostSec || (luckPlaytimeMin(luck.playerCount) * 60);
        state.arcadeTimeSec = Math.max(0, (state.arcadeTimeSec || 0) - cost);
        if(typeof renderArcadeTime === "function") renderArcadeTime();
        updatePointsDisplay();
        persist();
      }
      function luckHostBegin(){
        if(luck.startTimeout){ clearTimeout(luck.startTimeout); luck.startTimeout = null; }
        luck.phase = "playing";
        luck.round = 1;
        luckResetRound();
        luck.turnSeat = 0;            // Seat 0 (Host) beginnt das Spiel
        luck.lastActorSeat = 0;
        luck.log = "Spiel startet! " + luck.players[luck.turnSeat].name + " beginnt.";
        luckPayEntryOnce();
        luckStartTurnTimer();
        luckHostBroadcast();
        luckRenderFromState();
        diceGameClick();
      }
      // Rundenstände aller Spieler zurücksetzen (neue Runde / Spielstart).
      function luckResetRound(){
        const N = luck.playerCount;
        luck.roundSums = Array(N).fill(0);
        luck.roundRolls = Array.from({length: N}, () => []);
        luck.roundDone = Array(N).fill(false);
        luck.lastRoll = null;
      }
      function luckSnapshot(){
        return {
          seq: ++luck.seq, phase: luck.phase, round: luck.round,
          turnSeat: luck.turnSeat, turnStartedAt: luck.turnStartedAt,
          totals: luck.totals, left: luck.left, tbTally: luck.tbTally,
          roundSums: luck.roundSums, roundRolls: luck.roundRolls, roundDone: luck.roundDone,
          lastRoll: luck.lastRoll, log: luck.log, result: luck.result,
        };
      }
      function luckHostBroadcast(){
        if(!luck || !luck.isHost || !luckGameChannel) return;
        try{ luckGameChannel.send({ type: "broadcast", event: "state", payload: luckSnapshot() }); }catch(_){}
      }
      function luckApplySnapshot(snap){
        if(!luck || luck.isHost || !snap) return;
        if(Number.isFinite(luck.seq) && snap.seq <= luck.seq) return; // veralteten Snapshot verwerfen
        luck.seq = snap.seq;
        luck.phase = snap.phase; luck.round = snap.round;
        luck.turnSeat = snap.turnSeat; luck.turnStartedAt = snap.turnStartedAt || 0;
        luck.totals = snap.totals; luck.left = snap.left; luck.tbTally = snap.tbTally;
        luck.roundSums = snap.roundSums || luck.roundSums;
        luck.roundRolls = snap.roundRolls || luck.roundRolls;
        luck.roundDone = snap.roundDone || luck.roundDone;
        luck.lastRoll = snap.lastRoll; luck.log = snap.log; luck.result = snap.result;
        // Lokale Aktions-Sperre lösen, sobald ich nicht (mehr) dran bin (der Zug wechselt
        // im Reihum-Modell nach jedem Wurf, also direkt nach meiner eigenen Aktion).
        if(luck.turnSeat !== luck.mySeat){ luck.locked = false; }
        // Client-seitigen Countdown an den neuen Zug koppeln.
        luckSyncCountdown();
        if(luck.phase === "playing" || luck.phase === "tiebreak") luckPayEntryOnce();
        if(luck.phase === "done") luckClientFinalizePayout();
        luckRenderFromState();
      }

      // ── Aktionen ──
      // Zwei getrennte Sperren:
      //   luck.rolling = eine Würfel-ANIMATION läuft gerade (für Badge + Button-Sperre)
      //   luck.locked  = lokale Aktion abgeschickt, Zug noch nicht aufgelöst (Anti-Doppelklick).
      // locked wird beim Zugwechsel (luckHostAdvance / Snapshot mit neuem turnSeat) sowie nach
      // einem fortsetzenden (Nicht-Bust-)Wurf wieder gelöst — NICHT an die Animation gekoppelt
      // (ein "Sichern" hat keine Animation und ließ das alte rolling-Flag sonst hängen).
      function luckRoll(){
        if(!luckCanAct()) return;
        luck.locked = true; renderLuckGame();
        if(luck.isHost) luckHostApply(luck.mySeat, "roll");
        else luckSendAct("roll");
      }
      function luckSafe(){
        if(!luckCanAct()) return;
        luck.locked = true; renderLuckGame();
        if(luck.isHost) luckHostApply(luck.mySeat, "safe");
        else luckSendAct("safe");
      }
      function luckCanAct(){
        return luck && luck.phase === "playing" && luck.turnSeat === luck.mySeat
          && !luck.left[luck.mySeat] && !luck.roundDone[luck.mySeat] && !luck.rolling && !luck.locked;
      }
      function luckSendAct(action){
        try{ luckGameChannel.send({ type: "broadcast", event: "act", payload: { seat: luck.mySeat, action } }); }catch(_){}
      }
      function luckHostOnAction(payload){
        if(!luck || !luck.isHost || !payload) return;
        // Forfeit eines Clients gilt jederzeit (nicht nur wenn er dran ist).
        if(payload.action === "forfeit"){ luckMarkLeft(payload.seat); return; }
        if(luck.phase !== "playing") return;
        if(payload.seat !== luck.turnSeat) return;        // nicht dran → ignorieren
        luckHostApply(payload.seat, payload.action);
      }
      function luckHostApply(seat, action){
        if(!luck || !luck.isHost || luck.phase !== "playing" || seat !== luck.turnSeat) return;
        if(luck.roundDone[seat] || luck.left[seat]) return;     // sollte nie dran sein
        luckClearTurnTimer();                                    // Aktion erfolgt → Zug-Timer stoppen
        luck.lastActorSeat = seat;
        if(action === "roll"){
          const v = 1 + Math.floor(Math.random() * luck.sides);
          const bust = luck.roundRolls[seat].includes(v);
          luck.lastRoll = { seat, value: v, bust, nonce: ++luck.nonce };
          if(bust){
            // Doppelte Zahl → für diese Runde raus, ungesicherte Punkte verloren.
            luck.log = luck.players[seat].name + " würfelt " + v + " — schon dagewesen! Bust, Runde verloren.";
            luck.roundSums[seat] = 0; luck.roundDone[seat] = true;
            luckHostBroadcast(); luckRenderFromState();
            luckHostAdvanceAfter(1500);  // erst nach der Würfel-Animation weiterschalten
          } else {
            luck.roundRolls[seat] = luck.roundRolls[seat].concat(v);
            luck.roundSums[seat] += v;
            if(luck.roundRolls[seat].length >= luck.sides){
              // Ganzer Würfel durch → kann nicht mehr würfeln, automatisch gesichert.
              luck.totals[seat] += luck.roundSums[seat];
              luck.roundDone[seat] = true;
              luck.log = luck.players[seat].name + " würfelt " + v + " — Würfel komplett! Automatisch gesichert (" + luck.roundSums[seat] + " → Gesamt " + luck.totals[seat] + ").";
              luckHostBroadcast(); luckRenderFromState();
              luckHostAdvanceAfter(1500);
            } else {
              // Normaler Wurf: Zug wandert reihum zum nächsten Spieler.
              luck.log = luck.players[seat].name + " würfelt " + v + " → " + luck.roundSums[seat] + " ungesichert.";
              luckHostBroadcast(); luckRenderFromState();
              luckHostAdvanceAfter(900);
            }
          }
        } else if(action === "safe"){
          luck.totals[seat] += luck.roundSums[seat];
          luck.roundDone[seat] = true;
          luck.log = luck.players[seat].name + " sichert " + luck.roundSums[seat] + " Punkte (Gesamt " + luck.totals[seat] + ").";
          luck.lastRoll = null;
          luckHostBroadcast(); luckRenderFromState();
          luckHostAdvanceAfter(300);
        }
      }
      // Nach Bust/Safe (mit kleiner Verzögerung für die Animation) zum nächsten Spieler.
      function luckHostAdvanceAfter(ms){
        if(luck._advTimer) clearTimeout(luck._advTimer);
        luck._advTimer = setTimeout(() => { luck._advTimer = null; luckHostAdvance(); }, ms);
      }
      function luckHostAdvance(){
        if(!luck || !luck.isHost || luck.phase !== "playing") return;
        luck.locked = false; luck.rolling = false;   // neuer Zug → Sperren lösen
        const N = luck.playerCount;
        // Nächsten Spieler im Ring suchen, der weder verlassen noch für die Runde fertig ist.
        let next = -1;
        for(let i = 1; i <= N; i++){
          const s = (luck.turnSeat + i) % N;
          if(!luck.left[s] && !luck.roundDone[s]){ next = s; break; }
        }
        if(next !== -1){
          luck.turnSeat = next;
          luck.lastRoll = null;
          luck.log = luck.players[luck.turnSeat].name + " ist dran.";
          luckStartTurnTimer();
          luckHostBroadcast(); luckRenderFromState();
          return;
        }
        // Kein aktiver Spieler mehr → Runde ist vorbei.
        if(luck.round < LUCK_ROUNDS){
          luck.round++;
          luckResetRound();
          // Nächste Runde beginnt beim Spieler NACH dem zuletzt Aktiven (nie zweimal hintereinander).
          let start = luck.lastActorSeat;
          for(let i = 1; i <= N; i++){
            const s = (luck.lastActorSeat + i) % N;
            if(!luck.left[s]){ start = s; break; }
          }
          luck.turnSeat = start;
          luck.log = "Runde " + luck.round + " — " + luck.players[luck.turnSeat].name + " beginnt.";
          luckStartTurnTimer();
          luckHostBroadcast(); luckRenderFromState();
        } else {
          luckHostFinish();
        }
      }
      // ── 10-Sekunden-Zug-Timer (host-autoritativ) ──
      const LUCK_TURN_SEC = 10;
      function luckStartTurnTimer(){
        luck.turnStartedAt = Date.now();
        luckSyncCountdown();
        if(!luck.isHost) return;                 // nur der Host erzwingt das Limit
        luckClearTurnTimer();
        luck.turnTimer = setTimeout(() => {
          luck.turnTimer = null;
          if(!luck || !luck.isHost || luck.phase !== "playing") return;
          const seat = luck.turnSeat;
          if(luck.left[seat] || luck.roundDone[seat]) return;
          // Zeit abgelaufen → automatisch sichern (ggf. 0 Punkte → für die Runde raus).
          luck.log = luck.players[seat].name + " hat zu lange gezögert — automatisch gesichert.";
          luckHostApply(seat, "safe");
        }, LUCK_TURN_SEC * 1000);
      }
      function luckClearTurnTimer(){
        if(luck && luck.turnTimer){ clearTimeout(luck.turnTimer); luck.turnTimer = null; }
      }
      // Visueller Countdown auf ALLEN Clients (lokaler 1s-Tick aus turnStartedAt).
      function luckSyncCountdown(){
        if(luckCountdownTimer){ clearInterval(luckCountdownTimer); luckCountdownTimer = null; }
        if(!luck || luck.phase !== "playing"){ luckRenderTimer(); return; }
        luckRenderTimer();
        luckCountdownTimer = setInterval(() => {
          if(!luck || luck.phase !== "playing"){ clearInterval(luckCountdownTimer); luckCountdownTimer = null; luckRenderTimer(); return; }
          luckRenderTimer();
        }, 250);
      }
      // ── Host: Spielende + Stechen (Tiebreak) ──
      function luckRanking(){
        const seats = luck.players.map(p => p.seat);
        return seats.sort((a, b) =>
          (luck.totals[b] - luck.totals[a]) || (luck.tbTally[b] - luck.tbTally[a]) || (a - b)
        );
      }
      function luckHasExactTie(){
        const r = luckRanking();
        for(let i = 0; i + 1 < r.length; i++){
          if(luck.totals[r[i]] === luck.totals[r[i+1]] && luck.tbTally[r[i]] === luck.tbTally[r[i+1]]) return true;
        }
        return false;
      }
      function luckHostFinish(){
        if(luckHasExactTie() && (luck.tbRounds || 0) < 8){
          luckHostRunTiebreakRound();
        } else {
          luckHostFinalize();
        }
      }
      function luckHostRunTiebreakRound(){
        luck.phase = "tiebreak";
        luck.tbRounds = (luck.tbRounds || 0) + 1;
        luck.log = "Gleichstand! Stechen – Runde " + luck.tbRounds + ".";
        luckHostBroadcast(); luckRenderFromState();
        // Jeder (nicht verlassene) Spieler würfelt einmal, nacheinander mit kurzer Pause.
        const seats = luck.players.map(p => p.seat).filter(s => !luck.left[s]);
        let i = 0;
        const step = () => {
          if(!luck || luck.phase !== "tiebreak") return;
          if(i >= seats.length){
            // Stechen-Runde fertig → erneut prüfen
            if(luckHasExactTie() && luck.tbRounds < 8) luckHostRunTiebreakRound();
            else { luck.phase = "playing"; luckHostFinalize(); }
            return;
          }
          const seat = seats[i++];
          const v = 1 + Math.floor(Math.random() * luck.sides);
          luck.tbTally[seat] += v;
          luck.lastRoll = { seat, value: v, bust: false, nonce: ++luck.nonce };
          luck.log = "Stechen: " + luck.players[seat].name + " würfelt " + v + " (Σ " + luck.tbTally[seat] + ").";
          luckHostBroadcast(); luckRenderFromState();
          luck.tbTimer = setTimeout(step, 1300);
        };
        luck.tbTimer = setTimeout(step, 800);
      }
      function luckHostFinalize(){
        luck.phase = "done";
        const ranking = luckRanking();
        const payArr = LUCK_PAYOUTS[luck.playerCount] || [];
        const payouts = Array(luck.playerCount).fill(0);
        ranking.forEach((seat, rank) => { payouts[seat] = payArr[rank] || 0; });
        luck.result = { ranking, payouts };
        luck.log = "Spiel beendet.";
        luckHostBroadcast(); luckRenderFromState();
        luckClientFinalizePayout();
      }
      // Auszahlung des EIGENEN Platzes gutschreiben (auf jedem Client genau einmal).
      function luckClientFinalizePayout(){
        if(!luck || !luck.result || luck.paidOut) return;
        luck.paidOut = true;
        const my = luck.result.payouts[luck.mySeat] || 0;
        if(my > 0){ state.points = (state.points || 0) + my; updatePointsDisplay(); persist(); }
        const rank = luck.result.ranking.indexOf(luck.mySeat);
        if(rank === 0) diceWin(false); else diceLose();
        renderLuckView();
      }

      // ── Aufgeben / Verbindungsabbrüche ──
      function luckForfeit(){
        if(!luck) return;
        if(luck.phase === "playing" || luck.phase === "tiebreak" || luck.phase === "starting"){
          // Sich selbst als "verlassen" markieren. Host verarbeitet das direkt,
          // Nicht-Host meldet es dem Host und verlässt den Channel.
          if(luck.isHost){
            luckMarkLeft(luck.mySeat);
          } else {
            try{ luckGameChannel && luckGameChannel.send({ type: "broadcast", event: "act", payload: { seat: luck.mySeat, action: "forfeit" } }); }catch(_){}
            luckTeardown();
            luckIdleMsg = "Du hast das Spiel verlassen. Einsatz verloren.";
            renderLuckView();
          }
        } else {
          luckCancelSearch();
        }
      }
      function luckMarkLeft(seat){
        if(!luck || !luck.isHost || seat == null || luck.left[seat]) return;
        luck.left[seat] = true;
        luck.roundDone[seat] = true;     // verlassene Spieler kommen nicht mehr dran
        luck.log = luck.players[seat].name + " hat das Spiel verlassen.";
        // Nur noch ein aktiver Spieler übrig → Spiel sofort beenden.
        const remaining = luck.players.map(p => p.seat).filter(s => !luck.left[s]);
        if(remaining.length <= 1 && (luck.phase === "playing" || luck.phase === "tiebreak")){
          luckClearTurnTimer();
          if(luck._advTimer){ clearTimeout(luck._advTimer); luck._advTimer = null; }
          if(luck.tbTimer){ clearTimeout(luck.tbTimer); luck.tbTimer = null; }
          luckHostFinalize();
          return;
        }
        // War der Verlassende gerade dran → weiter zum nächsten.
        if(luck.phase === "playing" && luck.turnSeat === seat){
          luckClearTurnTimer();
          luck.lastRoll = null;
          luckHostBroadcast(); luckRenderFromState();
          luckHostAdvanceAfter(200);
        } else {
          luckHostBroadcast(); luckRenderFromState();
        }
      }
      function luckOnPlayerLeave(key){
        if(!luck || key === luckMyKey) return;
        // Host verlässt das Spiel → kein Schiedsrichter mehr: abbrechen + Einsatz zurück.
        const hostKey = luck.players[0] && luck.players[0].key;
        if(!luck.isHost && key === hostKey){
          luckAbortRefund("Host hat das Spiel verlassen — Einsatz zurückerstattet.");
          return;
        }
        if(luck.isHost){
          const p = luck.players.find(pp => pp.key === key);
          if(p) luckMarkLeft(p.seat);
        }
      }
      // Host-bezogene "act"-Forfeits laufen ebenfalls über luckHostOnAction:
      // (wird dort an luckMarkLeft delegiert)
      function luckFail(msg){
        luckTeardown();
        luckIdleMsg = msg;
        renderLuckView();
        uiError();
      }
      function luckAbortRefund(msg){
        // Einsatz zurück, falls schon abgezogen (Spiel kam nie zu Ende).
        if(luck && luck.entryPaid && !luck.paidOut){
          state.points = (state.points || 0) + LUCK_COST;
          const cost = luck.playtimeCostSec || (luckPlaytimeMin(luck.playerCount) * 60);
          state.arcadeTimeSec = Math.max(0, (state.arcadeTimeSec || 0) + cost);
          if(typeof renderArcadeTime === "function") renderArcadeTime();
          updatePointsDisplay(); persist();
        }
        luckTeardown();
        luckIdleMsg = msg || "";
        renderLuckView();
      }
      function luckTeardown(){
        if(luck){
          if(luck.startTimeout) clearTimeout(luck.startTimeout);
          if(luck.tbTimer) clearTimeout(luck.tbTimer);
          if(luck._advTimer) clearTimeout(luck._advTimer);
          if(luck.turnTimer) clearTimeout(luck.turnTimer);
        }
        if(luckCountdownTimer){ clearInterval(luckCountdownTimer); luckCountdownTimer = null; }
        luckLeaveLobby();
        const ch = luckGameChannel; luckGameChannel = null;
        if(ch) setTimeout(() => { try{ sb.removeChannel(ch); }catch(_){} }, 300);
        if(luckDie3d){ luckDie3d.cleanup(); luckDie3d = null; }
        const w = document.getElementById("luckDie3d"); if(w) w.textContent = "";
        luck = null;
      }

      // ── Rendering ──
      function luckRenderFromState(){ renderLuckView(); luckSyncDie(); }
      function luckSetupDie3D(){
        const wrap = document.getElementById("luckDie3d");
        if(!wrap) return;
        if(luckDie3d){ luckDie3d.cleanup(); luckDie3d = null; }
        wrap.textContent = "";
        if(luck) luck.dieOwner = null;
        const firstSeat = luck ? luck.turnSeat : 0;
        loadDice3D().then(mod => {
          if(!mod || !luck || (luck.phase !== "playing" && luck.phase !== "tiebreak")) return;
          if(luckDie3d) return;
          const faces = luck.players[firstSeat] && luck.players[firstSeat].skinFaces;
          const die = mod.createDie3D(wrap, luck.dieType, faces ? { dieType: luck.dieType, faces } : null, { size: 150 });
          if(die){ luckDie3d = die; luck.dieOwner = firstSeat; }
        });
      }
      // Würfel auf den Skin des aktuell Würfelnden umstellen + neuen Wurf animieren.
      function luckSyncDie(){
        if(!luck || (luck.phase !== "playing" && luck.phase !== "tiebreak")) return;
        if(!luckDie3d){ luckSetupDie3D(); }
        if(!luck.lastRoll) return;
        if(luck.lastRoll.nonce === luck.animatedNonce) return; // schon animiert
        luck.animatedNonce = luck.lastRoll.nonce;
        const seat = luck.lastRoll.seat, value = luck.lastRoll.value, wasBust = !!luck.lastRoll.bust;
        luck.rolling = true; renderLuckGame();
        // Nach der Animation: rolling aus. Bei Nicht-Bust setzt derselbe Spieler fort →
        // locked lösen. Bei Bust endet der Zug → gesperrt bis zum Zugwechsel (advance).
        const finish = () => {
          if(!luck) return;
          luck.rolling = false;
          if(!wasBust) luck.locked = false;
          renderLuckGame();
        };
        if(luckDie3d && dice3dMod){
          if(luck.dieOwner !== seat){
            const faces = luck.players[seat] && luck.players[seat].skinFaces;
            dice3dMod.updateDieSkin(luckDie3d, faces ? { dieType: luck.dieType, faces } : null);
            luck.dieOwner = seat;
          }
          diceRollStart();
          dice3dMod.rollDie3D(luckDie3d, value, () => { wasBust ? diceLose() : diceLand(); setTimeout(finish, 120); });
        } else {
          setTimeout(finish, 400);
        }
      }
      function renderLuckSetup(){
        const dieRow = document.getElementById("luckDieRow");
        const playerRow = document.getElementById("luckPlayerRow");
        const btn = document.getElementById("luckSearchBtn");
        const hint = document.getElementById("luckIdleHint");
        const statusEl = document.getElementById("luckIdleStatus");
        if(dieRow){
          while(dieRow.firstChild) dieRow.removeChild(dieRow.firstChild);
          const ownedLuckDice = LUCK_DICE.filter(d => ownsDie(d));
          if(ownedLuckDice.length && !ownedLuckDice.includes(luckSetupDie)) luckSetupDie = ownedLuckDice[0];
          for(const id of LUCK_DICE){
            const owned = ownsDie(id);
            const b = document.createElement("button");
            b.type = "button";
            b.className = "luckDieBtn" + (id === luckSetupDie ? " active" : "") + (owned ? "" : " locked");
            b.dataset.dieId = id;
            b.disabled = !owned;
            b.textContent = DICE_LABELS[id];
            if(!owned) b.title = "Erst im Würfel-Shop freischalten";
            dieRow.appendChild(b);
          }
        }
        if(playerRow){
          [...playerRow.querySelectorAll(".luckPlayerBtn")].forEach(b => {
            b.classList.toggle("active", Number(b.dataset.players) === luckSetupPlayers);
          });
        }
        const hasDie = ownsDie(luckSetupDie);
        const enough = (state.points || 0) >= LUCK_COST;
        const needMin = luckPlaytimeMin(luckSetupPlayers);
        const enoughTime = (state.arcadeTimeSec || 0) >= needMin * 60;
        if(btn) btn.disabled = !sb || !hasDie || !enough || !enoughTime;
        if(statusEl) statusEl.textContent = luckIdleMsg;
        if(hint){
          if(!sb) hint.textContent = "Online-Spiele sind gerade nicht verfügbar.";
          else if(!LUCK_DICE.some(d => ownsDie(d))) hint.textContent = "🔒 Du brauchst mindestens den W6 — schalte ihn im Würfel-Shop frei.";
          else if(!hasDie) hint.textContent = "🔒 Diesen Würfel hast du noch nicht freigeschaltet.";
          else if(!enough) hint.textContent = "Nicht genug Punkte — du brauchst mindestens " + LUCK_COST + ".";
          else if(!enoughTime) hint.textContent = "Nicht genug Spielzeit — du brauchst " + needMin + " Min (für " + luckSetupPlayers + " Spieler).";
          else hint.textContent = "Kosten: " + needMin + " Min Spielzeit + " + LUCK_COST + " Punkte. Dein " + DICE_LABELS[luckSetupDie] + "-Skin wird angezeigt.";
        }
      }
      function renderLuckView(){
        const setup = document.getElementById("luckSetup");
        const queue = document.getElementById("luckQueue");
        const game = document.getElementById("luckGame");
        const result = document.getElementById("luckResult");
        if(!setup) return;
        const phase = luck ? luck.phase : "setup";
        setup.style.display = phase === "setup" ? "" : "none";
        queue.style.display = (phase === "queue" || phase === "starting") ? "" : "none";
        game.style.display = (phase === "playing" || phase === "tiebreak") ? "" : "none";
        result.style.display = phase === "done" ? "" : "none";
        if(phase === "setup"){ renderLuckSetup(); return; }
        if(phase === "queue" || phase === "starting"){
          const txt = document.getElementById("luckQueueText");
          const cnt = document.getElementById("luckQueueCount");
          if(txt) txt.textContent = phase === "starting" ? "Mitspieler gefunden — Spiel startet…" : "Suche Mitspieler…";
          if(cnt) cnt.textContent = phase === "starting" ? "" :
            (DICE_LABELS[luck.dieType] + " · " + Math.min(luck.queueCount || 1, luck.playerCount) + " / " + luck.playerCount + " bereit");
          return;
        }
        if(phase === "playing" || phase === "tiebreak"){ renderLuckGame(); return; }
        if(phase === "done"){ renderLuckResult(); return; }
      }
      function renderLuckGame(){
        if(!luck) return;
        const roundBadge = document.getElementById("luckRoundBadge");
        const turnBadge = document.getElementById("luckTurnBadge");
        const board = document.getElementById("luckScoreboard");
        const curSumEl = document.getElementById("luckCurSum");
        const rolledList = document.getElementById("luckRolledList");
        const rollBtn = document.getElementById("luckRollBtn");
        const safeBtn = document.getElementById("luckSafeBtn");
        const logEl = document.getElementById("luckLog");
        const isTb = luck.phase === "tiebreak";
        if(roundBadge) roundBadge.textContent = isTb ? ("Stechen " + (luck.tbRounds || 1)) : ("Runde " + luck.round + " / " + LUCK_ROUNDS);
        const myTurn = luck.turnSeat === luck.mySeat && luck.phase === "playing" && !luck.left[luck.mySeat];
        const busy = luck.rolling || (luck.locked && luck.turnSeat === luck.mySeat);
        if(turnBadge){
          const name = luck.players[luck.turnSeat] ? luck.players[luck.turnSeat].name : "";
          turnBadge.textContent = isTb ? "Stechen läuft…"
            : busy ? ("🎲 " + (luck.turnSeat === luck.mySeat ? "Dein Wurf" : name + " würfelt") + "…")
            : (myTurn ? "Du bist dran!" : name + " ist dran…");
          turnBadge.classList.toggle("mine", myTurn && !busy);
        }
        if(board){
          while(board.firstChild) board.removeChild(board.firstChild);
          luck.players.forEach(p => {
            const s = p.seat;
            const done = !isTb && luck.roundDone && luck.roundDone[s];
            const row = document.createElement("div");
            row.className = "luckPlayerCard" + (s === luck.turnSeat && !done ? " active" : "") + (s === luck.mySeat ? " me" : "") + (luck.left[s] ? " left" : "") + (done ? " done" : "");
            const dot = document.createElement("span"); dot.className = "luckSeatDot"; dot.style.background = LUCK_SEAT_COLORS[s % 4];
            const nm = document.createElement("span"); nm.className = "luckPlayerName"; nm.textContent = p.name + (s === luck.mySeat ? " (Du)" : "");
            // Ungesicherte Rundenpunkte (nur solange der Spieler in der Runde aktiv ist).
            if(!isTb){
              const rs = (luck.roundSums && luck.roundSums[s]) || 0;
              const open = document.createElement("span"); open.className = "luckPlayerOpen";
              open.textContent = luck.left[s] ? "" : (done ? "✓" : (rs > 0 ? "+" + rs : "—"));
              row.appendChild(dot); row.appendChild(nm); row.appendChild(open);
            } else {
              row.appendChild(dot); row.appendChild(nm);
            }
            const tot = document.createElement("span"); tot.className = "luckPlayerTotal"; tot.textContent = String(luck.totals[s]);
            row.appendChild(tot);
            if(isTb){ const tb = document.createElement("span"); tb.className = "luckPlayerTb"; tb.textContent = "🎲" + luck.tbTally[s]; row.appendChild(tb); }
            board.appendChild(row);
          });
        }
        // luckCurSum/RolledList zeigen den gerade aktiven Spieler (Reihum-Modell).
        const actSeat = luck.turnSeat;
        const actSum = (luck.roundSums && luck.roundSums[actSeat]) || 0;
        const actRolls = (luck.roundRolls && luck.roundRolls[actSeat]) || [];
        if(curSumEl) curSumEl.textContent = String(actSum);
        if(rolledList){
          while(rolledList.firstChild) rolledList.removeChild(rolledList.firstChild);
          actRolls.forEach(v => { const c = document.createElement("span"); c.className = "luckRollChip"; c.textContent = v; rolledList.appendChild(c); });
        }
        const canAct = luckCanAct();
        if(rollBtn) rollBtn.disabled = !canAct;
        // Sichern ist im Reihum-Modell auch mit 0 ungesicherten Punkten erlaubt (Runde abgeben).
        if(safeBtn){ safeBtn.disabled = !canAct; }
        luckRenderTimer();
        if(logEl) logEl.textContent = luck.log || "";
      }
      // Countdown-Anzeige (Restsekunden des aktuellen Zugs) auf allen Clients.
      function luckRenderTimer(){
        const el = document.getElementById("luckTimer");
        if(!el) return;
        if(!luck || luck.phase !== "playing" || !luck.turnStartedAt){ el.textContent = ""; el.className = "luckTimer"; return; }
        const remain = Math.max(0, LUCK_TURN_SEC - (Date.now() - luck.turnStartedAt) / 1000);
        const secs = Math.ceil(remain);
        const myTurn = luck.turnSeat === luck.mySeat && !luck.left[luck.mySeat] && !luck.roundDone[luck.mySeat];
        el.textContent = "⏱ " + secs + "s";
        el.className = "luckTimer" + (myTurn ? " mine" : "") + (remain <= 3 ? " warn" : "");
      }
      function renderLuckResult(){
        if(!luck || !luck.result) return;
        const icon = document.getElementById("luckResultIcon");
        const title = document.getElementById("luckResultTitle");
        const sub = document.getElementById("luckResultSub");
        const board = document.getElementById("luckResultBoard");
        const myRank = luck.result.ranking.indexOf(luck.mySeat);
        const myPay = luck.result.payouts[luck.mySeat] || 0;
        const net = myPay - LUCK_COST;
        if(icon) icon.textContent = myRank === 0 ? "🏆" : (net >= 0 ? "🙂" : "💀");
        if(title) title.textContent = myRank === 0 ? "Gewonnen!" : ("Platz " + (myRank + 1) + " von " + luck.playerCount);
        if(sub) sub.textContent = (net > 0 ? "+" + net : net) + " Punkte (Auszahlung " + myPay + " − Einsatz " + LUCK_COST + "). Stand: " + (state.points || 0) + ".";
        if(board){
          while(board.firstChild) board.removeChild(board.firstChild);
          luck.result.ranking.forEach((seat, rank) => {
            const p = luck.players[seat];
            const row = document.createElement("div");
            row.className = "luckResultRow" + (seat === luck.mySeat ? " me" : "");
            const pos = document.createElement("span"); pos.className = "luckResultPos"; pos.textContent = (rank + 1) + ".";
            const dot = document.createElement("span"); dot.className = "luckSeatDot"; dot.style.background = LUCK_SEAT_COLORS[seat % 4];
            const nm = document.createElement("span"); nm.className = "luckResultName"; nm.textContent = p.name + (seat === luck.mySeat ? " (Du)" : "");
            const tot = document.createElement("span"); tot.className = "luckResultTotal"; tot.textContent = luck.totals[seat] + " Pkt";
            const pay = document.createElement("span"); pay.className = "luckResultPay"; const pnet = (luck.result.payouts[seat] || 0) - LUCK_COST;
            pay.textContent = (pnet > 0 ? "+" + pnet : pnet); pay.classList.add(pnet > 0 ? "pos" : (pnet < 0 ? "neg" : "zero"));
            row.appendChild(pos); row.appendChild(dot); row.appendChild(nm); row.appendChild(tot); row.appendChild(pay);
            board.appendChild(row);
          });
        }
      }
      function bindLuckEvents(){
        const dieRow = document.getElementById("luckDieRow");
        if(dieRow) dieRow.addEventListener("click", (e) => {
          const b = e.target.closest(".luckDieBtn"); if(!b || b.disabled) return;
          luckSetupDie = b.dataset.dieId; uiSoftClick(); renderLuckSetup();
        });
        const playerRow = document.getElementById("luckPlayerRow");
        if(playerRow) playerRow.addEventListener("click", (e) => {
          const b = e.target.closest(".luckPlayerBtn"); if(!b) return;
          luckSetupPlayers = Math.min(LUCK_MAX_PLAYERS, Math.max(LUCK_MIN_PLAYERS, Number(b.dataset.players) || 2));
          uiSoftClick(); renderLuckSetup();
        });
        const search = document.getElementById("luckSearchBtn");
        if(search) search.addEventListener("click", () => { uiSoftClick(); luckJoinQueue(); });
        const cancel = document.getElementById("luckCancelBtn");
        if(cancel) cancel.addEventListener("click", () => { uiSoftClick(); luckCancelSearch(); });
        const rollBtn = document.getElementById("luckRollBtn");
        if(rollBtn) rollBtn.addEventListener("click", luckRoll);
        const safeBtn = document.getElementById("luckSafeBtn");
        if(safeBtn) safeBtn.addEventListener("click", luckSafe);
        const forfeit = document.getElementById("luckForfeitBtn");
        if(forfeit) forfeit.addEventListener("click", () => { uiSoftClick(); luckForfeit(); });
        const resultBack = document.getElementById("luckResultBackBtn");
        if(resultBack) resultBack.addEventListener("click", () => { uiSoftClick(); luckTeardown(); showArcadeGame("menu"); });
      }

      // ════════════════════════════════════════════════════════════
      //   LOOTBOX + SKIN-SAMMLUNG  (Shop-View, unterhalb des Kauf-Grids)
      // ════════════════════════════════════════════════════════════
      let selectedLootType = "d4";     // gewählter Würfeltyp für die nächste Lootbox
      let skinFilter = "all";          // Sammlung: "all" | "d4" … "d20"
      let skinSort = "new";            // Sortierung: "new" | "old" | "rareFirst" | "commonFirst"
      let pendingDeleteSkinId = null;  // Skin, der im Lösch-Dialog bestätigt werden soll
      let pendingLootboxSkin = null;   // Skin der gerade geöffneten Lootbox
      let lootboxRevealTimer = null;
      let lootboxDie3d = null;         // 3D-Würfel im Reveal-Step

      function renderLootboxSection(){
        ensureDiceState(); ensureSkinState();
        const typeRow = document.getElementById("lootboxTypeRow");
        const openBtn = document.getElementById("lootboxOpenBtn");
        const ptsEl = document.getElementById("lootboxPoints");
        const countEl = document.getElementById("lootboxSkinCount");
        const hintEl = document.getElementById("lootboxHint");
        if(!typeRow || !openBtn) return;
        if(ptsEl) ptsEl.textContent = String(state.points || 0);
        if(countEl) countEl.textContent = state.diceSkins.owned.length + " / " + MAX_SKINS;
        // Typ-Auswahl: nur freigeschaltete Würfel
        if(!ownsDie(selectedLootType)) selectedLootType = state.dice.owned[0] || "d4";
        while(typeRow.firstChild) typeRow.removeChild(typeRow.firstChild);
        for(const id of DICE_TYPES){
          if(!ownsDie(id)) continue;
          const b = document.createElement("button");
          b.type = "button";
          b.className = "lootTypePill" + (id === selectedLootType ? " active" : "");
          b.dataset.action = "lootType";
          b.dataset.dieId = id;
          b.setAttribute("aria-pressed", id === selectedLootType ? "true" : "false");
          b.textContent = DICE_LABELS[id];
          typeRow.appendChild(b);
        }
        const full = state.diceSkins.owned.length >= MAX_SKINS;
        const broke = (state.points || 0) < LOOTBOX_PRICE;
        openBtn.disabled = full || broke;
        openBtn.textContent = "🎁 Skin ziehen — " + LOOTBOX_PRICE + " Punkte";
        if(hintEl){
          if(full) hintEl.textContent = "Deine Sammlung ist voll (" + MAX_SKINS + " Skins). Es können keine weiteren Skins gezogen werden.";
          else if(broke) hintEl.textContent = "Nicht genug Punkte — du brauchst mindestens " + LOOTBOX_PRICE + ".";
          else hintEl.textContent = "Der Skin gilt für den gewählten Würfeltyp: " + (DICE_LABELS[selectedLootType] || "W4") + ".";
        }
      }

      function openLootbox(dieType){
        ensureDiceState(); ensureSkinState();
        if(!ownsDie(dieType)){ uiError(); return; }
        if((state.points || 0) < LOOTBOX_PRICE){ uiError(); renderLootboxSection(); return; }
        if(state.diceSkins.owned.length >= MAX_SKINS){ uiError(); renderLootboxSection(); return; }
        state.points -= LOOTBOX_PRICE;
        const skin = generateSkin(dieType);
        addSkinToCollection(skin); // persistiert sofort — der Skin kann nicht verloren gehen
        pendingLootboxSkin = skin;
        updatePointsDisplay();
        renderLootboxSection();
        // Modal: Schritt 1 (Öffnen-Animation), dann Reveal
        const modal = document.getElementById("lootboxModal");
        const stepOpen = document.getElementById("lootboxStepOpening");
        const stepReveal = document.getElementById("lootboxStepReveal");
        const box = document.getElementById("lootboxBox");
        if(!modal || !stepOpen || !stepReveal) return;
        stepOpen.style.display = "";
        stepReveal.style.display = "none";
        if(box){ box.classList.remove("anim"); void box.offsetWidth; box.classList.add("anim"); }
        modal.classList.add("show");
        modal.setAttribute("aria-hidden", "false");
        rewardRollStart();
        if(lootboxRevealTimer) clearTimeout(lootboxRevealTimer);
        lootboxRevealTimer = setTimeout(() => showLootboxReveal(skin), 1500);
      }

      function showLootboxReveal(skin){
        lootboxRevealTimer = null;
        const modal = document.getElementById("lootboxModal");
        if(!modal || !modal.classList.contains("show")) return;
        const stepOpen = document.getElementById("lootboxStepOpening");
        const stepReveal = document.getElementById("lootboxStepReveal");
        const titleEl = document.getElementById("lootboxRevealTitle");
        const rarityEl = document.getElementById("lootboxRarity");
        const codeEl = document.getElementById("lootboxCode");
        const descEl = document.getElementById("lootboxDesc");
        const probEl = document.getElementById("lootboxProb");
        const dieWrap = document.getElementById("lootboxDie3d");
        if(stepOpen) stepOpen.style.display = "none";
        if(stepReveal) stepReveal.style.display = "";
        const rarity = skinRarity(skin);
        if(titleEl) titleEl.textContent = (DICE_LABELS[skin.dieType] || skin.dieType) + "-Skin erhalten!";
        if(rarityEl){
          rarityEl.textContent = rarity.label;
          rarityEl.className = "lootboxRarity rarity-" + rarity.key;
        }
        if(codeEl) codeEl.textContent = skinCode(skin);
        if(descEl) descEl.textContent = skinDescription(skin);
        if(probEl){
          const prob = skinCompositionProbability(skin);
          const fmt = formatSkinProbability(prob);
          const tier = skinProbTier(prob);
          probEl.innerHTML =
            'Wahrscheinlichkeit: <strong>' + fmt.pctStr + '</strong> · ' + fmt.oneInStr +
            ' <span class="probTier ' + tier.key + '">' + tier.label + '</span>';
        }
        diceLand();
        // 3D-Würfel mit dem neuen Skin: schnelle Rotation, die ausläuft (wie ein echter Wurf)
        if(dieWrap){
          dieWrap.textContent = "";
          loadDice3D().then(mod => {
            if(!mod){ renderSkinSwatchFallback(dieWrap, skin); return; }
            if(!modal.classList.contains("show") || pendingLootboxSkin !== skin) return;
            if(lootboxDie3d){ lootboxDie3d.cleanup(); lootboxDie3d = null; }
            const die = mod.createDie3D(dieWrap, skin.dieType, skin, { size: 280 });
            if(!die){ renderSkinSwatchFallback(dieWrap, skin); return; }
            lootboxDie3d = die;
            const sides = DICE_SIDES[skin.dieType] || 4;
            mod.rollDie3D(die, 1 + Math.floor(Math.random() * sides), () => {
              die.autoRotate = true;
              die.autoRotateSpeed = 0.006;
            });
          });
        }
      }
      // 2D-Fallback im Reveal (kein WebGL/CDN): Farbfelder pro Seite.
      function renderSkinSwatchFallback(wrap, skin){
        wrap.textContent = "";
        const row = document.createElement("div");
        row.className = "skinSwatchRow";
        skin.faces.forEach((color, i) => {
          const sw = document.createElement("span");
          sw.className = "skinSwatch skinColor-" + color;
          sw.title = "Seite " + (i + 1) + ": " + (SKIN_COLOR_NAMES_DE[color] || color);
          sw.textContent = String(i + 1);
          row.appendChild(sw);
        });
        wrap.appendChild(row);
      }
      function closeLootboxModal(){
        const modal = document.getElementById("lootboxModal");
        if(modal){
          modal.classList.remove("show");
          modal.setAttribute("aria-hidden", "true");
        }
        if(lootboxRevealTimer){ clearTimeout(lootboxRevealTimer); lootboxRevealTimer = null; }
        if(lootboxDie3d){ lootboxDie3d.cleanup(); lootboxDie3d = null; }
        const dieWrap = document.getElementById("lootboxDie3d");
        if(dieWrap) dieWrap.textContent = "";
        pendingLootboxSkin = null;
        diceClose();
        renderLootboxSection();
        renderSkinCollection();
      }
      function bindLootboxEvents(){
        const modal = document.getElementById("lootboxModal");
        const activateBtn = document.getElementById("lootboxActivateBtn");
        const keepBtn = document.getElementById("lootboxKeepBtn");
        if(activateBtn) activateBtn.addEventListener("click", () => {
          if(pendingLootboxSkin){
            setActiveSkin(pendingLootboxSkin.dieType, pendingLootboxSkin.id);
            uiSave();
          }
          closeLootboxModal();
        });
        if(keepBtn) keepBtn.addEventListener("click", () => { uiSoftClick(); closeLootboxModal(); });
        if(modal) modal.addEventListener("click", (e) => {
          // Backdrop-Klick schließt nur im Reveal-Step (nicht mitten in der Öffnen-Animation)
          if(e.target === modal && !lootboxRevealTimer) closeLootboxModal();
        });
        // Sortier-Dropdown der Sammlung
        const sortSel = document.getElementById("skinSortSelect");
        if(sortSel) sortSel.addEventListener("change", () => {
          skinSort = sortSel.value;
          uiSoftClick();
          renderSkinCollection();
        });
        // Info-Index "Wie selten ist ein Skin?": Hover via CSS, Klick-Toggle für Touch.
        const infoWrap = document.querySelector(".skinInfoWrap");
        const infoBtn = document.getElementById("skinInfoBtn");
        if(infoWrap && infoBtn){
          infoBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            infoWrap.classList.toggle("open");
          });
          document.addEventListener("click", (e) => {
            if(!infoWrap.classList.contains("open")) return;
            if(!infoWrap.contains(e.target)) infoWrap.classList.remove("open");
          }, { passive: true });
        }
      }

      // ── Skin-Sammlung ("Meine Skins") ──
      let skinPreviewInstances = [];           // aktive 3D-Previews (für cleanup)
      // Previews werden LAZY erzeugt, erst wenn die Karte in den Viewport scrollt —
      // 200 Karten × 3D-Szene sofort zu bauen wäre unnötig teuer. Die Sichtbarkeits-
      // Prüfung läuft über Scroll/Resize + getBoundingClientRect (bewusst KEIN
      // IntersectionObserver: der feuert in manchen Embedded-/Preview-Browsern nicht).
      let pendingSkinPreviewHolders = [];
      let skinPreviewCheckQueued = false;
      function queueSkinPreviewCheck(){
        if(skinPreviewCheckQueued) return;
        skinPreviewCheckQueued = true;
        requestAnimationFrame(() => {
          skinPreviewCheckQueued = false;
          ensureSkinPreviewsVisible();
        });
      }
      function ensureSkinPreviewsVisible(){
        if(pendingSkinPreviewHolders.length === 0) return;
        const margin = 160;
        const vh = window.innerHeight + margin;
        const still = [];
        for(const holder of pendingSkinPreviewHolders){
          if(!holder.isConnected) continue;
          const r = holder.getBoundingClientRect();
          const inView = r.width > 0 && r.bottom > -margin && r.top < vh;
          if(!inView){ still.push(holder); continue; }
          const skin = holder.__skin;
          if(!skin) continue;
          loadDice3D().then(mod => {
            if(!holder.isConnected || holder.childNodes.length > 0) return;
            if(!mod){ renderSkinSwatchFallback(holder, skin); return; }
            const die = mod.createDie3D(holder, skin.dieType, skin, {
              size: 120, autoRotate: true, autoRotateSpeed: 0.008, textureSize: 64,
            });
            if(!die){ renderSkinSwatchFallback(holder, skin); return; }
            skinPreviewInstances.push(die);
          });
        }
        pendingSkinPreviewHolders = still;
      }
      window.addEventListener("scroll", queueSkinPreviewCheck, { passive: true });
      window.addEventListener("resize", queueSkinPreviewCheck, { passive: true });
      function teardownSkinPreviews(){
        for(const die of skinPreviewInstances) die.cleanup();
        skinPreviewInstances = [];
        pendingSkinPreviewHolders = [];
      }
      function renderSkinCollection(){
        ensureDiceState(); ensureSkinState();
        const wrap = document.getElementById("skinCollection");
        const emptyEl = document.getElementById("skinCollectionEmpty");
        const filterRow = document.getElementById("skinFilterRow");
        if(!wrap) return;
        teardownSkinPreviews();
        while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
        const owned = state.diceSkins.owned;
        // Filter-Pills: "Alle" + jeder Typ, für den Skins existieren
        if(filterRow){
          while(filterRow.firstChild) filterRow.removeChild(filterRow.firstChild);
          const typesPresent = DICE_TYPES.filter(t => owned.some(s => s.dieType === t));
          if(skinFilter !== "all" && !typesPresent.includes(skinFilter)) skinFilter = "all";
          const mkPill = (value, label) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "skinFilterPill" + (skinFilter === value ? " active" : "");
            b.dataset.action = "skinFilter";
            b.dataset.filter = value;
            b.textContent = label;
            filterRow.appendChild(b);
          };
          if(typesPresent.length > 0){
            mkPill("all", "Alle");
            for(const t of typesPresent) mkPill(t, DICE_LABELS[t]);
          }
        }
        // Sortier-Dropdown auf den aktuellen Zustand spiegeln
        const sortSel = document.getElementById("skinSortSelect");
        if(sortSel && sortSel.value !== skinSort) sortSel.value = skinSort;
        // Filtern + nach gewähltem Kriterium sortieren. Die Wahrscheinlichkeit wird einmal
        // pro Skin berechnet und mitgeführt (kein Neuberechnen im Vergleich).
        const visible = owned
          .filter(s => skinFilter === "all" || s.dieType === skinFilter)
          .map(s => ({ s, prob: skinCompositionProbability(s), pulledAt: s.pulledAt || 0 }))
          .sort((a, b) => {
            switch(skinSort){
              case "old":         return a.pulledAt - b.pulledAt;
              case "rareFirst":   return (a.prob - b.prob) || (b.pulledAt - a.pulledAt);   // unwahrscheinlichste zuerst
              case "commonFirst": return (b.prob - a.prob) || (b.pulledAt - a.pulledAt);   // wahrscheinlichste zuerst
              case "new":
              default:            return b.pulledAt - a.pulledAt;
            }
          })
          .map(x => x.s);
        if(emptyEl) emptyEl.style.display = owned.length === 0 ? "block" : "none";
        for(const skin of visible){
          const rarity = skinRarity(skin);
          const isActive = state.diceSkins.active[skin.dieType] === skin.id;
          const card = document.createElement("div");
          card.className = "skinCard rarity-" + rarity.key + (isActive ? " active" : "");
          const preview = document.createElement("div");
          preview.className = "skinCardPreview";
          preview.__skin = skin;
          pendingSkinPreviewHolders.push(preview);
          const head = document.createElement("div");
          head.className = "skinCardHead";
          const typeLbl = document.createElement("span");
          typeLbl.className = "skinCardType";
          typeLbl.textContent = DICE_LABELS[skin.dieType] || skin.dieType;
          const rarityLbl = document.createElement("span");
          rarityLbl.className = "skinCardRarity rarity-" + rarity.key;
          rarityLbl.textContent = rarity.label;
          head.appendChild(typeLbl);
          head.appendChild(rarityLbl);
          const codeEl = document.createElement("div");
          codeEl.className = "skinCardCode";
          codeEl.textContent = skinCode(skin);
          codeEl.title = "Skin-Name / Code";
          const desc = document.createElement("div");
          desc.className = "skinCardDesc";
          desc.textContent = skinDescription(skin);
          const prob = skinCompositionProbability(skin);
          const fmt = formatSkinProbability(prob);
          const tier = skinProbTier(prob);
          const probEl = document.createElement("div");
          probEl.className = "skinCardProb";
          probEl.title = "Wahrscheinlichkeit dieser Farb-Zusammensetzung: " + fmt.oneInStr;
          probEl.innerHTML = '<strong>' + fmt.pctStr + '</strong> <span class="probTier ' +
            tier.key + '">' + tier.label + '</span>';
          const actions = document.createElement("div");
          actions.className = "skinCardActions";
          if(isActive){
            const badge = document.createElement("span");
            badge.className = "skinActiveBadge";
            badge.textContent = "✓ Aktiv";
            actions.appendChild(badge);
            const offBtn = document.createElement("button");
            offBtn.type = "button";
            offBtn.className = "skinActivateBtn";
            offBtn.dataset.action = "skinDeactivate";
            offBtn.dataset.skinId = skin.id;
            offBtn.textContent = "Deaktivieren";
            actions.appendChild(offBtn);
          } else {
            const onBtn = document.createElement("button");
            onBtn.type = "button";
            onBtn.className = "skinActivateBtn primary";
            onBtn.dataset.action = "skinActivate";
            onBtn.dataset.skinId = skin.id;
            onBtn.textContent = "Aktivieren";
            actions.appendChild(onBtn);
          }
          // Löschen: entfernt den Skin und gibt einen Würfelwurf zurück (Platz im 200er-Limit schaffen)
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "skinDeleteBtn";
          delBtn.dataset.action = "skinDelete";
          delBtn.dataset.skinId = skin.id;
          delBtn.title = "Skin löschen (gibt einen Würfelwurf zurück)";
          delBtn.textContent = "🗑 Löschen";
          actions.appendChild(delBtn);
          card.appendChild(preview);
          card.appendChild(head);
          card.appendChild(codeEl);
          card.appendChild(desc);
          card.appendChild(probEl);
          card.appendChild(actions);
          wrap.appendChild(card);
        }
        // Initiale Sichtbarkeits-Prüfung (lädt die 3D-Previews der sichtbaren Karten)
        queueSkinPreviewCheck();
      }
      // ── Skin löschen: Bestätigungs-Dialog ──
      function openSkinDeleteConfirm(skinId){
        ensureSkinState();
        const skin = state.diceSkins.owned.find(s => s.id === skinId);
        if(!skin){ uiError(); return; }
        pendingDeleteSkinId = skinId;
        const infoEl = document.getElementById("skinDeleteInfo");
        if(infoEl){
          const rarity = skinRarity(skin);
          infoEl.innerHTML =
            '<span class="skinDeleteType">' + (DICE_LABELS[skin.dieType] || skin.dieType) + '</span> ' +
            '<span class="skinDeleteCode">' + skinCode(skin) + '</span> ' +
            '<span class="skinCardRarity rarity-' + rarity.key + '">' + rarity.label + '</span>';
        }
        const modal = document.getElementById("skinDeleteModal");
        if(modal){
          modal.classList.add("show");
          modal.setAttribute("aria-hidden", "false");
        }
        uiSoftClick();
      }
      function closeSkinDeleteConfirm(){
        pendingDeleteSkinId = null;
        const modal = document.getElementById("skinDeleteModal");
        if(modal){
          modal.classList.remove("show");
          modal.setAttribute("aria-hidden", "true");
        }
      }
      function confirmSkinDelete(){
        const id = pendingDeleteSkinId;
        closeSkinDeleteConfirm();
        if(!id) return;
        if(deleteSkinFromCollection(id)){
          uiSave();
          updateRewardBadge(true);
          renderLootboxSection();   // Skin-Zähler aktualisieren
          renderSkinCollection();
        } else {
          uiError();
        }
      }
      function bindSkinDeleteEvents(){
        const cancel = document.getElementById("skinDeleteCancel");
        const confirm = document.getElementById("skinDeleteConfirm");
        const modal = document.getElementById("skinDeleteModal");
        if(cancel) cancel.addEventListener("click", () => { uiSoftClick(); closeSkinDeleteConfirm(); });
        if(confirm) confirm.addEventListener("click", confirmSkinDelete);
        if(modal) modal.addEventListener("click", (e) => { if(e.target === modal) closeSkinDeleteConfirm(); });
      }

      function openChoiceModal(modal){ diceGameClick(); modal.classList.add("show"); modal.setAttribute("aria-hidden", "false"); if(modal === dom.exactModal) renderExactOptions(); }
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
        const sides = casinoDieSides();
        // Ergebnis VOR der Animation würfeln — der 3D-Wurf landet exakt darauf.
        const result = Math.floor(Math.random() * sides) + 1;
        if(casinoDie3d && dice3dMod){
          // 3D-Pfad: Tick-Sounds während der 1.2-Sek-Roll-Animation
          const tickInterval = setInterval(diceTickRoll, 110);
          dice3dMod.rollDie3D(casinoDie3d, result, () => {
            clearInterval(tickInterval);
            diceLand();
            setTimeout(() => resolveDiceGame(result, bet), 150);
          });
          return;
        }
        // 2D-Fallback (kein WebGL / Three.js nicht geladen)
        dom.gameDie.classList.remove("rolling");
        void dom.gameDie.offsetWidth;
        dom.gameDie.classList.add("rolling");
        // Strip the rolling class after the keyframe finishes (see comment in rollRewardDice).
        setTimeout(() => dom.gameDie.classList.remove("rolling"), 850);

        let count = 0;
        const interval = setInterval(() => {
          showDiceFace(dom.gameDie, Math.floor(Math.random() * sides) + 1, sides);
          diceTickRoll();
          count++;
          if(count >= 10){
            clearInterval(interval);
            showDiceFace(dom.gameDie, result, sides);
            setTimeout(() => {
              diceLand();
              setTimeout(() => resolveDiceGame(result, bet), 150);
            }, 80);
          }
        }, 80);
      }
      // Löst den Einsatz auf (Gewinn/Verlust, Streak, Game-Over). Wird vom 3D-
      // UND vom 2D-Fallback-Pfad aufgerufen, nachdem der Würfel gelandet ist.
      function resolveDiceGame(result, bet){
                let won = false;
                if(diceGameMode === "exact"){
                  won = (result === diceSelection);
                }else{
                  const isEven = result % 2 === 0;
                  won = (diceSelection === "even" && isEven) || (diceSelection === "odd" && !isEven);
                }
                // Restore odd/even highlight visually (2D-Div + 3D-Container)
                if(diceGameMode === "oe"){
                  if(diceSelection === "even") setDiceHighlight("evenHl");
                  else if(diceSelection === "odd") setDiceHighlight("oddHl");
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

        // Event delegation for dice options (1..sides) — generated dynamically
        dom.exactModal.addEventListener("click", (e) => {
          const btn = e.target.closest(".diceOption");
          if(!btn) return;
          diceSelection = Number(btn.dataset.value);
          diceSelect();
          dom.guessLabel.textContent = "Gewählt:";
          // Use dice-face glyph for 1-6, plain number otherwise
          const glyph = (diceSelection >= 1 && diceSelection <= 6) ? "⚀⚁⚂⚃⚄⚅".charAt(diceSelection - 1) : "";
          dom.guessValue.textContent = (glyph ? glyph + " " : "") + "(" + diceSelection + ")";
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
            setDiceHighlight("evenHl");
          }else{
            dom.guessLabel.textContent = "Gewählt:";
            dom.guessValue.textContent = "Ungerade (1·3·5)";
            setDiceHighlight("oddHl");
          }
          closeChoiceModal(dom.oeModal);
          setDiceMessage("Tipp: " + (diceSelection === "even" ? "Gerade" : "Ungerade") + ". Einsatz eingeben.", "");
          dom.diceSmall.textContent = "Multiplikator bei Gewinn: ×" + getDiceMultiplier().toFixed(2);
        });
        dom.rollGameBtn.addEventListener("click", rollDiceGame);
        // Casino: tap a die label to switch the active casino die
        const dieSelector = document.getElementById("casinoDieSelector");
        if(dieSelector){
          dieSelector.addEventListener("click", (e) => {
            const btn = e.target.closest(".casinoDieBtn");
            if(!btn || !btn.dataset.dieId) return;
            if(diceRolling) return;
            if(setCasinoDie(btn.dataset.dieId)){
              diceSelection = null;  // selection no longer valid for new die's range
              if(dom.guessLabel) dom.guessLabel.textContent = "Kein Tipp";
              if(dom.guessValue) dom.guessValue.textContent = "";
              clearDiceHighlight();
              uiSoftClick();
              updateDiceGameUI();
              setDiceMessage("Würfel gewechselt: " + DICE_LABELS[btn.dataset.dieId] + ". Wähle einen neuen Tipp.", "");
            }
          });
        }
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
        if(typeof applyModeBodyClass === "function") applyModeBodyClass();
        // Sync mode-tab active state
        const tp = document.getElementById("modeTabPomodoro");
        const tf = document.getElementById("modeTabFlow");
        if(tp) tp.classList.toggle("active", isPomodoro());
        if(tf) tf.classList.toggle("active", isFlow());
        if(typeof renderVolumeUI === "function") renderVolumeUI();
        if(typeof renderThemeChoice === "function") renderThemeChoice();
        renderLegends(); updateSettingsView(); updateTimerUI(); drawTrack(); updateStats(); drawHeatmap();
        updateDiceGameUI();
        updateCompactStar();
        if(typeof renderAvatarsEverywhere === "function") renderAvatarsEverywhere();
        // initialize dice faces
        ensureDiceState();
        showDiceFace(dom.gameDie, 1, casinoDieSides());
        showDiceFace(dom.rewardDie, 1, activeDieSides());
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
        bindModeTabs();
        bindFlowPauseModal();
        bindLeaderboardEvents();
        bindLootboxEvents();
        bindSkinDeleteEvents();
        bindArcadeEvents();
        bindRaceEvents();
        bindLuckEvents();
        applyLoadedState();
        appBootstrapped = true;
      }
      // Re-render UI + resume timers based on current `state`. Called after cloud-load and after logout.
      function applyLoadedState(){
        // Stop anything that may still be running from a previous session
        workerStop(); diceTrackingStop(); stopAlarm();
        // Online-Spiele überleben keinen Login/Logout-Wechsel (Channels gehören zur Sitzung)
        if(typeof raceTeardown === "function" && race) raceTeardown();
        if(typeof luckTeardown === "function" && luck) luckTeardown();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        // Ensure at least one template exists; auto-create "Standard" from current settings if needed.
        ensureAtLeastOneTemplate();
        recomputeTotalSessions();
        reconcileSessionArrays();
        flowResetIfNewDay();   // wipe stale flow timer display from previous day
        lastSeenDay = todayISO();   // anchor the rollover watcher to the current study-day
        // ── v3: midnight rollover — sessionsDone/breaksDone/sessionIdx must reset on a new local day ──
        // If state was persisted yesterday with sessionIdx=5 and today's completedIntervals is empty
        // (or doesn't exist), we MUST start fresh at sessionIdx=0 — that's the "neuer Tag bei
        // Intervall 2" bug. updateDataFromToday() now uses completedIntervals[today], which is
        // empty/absent on a new day → n=0 → sessionsDone all false → sessionIdx=0.
        resolveActiveIntervalOnLoad();
        carryOverUnfinishedTasksToInbox(); // reload after midnight: rescue stranded tasks
        updateDataFromToday();
        updateSettingsView();
        renderTemplatesList();
        drawEverything();
        // Honor the URL hash if present (reload-preserves-tab); else default to Timer
        setTab(parseRoute(location.hash) || "timer", { fromHash: true });
        if(state.compact) toggleCompact(true); else toggleCompact(false);
        if(state.alarmActive) startAlarm();
        // Resume timers based on mode
        if(isFlow()){
          if(state.flow.running && (state.flow.phase === "learning" || state.flow.phase === "break")){
            startFlowAnchor();
            workerStart();
            if(state.flow.phase === "learning"){
              diceTrackingStart();
              requestWakeLock();
            }
          }
        } else if(state.running && state.phase !== "done"){
          startTickAnchor();
          workerStart();
          if(state.phase === "learning") diceTrackingStart();
        }
        if(dom.finishBox) dom.finishBox.style.display = state.phase === "done" ? "flex" : "none";
        setDiceMessage("Noch nicht gewürfelt.", "");
        if(dom.diceSmall) dom.diceSmall.textContent = "Wähle Modus, tippe eine Zahl und gib deinen Einsatz ein.";
      }

      // ── Volume slider (replaces the simple sound on/off button) ──
      const soundDom = {
        wrap:     document.getElementById("soundWrap"),
        btn:      document.getElementById("soundBtn"),
        popover:  document.getElementById("soundPopover"),
        slider:   document.getElementById("soundSlider"),
        valueLbl: document.getElementById("soundValue"),
      };
      function volumeIcon(v){
        if(!state.soundEnabled || v <= 0) return "🔇";
        if(v < 0.34) return "🔈";
        if(v < 0.67) return "🔉";
        return "🔊";
      }
      function renderVolumeUI(){
        const v = Number.isFinite(state.soundVolume) ? state.soundVolume : 1;
        if(soundDom.btn) soundDom.btn.textContent = volumeIcon(v);
        if(soundDom.slider) soundDom.slider.value = String(Math.round(v * 100));
        if(soundDom.valueLbl) soundDom.valueLbl.textContent = Math.round(v * 100) + "%";
      }
      let soundHideTimer = null;
      function showVolumePopover(){
        if(!soundDom.popover) return;
        if(soundHideTimer){ clearTimeout(soundHideTimer); soundHideTimer = null; }
        soundDom.popover.classList.add("show");
        soundDom.popover.setAttribute("aria-hidden", "false");
      }
      function hideVolumePopoverSoon(){
        if(!soundDom.popover) return;
        if(soundHideTimer) clearTimeout(soundHideTimer);
        soundHideTimer = setTimeout(() => {
          soundDom.popover.classList.remove("show");
          soundDom.popover.setAttribute("aria-hidden", "true");
        }, 220);
      }
      if(soundDom.wrap){
        // Pointer hover (desktop). Touch devices report pointerType="touch" and
        // we suppress hover-open there so a tap-toggle is the single source of truth.
        soundDom.wrap.addEventListener("pointerenter", (e) => {
          if(e.pointerType === "touch") return;
          showVolumePopover();
        });
        soundDom.wrap.addEventListener("pointerleave", (e) => {
          if(e.pointerType === "touch") return;
          hideVolumePopoverSoon();
        });
        soundDom.popover && soundDom.popover.addEventListener("pointerenter", (e) => {
          if(e.pointerType === "touch") return;
          showVolumePopover();
        });
        soundDom.popover && soundDom.popover.addEventListener("pointerleave", (e) => {
          if(e.pointerType === "touch") return;
          hideVolumePopoverSoon();
        });
        // Tap/click toggles (covers touch + keyboard activation)
        soundDom.btn && soundDom.btn.addEventListener("click", (e) => {
          e.stopPropagation();
          if(soundDom.popover.classList.contains("show")) hideVolumePopoverSoon();
          else showVolumePopover();
        });
        // Tap outside closes (touch users have no mouseleave)
        document.addEventListener("click", (e) => {
          if(!soundDom.popover || !soundDom.popover.classList.contains("show")) return;
          if(soundDom.wrap.contains(e.target)) return;
          hideVolumePopoverSoon();
        }, { passive: true });
      }
      if(soundDom.slider){
        soundDom.slider.addEventListener("input", () => {
          const v = Math.max(0, Math.min(1, (parseInt(soundDom.slider.value, 10) || 0) / 100));
          state.soundVolume = v;
          // soundEnabled tracks whether the user effectively wants sound. Volume 0 == muted.
          state.soundEnabled = v > 0;
          renderVolumeUI();
        });
        soundDom.slider.addEventListener("change", () => {
          // Persist only on commit (after the user releases the slider).
          renderVolumeUI();
          // Confirmation tick when ramping back up from mute (only if there's volume to hear it).
          if(state.soundEnabled && state.soundVolume > 0) uiSoftClick();
          persist();
        });
      }
      // ── Theme choice (in Profileinstellungen) ──
      const themeChoiceDom = {
        group: document.getElementById("themeChoice"),
        dark:  document.getElementById("themeChoiceDark"),
        light: document.getElementById("themeChoiceLight"),
      };
      function renderThemeChoice(){
        if(!themeChoiceDom.dark || !themeChoiceDom.light) return;
        themeChoiceDom.dark.classList.toggle("active",  state.theme === "dark");
        themeChoiceDom.light.classList.toggle("active", state.theme === "light");
      }
      function setTheme(name){
        if(name !== "dark" && name !== "light") return;
        if(state.theme === name) return;
        state.theme = name;
        uiToggle();
        drawEverything();
        renderThemeChoice();
        persist();
      }
      if(themeChoiceDom.dark)  themeChoiceDom.dark.addEventListener("click",  () => setTheme("dark"));
      if(themeChoiceDom.light) themeChoiceDom.light.addEventListener("click", () => setTheme("light"));

      // Tabs
      dom.tabs.forEach(btn => btn.addEventListener("click", () => { uiTabSwitch(); setTab(btn.dataset.tab); }));
      // Shop click handler (Buy / Activate)
      {
        const shopView = document.getElementById("shopView");
        if(shopView) shopView.addEventListener("click", shopHandleClick);
      }

      // Timer buttons — mode-aware
      dom.startBtn.addEventListener("click", () => {
        uiSoftClick();
        if(isFlow()) flowToggleRunning(); else startOrPause();
      });
      dom.skipBtn.addEventListener("click", () => {
        uiSoftClick();
        if(isFlow()){
          if(state.flow.phase === "break"){
            flowSkipBreak();
          } else if(state.flow.phase === "learning" && flowPauseWindowActive()){
            // Manual pause prompt (user-triggered inside the 30-sec window)
            openFlowPauseModal({ auto: false });
          }
        } else {
          skipPhase();
        }
      });
      // Prominent pause-choice button (Flow only, visible during 30-sec window)
      const _flowPauseChoiceBtn = document.getElementById("flowPauseChoiceBtn");
      if(_flowPauseChoiceBtn){
        _flowPauseChoiceBtn.addEventListener("click", () => {
          uiSoftClick();
          if(isFlow() && state.flow.phase === "learning" && flowPauseWindowActive()){
            openFlowPauseModal({ auto: false });
          }
        });
      }
      dom.resetBtn.addEventListener("click", () => {
        uiSoftClick();
        if(isFlow()) flowResetCurrentBlock(); else resetCurrentInterval();
      });
      dom.celebrateBtn.addEventListener("click", () => { uiSave(); celebrate(); });

      // Compact mode
      dom.compactOpen.addEventListener("click", () => { uiSoftClick(); toggleCompact(true); });
      dom.compactExit.addEventListener("click", () => { uiSoftClick(); toggleCompact(false); });
      dom.compactClose.addEventListener("click", () => { uiSoftClick(); toggleCompact(false); });
      dom.compactToggle.addEventListener("click", () => { uiSoftClick(); if(isFlow()) flowToggleRunning(); else startOrPause(); });
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
      // Touch support: tap on the track opens the task popover for that interval.
      // Pin it so it doesn't auto-hide after a touch (no hover to keep it alive).
      dom.trackCanvas.addEventListener("click", (e) => {
        // Reuse the same hit-testing handleTrackMove does
        handleTrackMove(e);
        popPinned = true;
        clearPopHide();
      }, { passive: true });
      // Tap outside the popover closes it (touch users)
      document.addEventListener("click", (e) => {
        if(!dom.taskPopover || !dom.taskPopover.classList.contains("show")) return;
        if(dom.taskPopover.contains(e.target)) return;
        if(dom.trackCanvas && dom.trackCanvas.contains(e.target)) return;
        popPinned = false;
        hideTaskPopover();
      }, { passive: true });
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
          if(key === "playtime"){
            // Addiert X Minuten zum Spielzeit-Konto (arcadeTimeSec in Sekunden).
            refundArcadeTime(n * 60);
            renderArcadeTime();
            setCommandFeedback(`✓ +${n} Min Spielzeit (Konto: ${formatArcadeTime(state.arcadeTimeSec)}).`, "ok");
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
          setCommandFeedback(`Unbekannter Schlüssel: ${key}. Verfügbar: points, litters, rolls, streak, playtime`, "err");
          uiError();
          return;
        }
        if(cmd === "skip"){
          if(state.phase === "learning"){
            skipAny();
            setCommandFeedback("✓ Intervall übersprungen.", "ok");
            uiSave();
          } else if(state.phase === "break"){
            const r = requestBreakSkip();
            if(r === "asking") setCommandFeedback("Wähle im Dialog, ob die Restzeit übertragen wird.", "ok");
            else setCommandFeedback("✓ Pause übersprungen.", "ok");
            uiSave();
          } else {
            setCommandFeedback("Aktuell gibt es nichts zum Überspringen.", "err");
            uiError();
          }
          return;
        }
        if(cmd === "reset"){
          resetTodayProgress();
          setCommandFeedback("✓ Heutiger Intervall-Fortschritt geleert (Pomodoro & Flow). Punkte, Würfel & To-Dos bleiben.", "ok");
          uiSave();
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

      // ── To-Do view v2 (Inbox + Interval-Grid + Projects) ──
      {
        const todoView = document.getElementById("todoView");
        if(todoView){
          todoView.addEventListener("click", todoV2HandleClick);
          todoView.addEventListener("keydown", todoV2HandleKeydown);
          // Cross-Container Drag-and-Drop
          todoView.addEventListener("dragstart", todoV2DragStart);
          todoView.addEventListener("dragend", todoV2DragEnd);
          todoView.addEventListener("dragover", todoV2DragOver);
          todoView.addEventListener("dragleave", todoV2DragLeave);
          todoView.addEventListener("drop", todoV2Drop);
        }
        const inboxBtn = document.getElementById("todoInboxAddBtn");
        const inboxInp = document.getElementById("todoInboxInput");
        if(inboxBtn){ inboxBtn.addEventListener("click", todoInboxAddSubmit); }
        if(inboxInp){
          inboxInp.addEventListener("keydown", (e) => {
            if(e.key === "Enter"){ e.preventDefault(); todoInboxAddSubmit(); }
          });
        }
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

      // Skip-break carry-over choice
      if(dom.skipBreakYes) dom.skipBreakYes.addEventListener("click", () => {
        uiToggle(); closeSkipBreakModal(); performBreakSkip(true);
      });
      if(dom.skipBreakNo) dom.skipBreakNo.addEventListener("click", () => {
        uiToggle(); closeSkipBreakModal(); performBreakSkip(false);
      });
      // Backdrop click = cancel (do NOT skip the break).
      if(dom.skipBreakModal) dom.skipBreakModal.addEventListener("click", (e) => {
        if(e.target === dom.skipBreakModal) closeSkipBreakModal();
      });

      document.addEventListener("keydown", e => {
        if(e.key === "Escape"){
          if(dom.skipBreakModal && dom.skipBreakModal.classList.contains("show")) closeSkipBreakModal();
          else if(dom.confirmResetModal.classList.contains("show")) closeResetConfirm();
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
        if(m.includes("network") || m.includes("fetch") || m.includes("load failed")){
          // Trigger an async diagnosis in the background; result will be appended to the error message.
          if(typeof diagnoseSupabaseConnection === "function") diagnoseSupabaseConnection();
          return "Netzwerkfehler — siehe Konsole (F12 → Console) für Details.";
        }
        if(m.includes("rate limit")) return "Zu viele Versuche. Bitte später erneut probieren.";
        return err && err.message ? err.message : "Unbekannter Fehler.";
      }
      // Diagnoses why Supabase calls fail. Logs detailed info to the console so the user
      // can copy it and figure out: pausiertes Projekt, CORS, Adblocker oder Offline.
      // Runs asynchronously after a network failure has been detected.
      async function diagnoseSupabaseConnection(){
        const log = (...a) => console.log("%c[Supabase-Diagnose]", "color:#3DC061;font-weight:bold", ...a);
        const warn = (...a) => console.warn("%c[Supabase-Diagnose]", "color:#E25555;font-weight:bold", ...a);
        log("Starte Diagnose…");
        // 1) Browser online at all?
        if(!navigator.onLine){
          warn("Browser meldet OFFLINE. Bitte Internetverbindung prüfen.");
          return;
        }
        log("✓ Browser ist online");
        // 2) Can we reach the Supabase auth health endpoint?
        const healthUrl = SUPABASE_URL + "/auth/v1/health";
        try{
          const r = await fetch(healthUrl, {
            method: "GET",
            headers: { "apikey": SUPABASE_KEY },
          });
          log("Auth-Health Status:", r.status);
          if(r.status === 0){
            warn("Antwort-Status 0 — wahrscheinlich CORS-Block oder Browser-Extension (Adblocker, Privacy-Tool).");
          } else if(r.status >= 200 && r.status < 300){
            log("✓ Supabase Auth erreichbar.");
            try{
              const body = await r.text();
              log("Health-Body:", body);
            }catch(_){}
          } else if(r.status === 401 || r.status === 403){
            warn("API-Key wird abgelehnt (Status " + r.status + "). Prüfe SUPABASE_KEY oder ob das Projekt PAUSIERT ist (Free-Tier pausiert nach ~1 Woche).");
          } else if(r.status === 503 || r.status === 502 || r.status === 504){
            warn("Server-Status " + r.status + " — Supabase ist gerade nicht erreichbar oder das Projekt ist PAUSIERT.");
          } else {
            warn("Unerwarteter Status: " + r.status);
          }
        } catch(e){
          warn("Konnte Auth-Endpoint nicht erreichen:", e && e.message || e);
          warn("Mögliche Ursachen (in dieser Reihenfolge prüfen):");
          warn("  1. Supabase-Projekt PAUSIERT (sehr häufig bei Free-Tier nach Inaktivität)");
          warn("     → dashboard.supabase.com öffnen → Projekt wieder starten");
          warn("  2. Browser-Extension blockiert *.supabase.co (Adblocker / Privacy-Tool)");
          warn("     → testweise Inkognito-Tab probieren");
          warn("  3. CORS-Konfiguration im Supabase-Dashboard");
          warn("     → API → Settings → CORS: prüfe ob deine Domain freigegeben ist");
        }
        // 3) Try the REST endpoint as well
        try{
          const r2 = await fetch(SUPABASE_URL + "/rest/v1/", {
            method: "GET",
            headers: { "apikey": SUPABASE_KEY },
          });
          log("REST Status:", r2.status);
        } catch(e){
          warn("REST nicht erreichbar:", e && e.message || e);
        }
        log("Aktuelle Config:");
        log("  URL:", SUPABASE_URL);
        log("  Key (gekürzt):", SUPABASE_KEY.slice(0, 20) + "…");
        log("  Origin:", window.location.origin);
        log("Diagnose fertig. Wenn der Fehler bleibt: Supabase-Dashboard öffnen → ist das Projekt aktiv?");
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
        // Guests start directly with the default template — questionnaire removed.
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
        // First-time welcome tour (still shown to first-time accounts).
        // The follow-up questionnaire has been removed — users start with the default template
        // and can customize via Settings → Intervall-Einstellungen instead.
        if(!state.onboardingDone) maybeShowOnboarding();
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
          // (Questionnaire chain removed — users go straight into the app with default template.)
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
        if(document.visibilityState === "visible"){
          if(state.running && state.phase === "learning") requestWakeLock();
          // Reopened/refocused — reset if the study-day rolled over while we were away.
          handleDayRollover();
        }
      });
      // Foreground focus is a second trigger (desktop / some PWAs don't fire visibilitychange).
      window.addEventListener("focus", handleDayRollover);
      // And a low-frequency tick so the rollover also fires while the app stays open
      // in the foreground across the 1 AM cutoff (cheap: a string compare once a minute).
      setInterval(handleDayRollover, 60 * 1000);

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
      //   LEADERBOARD  (weekly: Mon 00:00 → Sun 23:59, reset on new Monday)
      // ════════════════════════════════════════════════════════════
      const lbDom = {
        list:       null,
        empty:      null,
        weekInfo:   null,
        hint:       null,
        refreshBtn: null,
      };
      function initLeaderboardDom(){
        lbDom.list       = document.getElementById("lbList");
        lbDom.empty      = document.getElementById("lbEmpty");
        lbDom.weekInfo   = document.getElementById("lbWeekInfo");
        lbDom.hint       = document.getElementById("lbHint");
        lbDom.refreshBtn = document.getElementById("lbRefreshBtn");
      }
      // Monday-anchored week range in LOCAL time (matches the data-day keys we already store).
      function currentWeekRange(){
        const today = logicalNow();
        const dow = today.getDay(); // 0 = Sun, 1 = Mon, …, 6 = Sat
        const monOffset = (dow === 0) ? -6 : (1 - dow);
        const monday = new Date(today);
        monday.setDate(today.getDate() + monOffset);
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return { monday, sunday };
      }
      function fmtWeekRange(){
        const { monday, sunday } = currentWeekRange();
        const fmt = d => `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.`;
        return `Woche ${fmt(monday)} – ${fmt(sunday)}`;
      }
      // fmtHoursFromMinutes imported from time.js
      // Render a single avatar into a leaderboard row's avatar slot.
      // Uses the row's USERNAME (not the current user's) for the initial-letter case.
      function renderAvatarForRow(host, avatar, displayUsername){
        if(!host) return;
        while(host.firstChild) host.removeChild(host.firstChild);
        host.style.background = "";
        const a = (avatar && isValidAvatar(avatar))
          ? avatar
          : { type:"initial", value:"#3DC061" };
        if(a.type === "emoji"){
          host.textContent = a.value;
          host.style.background = "var(--btn-neutral)";
        } else if(a.type === "initial"){
          const wrap = document.createElement("div");
          wrap.className = "avatarInitial";
          wrap.style.background = a.value;
          wrap.textContent = (displayUsername || "?").charAt(0).toUpperCase();
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
      async function fetchLeaderboard(){
        if(!sb) return { ok:false, rows:[], error:"Supabase nicht geladen." };
        try{
          const { data, error } = await sb.rpc("get_weekly_leaderboard");
          if(error) return { ok:false, rows:[], error: error.message || String(error) };
          return { ok:true, rows: Array.isArray(data) ? data : [] };
        }catch(e){
          return { ok:false, rows:[], error: (e && e.message) || String(e) };
        }
      }
      function renderLeaderboard(rows, opts){
        if(!lbDom.list) initLeaderboardDom();
        if(!lbDom.list) return;
        const wrap = lbDom.list;
        while(wrap.firstChild) wrap.removeChild(wrap.firstChild);
        if(lbDom.weekInfo) lbDom.weekInfo.textContent = fmtWeekRange();
        const errMsg = opts && opts.error;
        if(errMsg){
          lbDom.empty.style.display = "block";
          lbDom.empty.textContent = "Konnte Leaderboard nicht laden: " + errMsg;
          if(lbDom.hint) lbDom.hint.style.display = "none";
          return;
        }
        if(!rows || rows.length === 0){
          lbDom.empty.style.display = "block";
          lbDom.empty.textContent = "Diese Woche hat noch niemand etwas gelernt. Sei der oder die Erste!";
          if(lbDom.hint) lbDom.hint.style.display = (currentUser && !guestMode) ? "block" : "none";
          return;
        }
        lbDom.empty.style.display = "none";
        const meName = (state.username || "").toLowerCase();
        let foundSelf = false;
        // Split: ranked (>= 60 min) and unranked (< 60 min). Re-rank the ranked
        // ones client-side in case the RPC mixed unranked rows into the list.
        const RANK_THRESHOLD_MIN = 60;
        const ranked = [], unranked = [];
        for(const r of rows){
          const m = Number(r.minutes_this_week) || 0;
          if(m >= RANK_THRESHOLD_MIN) ranked.push(r);
          else unranked.push(r);
        }
        ranked.sort((a, b) => (Number(b.minutes_this_week)||0) - (Number(a.minutes_this_week)||0));
        unranked.sort((a, b) => (Number(b.minutes_this_week)||0) - (Number(a.minutes_this_week)||0));

        const frag = document.createDocumentFragment();
        const buildRow = (r, rankNum) => {
          const row = document.createElement("div");
          row.className = "lbRow";
          row.setAttribute("role", "listitem");
          if(rankNum === 1) row.classList.add("lb-rank-1");
          else if(rankNum === 2) row.classList.add("lb-rank-2");
          else if(rankNum === 3) row.classList.add("lb-rank-3");
          if(rankNum === null) row.classList.add("lb-unranked");
          if(meName && r.username && r.username.toLowerCase() === meName){
            row.classList.add("lb-self");
            foundSelf = true;
          }
          const rank = document.createElement("div");
          rank.className = "lbRank";
          rank.textContent = (rankNum === null) ? "–" : ("#" + rankNum);
          row.appendChild(rank);
          const avi = document.createElement("div");
          avi.className = "lbAvatar";
          renderAvatarForRow(avi, r.avatar, r.username);
          row.appendChild(avi);
          const name = document.createElement("div");
          name.className = "lbName";
          name.textContent = r.username || "—";
          row.appendChild(name);
          const hours = document.createElement("div");
          hours.className = "lbHours";
          hours.textContent = fmtHoursFromMinutes(r.minutes_this_week);
          const hLbl = document.createElement("span");
          hLbl.className = "lbHoursLabel";
          hLbl.textContent = (rankNum === null) ? "unter 1h" : "diese Woche";
          hours.appendChild(hLbl);
          row.appendChild(hours);
          return row;
        };
        ranked.forEach((r, i) => frag.appendChild(buildRow(r, i + 1)));
        if(unranked.length > 0){
          if(ranked.length > 0){
            const sep = document.createElement("div");
            sep.className = "lbSeparator";
            sep.textContent = "Unter 1h diese Woche";
            frag.appendChild(sep);
          }
          unranked.forEach(r => frag.appendChild(buildRow(r, null)));
        }
        wrap.appendChild(frag);
        // Show hint if the user is logged in but not in the list yet
        if(lbDom.hint){
          if(currentUser && !guestMode && !foundSelf){
            lbDom.hint.style.display = "block";
          } else {
            lbDom.hint.style.display = "none";
          }
        }
      }
      async function loadLeaderboard(){
        initLeaderboardDom();
        if(!lbDom.list) return;
        // Guests can't query the RPC (it's authenticated-only)
        if(guestMode || !currentUser){
          renderLeaderboard([], { error: "Bitte melde dich an, um das Leaderboard zu sehen." });
          return;
        }
        lbDom.list.setAttribute("aria-busy", "true");
        if(lbDom.refreshBtn) lbDom.refreshBtn.disabled = true;
        const res = await fetchLeaderboard();
        lbDom.list.setAttribute("aria-busy", "false");
        if(lbDom.refreshBtn) lbDom.refreshBtn.disabled = false;
        if(!res.ok){
          renderLeaderboard([], { error: res.error });
        } else {
          renderLeaderboard(res.rows);
        }
      }
      function bindLeaderboardEvents(){
        initLeaderboardDom();
        if(lbDom.refreshBtn){
          lbDom.refreshBtn.addEventListener("click", () => {
            loadLeaderboard();
            uiSoftClick();
          });
        }
      }

      // ════════════════════════════════════════════════════════════
      //   FLOW MODE  (open-ended timer that counts UP from 0)
      //   Pomodoro stays as is; Flow is an alternative mode chosen via the mode tabs.
      //   FLOW_* constants imported from constants.js
      //   fmtTimeFlow imported from time.js (alias for fmtTime)
      // ════════════════════════════════════════════════════════════
      let flowTickAnchor = null;             // { wallStart, secAtStart, phase }
      function isFlow(){ return state.mode === "flow"; }
      function isPomodoro(){ return state.mode === "pomodoro" || !state.mode; }
      // True once the current learning block has run for at least FLOW_MIN_INTERVAL_SEC
      // (1 min). From that point the user may pause/end the interval AT ANY TIME — there is
      // no 10-min "window" anymore; every minute learned counts. Used to ENABLE the manual
      // pause-prompt button and arm the skip button.
      function flowPauseWindowActive(){
        if(!isFlow() || state.flow.phase !== "learning") return false;
        const t = state.flow.elapsedSec | 0;
        return t >= FLOW_MIN_INTERVAL_SEC;
      }
      // Start the flow-tick anchor. Reads the current phase (learning vs break)
      // so a single anchor can drive either count-up or count-down.
      function startFlowAnchor(){
        flowTickAnchor = {
          wallStart: Date.now(),
          secAtStart: state.flow.phase === "break" ? state.flow.breakLeftSec : state.flow.elapsedSec,
          phase: state.flow.phase,
        };
      }
      function stopFlowAnchor(){ flowTickAnchor = null; }
      // Called each worker tick when state.mode === "flow" && flow.running.
      function flowTimerTick(){
        if(!flowTickAnchor) return;
        const elapsedRealSec = (Date.now() - flowTickAnchor.wallStart) / 1000;
        if(flowTickAnchor.phase === "learning"){
          const newSec = Math.floor(flowTickAnchor.secAtStart + elapsedRealSec);
          if(newSec !== state.flow.elapsedSec){
            state.flow.elapsedSec = newSec;
            updateTimerTickUI();
            persistThrottled();
          }
          // Auto-prompt at 60 min, then every +30 min, unless one is already open
          if(state.flow.elapsedSec >= state.flow.nextAutoPromptSec){
            if(!isFlowPauseModalOpen()){
              openFlowPauseModal({ auto: true });
            }
          }
        } else if(flowTickAnchor.phase === "break"){
          const remain = Math.max(0, Math.ceil(flowTickAnchor.secAtStart - elapsedRealSec));
          if(remain !== state.flow.breakLeftSec){
            state.flow.breakLeftSec = remain;
            updateTimerTickUI();
            persistThrottled();
          }
          if(remain <= 0){
            // Break time is up → RING and wait for the user (no silent auto-continue).
            flowBreakFinished();
          }
        }
      }
      function flowStartLearning(){
        // Begin a fresh learning block at 0 sec
        state.flow.phase = "learning";
        state.flow.elapsedSec = 0;
        state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
        state.flow.running = true;
        state.flow.breakLeftSec = 0;
        state.flow.breakTotalSec = 0;
        state.flow.dayKey = todayISO();
        startFlowAnchor();
        workerStart();
        requestWakeLock();
        diceTrackingStart(); // earn rolls during flow learning too
      }
      function flowToggleRunning(){
        // If the break-end alarm is ringing, the first press just silences it (mirrors
        // Pomodoro: dismiss first, then a second press actually starts the next block).
        if(state.alarmActive){ dismissFlowAlarm(); return; }
        if(state.flow.phase === "idle"){
          flowStartLearning();
        } else {
          state.flow.running = !state.flow.running;
          if(state.flow.running){
            startFlowAnchor();
            workerStart();
            if(state.flow.phase === "learning"){
              requestWakeLock();
              diceTrackingStart();
            }
          } else {
            // Pausing the flow timer: freeze counters
            if(flowTickAnchor){
              const elapsed = (Date.now() - flowTickAnchor.wallStart) / 1000;
              if(state.flow.phase === "learning"){
                state.flow.elapsedSec = Math.floor(flowTickAnchor.secAtStart + elapsed);
              } else if(state.flow.phase === "break"){
                state.flow.breakLeftSec = Math.max(0, Math.ceil(flowTickAnchor.secAtStart - elapsed));
              }
            }
            stopFlowAnchor();
            workerStop();
            releaseWakeLock();
            diceTrackingStop();
          }
        }
        updateTimerUI();
        drawTrack();
        persist();
      }
      // New-local-day handling for Flow mode. Two distinct things must reset at the
      // midnight (1 AM logical) cutoff, mirroring how Pomodoro resets to interval 0:
      //   (1) the COMPLETED-BLOCK LOG (state.flow.sessions) — these are "die Intervalle,
      //       die man gemacht hat". The timer track + the "N Blocks abgeschlossen" counter
      //       read this array directly, so stale entries from yesterday would keep showing.
      //       We prune it to today only (heatmap minutes live separately in state.data, so
      //       this never touches the streak/history). This happens EVEN if a block is
      //       currently running, so a session that spans midnight keeps counting while
      //       yesterday's finished blocks still drop off the track.
      //   (2) the LIVE BLOCK display (elapsed/break counters) — reset to a fresh idle 0,
      //       but only when nothing is actively running (don't interrupt a continuous
      //       session the user is mid-way through).
      function flowResetIfNewDay(){
        if(!state.flow) return;
        const today = todayISO();
        const stamped = state.flow.dayKey || "";
        if(stamped === today) return;
        // (1) Drop completed blocks that don't belong to today (keeps the array bounded
        //     and the track/counter day-accurate regardless of when this runs).
        if(Array.isArray(state.flow.sessions)){
          state.flow.sessions = state.flow.sessions
            .filter(s => s && localDateKey(new Date(s.completedAt)) === today);
        }
        // Don't disrupt an active learning/break in progress — just re-stamp the day.
        if(state.flow.running) { state.flow.dayKey = today; return; }
        // (2) Idle on a fresh day: reset the live block display back to 0.
        state.flow.elapsedSec = 0;
        state.flow.breakLeftSec = 0;
        state.flow.breakTotalSec = 0;
        state.flow.phase = "idle";
        state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
        state.flow.dayKey = today;
      }
      // Logical study-day key last reflected in the UI. Set on load; the rollover
      // watcher below compares against it to detect a new day WITHOUT a page reload.
      let lastSeenDay = null;
      // Runtime day-rollover: fires when the local study-day (1 AM cutoff, see
      // js/time.js) changes while the app stays open or is reopened from background
      // (PWA). On reload this work is already done by applyLoadedState(); this is the
      // path for the tab/app that simply survives across the cutoff.
      //   • Flow mode → flowResetIfNewDay() prunes yesterday's completed blocks even if a
      //     block is running across the cutoff (the running block keeps counting; only the
      //     finished-block track + counter reset).
      //   • Classic mode → if a learning/break is actively running we do NOT interrupt
      //     it (it rolls into today's history on completion); otherwise we wipe the
      //     stale interval progress back to a fresh day-0 timer (interval 1).
      function handleDayRollover(){
        const t = todayISO();
        if(lastSeenDay === null){ lastSeenDay = t; return; }
        if(t === lastSeenDay) return;
        // A running Pomodoro interval must NOT be interrupted (resetAll would yank the
        // user out mid-interval). Leave lastSeenDay unchanged so the reset is retried as
        // soon as they pause/finish. A running FLOW block, by contrast, can be left
        // counting — flowResetIfNewDay only prunes the completed-block log around it.
        const classicBusy = !isFlow() && state.running
          && (state.phase === "learning" || state.phase === "break");
        if(classicBusy) return;
        lastSeenDay = t;
        flowResetIfNewDay();
        if(!isFlow()){
          state.activeInterval = null;   // drop yesterday's mid-interval snapshot
          resetAll();                    // clean idle state at session 0
        }
        carryOverUnfinishedTasksToInbox(); // stranded interval tasks → today's Inbox
        updateDataFromToday();           // recompute from today's (empty) history
        drawEverything();
      }
      function flowResetCurrentBlock(){
        // Reset the current block to 0 (learning) or to its full chosen duration (break).
        stopFlowAnchor(); workerStop(); diceTrackingStop(); releaseWakeLock();
        if(state.flow.phase === "break"){
          state.flow.breakLeftSec = state.flow.breakTotalSec || 0;
        } else {
          state.flow.elapsedSec = 0;
          state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
        }
        state.flow.running = false;
        updateTimerUI();
        persist();
      }
      // User decided: take a break of N minutes (1..30). Saves a flow session.
      function flowCommitPauseStart(minutes){
        const m = clamp(Math.floor(minutes), 1, 30);
        const learnedMin = Math.max(0, Math.floor(state.flow.elapsedSec / 60));
        // Save the completed learning block as a flow session
        if(learnedMin > 0){
          state.flow.sessions.push({ learnMin: learnedMin, breakMin: m, completedAt: Date.now() });
          recordSession(learnedMin);  // counts toward today's heatmap minutes
        }
        // Transition to break phase
        state.flow.phase = "break";
        state.flow.breakTotalSec = m * 60;
        state.flow.breakLeftSec  = m * 60;
        state.flow.elapsedSec = 0;
        state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
        state.flow.running = true;
        releaseWakeLock();    // no need to keep screen on during break
        diceTrackingStop();   // dice timer only advances during active learning
        startFlowAnchor();
        workerStart();
        updateTimerUI(); drawTrack(); persist();
      }
      // User declined the pause → continue learning, re-schedule auto-prompt
      function flowDeclinePause(){
        state.flow.nextAutoPromptSec = (state.flow.elapsedSec | 0) + FLOW_AUTO_INTERVAL_SEC;
        updateTimerUI(); persist();
      }
      // Break time finished → start fresh learning block at 0
      function flowEndBreak(){
        const lastIdx = state.flow.sessions.length - 1;
        // Mark the just-finished break as completed (already saved with breakMin on start; nothing to change)
        state.flow.phase = "learning";
        state.flow.elapsedSec = 0;
        state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
        state.flow.breakLeftSec = 0;
        state.flow.breakTotalSec = 0;
        // Stay running, continue into learning
        startFlowAnchor();
        if(state.flow.running){
          workerStart();
          requestWakeLock();
          diceTrackingStart();
        }
        updateTimerUI(); drawTrack(); persist();
        if(state.soundEnabled) playTone(880, "sine", 0.25, 0.18);
        notifyPhaseEnd("break");
      }
      // Flow break countdown reached 0 naturally. Unlike a manual skip (which jumps
      // straight back into learning), this RINGS like a Pomodoro phase-end and stops —
      // the user must acknowledge the alarm before anything else happens. After dismissing
      // they can start a fresh learning block, or switch to Pomodoro. We land in "idle"
      // (a clean, runnable start state) so the next Start press begins learning at 0.
      function flowBreakFinished(){
        stopFlowAnchor(); workerStop(); releaseWakeLock(); diceTrackingStop();
        state.flow.running = false;
        state.flow.breakLeftSec = 0;
        state.flow.breakTotalSec = 0;
        state.flow.elapsedSec = 0;
        state.flow.phase = "idle";
        state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
        state.alarmActive = true;
        startAlarm();
        updateTimerUI(); drawTrack(); persist();
        notifyPhaseEnd("break");
      }
      // Acknowledge the flow break-end alarm. Stops the ringing and leaves the timer in
      // its idle/ready state; the user then presses Start (or switches mode) themselves.
      function dismissFlowAlarm(){
        stopAlarm();
        state.flow.running = false;
        updateTimerUI(); drawTrack(); persist();
      }
      // User skips a flow break manually (skip button while in break) → continue now.
      function flowSkipBreak(){
        if(state.flow.phase !== "break") return;
        flowEndBreak();
      }
      // Stop everything Flow-related (used by mode switch / logout)
      function flowStopAll(){
        stopFlowAnchor(); workerStop(); diceTrackingStop(); releaseWakeLock();
        state.flow.running = false;
      }

      // ── Flow pause modal ──
      const flowPauseDom = {
        modal:   document.getElementById("flowPauseModal"),
        title:   document.getElementById("flowPauseTitle"),
        sub:     document.getElementById("flowPauseSub"),
        range:   document.getElementById("flowPauseRange"),
        mins:    document.getElementById("flowPauseMins"),
        quickRow: document.getElementById("flowPauseQuickRow"),
        cancel:  document.getElementById("flowPauseCancel"),
        none:    document.getElementById("flowPauseNone"),
        start:   document.getElementById("flowPauseStart"),
      };
      let flowPauseAutoFlag = false;
      function isFlowPauseModalOpen(){
        return flowPauseDom.modal && flowPauseDom.modal.classList.contains("show");
      }
      function openFlowPauseModal(opts){
        if(!flowPauseDom.modal) return;
        flowPauseAutoFlag = !!(opts && opts.auto);
        const min = Math.max(0, Math.floor(state.flow.elapsedSec / 60));
        flowPauseDom.sub.textContent = `Du hast gerade ${min} Minute${min === 1 ? "" : "n"} gelernt. Wie lange möchtest du pausieren?`;
        flowPauseDom.title.textContent = flowPauseAutoFlag ? "Zeit für eine Pause!" : "Pause einlegen?";
        // Default to last-used or 10
        const defaultMin = FLOW_BREAK_DEFAULT_MIN;
        flowPauseDom.range.value = String(defaultMin);
        flowPauseDom.mins.textContent = String(defaultMin);
        // Sync quick-pick highlights
        flowPauseDom.quickRow.querySelectorAll(".flowPauseQuick").forEach(b => {
          b.classList.toggle("active", parseInt(b.dataset.mins, 10) === defaultMin);
        });
        flowPauseDom.modal.classList.add("show");
        flowPauseDom.modal.setAttribute("aria-hidden", "false");
        if(state.soundEnabled) playTone(620, "sine", 0.12, 0.14);
      }
      function closeFlowPauseModal(){
        if(!flowPauseDom.modal) return;
        flowPauseDom.modal.classList.remove("show");
        flowPauseDom.modal.setAttribute("aria-hidden", "true");
      }
      function bindFlowPauseModal(){
        if(!flowPauseDom.modal) return;
        flowPauseDom.range.addEventListener("input", () => {
          const v = parseInt(flowPauseDom.range.value, 10) || 1;
          flowPauseDom.mins.textContent = String(v);
          flowPauseDom.quickRow.querySelectorAll(".flowPauseQuick").forEach(b => {
            b.classList.toggle("active", parseInt(b.dataset.mins, 10) === v);
          });
        });
        flowPauseDom.quickRow.addEventListener("click", (e) => {
          const btn = e.target.closest(".flowPauseQuick");
          if(!btn) return;
          const v = parseInt(btn.dataset.mins, 10);
          if(Number.isFinite(v)){
            flowPauseDom.range.value = String(v);
            flowPauseDom.mins.textContent = String(v);
            flowPauseDom.quickRow.querySelectorAll(".flowPauseQuick").forEach(b => {
              b.classList.toggle("active", parseInt(b.dataset.mins, 10) === v);
            });
          }
        });
        flowPauseDom.start.addEventListener("click", () => {
          const m = parseInt(flowPauseDom.range.value, 10) || FLOW_BREAK_DEFAULT_MIN;
          closeFlowPauseModal();
          flowCommitPauseStart(m);
          uiSave();
        });
        flowPauseDom.none.addEventListener("click", () => {
          closeFlowPauseModal();
          flowDeclinePause();
          uiSoftClick();
        });
        flowPauseDom.cancel.addEventListener("click", () => {
          closeFlowPauseModal();
          // Cancel: same as decline, schedule next prompt
          if(flowPauseAutoFlag) flowDeclinePause();
        });
      }

      // ── Mode switching (Pomodoro ↔ Flow) ──
      function applyModeBodyClass(){
        document.body.classList.toggle("mode-flow",      isFlow());
        document.body.classList.toggle("mode-pomodoro",  isPomodoro());
      }
      // Switch between Pomodoro and Flow. CARRIES OVER the active learning seconds
      // (only learning, NOT break time — breaks are mode-specific by user spec).
      // Avoids double-counting: recordSession() only fires on actual interval completion
      // / flow-pause-commit, NOT on mode switch.
      function switchMode(target){
        if(target !== "pomodoro" && target !== "flow") return;
        if(state.mode === target) return;

        // Capture active learning seconds from the OLD mode
        let activeSec = 0;
        let wasRunning = false;
        if(state.mode === "pomodoro" && state.phase === "learning"){
          activeSec = Math.max(0, effectiveLearnSec(state.sessionIdx) - state.timeLeft);
          wasRunning = state.running;
        } else if(state.mode === "flow" && state.flow && state.flow.phase === "learning"){
          activeSec = Math.max(0, state.flow.elapsedSec | 0);
          wasRunning = state.flow.running;
        }
        // If we're carrying a Pomodoro interval that ALREADY exceeded its length, clamp.
        // (Otherwise the user could carry an unbounded amount of time over.)

        // Stop everything from the old mode
        workerStop(); diceTrackingStop(); stopAlarm(); releaseWakeLock();
        if(tickTimer){ clearTimeout(tickTimer); tickTimer = null; }
        tickAnchor = null;
        flowTickAnchor = null;
        state.running = false;
        state.alarmActive = false;
        if(state.flow) state.flow.running = false;

        // Apply the new mode
        state.mode = target;
        applyModeBodyClass();

        if(target === "flow"){
          // Migrate active learning seconds → flow.elapsedSec
          state.flow.breakLeftSec = 0;
          state.flow.breakTotalSec = 0;
          if(activeSec > 0){
            state.flow.phase = "learning";
            state.flow.elapsedSec = activeSec;
            // Next auto-prompt: at least 60 min total, otherwise 30 min from now
            state.flow.nextAutoPromptSec = Math.max(FLOW_AUTO_FIRST_SEC, activeSec + FLOW_AUTO_INTERVAL_SEC);
          } else {
            state.flow.phase = "idle";
            state.flow.elapsedSec = 0;
            state.flow.nextAutoPromptSec = FLOW_AUTO_FIRST_SEC;
          }
          // Auto-resume if the source was running
          if(wasRunning && state.flow.phase === "learning"){
            state.flow.running = true;
            startFlowAnchor();
            workerStart();
            requestWakeLock();
            diceTrackingStart();
          }
        } else { // target === "pomodoro"
          if(activeSec > 0){
            // Bring the user back into the current learning interval, prefilled.
            // If they already exceeded the interval length, leave timeLeft = 0 and
            // complete() will mark this interval done on the next tick.
            const learnSec = effectiveLearnSec(state.sessionIdx);
            state.phase = "learning";
            state.timeLeft = Math.max(0, learnSec - activeSec);
            // Auto-resume if the source was running
            if(wasRunning){
              state.running = true;
              startTickAnchor();
              workerStart();
              requestWakeLock();
              diceTrackingStart();
            }
          }
          // If no active learning sec carried over → leave pomodoro state where it was
        }

        // Refresh UI
        const tp = document.getElementById("modeTabPomodoro");
        const tf = document.getElementById("modeTabFlow");
        if(tp) tp.classList.toggle("active", isPomodoro());
        if(tf) tf.classList.toggle("active", isFlow());
        updateTimerUI();
        drawTrack();
        persist();
        uiTabSwitch();
      }
      function bindModeTabs(){
        const tp = document.getElementById("modeTabPomodoro");
        const tf = document.getElementById("modeTabFlow");
        if(tp) tp.addEventListener("click", () => switchMode("pomodoro"));
        if(tf) tf.addEventListener("click", () => switchMode("flow"));
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
        // Onboarding-questionnaire was removed per user request.
        // Everyone (first login / returning login / guest) starts directly with the
        // default "Standard"-template. Customization happens in Settings → Intervall-Einstellungen.
        // This function is intentionally kept as a no-op to avoid breaking any stale callers.
        return;
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

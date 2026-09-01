(() => {
  const DURATION = 74;
  const $ = (id) => document.getElementById(id);
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const mix = (a, b, p) => a + (b - a) * p;
  const smooth = (p) => {
    p = clamp(p);
    return p * p * (3 - 2 * p);
  };
  const out = (p) => 1 - Math.pow(1 - clamp(p), 3);
  const pop = (p) => {
    p = clamp(p);
    const c = 1.70158;
    return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
  };
  const between = (t, start, end) => clamp((t - start) / (end - start));
  const visible = (t, start, end, fadeIn = .7, fadeOut = .7) => Math.min(between(t, start, start + fadeIn), between(end - t, 0, fadeOut));
  const transform = (element, x, y, scale = 1, rotate = 0) => {
    element.style.transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotate}deg)`;
  };
  const showScene = (id, t, start, end, fadeIn = .7, fadeOut = .7) => {
    const element = $(id);
    const opacity = visible(t, start, end, fadeIn, fadeOut);
    element.style.opacity = opacity;
    element.style.visibility = opacity > .001 ? "visible" : "hidden";
    return opacity;
  };
  const showPop = (element, t, start, duration = .7, fromY = 28, fromScale = .96) => {
    const p = pop(between(t, start, start + duration));
    element.style.opacity = clamp(p);
    transform(element, 0, mix(fromY, 0, p), mix(fromScale, 1, p));
  };
  const type = (element, copy, t, start, charsPerSecond = 30) => {
    const length = Math.floor(clamp((t - start) * charsPerSecond, 0, copy.length));
    element.textContent = copy.slice(0, length);
  };
  const setComplete = (element, state) => {
    element.classList.toggle("complete", state === "complete");
    element.classList.toggle("active", state === "active");
  };

  const narration = "I review what shipped and what is blocked. If a launch date moved, include the reason. If a blocker has no owner, stop and ask me. Save the email as a draft—never send it.";
  const mailCopy = "Hi team,\n\nHere is this week’s project update.\n\nShipped\nNew onboarding and the usage dashboard.\n\nNeeds attention\nThe mobile launch moved to May 24. Customer import still needs an owner.";
  const answerCopy = "Anything that could delay the committed launch date.";
  const buildStages = [
    ["Preparing local evidence", 12],
    ["Finding the demonstrated steps", 38],
    ["Extracting decisions and exceptions", 66],
    ["Adding success checks", 88],
    ["Saving the draft workflow", 100],
  ];

  function renderTeach(t) {
    const sceneOpacity = showScene("scene-teach", t, 0, 27.6, .8, .9);
    if (!sceneOpacity) return;
    $("corner-brand").style.opacity = clamp(between(t, .5, 1.5) * between(27 - t, 0, .8));

    const opening = $("opening-copy");
    const introP = out(between(t, .5, 2.2));
    opening.style.opacity = clamp(between(t, .4, 1.3) * between(9.5 - t, 0, 1.2));
    transform(opening, mix(-35, 0, introP), 0, 1);
    $("opening-subtitle").style.opacity = between(t, 4.6, 5.5);
    transform($("opening-subtitle"), 0, mix(12, 0, out(between(t, 4.6, 5.6))), 1);

    const workstation = $("workstation");
    const deskP = out(between(t, 1.2, 3.1));
    workstation.style.opacity = between(t, 1.1, 2.1);
    const zoom = t < 8 ? mix(.78, .9, deskP) : mix(.9, 1.13, smooth(between(t, 8, 11.5)));
    const x = t < 8 ? mix(150, 0, deskP) : mix(0, -285, smooth(between(t, 8, 11.5)));
    const y = t < 8 ? mix(45, 0, deskP) : mix(0, -22, smooth(between(t, 8, 11.5)));
    transform(workstation, x, y, zoom);

    const record = $("record-control");
    showPop(record, t, 8.6, .75, 30, .96);
    record.style.opacity = Math.min(record.style.opacity || 0, between(27.1 - t, 0, .5));
    const elapsed = Math.max(0, t - 9.1);
    $("record-time").textContent = `00:${String(Math.floor(elapsed)).padStart(2, "0")}`;
    document.querySelectorAll(".waveform i").forEach((bar, index) => {
      const wave = .3 + .7 * Math.abs(Math.sin(t * 4.8 + index * .83) * Math.cos(t * 1.7 + index));
      bar.style.transform = `scaleY(${wave})`;
    });

    const narrationBubble = $("narration-bubble");
    showPop(narrationBubble, t, 9.4, .8, 24, .97);
    narrationBubble.style.opacity = Math.min(narrationBubble.style.opacity || 0, between(26.7 - t, 0, .7));
    type($("narration-text"), narration, t, 10, 16.5);

    const phase1 = between(t, 11.8, 15.2);
    const phase2 = between(t, 15.2, 19.2);
    const phase3 = between(t, 19.2, 25.5);
    $("project-board").style.opacity = 1 - smooth(between(t, 15.2, 16));
    transform($("project-board"), mix(0, -60, smooth(between(t, 15.2, 16))), 0, 1);
    $("notes-panel").style.opacity = smooth(between(t, 15, 16.1)) * (1 - smooth(between(t, 19.2, 20)));
    transform($("notes-panel"), mix(100, 0, smooth(between(t, 15, 16.1))), 0, mix(.94, 1, smooth(between(t, 15, 16.1))));
    $("mail-panel").style.opacity = smooth(between(t, 19, 20));
    transform($("mail-panel"), mix(100, 0, smooth(between(t, 19, 20))), 0, mix(.94, 1, smooth(between(t, 19, 20))));
    $("risk-card").style.boxShadow = phase1 > .38 && phase1 < .83 ? "0 0 0 4px rgba(225,29,72,.16)" : "none";
    $("blocked-card").style.boxShadow = phase1 > .72 ? "0 0 0 4px rgba(225,29,72,.16)" : "none";
    type($("mail-body"), mailCopy, t, 20, 33);

    const cursor = $("demo-cursor");
    let cx = 820, cy = 270;
    if (t < 15.2) { cx = mix(820, 455, phase1); cy = mix(270, 400, phase1); }
    else if (t < 19.2) { cx = mix(780, 905, phase2); cy = mix(250, 365, phase2); }
    else { cx = mix(900, 880, phase3); cy = mix(330, 515, phase3); }
    cursor.style.left = `${cx}px`; cursor.style.top = `${cy}px`;
    cursor.querySelector("i").style.opacity = Math.sin(t * 7) > .82 ? .7 : 0;

    [["action-1", 12.9], ["action-2", 16.7], ["action-3", 21.4]].forEach(([id, start]) => {
      const element = $(id);
      const p = out(between(t, start, start + .55));
      element.style.opacity = p * between(27 - t, 0, .6);
      transform(element, mix(35, 0, p), 0, 1);
    });
  }

  function renderBuild(t) {
    const opacity = showScene("scene-build", t, 26.7, 36.2, .8, .8);
    if (!opacity) return;
    $("corner-brand").style.opacity = 0;
    [
      ["evidence-screen", 27.3],
      ["evidence-actions", 27.8],
      ["evidence-voice", 28.3],
    ].forEach(([id, start]) => {
      const element = $(id); const p = out(between(t, start, start + .7));
      element.style.opacity = p; transform(element, mix(-30, 0, p), 0, 1);
    });
    ["line-screen", "line-actions", "line-voice"].forEach((id, index) => {
      const line = $(id); const p = between(t, 28.5 + index * .25, 30.1 + index * .25);
      line.style.opacity = p; line.style.strokeDashoffset = `${mix(190, 0, p)}`;
    });
    showPop($("build-card"), t, 29.2, .8, 28, .92);
    $("local-note").style.opacity = between(t, 30.5, 31.3);
    const p = smooth(between(t, 29.4, 35.2));
    const percent = Math.round(mix(12, 100, p));
    let stageIndex = Math.min(buildStages.length - 1, Math.floor(p * buildStages.length));
    $("build-stage").textContent = buildStages[stageIndex][0];
    $("build-percent").textContent = `${percent}%`;
    $("build-progress-fill").style.width = `${percent}%`;
    for (let index = 1; index <= 4; index++) {
      const state = p > index / 4 ? "complete" : p > (index - 1) / 4 ? "active" : "idle";
      setComplete($(`build-step-${index}`), state);
      const badge = $(`build-step-${index}`).querySelector("i");
      badge.textContent = state === "complete" ? "✓" : String(index);
    }
  }

  function renderReview(t) {
    const opacity = showScene("scene-review", t, 35.3, 55.8, .8, .8);
    if (!opacity) return;
    const app = $("replay-app");
    const appP = out(between(t, 35.7, 36.8));
    app.style.opacity = appP; transform(app, 0, mix(35, 0, appP), mix(.97, 1, appP));

    const question = $("question-modal");
    const questionIn = out(between(t, 39.2, 40.1));
    const questionOut = smooth(between(t, 47.5, 48.1));
    question.style.opacity = questionIn * (1 - questionOut);
    transform(question, 0, mix(30, 0, questionIn) - mix(0, 20, questionOut), mix(.94, 1, questionIn));
    $("questions-tab").classList.toggle("pulse-tab", t > 37 && t < 48);
    $("questions-tab").querySelector("em").textContent = t >= 48.1 ? "0" : "1";
    $("reviewed-rule").classList.toggle("resolved", t >= 48.1);
    type($("answer-field"), answerCopy, t, 41.1, 23);
    $("save-answer").style.background = t > 44.5 ? "#be123c" : "#e11d48";

    const approved = t > 49.8;
    $("status-pill").textContent = approved ? "APPROVED" : "DRAFT";
    $("status-pill").classList.toggle("approved", approved);
    $("approve-button").textContent = approved ? "Approved ✓" : "Approve workflow";
    $("approve-button").classList.toggle("done", approved);
    $("workflow-nav-state").textContent = approved ? "4 steps · approved" : "4 steps · draft";
    const toast = $("approved-toast");
    const toastIn = out(between(t, 49.8, 50.5));
    toast.style.opacity = toastIn * between(55 - t, 0, .5);
    transform(toast, 0, mix(-20, 0, toastIn), 1);
    $("safe-step").style.boxShadow = t > 47.8 && t < 50 ? "0 0 0 3px rgba(16,185,129,.15)" : "none";
  }

  function renderOutputs(t) {
    const opacity = showScene("scene-outputs", t, 55, 63, .75, .7);
    if (!opacity) return;
    [["output-playbook",55.7],["output-script",56.15],["output-runner",56.6]].forEach(([id,start]) => showPop($(id), t, start, .75, 45, .96));
    $("outputs-caption").style.opacity = between(t, 58.2, 59.1);
  }

  function renderRun(t) {
    const opacity = showScene("scene-run", t, 62.2, 69.2, .7, .7);
    if (!opacity) return;
    const desktop = $("run-desktop"); const deskP = out(between(t,62.3,63.15));
    desktop.style.opacity = deskP; transform(desktop,0,mix(25,0,deskP),mix(.98,1,deskP));
    const panel = $("run-panel"); const panelP = out(between(t,62.8,63.65));
    panel.style.opacity = panelP; transform(panel,mix(50,0,panelP),0,mix(.95,1,panelP));
    $("next-monday").style.opacity = between(t,62.2,62.9);
    const progress = smooth(between(t,63.4,67.1));
    $("run-progress-fill").style.width = `${Math.round(progress*100)}%`;
    for (let index=1; index<=4; index++) {
      const threshold = (index-1)/4;
      const next = index/4;
      const state = progress >= next ? "complete" : progress >= threshold ? "active" : "idle";
      setComplete($(`run-step-${index}`),state);
    }
    const completed = progress > .98;
    $("run-status").textContent = completed ? "COMPLETED" : "RUNNING";
    $("run-status").classList.toggle("complete",completed);
    $("run-evidence").querySelector("b").textContent = `${Math.round(progress*7)} screenshots`;
    const result = $("result-card"); const resultP = out(between(t,67.05,67.8));
    result.style.opacity = resultP; transform(result,0,mix(40,0,resultP),mix(.97,1,resultP));
  }

  function renderEnd(t) {
    const opacity = showScene("scene-end", t, 68.3, DURATION, .8, .4);
    if (!opacity) return;
    const lockup = $("end-lockup"); const p = out(between(t,68.8,70));
    lockup.style.opacity = p; transform(lockup,0,0,mix(.97,1,p));
    $("end-lockup").querySelector(".end-rule i").style.width = `${smooth(between(t,71.2,72.5))*100}%`;
  }

  function renderAt(seconds) {
    const t = clamp(Number(seconds) || 0, 0, DURATION);
    renderTeach(t);
    renderBuild(t);
    renderReview(t);
    renderOutputs(t);
    renderRun(t);
    renderEnd(t);
    document.documentElement.dataset.time = t.toFixed(3);
    void document.body.offsetWidth;
  }

  let startTime = 0;
  let raf = 0;
  function tick(now) {
    if (!startTime) startTime = now;
    const t = (now - startTime) / 1000;
    renderAt(t);
    if (t < DURATION) raf = requestAnimationFrame(tick);
    else window.promoDone = true;
  }
  function play() {
    cancelAnimationFrame(raf);
    startTime = 0;
    window.promoDone = false;
    raf = requestAnimationFrame(tick);
  }

  window.ReplayPromo = { duration: DURATION, renderAt, play };
  window.promoReady = true;
  renderAt(Number(new URLSearchParams(location.search).get("t")) || 0);
  if (new URLSearchParams(location.search).get("autoplay") === "1") play();
})();

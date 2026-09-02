/* Replay film v2 — deterministic timeline.
   window.ReplayFilm.renderAt(seconds) lays out every element for that instant; nothing depends on
   wall-clock time, so the renderer can screenshot frames in any order and the result is identical. */
(() => {
  const DURATION = 82;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const mix = (a, b, p) => a + (b - a) * p;
  const between = (t, a, b) => clamp((t - a) / (b - a));
  const smooth = (p) => { p = clamp(p); return p * p * (3 - 2 * p); };
  const out = (p) => 1 - Math.pow(1 - clamp(p), 3);
  const inOut = (p) => { p = clamp(p); return p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
  const pop = (p) => { p = clamp(p); const c = 1.25; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
  const pad2 = (n) => String(Math.floor(n)).padStart(2, "0");
  const fmtTc = (s) => `${pad2(s / 60)}:${pad2(s % 60)}`;
  const fmtTc1 = (s) => `${fmtTc(s)}.${Math.floor((s % 1) * 10)}`;
  const setO = (el, o) => { el.style.opacity = clamp(o); };
  const tf = (el, x = 0, y = 0, s = 1, r = 0) => { el.style.transform = `translate(${x}px, ${y}px) scale(${s}) rotate(${r}deg)`; };
  const tfc = (el, s = 1, dy = 0) => { el.style.transform = `translate(-50%, calc(-54% + ${dy}px)) scale(${s})`; };
  const typeInto = (el, text, t, start, cps) => {
    const n = Math.floor(clamp((t - start) * cps, 0, text.length));
    el.textContent = text.slice(0, n);
    return n >= text.length;
  };
  const keyPath = (keys, x) => {
    if (x <= keys[0][0]) return [keys[0][1], keys[0][2]];
    for (let i = 1; i < keys.length; i += 1) {
      const [t1, x1, y1] = keys[i - 1];
      const [t2, x2, y2] = keys[i];
      if (x <= t2) { const p = smooth(between(x, t1, t2)); return [mix(x1, x2, p), mix(y1, y2, p)]; }
    }
    const last = keys[keys.length - 1];
    return [last[1], last[2]];
  };

  /* ---------- timing ---------- */
  const REC = { start: 8.57, end: 20.0, len: 21 };
  const RUN = { start: 58.5, end: 65.5, len: 12 };
  const tcAt = (t) => clamp((t - REC.start) / (REC.end - REC.start)) * REC.len;
  const rtcAt = (t) => clamp((t - RUN.start) / (RUN.end - RUN.start)) * RUN.len;
  const rtcT = (r) => RUN.start + (r / RUN.len) * (RUN.end - RUN.start);
  const CLICKS = [1.2, 1.9, 2.3];
  const DEVELOP = [26.4, 27.6, 28.8];
  const FAN = [48.8, 50.2, 51.6];
  const PRINTS = [49.2, 50.6, 52.0];

  const CAM = [
    [0, 0, 540, 1],
    [REC.start, 0, 540, 1],
    [REC.end, 2100, 540, 1, "linear"],
    [22.6, 2100, 540, 1],
    [25.7, 990, 475, .9],
    [33.6, 990, 475, .9],
    [35.6, 990, 400, 1.35],
    [41.4, 990, 400, 1.35],
    [43.6, 990, 430, 1],
    [46.6, 990, 430, 1],
    [49.2, 3300, 430, .86],
    [55.6, 3300, 430, .86],
    [58.3, 5500, 540, 1],
    [RUN.end, 6100, 540, 1, "linear"],
    [68.6, 6100, 540, 1],
    [71.6, 3200, 520, .27],
    [DURATION, 3200, 520, .258, "linear"],
  ];
  function camera(t) {
    for (let i = 1; i < CAM.length; i += 1) {
      const [t1, x1, y1, z1] = CAM[i - 1];
      const [t2, x2, y2, z2, ease] = CAM[i];
      if (t <= t2) {
        const raw = between(t, t1, t2);
        const p = ease === "linear" ? raw : inOut(raw);
        return { x: mix(x1, x2, p), y: mix(y1, y2, p), z: Math.exp(mix(Math.log(z1), Math.log(z2), p)) };
      }
    }
    const last = CAM[CAM.length - 1];
    return { x: last[1], y: last[2], z: last[3] };
  }

  /* ---------- content ---------- */
  const REC_INV = { id: "INV-1048", vendor: "Harbor Logistics · net 14", total: "$1,284.40", po: "PO-8821", poTotal: "$1,284.40" };
  const RUN_INV = { id: "INV-1052", vendor: "Harbor Logistics · net 14", total: "$980.00", po: "PO-8834", poTotal: "$995.00" };
  const REC_ROWS = [
    ["INV-1046", "Acme Supply", "$412.00", "Approved"],
    ["INV-1047", "Bright Paper Co.", "$2,150.00", "Approved"],
    ["INV-1048", "Harbor Logistics", "$1,284.40", "Pending", true],
    ["INV-1049", "Tidewater Print", "$96.50", "Pending"],
    ["INV-1050", "Meridian Freight", "$3,020.00", "Pending"],
  ];
  const RUN_ROWS = [
    ["INV-1050", "Meridian Freight", "$3,020.00", "Approved"],
    ["INV-1051", "Acme Supply", "$188.00", "Approved"],
    ["INV-1052", "Harbor Logistics", "$980.00", "Pending", true],
    ["INV-1053", "Bright Paper Co.", "$1,410.00", "Pending"],
    ["INV-1054", "Tidewater Print", "$72.25", "Pending"],
  ];
  const REC_THUMBS = [
    [0, "queue"], [2, "queue", "target"], [4, "detail"], [6, "detail"], [8, "detail", "totals"], [10, "detail", "totals"],
    [12, "detail", "totals"], [14, "detail"], [16, "detail", "approve"], [18, "detail", "none", "approved"], [20, "detail", "none", "approved"],
  ];
  const RUN_THUMBS = [[0, "queue"], [2, "detail"], [5, "detail", "totals"], [8, "detail", "none", "flagged"], [10, "detail", "none", "flagged"]];
  const EVENTS = [
    [1.2, "click", "CLICK", "Invoices"],
    [3.0, "click", "CLICK", "INV-1048 · Review queue"],
    [5.6, "scroll", "SCROLL", "wheel −120"],
    [8.0, "narration", "VOICE", "“…check its total against the purchase order”"],
    [12.4, "hover", "HOVER", "Invoice total · PO-8821"],
    [16.0, "click", "CLICK", "Approve invoice"],
    [18.4, "screen", "SCREEN", "badge → Approved"],
    [21.0, "stop", "STOP", "saved · 00:21"],
  ];
  const RECEIPTS = [
    [2.5, "ok", "step 1 · 0.8s", "screenshot-01.png · details visible"],
    [5.4, "amber", "decision · NO branch", "screenshot-02.png · $980.00 ≠ $995.00"],
    [8.6, "ok", "step 3 · flagged", "screenshot-03.png · Needs attention visible"],
    [10.2, "ok", "result verified", "screenshot-04.png · run.json written"],
  ];
  const NARRATION_A = "I open the next invoice and check its total against the purchase order.";
  const NARRATION_B = "If they match exactly, I approve it. Anything else, I flag for follow-up.";
  const ANSWER = "No. Any difference is flagged for follow-up.";
  const RULE = "Any difference, however small, is flagged.";
  const HASH = "7c1e9b4af02d5e88c3b19a71…d24a";
  const CAPTIONS = [
    [20.5, 22.5, "Twenty-one seconds. Three clicks. One rule that was only ever spoken."],
    [23.8, 25.9, "The raw recording never leaves this Mac."],
    [29.8, 31.7, "Not a recording of the work. A specification of it, linked to the evidence."],
    [32.0, 35.0, "Where the recording was silent, Replay asks."],
    [45.9, 48.6, "Approval binds to this exact revision. Change one word, and it is a draft again."],
    [53.0, 56.2, "The same revision, printed three ways. Or run it right here."],
  ];
  const KICKERS = [
    [22.8, 25.8, "BUILD WORKFLOW · WHAT CROSSES THE BOUNDARY"],
    [26.0, 33.4, "UNDERSTAND · EVERY STEP LINKED TO ITS EVIDENCE"],
    [34.2, 41.2, "REVIEW · ONE QUESTION, ONE RULE"],
    [42.0, 48.4, "APPROVE · THIS EXACT REVISION"],
    [48.6, 55.4, "EXPORT · ONE REVISION, ANY AGENT"],
    [57.6, 68.4, "THURSDAY · SUPERVISED RUN · FRESH EVIDENCE"],
  ];
  const HUMAN_PATH = [[0, 560, 150], [2.8, 330, 276], [3.3, 330, 276], [6.5, 500, 240], [12, 500, 240], [15.5, 297, 343], [16.4, 297, 343], [21, 420, 380]];
  const AGENT_PATH = [[0, 420, 160], [2.0, 330, 276], [2.4, 330, 276], [4.0, 500, 240], [6.0, 500, 240], [8.0, 446, 343], [8.6, 446, 343], [12, 560, 400]];

  /* ---------- DOM setup ---------- */
  const world = $("world");
  const appProto = $("app-main");
  function setQueue(app, rows) {
    app.querySelector(".app-queue ul").innerHTML = rows.map(([id, vendor, total, status, target]) =>
      `<li class="${status === "Approved" ? "done" : "pending"}${target ? " target" : ""}"><b>${id}</b><span>${vendor}</span><i>${total}</i><em>${status}</em></li>`).join("");
  }
  function setInvoice(app, inv) {
    app.querySelector(".inv-id").textContent = inv.id;
    app.querySelector(".inv-vendor").textContent = inv.vendor;
    app.querySelector(".inv-total").textContent = inv.total;
    app.querySelector(".po-id").textContent = inv.po;
    app.querySelector(".po-total").textContent = inv.poTotal;
  }
  function setApp(app, view, hover = "none", outcome = "none") {
    if (app.dataset.view !== view) app.dataset.view = view;
    if (app.dataset.hover !== hover) app.dataset.hover = hover;
    if (app.dataset.outcome !== outcome) app.dataset.outcome = outcome;
  }
  function makeThumb(container, [at, view, hover, outcome], inv, rows) {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.style.left = `${at * 100 - 75}px`;
    thumb.dataset.at = at;
    const frame = document.createElement("div");
    frame.className = "thumb-frame";
    const app = appProto.cloneNode(true);
    app.removeAttribute("id");
    setInvoice(app, inv); setQueue(app, rows); setApp(app, view, hover, outcome);
    frame.appendChild(app);
    thumb.appendChild(frame);
    const label = document.createElement("small");
    label.textContent = fmtTc(at);
    thumb.appendChild(label);
    container.appendChild(thumb);
    return thumb;
  }
  const recThumbs = REC_THUMBS.map((spec) => makeThumb($("rec-thumbs"), spec, REC_INV, REC_ROWS));
  const runThumbs = RUN_THUMBS.map((spec) => makeThumb($("run-thumbs"), spec, RUN_INV, RUN_ROWS));
  for (const [ruler, max] of [[$("rec-ruler"), 24], [$("run-ruler"), 14]]) {
    for (let s = 0; s <= max; s += 2) {
      const label = document.createElement("span");
      label.style.left = `${s * 100}px`;
      label.textContent = fmtTc(s);
      ruler.appendChild(label);
    }
  }
  const eventEls = EVENTS.map(([at, kind, label, text]) => {
    const el = document.createElement("div");
    el.className = `event ${kind}`;
    el.style.left = `${at * 100 + 6}px`;
    el.innerHTML = `<b>${label}</b>${text}`;
    $("rec-events").appendChild(el);
    return el;
  });
  const receiptEls = RECEIPTS.map(([at, kind, title, detail], index) => {
    const el = document.createElement("div");
    el.className = `receipt${kind === "amber" ? " amber" : ""}`;
    el.style.left = `${at * 100 - 12}px`;
    el.style.top = index % 2 ? "80px" : "0";
    el.innerHTML = `<i>${kind === "amber" ? "◆" : "✓"}</i><div><b>${title}</b><span>${detail}</span></div>`;
    $("run-receipts").appendChild(el);
    return el;
  });
  // print layout: one revision node fanning into three prints
  const PRINT_LEFT = [2560, 3150, 3740];
  PRINTS.forEach((_, i) => { $(`print-${i + 1}`).style.left = `${PRINT_LEFT[i]}px`; });
  $("rev-node").style.left = "2330px";
  const fanPaths = [
    [$("fan-1"), "M178 430 C 260 430, 280 300, 360 300"],
    [$("fan-2"), "M178 430 C 500 430, 600 430, 950 430"],
    [$("fan-3"), "M178 430 C 700 430, 900 560, 1540 560"],
  ].map(([el, d]) => { el.setAttribute("d", d); el.style.strokeDasharray = "0 99999"; return [el, el.getTotalLength()]; });
  const evidenceLines = [1, 2, 3].map((i) => {
    const card = $(`card-${i}`);
    const left = parseFloat(card.style.left);
    const start = [left + (i === 2 ? 270 : 280), 120 + card.offsetHeight - 8];
    const end = [[300, 800, 1600][i - 1], 658];
    const el = $(`ev-line-${i}`);
    el.style.strokeDasharray = "none";
    return { el, start, end };
  });
  const cardGeom = [1, 2, 3].map((i) => {
    const card = $(`card-${i}`);
    return { el: card, cx: parseFloat(card.style.left) + 280, cy: 120 + card.offsetHeight / 2 };
  });
  const waveBars = Array.from($("rec-wave").querySelectorAll("i"));
  const thesis = [$("thesis-1"), $("thesis-2"), $("thesis-3")];
  const monitor = $("monitor");
  const app = appProto;
  let appPhase = "";

  /* ---------- render ---------- */
  function renderAt(seconds) {
    const t = clamp(Number(seconds) || 0, 0, DURATION);
    const tc = tcAt(t);
    const rtc = rtcAt(t);

    // camera + world
    const cam = camera(t);
    world.style.transform = `translate(960px, 540px) scale(${cam.z}) translate(${-cam.x}px, ${-cam.y}px)`;
    setO(world, between(t, 8.3, 9.3) * (t < 73.4 ? 1 : mix(1, .12, smooth(between(t, 73.4, 74.6)))));
    setO($("fade"), t < 2 ? 1 - between(t, .2, 1.1) : between(t, 81.2, 82));

    // ---- cold open
    const cold = $("cold");
    const coldOn = t < 8.7;
    cold.style.visibility = coldOn ? "visible" : "hidden";
    if (coldOn) {
      const dot = $("cold-dot");
      const ring = CLICKS.reduce((m, c) => Math.max(m, t >= c ? Math.max(0, 1 - (t - c) / .7) : 0), 0);
      setO(dot, between(t, .6, 1.1) * (1 - between(t, 8.2, 8.6)));
      tf(dot, 0, 0, 1 + .1 * Math.sin(t * 6.9) + (ring > 0 ? (1 - ring) * .15 : 0));
      dot.style.boxShadow = ring > 0
        ? `0 0 0 ${Math.round((1 - ring) * 34)}px rgba(244,63,94,${(ring * .35).toFixed(3)}), 0 0 30px rgba(244,63,94,.5)`
        : "0 0 0 0 rgba(244,63,94,0), 0 0 30px rgba(244,63,94,.5)";
      const counter = $("cold-counter");
      setO(counter, between(t, 1.0, 1.6) * (1 - between(t, 8.2, 8.6)));
      counter.textContent = `00:00:${pad2(t)}.${pad2((t % 1) * 100)}`;
      const h1 = $("hook-1"), h2 = $("hook-2");
      const p1 = between(t, 2.6, 3.4), q1 = between(t, 5.3, 5.9);
      setO(h1, p1 * (1 - q1)); tfc(h1, mix(.985, 1, out(p1)) + q1 * .01, mix(10, 0, out(p1)));
      const p2 = between(t, 5.8, 6.6), q2 = between(t, 8.0, 8.5);
      setO(h2, p2 * (1 - q2)); tfc(h2, mix(.985, 1, out(p2)) + q2 * .01, mix(10, 0, out(p2)));
    }

    // ---- rec pill (recording, then saved, then reused for the run)
    const pill = $("rec-pill");
    let pillO = 0, pillIn = 0;
    if (t < 40) { pillIn = pop(between(t, 8.5, 9.1)); pillO = pillIn * (1 - between(t, 22.0, 22.5)); }
    else { pillIn = pop(between(t, 57.8, 58.4)); pillO = pillIn * (1 - between(t, 68.6, 69.1)); }
    setO(pill, pillO); tf(pill, 0, mix(-14, 0, pillIn));
    const running = t >= 40;
    pill.classList.toggle("saved", (t >= REC.end && t < 40) || running);
    $("rec-pill-state").textContent = running ? "REPLAY IS RUNNING · SUPERVISED" : t < REC.end ? "REPLAY IS RECORDING" : "SAVED ON THIS MAC";
    $("rec-pill-time").textContent = running ? fmtTc(rtc) : t < REC.end ? fmtTc(tc) : "00:21 · video.mp4 · events.jsonl · audio.m4a";
    const narrating = !running && ((tc >= 4 && tc < 9) || (tc >= 9.6 && tc < 15.5));
    const amp = running ? .35 : narrating ? 1 : .22;
    waveBars.forEach((bar, i) => { bar.style.transform = `scaleY(${(.18 + amp * .82 * Math.abs(Math.sin(t * 9.3 + i * .9) * Math.cos(t * 3.1 + i * .5))).toFixed(3)})`; });

    // ---- monitor + app
    let mO = 0;
    if (t < 40) {
      const mIn = pop(between(t, 8.6, 9.6)), mOut = between(t, 22.2, 22.8);
      mO = mIn * (1 - mOut);
      tf(monitor, 0, mix(24, 0, mIn) - mOut * 30, mix(.96, 1, mIn));
      const phase = "rec";
      if (appPhase !== phase) { appPhase = phase; setInvoice(app, REC_INV); setQueue(app, REC_ROWS); }
      const view = tc < 3.0 ? "queue" : "detail";
      const hover = tc >= 2.2 && tc < 3.0 ? "target" : tc >= 6 && tc < 12 ? "totals" : tc >= 14.5 && tc < 16.2 ? "approve" : "none";
      setApp(app, view, hover, tc >= 16.3 ? "approved" : "none");
      $("monitor-url").textContent = `finance.northwind.example/invoices${view === "detail" ? "/INV-1048" : ""}`;
    } else {
      const mIn = pop(between(t, 57.6, 58.4)), mOut = between(t, 68.6, 69.2);
      mO = mIn * (1 - mOut) * mix(1, .28, between(t, 65.8, 66.3));
      tf(monitor, -230, 24 + mix(24, 0, mIn), .9 * mix(.96, 1, mIn));
      const phase = "run";
      if (appPhase !== phase) { appPhase = phase; setInvoice(app, RUN_INV); setQueue(app, RUN_ROWS); }
      const view = rtc < 2.2 ? "queue" : "detail";
      const hover = rtc >= 1.4 && rtc < 2.2 ? "target" : rtc >= 3.2 && rtc < 6 ? "totals" : rtc >= 7.2 && rtc < 8.2 ? "flag" : "none";
      setApp(app, view, hover, rtc >= 8.3 ? "flagged" : "none");
      $("monitor-url").textContent = `finance.northwind.example/invoices${view === "detail" ? "/INV-1052" : ""}`;
    }
    setO(monitor, mO);

    // cursors
    const human = $("cursor-human");
    const [hx, hy] = keyPath(HUMAN_PATH, tc);
    human.style.left = `${hx}px`; human.style.top = `${hy}px`;
    setO(human, between(t, 9.0, 9.4) * (1 - between(t, 22.0, 22.4)));
    const hRing = [3.0, 16.0].reduce((m, c) => Math.max(m, tc >= c && tc < c + .5 ? 1 - (tc - c) / .5 : 0), 0);
    const hRingEl = human.querySelector("i");
    setO(hRingEl, hRing); tf(hRingEl, 0, 0, hRing > 0 ? 1 + (1 - hRing) * 1.4 : 1);
    const agent = $("cursor-agent");
    const [ax, ay] = keyPath(AGENT_PATH, rtc);
    agent.style.left = `${ax}px`; agent.style.top = `${ay}px`;
    setO(agent, between(t, 58.6, 59.0) * (1 - between(t, 65.6, 66.0)));
    const aRing = [2.0, 8.0].reduce((m, c) => Math.max(m, rtc >= c && rtc < c + .5 ? 1 - (rtc - c) / .5 : 0), 0);
    agent.style.boxShadow = `0 0 0 ${Math.round(4 + (aRing > 0 ? (1 - aRing) * 18 : 0))}px rgba(244,63,94,${(aRing > 0 ? .15 + aRing * .3 : .15).toFixed(3)}), 0 0 20px rgba(244,63,94,.5)`;
    $("agent-label").textContent = rtc < 2.5 ? "STEP 1" : rtc < 5.6 ? "STEP 2 · CHECKING" : rtc < 9 ? "STEP 3" : "VERIFYING";
    const fresh = $("fresh-check");
    const fIn = pop(between(t, rtcT(4.2), rtcT(4.2) + .5)), fOut = between(t, rtcT(6.4), rtcT(6.4) + .4);
    setO(fresh, fIn * (1 - fOut)); tf(fresh, 0, mix(8, 0, fIn) - fOut * 6, 1);

    // ---- captions + kickers
    const caption = $("caption"), captionText = $("caption-text");
    let capO = 0;
    const narrO = between(tc, 3.8, 4.3) * (1 - between(t, 19.9, 20.4));
    if (narrO > 0) {
      caption.classList.add("narration");
      if (tc < 9.6) typeInto(captionText, NARRATION_A, tc, 4.0, 14);
      else typeInto(captionText, NARRATION_B, tc, 9.6, 13);
      capO = narrO;
    } else {
      caption.classList.remove("narration");
      const active = CAPTIONS.find(([a, b]) => t >= a && t < b);
      if (active) { captionText.textContent = active[2]; capO = between(t, active[0], active[0] + .45) * (1 - between(t, active[1] - .45, active[1])); }
    }
    setO(caption, capO);
    caption.style.transform = `translate(-50%, ${mix(8, 0, capO).toFixed(2)}px)`;
    const kicker = $("kicker");
    const activeKicker = KICKERS.find(([a, b]) => t >= a && t < b);
    if (activeKicker) { kicker.textContent = activeKicker[2]; setO(kicker, between(t, activeKicker[0], activeKicker[0] + .4) * (1 - between(t, activeKicker[1] - .3, activeKicker[1]))); }
    else setO(kicker, 0);

    // ---- gate
    const gate = $("gate");
    const gIn = pop(between(t, 22.6, 23.3)), gOut = between(t, 25.6, 26.1);
    setO(gate, gIn * (1 - gOut)); tf(gate, 0, mix(24, 0, gIn), mix(.96, 1, gIn) * (1 - gOut * .03));
    [["gate-actions", 23.4], ["gate-narr", 23.7], ["gate-frames", 24.0], ["gate-plan", 24.3]].forEach(([id, s]) => {
      const p = out(between(t, s, s + .6)); const el = $(id); setO(el, p); tf(el, mix(-160, 0, p));
    });

    // ---- recording strip
    setO($("strip-rec"), between(t, 8.8, 9.6));
    $("strip-rec").querySelector(".strip-label").style.left = `${Math.min(1500, Math.max(-70, cam.x - 900))}px`;
    $("strip-run").querySelector(".strip-label").style.left = `${Math.min(600, Math.max(-70, cam.x - 900 - 5200))}px`;
    const ph = $("rec-playhead");
    ph.style.left = `${tc * 100}px`;
    setO(ph, between(t, 8.9, 9.3) * (1 - between(t, 25.7, 26.3)));
    $("rec-playhead-time").textContent = fmtTc1(tc);
    $("rec-ruler-fill").style.width = `${tc * 100}px`;
    $("strip-rec-length").textContent = fmtTc(tc);
    recThumbs.forEach((el) => { const at = Number(el.dataset.at); setO(el, between(tc, at, at + .5)); });
    const eventsOut = 1 - between(t, 25.7, 26.3);
    eventEls.forEach((el, i) => { const p = out(between(tc, EVENTS[i][0], EVENTS[i][0] + .4)); setO(el, p * eventsOut); tf(el, 0, mix(6, 0, p)); });
    const scan = $("scanlight");
    scan.style.left = `${tc * 100}px`;
    setO(scan, between(t, 9, 9.8) * (1 - between(t, 25.7, 26.5)));
    const marks = Array.from($("rec-marks").children);
    marks.forEach((mark, i) => { setO(mark, pop(between(t, DEVELOP[i], DEVELOP[i] + .5))); });
    marks[1].classList.toggle("amber", t >= 31.6 && t < 40.6);

    // ---- cards develop, then fold, then return for the reveal
    const foldP = inOut(between(t, 43.4, 44.6));
    const qIn = pop(between(t, 35.4, 36.2)), qOut = between(t, 40.5, 41.0);
    const qVis = qIn * (1 - qOut);
    cardGeom.forEach(({ el, cx, cy }, i) => {
      const dev = out(between(t, DEVELOP[i], DEVELOP[i] + 1.1));
      let o = t < 70 ? dev * (1 - foldP) : between(t, 70, 71.5);
      if (i === 1) o *= mix(1, .45, qVis);
      setO(el, o);
      el.style.filter = dev < 1 ? `blur(${((1 - dev) * 16).toFixed(1)}px)` : "none";
      const fold = t >= 43.4 && t < 70 ? foldP : 0;
      tf(el, (990 - cx) * fold, (393 - cy) * fold + (1 - dev) * 24, mix(1, .22, fold));
    });
    evidenceLines.forEach(({ el, start, end }, i) => {
      const p = out(between(t, DEVELOP[i] - .15, DEVELOP[i] + .75));
      const vis = t < 70 ? p * (1 - foldP) : between(t, 70, 71.5);
      el.setAttribute("d", `M${start[0]} ${start[1]} L${mix(start[0], end[0], p)} ${mix(start[1], end[1], p)}`);
      setO(el, vis * .9);
    });
    const conf = $("decision-confidence");
    const confState = t >= 40.6 ? "high" : t >= 31.6 ? "low" : "review";
    conf.textContent = confState === "high" ? "HIGH CONFIDENCE" : confState === "low" ? "LOW CONFIDENCE" : "NEEDS REVIEW";
    conf.classList.toggle("high", confState === "high");
    $("decision-rule").classList.toggle("on", t >= 40.6);
    $("decision-rule-text").textContent = RULE;

    // ---- question
    const q = $("question-card");
    setO(q, qVis); tf(q, 0, mix(30, 0, qIn) - qOut * 10, mix(.94, 1, qIn) * (1 - qOut * .03));
    const answered = typeInto($("answer-text"), ANSWER, t, 36.8, 17);
    const caret = $("answer-caret");
    setO(caret, qVis > 0 ? ((t < 36.8 || answered) ? (Math.sin(t * 2 * Math.PI * 1.6) > 0 ? 1 : 0) : 1) : 0);
    $("answer-save").classList.toggle("pressed", t >= 40.2 && t < 40.5);

    // ---- approve button (HUD) → revision bar → chip
    const approveBtn = $("approve-btn");
    const abIn = pop(between(t, 42.0, 42.6)), abOut = between(t, 43.5, 43.9);
    const pressed = t >= 43.2 && t < 43.5;
    setO(approveBtn, abIn * (1 - abOut)); tf(approveBtn, 0, mix(-14, 0, abIn), pressed ? .96 : 1);
    approveBtn.classList.toggle("pressed", pressed);
    const bar = $("revision-bar");
    const bIn = pop(between(t, 44.2, 44.9)), bOut = between(t, 47.5, 48.3);
    setO(bar, bIn * (1 - bOut)); tf(bar, 0, mix(20, 0, bIn), mix(.9, 1, bIn));
    typeInto($("rev-hash"), HASH, t, 44.6, 26);
    const stamp = $("rev-stamp");
    const sIn = between(t, 45.71, 45.95);
    setO(stamp, sIn); stamp.style.transform = `rotate(-6deg) scale(${mix(1.6, 1, out(sIn)).toFixed(3)})`;
    const chip = $("rev-chip");
    const cIn = pop(between(t, 46.2, 46.8)), cOut = between(t, 68.6, 69.1);
    setO(chip, cIn * (1 - cOut)); tf(chip, 0, mix(-14, 0, cIn));
    $("rev-chip-hash").textContent = "7c1e9b4a…d24a";

    // ---- compile: node + fan + prints
    setO($("rev-node"), between(t, 48.0, 48.6));
    fanPaths.forEach(([el, len], i) => {
      const p = inOut(between(t, FAN[i], FAN[i] + .6));
      el.style.strokeDasharray = `${(len * p).toFixed(1)} 99999`;
      setO(el, p > 0 ? .85 : 0);
    });
    PRINTS.forEach((s, i) => {
      const el = $(`print-${i + 1}`);
      const p = pop(between(t, s, s + .8));
      setO(el, clamp(p)); tf(el, 0, mix(36, 0, p), mix(.96, 1, p));
    });

    // ---- run strip + hud
    setO($("strip-run"), between(t, 58.2, 58.8));
    const rph = $("run-playhead");
    rph.style.left = `${rtc * 100}px`;
    setO(rph, between(t, 58.6, 59.0) * (1 - between(t, 68.6, 69.2)));
    $("run-playhead-time").textContent = fmtTc1(rtc);
    $("run-ruler-fill").style.width = `${rtc * 100}px`;
    $("strip-run-length").textContent = fmtTc(rtc);
    runThumbs.forEach((el) => {
      const at = Number(el.dataset.at);
      setO(el, between(rtc, at, at + .4));
      el.classList.toggle("receipted", RECEIPTS.some(([r]) => rtc >= r && Math.abs(r - at) < 1.5));
    });
    let shots = 0;
    receiptEls.forEach((el, i) => {
      const p = out(between(t, rtcT(RECEIPTS[i][0]), rtcT(RECEIPTS[i][0]) + .45));
      if (p >= 1) shots += 1;
      setO(el, p); tf(el, 0, mix(8, 0, p));
    });
    const hud = $("run-hud");
    const hIn = pop(between(t, 58.0, 58.6)), hOut = between(t, 68.6, 69.1);
    setO(hud, hIn * (1 - hOut) * mix(1, .28, between(t, 65.8, 66.3))); tf(hud, mix(30, 0, hIn));
    [[2.5, 0], [5.6, 2.5], [9.0, 5.6]].forEach(([done, start], i) => {
      const li = $(`run-step-${i + 1}`);
      li.classList.toggle("complete", rtc >= done);
      li.classList.toggle("active", rtc >= start && rtc < done && t >= RUN.start - .2);
    });
    const status = $("run-status");
    status.textContent = rtc >= 10.4 ? "COMPLETE" : "RUNNING";
    status.classList.toggle("complete", rtc >= 10.4);
    $("run-shots").textContent = `${shots} screenshot${shots === 1 ? "" : "s"}`;
    const result = $("result");
    const rIn = pop(between(t, 65.8, 66.5)), rOut = between(t, 68.6, 69.1);
    setO(result, rIn * (1 - rOut)); tf(result, 0, mix(30, 0, rIn), mix(.96, 1, rIn));

    // ---- reveal + closing
    setO($("baseline"), between(t, 69.2, 71.2));
    Array.from($("reveal-labels").children).forEach((el, i) => { setO(el, between(t, 70.6 + i * .15, 71.8 + i * .15)); });
    const line = $("closing-line");
    const lIn = between(t, 73.8, 74.6), lOut = between(t, 76.4, 77.0);
    setO(line, lIn * (1 - lOut)); tfc(line, mix(.985, 1, out(lIn)) + lOut * .01, mix(10, 0, out(lIn)));
    const lockup = $("lockup");
    const kIn = pop(between(t, 77.0, 77.9));
    setO(lockup, clamp(kIn)); tf(lockup, 0, mix(20, 0, kIn), mix(.97, 1, kIn));
    thesis.forEach((el, i) => { const p = out(between(t, 77.9 + i * .7, 78.5 + i * .7)); setO(el, p); tf(el, 0, mix(14, 0, p)); });
    $("thesis-rule-fill").style.width = `${(smooth(between(t, 79.7, 80.7)) * 100).toFixed(1)}%`;
    setO($("closing-tag"), between(t, 80.2, 80.8));

    document.documentElement.dataset.time = t.toFixed(3);
    void document.body.offsetWidth;
  }

  /* ---------- playback for browser preview ---------- */
  let startTime = 0, raf = 0;
  function tick(now) {
    if (!startTime) startTime = now;
    const t = (now - startTime) / 1000;
    renderAt(t);
    if (t < DURATION) raf = requestAnimationFrame(tick);
    else window.filmDone = true;
  }
  function play() { cancelAnimationFrame(raf); startTime = 0; window.filmDone = false; raf = requestAnimationFrame(tick); }

  window.ReplayFilm = { duration: DURATION, renderAt, play };
  window.filmReady = true;
  const params = new URLSearchParams(location.search);
  renderAt(Number(params.get("t")) || 0);
  if (params.get("autoplay") === "1") play();
})();

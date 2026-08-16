# Replay — Screen Recording to Agentic Workflow

**Date:** 2026-08-16
**Status:** Approved design, pre-implementation
**Working name:** Replay (placeholder)

## 1. Purpose

A local-first macOS app. The user hits record, performs a piece of work
(any apps, optionally narrating aloud), and hits stop. The app turns the
recording into a reviewable, editable workflow — steps, inputs, decision
points. The user then chooses the output format:

1. **Agent playbook/skill** — a Markdown document an agent (or human) follows with judgment
2. **Deterministic script** — Playwright TypeScript for browser work
3. **Agentic replay** — the app's built-in runner executes the workflow, watching the screen and handling branches

All three are compiled from one format-neutral **workflow intermediate
representation (IR)**.

**Audience:** personal tool for the author, polished enough to demo.
No accounts, no teams, no cloud storage. Everything local except Claude
API calls.

**North-star demo:** a task with real decision logic — the runner must
look at the screen and branch ("if the invoice total matches the PO,
approve it; otherwise flag it"), not replay pixels.

### Prior art: Grok Bot "teach a task" (xAI, Aug 2026)

Grok Bot records demonstrations inside the agent's *cloud* computer
(max 10 min, no audio) and converts them to opaque skills tested by
running them. This validates the demonstration-beats-configuration bet.
Replay differentiates on: (a) recording the user's real desktop and
native apps locally, (b) narration as first-class input, (c) explicit
decision-point extraction and review, (d) a structural, provenance-linked
review step instead of "test it and see", (e) three output formats.
One idea adopted from them: a supervised **test run** before a workflow
is trusted to run autonomously.

## 2. Architecture Overview

One repo, five components around the shared IR:

1. **App shell — Electron** (React/TypeScript UI). Electron over Tauri
   because the main process is a full Node runtime, letting the Claude
   Agent SDK runner live inside the app rather than as a subprocess.
2. **Capture sidecar — small Swift binary**, spawned and supervised by
   the app. Screen video, global input events, accessibility context,
   optional mic. Capture only; zero intelligence.
3. **Understanding pipeline — TypeScript** in the app. Transcription,
   event condensation, frame sampling, then Claude (vision) for step
   segmentation and decision-point extraction. Output: draft IR.
4. **Review UI** — timeline of inferred steps beside the recording;
   the user corrects and approves. Output: approved IR.
5. **IR + compilers + runner** — three compilers behind one interface;
   the runner (Agent SDK + computer-use-style control) executes the IR
   directly.

**Data flow:** record → `sessions/<id>/` on disk (video, events.jsonl,
audio, meta) → pipeline → draft IR → review → approved IR → compile
and/or run → run log.

## 3. Capture Layer

### Session folder contents (`sessions/<id>/`)

- `video.mp4` — full-display recording via ScreenCaptureKit, timestamps
  aligned with events.
- `events.jsonl` — one line per input event: clicks, keystrokes,
  scrolls, drags, app/window switches (CGEventTap). Each interaction
  event is enriched **at capture time** with an accessibility snapshot
  of its target: element role, label, value, bounding box, app bundle
  ID, window title. A click is "clicked **Submit** in **Invoices —
  Chrome**", not "clicked at (612, 480)".
- `audio.m4a` + narration flag — mic capture, only if enabled for that
  recording.
- `meta.json` — display size/scale, start/stop times, app versions.

### Browser capture in v1

No custom extension. The macOS AX API exposes web page content
(buttons, fields, links) and the address-bar URL is readable per
interaction. The events schema reserves a `dom` field so a
DOM-precise browser extension can be added later without migration.

### Privacy guardrails (non-negotiable)

- When the focused element is a secure text field (per AX), keystrokes
  are recorded as `[REDACTED]`. Passwords never touch disk.
- Everything stays local until an explicit Claude API call.

### Permissions

Screen Recording, Accessibility, Input Monitoring, Microphone
(optional). First-run checklist screen that detects each grant and
deep-links to System Settings.

### Failure handling

The app heartbeats the sidecar. Events and video flush to disk
continuously (never buffered to the end); if the sidecar dies
mid-recording the session is preserved as partial and still usable.

## 4. Understanding Pipeline

Mechanical preprocessing is deterministic code; interpretation is
Claude. Five stages:

1. **Transcribe** (if narration exists): audio → timestamped transcript
   segments.
2. **Event condensation (pure TypeScript, no AI):** collapse raw events
   into *actions*. Keystroke runs become "typed `Q3 report` into the
   **Search** field"; scroll noise dropped. Output: dozens of actions
   instead of thousands of events, each with timestamp, target element,
   app/window/URL.
3. **Frame sampling:** keyframes just before each action (what the user
   saw when deciding) and after significant screen changes (what
   resulted). These, not full video, are what Claude sees.
4. **Step segmentation & intent (Claude, vision):** group actions into
   steps with plain-language intent; flag likely *parameters* (values
   that would change between runs); draft a one-paragraph workflow goal.
5. **Decision-point extraction (Claude, second pass):** hunt for
   evidence of conditional behavior — narration ("if the total doesn't
   match…"), comparison-shaped pauses, diverging paths — and propose
   explicit branches: screen-observable condition → branch taken →
   what the recording shows vs. what the user said happens otherwise.
   Every inference carries a confidence level; low-confidence branches
   surface as questions in review.

**Limitation by design:** one recording shows one path. Untaken
branches come only from narration or review edits — the pipeline never
invents behavior for paths it didn't see; it asks.

**Cost/latency posture:** a 10-minute recording → roughly 20–40
keyframes + condensed actions across two Claude passes. Background
processing with progress; tens of seconds to low minutes.

## 5. Workflow IR

One JSON document per workflow (`workflow.json`) — the contract between
understanding, review, compilers, and runner.

1. **Header:** name, goal paragraph, **parameters** (name, type,
   example value from the recording, description). Parameters make it a
   reusable workflow rather than a replay.
2. **Steps** — ordered list, each with:
   - `intent` — plain language, always present.
   - `actions` — concrete recorded actions (click, type, select,
     navigate…), each with a layered **target**: semantic description
     + AX identifiers (role, label, app, window) + URL if browser + a
     screenshot crop of the element. Consumers use as much precision as
     they can; the runner falls back to semantics + vision when
     identifiers drift.
   - `expects` — what the screen should show when the step succeeded.
     Used by runner and review to verify progress; makes failure
     detectable rather than silent.
3. **Branches** — `decision` nodes attached to steps: a plain-language,
   screen-observable `condition`, a `then` path and an `else` path
   (each a list of steps, possibly `ask_user` or `stop_and_flag` when
   the recording never showed that path). Conditions are semantic, not
   code: the runner evaluates them with vision; the script compiler
   turns them into code only when it can, otherwise compiles a human
   checkpoint or agent-check.
4. **Provenance:** every step and branch carries `source`
   (recorded / narrated / user-added-in-review) and timestamp
   references into the recording.

Schema-level requirements: a `version` field from day one; redacted
values stored as vault references (e.g. `{param: "password",
vault: true}`), never secrets.

## 6. Review UI

Video player beside the step list, linked by time — click a step, the
video jumps there; scrub the video, the list follows. Provenance is the
trust mechanism.

- **Steps:** rename intent, merge/split, delete noise, reorder, edit an
  action's target description, edit `expects`.
- **Parameters panel:** pipeline guesses appear as chips to confirm,
  rename, or reject; any typed value can be manually promoted to a
  parameter.
- **Decision points:** confirmed-looking branches render inline as
  condition → then/else. Low-confidence inferences arrive as a
  **question queue** ("At 2:41 you paused comparing two totals —
  decision point?"), answerable with one click. Untaken else-paths
  offer three fills: describe steps in text, *ask me at run time*, or
  *stop and flag*.
- **Approval:** one explicit "Approve workflow" action stamps the IR
  and unlocks compile/run. Edits after approval create a new IR
  version; previous versions retained as plain versioned files (no
  database).

**Not in v1:** re-recording individual steps, multi-recording merge,
collaborative review.

## 7. Compilers

All three consume the approved IR behind one interface
(`compile(ir, options) → files + warnings`). Warnings are a first-class
output.

1. **Playbook compiler → agent skill.** Markdown skill in Claude Code's
   format (SKILL.md-style frontmatter) plus playbook body: goal,
   parameters as declared inputs, steps in plain language with
   `expects` checks, decision points as explicit if/then/else prose,
   provenance as footnotes. Near-lossless; doubles as human SOP.
2. **Script compiler → deterministic code.** Playwright (TypeScript)
   for browser steps — URL + AX role/label map to Playwright role-based
   locators. Parameters become CLI arguments. Two honest limits, both
   compiled to explicit escape hatches rather than silently dropped:
   native-app segments and semantic branch conditions become either a
   *pause-and-ask-the-human* checkpoint or an *agent-check* call (a
   one-shot Claude vision judgment), chosen at compile time. Compile
   report states exactly which steps degraded and why.
3. **Computer-use compiler → runner task spec.** Emits a self-contained
   bundle: system prompt for the runner agent, the IR, element
   screenshot crops, and run policy (max retries, which branches are
   `ask_user`, what triggers `stop_and_flag`). "Export as computer-use
   task" and "Run" are the same compiler with two destinations.

## 8. Runner

**Architecture:** a Claude Agent SDK loop in Electron's main process,
driving the Mac via the same native layer capture uses — the Swift
sidecar grows an `act` mode (click element / type / screenshot on
request). The runner clicks by accessibility identity when it can,
falling back to vision-guided coordinates when identifiers drift.

**Execution model — the IR is the leash.** The agent walks the IR step
by step: perform the step's actions, verify `expects` against a fresh
screenshot, proceed. At decision nodes it evaluates the condition with
vision and takes the branch — including `ask_user` (dialog) and
`stop_and_flag`.

**Run modes:**

- **Test run** (default for a workflow's first run): pauses before
  every step showing what it's about to do; approve, skip, or abort.
  Corrections write back as IR edits — the test run doubles as final
  verification of the understanding pipeline.
- **Supervised:** continuous, but pauses at decision points and any
  `expects` failure.
- **Autonomous:** pauses only where the IR says so. Unlocked
  per-workflow after one clean test run.

**Failure handling:** an `expects` failure triggers one re-ground
attempt (re-find the target semantically + visually, retry once); then
pause with screenshot and step context. Never improvise past a failed
expectation.

**Guardrails in all modes:** secure fields are always human-typed (the
vault reference surfaces as "type your password now"); a global hotkey
and menu-bar button kill any run instantly; user mouse movement
auto-pauses the runner.

**Run log:** every run records per-step screenshots, actions, branch
decisions, and outcome — viewable in the same timeline UI as review.

## 9. Testing Strategy

**North-star e2e spine:** the repo includes a tiny local test web app —
an invoice-matching toy where some invoices match their PO and some
don't. The full-loop test records a scripted session against it, runs
the pipeline, approves programmatically, executes via the runner, and
asserts the end state — covering both branch paths.

Per layer:

- **Capture sidecar:** unit tests for event schema and **redaction**
  (secure-field keystrokes must never reach disk — tested first);
  scripted synthetic-input sessions for integration; manual checklist
  for the hardware/permission surface.
- **Event condensation:** pure functions; the most heavily unit-tested
  code in the repo (fixture JSONL in → expected actions out).
- **Understanding pipeline:** fixture-based evals, not pass/fail
  asserts — hand-labeled recordings scored for agreement, cached model
  outputs for cheap regression. Prompts in versioned files.
- **IR:** JSON Schema validation + migration tests from day one.
- **Compilers:** golden-file tests; generated Playwright scripts also
  *run* against the test app.
- **Runner:** integration-tested via the e2e spine; kill switch and
  auto-pause get dedicated tests.

TDD throughout, per the normal development workflow.

## 10. Repo Layout & Build Order

Standalone repo at `~/Desktop/Replay` (working name), npm workspaces:

```
apps/desktop        Electron + React app shell, review UI
packages/ir         IR schema, types, validation, versioning
packages/pipeline   understanding pipeline (stages 1–5)
packages/compilers  playbook / script / computer-use compilers
packages/runner     Agent SDK runner
packages/fixtures   recorded sessions, golden files, eval labels
native/capture      Swift sidecar (SPM): record + act modes
test-app            invoice-matching toy web app for e2e
```

**Build order (sub-projects, each separately testable):**

1. Capture (sidecar + session recording + permissions UI)
2. Understanding pipeline + review UI
3. IR + compilers
4. Runner (including `act` mode in the sidecar)

Each sub-project gets its own implementation plan when its turn comes.

## 11. Out of Scope for v1

- Accounts, teams, sharing, cloud storage
- Browser extension for DOM-precise capture (schema slot reserved)
- Re-recording individual steps; multi-recording merge
- Windows/Linux
- Scheduling/triggers for runs (manual invocation only)

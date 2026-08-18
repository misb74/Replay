# Replay architecture

> Show Replay a task once. Review what it learned. Export it or run it again with proof.

Replay is a local-first macOS app built around one durable object: a versioned workflow. A private recording becomes structured evidence, then a human-approved workflow, then portable exports or a guarded live run. Every important transition leaves an inspectable artifact.

## The whole loop in 30 seconds

```text
                         REPLAY - FROM DEMONSTRATION TO TRUSTED REUSE

                 DO THE WORK ONCE                                         MAKE IT TRUSTWORTHY
                 ================                                         ===================

+----------------------+    +----------------------+    +----------------------+    +--------------------------+
| YOU + ANY MAC APP    | -> | 1. CAPTURE           | -> | 2. UNDERSTAND        | -> | 3. REVIEW + APPROVE      |
| demonstrate the task |    | Swift native sidecar |    | pipeline + local     |    | edit, resolve, then hash |
| screen / input / mic |    | screen / mic / input |    | media tools + Claude |    | the exact revision       |
+----------------------+    +----------+-----------+    +----------+-----------+    +------------+-------------+
                                    |                           |                             |
                                    v                           v                             v
                         +----------------------+    +----------------------+    +--------------------------+
                         | CAPTURE EVIDENCE     |    | UNDERSTAND OUTPUTS   |    | APPROVED WORKFLOW        |
                         | video.mp4 + audio*   |    | draft -> workflows/  |    | workflow.vNNNN.json      |
                         | events.jsonl         |    | frames + safe crops  |    | content-hashed approval  |
                         | meta.json            |    | files -> sessions/   |    | exact revision only      |
                         +----------------------+    +----------------------+    +------------+-------------+
                                                                                              |
                                                                                              v
                                                                                      KEEP AND REUSE IT
                                                                                      =================
                                                                                              |
                                    +--------------------------------------------------+------+
                                    |                                                  |
                                    v                                                  v
                  +----------------------------------+                 +-------------------------------+
                  | 4A. PORTABLE EXPORTS             |                 | 4B. GUARDED LIVE RUN          |
                  |                                  |                 | test / supervised / autonomous|
                  | PLAYBOOK                         |                 | approved actions -> Swift     |
                  |   SKILL.md                       |                 | sidecar -> real Mac apps      |
                  |                                  |                 +---------------+---------------+
                  | PLAYWRIGHT                       |                                 |
                  |   workflow.ts                    |                                 v
                  |   compile-report.json            |                 +-------------------------------+
                  |                                  |                 | LIVE RESULT + RUN EVIDENCE    |
                  | COMPUTER-USE BUNDLE              |                 | intended work completed       |
                  |   prompt + workflow + policy     |                 | run.json + screenshots/       |
                  |   manifest + target crops        |                 | receipts + checks + decisions |
                  +----------------------------------+                 +---------------+---------------+
                                                                                       |
                                                                                       v
                                                              +------------------------+-----------------------+
                                                              | RUN FEEDBACK                                   |
                                                              | clean test -> trust.json                       |
                                                              |              -> autonomy for this revision     |
                                                              | correction -> new draft -> review again        |
                                                              +------------------------------------------------+
```

Narration is optional. Claude calls begin only after the user starts Build or Run; the current runner uses Claude to verify every executed step. The boundary below shows exactly what crosses.

The approved workflow is the hub, not a generated script. Replay can compile the same reviewed revision for people, browsers, or computer-use agents, or execute it directly on the Mac under its safety policy.

## What Replay produces

| Output | What it contains | Why it matters |
| --- | --- | --- |
| Private session | Screen video, optional narration audio, redacted input events, display metadata, sampled frames, and safe target crops | The original evidence remains inspectable without becoming the executable workflow |
| Canonical workflow | Versioned JSON with parameters, actions, expectations, branches, targets, confidence, and provenance | One format-neutral source of truth drives review, export, and execution |
| Approved revision | An immutable workflow snapshot with the user's approval and a SHA-256 content hash | Compilation and execution are tied to exactly what the user reviewed |
| Playbook | `SKILL.md` | A readable procedure for a person or an agent |
| Playwright export | `workflow.ts` and `compile-report.json` | Deterministic browser automation plus an explicit report of fallbacks or degraded steps |
| Computer-use export | `system-prompt.md`, `workflow.json`, `run-policy.json`, `manifest.json`, and `assets/` | A portable, policy-bounded task bundle for a computer-use runtime |
| Live result | The intended state change in the target Mac app | Replay produces completed work, not just instructions |
| Run evidence | `run.json`, screenshots, action receipts, expectation verdicts, branch decisions, answers, and outcome | A reviewable account of what happened and why |
| Revision trust | `trust.json` after a clean test | Unlocks autonomous mode only for the exact approved revision that passed |

## Durable output layout

Replay stores private artifacts beneath `~/Library/Application Support/Replay/ReplayData/` by default.

```text
ReplayData/
|
|-- sessions/<session-id>/
|   |-- video.mp4                         required H.264 screen recording
|   |-- audio.m4a                         optional narration
|   |-- events.jsonl                      redacted, timestamped input and app events
|   |-- meta.json                         status, display, timing, versions, recovery state
|   |-- transcript.json                   optional pre-supplied transcript input
|   `-- frames/
|       |-- frame-*.jpg                   full frames selected during understanding
|       `-- crops/*.jpg                   non-secure target evidence referenced by the workflow
|
|-- workflows/<workflow-id>/
|   |-- workflow.vNNNN.json               immutable canonical revisions
|   |-- workflow.json                     atomic copy of the latest revision
|   `-- trust.json                        clean-test stamp for one exact revision
|
|-- exports/<workflow-id>/vNNNN/
|   |-- playbook-<id>/
|   |   `-- SKILL.md
|   |-- playwright-<id>/
|   |   |-- workflow.ts
|   |   `-- compile-report.json
|   `-- computer-use-<id>/<workflow-slug>/
|       |-- system-prompt.md
|       |-- workflow.json
|       |-- run-policy.json
|       |-- manifest.json
|       `-- assets/*                      bundled target crops
|
`-- runs/<run-id>/
    |-- run.json                          outcome, receipts, checks, branches, answers
    `-- screenshots/*.png                 step, pause, retry, and decision evidence
```

Automatic transcription, condensed actions, screen-change scores, frame plans, and raw model responses stay in memory rather than becoming durable output. A manually supplied `transcript.json` is accepted, but the bundled local transcriber does not create one automatically.

## Privacy boundary

```text
+--------------------------------------------------------------------------------------------------+
| YOUR MAC - PRIVATE BY DEFAULT                                                                    |
|                                                                                                  |
|  +----------------+   sandboxed, typed IPC   +------------------------+                          |
|  | React UI       | <----------------------> | Electron main services |                          |
|  | record/review  |                          | capture / understand /  |                         |
|  | export/run     |                          | review / compile / run  |                         |
|  +----------------+                          +------------+-----------+                          |
|                                                           |                                      |
|                                                    +------+---------------+                      |
|                                                    |                      |                      |
|                                                    v                      v                      |
|                                           +----------------+  +----------------------+           |
|                                           | Swift sidecar  |  | ffmpeg / Whisper    |            |
|                                           | capture / act  |  | pipeline / workflow |            |
|                                           | guardrails     |  | ReplayData          |            |
|                                           +-------+--------+  +----------------------+           |
|                                                   |                                              |
|                                                   v                                              |
|                                           +----------------------------+                         |
|                                           | macOS + target apps        |                         |
|                                           | screen / mic / input       |                         |
|                                           | real work happens here     |                         |
|                                           +----------------------------+                         |
|                                                                                                  |
|  LOCAL ONLY: raw video/audio, full event log, crops, revisions, exports, and run logs.           |
+------------------------------------------------+---+---------------------------------------------+
                                      request    |   ^    response
                                                 v   |
                                   +-------------+---+-------------+
                                   | ANTHROPIC CLAUDE              |
                                   | workflow understanding        |
                                   | run-time verification         |
                                   +-------------------------------+
```

Claude calls start only after the user starts Build or Run. The exchange is deliberately narrower than the local evidence set:

| Direction | During Build | During Run |
| --- | --- | --- |
| Mac to Claude | Session identifier, versioned prompts, redacted condensed actions, narration text, frame plan, selected full frames, and the first-pass segmentation used to derive decisions | Approved step, expectation, condition, target, or custom-action text; a fresh screenshot; and the screenshot's absolute local path used by the Agent SDK |
| Claude to Mac | Structured workflow name, goal, parameters, step segmentation, decisions, confidence, and open questions | Structured verdict and reason, branch result, re-grounded target bounds, or one bounded action proposal |

The normal UI never collects vault values, and the runner never uses or logs values supplied for vault-backed actions. Secure-field event text is redacted before persistence. Full frames and run screenshots are not visually redacted, and narration is not secret-scanned, so information visible on screen or spoken aloud can cross this boundary after the user starts Build or Run. Raw video, raw audio, the full event log, target crops, workflow revisions, exports, and run logs remain local.

## Approval and learning loop

```text
                           resolve open questions
                                      |
                                      v
  DRAFT REVISION ----------> APPROVED REVISION ----------> CLEAN TEST ----------> AUTONOMOUS
  editable                    content hash                 executed steps pass    same revision only
         ^                            |                         |                      |
         |                            |                         |                      |
         +----------------------------+-------------------------+----------------------+
                       any edit or test-run correction
                    creates a new draft; old trust is ignored
```

Open low-confidence questions block approval. Approval creates a new immutable revision. A test-run correction creates another draft revision and ends the run. Autonomous mode is enabled only when `trust.json` names the current approved revision. A clean test covers the path that ran; branches not taken during that test are not certified.

## Runtime responsibilities

| Component | Responsibility |
| --- | --- |
| React renderer | Recording controls, source-video review, workflow editing, approval, export controls, guarded-run controls, and run history |
| Isolated preload | The narrow typed bridge between the sandboxed renderer and Electron main |
| Electron main | Orchestrates sessions, media processing, workflow persistence, compilation, execution, permissions, and safe media playback |
| Swift sidecar | Screen and microphone capture, accessibility-enriched input events, native actions, screenshots, first-frame health checks, recovery, mouse takeover, and emergency stop |
| Local media tools | ffmpeg validates video and derives full frames/crops; optional Whisper transcribes narration without a cloud transcription service |
| `@replay/pipeline` | Parses and redacts events, removes Replay's own stop tail, condenses actions, plans evidence, asks for structured understanding, and assembles a draft |
| `@replay/ir` | Defines the canonical workflow, validates it, migrates older documents, and enforces secure-value rules |
| `@replay/compilers` | Produces playbook, Playwright, and computer-use artifacts from an approved workflow |
| `@replay/runner` | Executes only approved IR, applies operator gates and safe retries, checks results, takes branches, and builds the run log |
| ReplayData | Local sessions, immutable workflow revisions, exports, run evidence, and revision-bound trust |

## Main data flows

1. **Record:** `SessionService` sends versioned JSON-line commands through `SidecarClient`. The Swift sidecar captures the primary display, optional microphone, and accessibility-enriched input events into a private session.
2. **Understand:** `DesktopPipelineService` validates the video, optionally transcribes narration locally, detects visual changes, and asks ffmpeg for selected frames and safe target crops. The pipeline redacts and condenses events before requesting structured steps and decisions. `@replay/ir` validates the assembled draft.
3. **Review:** the renderer edits a review view over typed IPC. Every save creates a new draft revision; edited steps and decisions receive review provenance. Approval is blocked until required questions are resolved, then stamps a new revision with the reviewed content hash.
4. **Export:** the compiler reads one approved revision and writes a playbook, Playwright program, or computer-use bundle under a revision-specific directory. It returns output paths and warnings to the UI.
5. **Run:** the runner reads the approved revision and sends bounded actions through the Swift sidecar. Test and supervised gates, secure-input handoff, fresh screenshots, mouse takeover, and the global emergency stop remain active. Replay completes the intended work in the target app, while `run.json` and screenshots preserve the evidence.
6. **Learn safely:** a correction becomes a new draft and invalidates approval and autonomy for that new revision. A clean test stamps only the exact revision that passed.

## Code map

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main process, isolated preload bridge, React review UI, and service wiring |
| `native/capture` | Swift recorder, macOS permissions, accessibility actions, screenshots, recovery, and safety interlocks |
| `packages/pipeline` | Event redaction and condensation, frame planning, model prompts, decision extraction, and draft assembly |
| `packages/ir` | Canonical workflow types, JSON Schema validation, migrations, and approval state |
| `packages/compilers` | Playbook, Playwright, and computer-use exports |
| `packages/runner` | IR-constrained execution, operator gates, retries, verification, decisions, and run logs |
| `packages/fixtures` | Synthetic recordings, cached model responses, expected actions, full-loop cases, and evaluation labels |
| `scripts/transcribe-whisper.mjs` | Optional local narration adapter for whisper.cpp |
| `test-app` | Deterministic target app used by end-to-end and compiler tests |

## Trust invariants

- The renderer has no direct Node.js access. The preload exposes only typed Replay operations over Electron IPC.
- The sidecar accepts a small, versioned command set. It has no shell, clipboard, or arbitrary file-upload action.
- Raw video and audio remain local. The Claude boundary receives only the model inputs described above after the user starts Build or Run.
- Secure-field text is redacted before event serialization. Secure targets have no reusable crop, and structured secret parameters are represented only by vault references.
- Workflow revisions, export files, run logs, frames, crops, and screenshots are written with owner-only file modes. Frame, crop, export, and run directories are created private.
- Only the exact approved, content-hashed revision can be compiled or run. Autonomous mode additionally requires a clean test of that same revision.
- Earlier successful actions are not replayed when a later expectation fails. Each decision uses fresh screen evidence.
- Mouse movement pauses execution, and Command-Shift-Escape trips the native safety latch even while an action is in progress.

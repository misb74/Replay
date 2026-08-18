# Replay architecture

Replay is a local-first macOS desktop app. Electron coordinates the interface, workflow logic, local files, and a Swift helper that records or controls the Mac. Raw recordings stay on the Mac; only the user-initiated model inputs described below can leave it.

## System map

```text
                           Optional remote boundary
                         +--------------------------+
                         | Anthropic Claude         |
                         | workflow understanding   |
                         | visual run judgments     |
                         +------------^-------------+
                                      | (4)
+--------------------- Replay desktop app ----------------------+
|                                                               |
|  +------------------+     isolated preload    +-------------+ |
|  | React renderer   | <-------- IPC --------> | Electron    | |
|  | review and run UI|                         | main process| |
|  +------------------+                         |             | |
|                                               | capture     | |
|                                               | pipeline/IR | |
|                                               | compilers   | |
|                                               | runner/judge| |
|                                               +--+---+---+--+ |
+--------------------------------------------------|---|---|----+
                                                   |   |   |
                                               (1) |(2)|(3)|
                                                   |   |   |
                    +------------------------------+   |   +----------------+
                    |                                  |                    |
                    v                                  v                    v
        +-------------------------+       +------------------+  +----------------------+
        | Swift native sidecar    |       | Local media tools|  | Private ReplayData   |
        | record, act, guardrails |       | ffmpeg, Whisper  |  | sessions, workflows, |
        +------------+------------+       +------------------+  | exports, runs        |
                     |                                          +----------------------+
                     | native capture and actions
                     v
        +-------------------------+
        | macOS frameworks/apps   |
        | screen, mic, input,     |
        | accessibility           |
        +-------------------------+
```

Arrows (1) through (4) are the main process boundaries: versioned JSON lines to the sidecar, local media subprocesses, private file reads and writes, and user-initiated model requests respectively.

## Main data flows

1. **Record:** the renderer asks Electron main to start a session. `SessionService` sends versioned JSON-line commands through `SidecarClient` to the Swift sidecar. The sidecar uses macOS frameworks and writes private `video.mp4`, optional `audio.m4a`, `events.jsonl`, and `meta.json` files under `ReplayData/sessions`.
2. **Build a workflow:** `DesktopPipelineService` validates the recording, optionally runs the local Whisper adapter, uses ffmpeg to inspect and sample the video, and invokes `@replay/pipeline`. The pipeline redacts and condenses events before Claude segments steps and extracts decisions. `@replay/ir` validates the result, then `WorkflowRepository` saves immutable JSON revisions under `ReplayData/workflows`.
3. **Review and approve:** the React UI reads and edits a view of the workflow through the isolated preload bridge. Saving creates a new draft revision. Approval hashes the reviewed content; later edits invalidate that approval.
4. **Compile:** `@replay/compilers` turns an approved IR into a human playbook, Playwright code, or a computer-use bundle. `CompilerService` writes each result under `ReplayData/exports` and reports any degraded steps as warnings.
5. **Run:** `RunnerService` loads an approved revision and delegates its step-by-step policy to `@replay/runner`. `NativeSidecarDriver` sends bounded actions to the same Swift sidecar. Claude can judge expectations or re-ground a target from fresh screenshots. Operator gates, mouse-takeover detection, and the emergency stop remain active; logs and screenshots go under `ReplayData/runs`.

## Code map

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Electron main process, isolated preload bridge, React review UI, and service wiring |
| `native/capture` | Swift recorder, macOS permissions, accessibility actions, screenshots, and safety interlocks |
| `packages/pipeline` | Event parsing and redaction, action condensation, frame planning, model prompts, and draft assembly |
| `packages/ir` | Canonical workflow types, schema validation, migrations, and approval state |
| `packages/compilers` | Playbook, Playwright, and computer-use exports |
| `packages/runner` | IR-constrained execution, operator gates, retries, verification, and run logs |
| `packages/fixtures` | Recorded fixtures, cached model responses, expected actions, and evaluation labels |
| `scripts/transcribe-whisper.mjs` | Optional local narration adapter for whisper-cpp |
| `test-app` | Deterministic invoice workflow used by full-loop tests |

## Boundaries and trust

- The renderer has no direct Node.js access. The preload exposes only typed Replay operations over Electron IPC.
- The sidecar accepts a small, versioned command set. It has no shell, clipboard, or arbitrary file-upload action.
- Raw video and audio remain local. Building a workflow sends only redacted condensed actions, selected frames, and narration text after the user initiates the build.
- Secure-field text is redacted during capture and represented as a vault reference. During a run, the operator types secure values directly.
- Every workflow edit creates a new revision. Only the exact approved revision can be compiled or run, and autonomous mode requires a clean test run of that revision.

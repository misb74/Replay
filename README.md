# Replay

Replay is a local-first macOS app that turns a screen recording of real work into a reviewable workflow. An approved workflow can be exported as an agent playbook, compiled into Playwright, or run under supervision on the Mac.

The implementation follows the [approved product design](docs/superpowers/specs/2026-08-16-screen-to-workflow-design.md). See the [architecture map](docs/architecture.md) for the runtime components, data flows, and trust boundaries.

## Development

Requirements: Node.js 20 or newer, npm, Swift 6, and macOS 14 or newer. Recording the real desktop requires Screen Recording, Accessibility, and Input Monitoring permission; narration also requires Microphone permission.

```sh
npm install
npm run check
npm run build
npm run dev
```

Run the deterministic invoice demo separately with `npm run dev:test-app`.

`npm run check` builds the shared packages, type-checks every workspace, runs the complete offline suite, executes both full Replay invoice branches in Chromium, runs a generated Playwright export, and runs the Swift sidecar suite. `npm run build` also produces the release capture sidecar and production desktop/test-app assets.

## Claude and narration

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY` there, or export it in the shell, before choosing **Build workflow** or using visual verification in a run. The development launcher loads the root `.env` automatically. The recording is not uploaded automatically. Replay first asks for explicit confirmation, keeps the full video local, and sends only redacted condensed actions, sampled frames, and narration text to Claude. Sampling includes observed visual changes; safe element crops remain local as layered target evidence, and secure elements never receive crop references.

Narration transcription is local and pluggable in this repository. Set `REPLAY_TRANSCRIBE_COMMAND` to an absolute executable that accepts `--input <audio.m4a> --output-json -` and returns the timestamped transcript shape used in `packages/fixtures/recordings/invoice-match/transcript.json`. A previously generated `transcript.json` beside a session is also accepted. Without either option, non-narrated recordings work normally and narrated recordings remain safely stored until a transcriber is configured.

For Apple Silicon development, `scripts/transcribe-whisper.mjs` is the included offline adapter. It defaults to Homebrew's `ffmpeg`, `whisper-cli`, and whisper-cpp base model paths; `.env.example` lists absolute-path overrides for other local installations. The adapter suppresses tool output so narration is not copied into logs, writes transcript files with owner-only permissions, and removes its temporary WAV and Whisper output after success, failure, or cancellation.

The emergency stop shortcut is **Command–Shift–Escape**. It is handled both by Electron and by the native safety latch. Moving the mouse during a run pauses it before more native actions can proceed.

Environment variable examples are documented in `.env.example`; the app deliberately does not copy secrets into local workflow files.

## Local data

Replay stores captures, workflow versions, exports, and run logs under the app's local application-data directory. Secrets are represented only by vault references; secure-field keystrokes are redacted before event serialization.

Each edit creates a new immutable workflow revision. Approval and clean-test trust apply only to the exact revision reviewed. Open low-confidence questions block approval. A correction made during a test run is saved as a new draft and removes autonomous trust. Run history includes per-step screenshots, decisions, and runtime answers and is available from the workflow’s **Runs** tab.

## Hardware release check

The automated suite cannot grant macOS privacy permissions. Before distributing a signed build, follow the clean-account checklist in `native/capture/README.md` to verify real display, microphone, event-tap, Accessibility, emergency-stop, and interrupted-video behavior.

# Replay capture sidecar

This package builds the macOS process that records Replay sessions and performs
the small set of native actions used by the runner. It targets macOS 14 or
newer and uses a versioned JSON-lines protocol over standard input and output.

## Build and test

```sh
swift build --disable-sandbox
./scripts/test.sh
```

The script includes a compatibility workaround for the standalone Apple
Command Line Tools 26.2 package. Full Xcode installations can also run the
usual `swift test --disable-sandbox` command directly.

## Protocol

Every request has this envelope:

```json
{"protocolVersion":1,"requestId":"request-1","command":"status","payload":{}}
```

Every direct response repeats `requestId`, sets `ok`, and contains either a
typed `result` or a safe error. Commands are:

- `record`, `stop`, and `status`
- `permissions` with `status`, `request`, or `open_settings`
- `act_screenshot`, `act_click`, `act_type`, `act_key`, `act_scroll`,
  `act_drag`, and `act_navigate`
- `heartbeat`
- `guardrails_subscribe` and `guardrails_unsubscribe`
- `live_prepare`, `live_speak`, `live_stop_speaking`, and `live_set_paused`

The canonical payload fields are:

| Command | Payload |
| --- | --- |
| `record` | `sessionId`, `sessionDirectory`, `display`; optional `includeAudio`, `appVersions`, `excludeProcessIds`, `live` |
| `stop` | optional `sessionId` |
| `status` | empty object |
| `permissions` | `operation`; `permission` for `request` or `open_settings` |
| `act_screenshot` | `outputPath`; optional `displayId`, `excludeProcessIds`, `createDirectories` |
| `act_click` | `position` and/or semantic `target`; optional `button`, `clickCount` |
| `act_type` | `text`; optional semantic `target` |
| `act_key` | macOS virtual `keyCode`; optional `modifiers`, `repeatCount` |
| `act_scroll` | `deltaX`, `deltaY`; optional `position` or semantic `target` |
| `act_drag` | `start`, `end`; optional `button`, `durationMs` |
| `act_navigate` | HTTP(S) `url`; optional expected browser `bundleId` |
| `heartbeat` | optional `nonce` |
| `guardrails_subscribe` | optional `killSwitch`, `mouseMovementThreshold` |
| `guardrails_unsubscribe` | empty object |
| `live_prepare` | optional BCP 47 `locale` |
| `live_speak` | `utteranceId`, `text` |
| `live_stop_speaking` | empty object |
| `live_set_paused` | `paused` |

Points use the macOS global display coordinate space. Modifier names are
`command`, `control`, `option`, `shift`, `caps_lock`, and `function`.

`excludeProcessIds` names processes whose windows must not be captured, so
Replay's own windows stay out of the recording and out of its screenshots.
`record`'s `live` object, with an optional `locale`, asks for a live tutor
session alongside the recording; it requires `includeAudio`, and it is
refused with `unsupported` on a system without on-device streaming speech.

A successful `result` carries a `type`, one of:

`recording_started`, `recording_stopped`, `status`, `permissions`,
`screenshot`, `action_completed`, `heartbeat`, `guardrails_subscribed`,
`guardrails_unsubscribed`, `speech_queued`, `speech_stopped`, `live_paused`,
`live_resumed`, `live_preparing`, and `live_ready`.

An error `code` is one of `invalid_command`, `invalid_state`,
`permission_denied`, `secure_field_requires_human_input`,
`safety_interlock_engaged`, `target_not_found`, `capture_failed`,
`io_failed`, `internal_error`, and `unsupported`.

The sidecar also emits messages that answer no request, and so carry no
request ID. A guardrail subscription produces these:

```json
{"protocolVersion":1,"event":"kill_switch","timestampMs":1200}
{"protocolVersion":1,"event":"user_mouse_moved","timestampMs":1250,"position":{"x":640,"y":480}}
```

A live session produces these, until it is stopped:

```json
{"protocolVersion":1,"event":"live_transcript","sessionId":"s1","segmentId":"segment-1","text":"open the invoice","isFinal":false,"startMs":2500,"endMs":4000}
{"protocolVersion":1,"event":"live_speech","sessionId":"s1","utteranceId":"u1","phase":"started","atMs":4200}
{"protocolVersion":1,"event":"live_state","sessionId":"s1","state":"listening"}
```

A `live_speech` `phase` is `started`, `finished`, or `cancelled`, and every
one carries `atMs`, the moment that phase was decided. A `live_state` `state`
is `preparing_model`, `listening`, `paused`, or `failed`, and a `failed`
carries a `reason`. All of these times, like a transcript's `startMs` and
`endMs`, are milliseconds from the capture origin — the same clock
`events.jsonl` uses.

The protocol default emergency shortcut is Control-Option-Command-Escape; the
Replay desktop host explicitly configures Command-Shift-Escape to match its
menu item. Keyboard and
mouse events posted by the sidecar carry a private marker and are excluded, so
an automated action does not pause its own run.

Act mode covers the recorded interaction types the runner needs: semantic or
coordinate clicks, Unicode typing, key chords, scrolling, timed drags, and
HTTP(S) navigation in the expected active browser. It deliberately has no
clipboard, file upload, native menu-selection, or shell-execution command.
Navigation uses Command-L in the active app and rejects non-HTTP(S) URLs.

Each `events.jsonl` line has `schemaVersion`, `id`, `sessionId`, relative
`timestampMs`, and a `type` discriminant: `click`, `key`, `scroll`, `drag`,
`app_switch`, or `window_switch`. Type-specific fields are `position`, `button`,
`clickCount`, `key`, `scroll`, and `drag`. The optional `target` contains AX
`role`, `subrole`, `label`, `value`, `bounds`, `bundleId`, `windowTitle`, `url`,
`identifier`, and `isSecure`. The optional `dom` slot is reserved for future
browser capture.

## Session durability and privacy

`events.jsonl` is synchronized after every event. `meta.json` is atomically
rewritten with `partial: true` throughout capture and changes to completed only
after a clean stop. Interrupted sessions can be recovered through
`SessionRecovery`; already-flushed event lines are never rewritten. If a hard
termination leaves `video.mp4` missing or empty, recovery promotes a unique,
structurally valid AVAssetWriter `video.mp4.sb-*` sibling with private `0600`
permissions. Ambiguous or malformed siblings are left untouched for inspection.
Status and heartbeat results set `captureHealthy` to false if either event
persistence or the live ScreenCaptureKit stream fails.

Raw OS key events are deliberately not encodable. Secure fields are redacted
before a `CapturedEvent` exists; the event encoder and session writer each
apply the same check again. If accessibility context is unavailable, key text
is redacted conservatively. The macOS adapter never asks Accessibility for a
secure field's value. Secure targets also discard the reserved `dom` object
instead of trying to decide which selector details might be sensitive.

## Hardware permission checks

Automated tests use deterministic fakes and do not trigger privacy prompts.
Before shipping a signed app bundle, manually verify on a clean macOS account:

1. Screen Recording allows MP4 capture and PNG screenshots.
2. Accessibility resolves and presses an element, refuses a secure field, and
   types into a normal field.
3. Input Monitoring records mouse, keyboard, scroll, drag, app, and window
   context and emits both guardrail signals.
4. Microphone permission creates playable `audio.m4a` when narration is on.
5. Killing the sidecar during capture leaves readable flushed JSONL and partial
   metadata; `SessionRecovery` promotes the unique valid AVAssetWriter sidecar
   into a playable private `video.mp4`.

These checks require real TCC grants and cannot be made reliable in a headless
unit-test process.

### Live tutor (macOS 26 or newer)

Run these on a clean account before distributing a signed build. None of
them can be automated, because the suite has no microphone.

- [ ] Echo: with Live on, speak, let the tutor reply, and confirm its own
      words never appear in `transcript.json`.
- [ ] Barge-in: speak while the tutor is speaking; it stops within about a
      second and the transcript keeps only what was actually said.
- [ ] Pause and resume: on pause, transcripts and speech both stop while
      `audio.m4a` keeps growing; on resume, the panel says it is listening
      again and a new sentence is transcribed.
- [ ] Stop: the session finalises and `audio.m4a` plays back.
- [ ] Stop mid-sentence: press Stop while the tutor is speaking. The
      session still finalises, the panel closes, and `transcript.json`
      keeps only the utterances that reached `finished` — the one that was
      cut off is not in it.
- [ ] Narration still lines up: for a live recording, play `video.mp4` and
      `audio.m4a` together and confirm speech lands where it was spoken,
      then run `scripts/transcribe-whisper.mjs` over `audio.m4a` and
      confirm it still produces segments. A live recording writes that file
      through the live audio tap rather than the recorder's own
      `AVAudioRecorder`, and Build falls back to transcribing it whenever
      `transcript.json` is absent.
- [ ] Exclusion: with Live on, record a few seconds, then click Pause and
      End Live on the panel itself. Confirm `video.mp4` shows neither the
      panel nor the main window, that `events.jsonl` contains no click at
      the panel's coordinates, and that clicking back into the recorded
      application afterwards produces no `app_switch`. Nothing automated
      covers this end to end, and it fails open: if exclusion silently
      stopped working, every recording would quietly include Replay.
- [ ] Audio failure: while recording with Live on, change the audio
      hardware's format — connect a Bluetooth headset, or switch the input
      device in Sound settings to one running at a different sample rate.
      It has to be a change of channel count or sample rate: that is what
      `AVAudioEngineConfigurationChange` is posted for. Plugging in
      analogue headphones may or may not qualify, depending on the Mac and
      on what the device reports, so use a Bluetooth headset or an input
      device at a different rate to be sure of triggering it. The panel
      stops saying it is listening and shows the failure with the reason
      `audio_route_changed`. **Time that delay and write it down**: the
      failure is only sent after the whole engine is torn down, including
      finalising the analyser's stream, and nobody has measured how long
      that takes. The recording itself
      carries on — the timer keeps running, `video.mp4` is unaffected, and
      `audio.m4a` simply ends early. The tutor does not come back on its
      own; stopping and starting again is what restarts it.
- [ ] First run: the speech model downloads and the panel shows
      "Preparing speech model" while it does.
- [ ] macOS 15: the "Talk to Replay while recording" checkbox is disabled
      and explains that it needs macOS 26.

Known and deferred, so not a new bug if it shows up: the panel's "hearing"
line can keep a stale partial. When the recogniser revokes a volatile
result it sends an empty string, which is forwarded as an ordinary
transcript event rather than as a revocation, so the last non-empty partial
stays on screen.

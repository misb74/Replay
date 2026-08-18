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

The canonical payload fields are:

| Command | Payload |
| --- | --- |
| `record` | `sessionId`, `sessionDirectory`, `display`; optional `includeAudio`, `appVersions` |
| `stop` | optional `sessionId` |
| `status` | empty object |
| `permissions` | `operation`; `permission` for `request` or `open_settings` |
| `act_screenshot` | `outputPath`; optional `displayId` |
| `act_click` | `position` and/or semantic `target`; optional `button`, `clickCount` |
| `act_type` | `text`; optional semantic `target` |
| `act_key` | macOS virtual `keyCode`; optional `modifiers`, `repeatCount` |
| `act_scroll` | `deltaX`, `deltaY`; optional `position` or semantic `target` |
| `act_drag` | `start`, `end`; optional `button`, `durationMs` |
| `act_navigate` | HTTP(S) `url`; optional expected browser `bundleId` |
| `heartbeat` | optional `nonce` |
| `guardrails_subscribe` | optional `killSwitch`, `mouseMovementThreshold` |
| `guardrails_unsubscribe` | empty object |

Points use the macOS global display coordinate space. Modifier names are
`command`, `control`, `option`, `shift`, `caps_lock`, and `function`.

After a guardrail subscription, the sidecar may emit messages without a
request ID:

```json
{"protocolVersion":1,"event":"kill_switch","timestampMs":1200}
{"protocolVersion":1,"event":"user_mouse_moved","timestampMs":1250,"position":{"x":640,"y":480}}
```

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

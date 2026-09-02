# Replay film v2 — "The reason is on the record"

## Creative idea

**Every click has a reason. Nobody writes it down. Replay puts the reason on the record.**

The whole film is one continuous camera move along a single timeline. The recording strip is the spine: the expert's clicks land on it as evidence, step cards develop up out of specific frames, the reviewer writes the missing rule in, approval collapses everything into one content hash, that hash fans into three exports, and a second strip grows as a supervised run leaves receipts, hitting the branch the recording never showed. The last shot pulls back to show the entire journey as one record before the brand lockup.

It is deliberately the opposite of the 2026 launch film: dark instead of airy, one shot instead of scene cuts, evidence and receipts instead of floating interfaces, and a plucked, driving score instead of an ambient bed. The story uses the repository's own deterministic invoice demo (`INV-1048` against `PO-8821`) rather than an invented scenario.

## Look and sound

- **Palette:** the Ivy system inverted. Slate-night ground, rose as the only warm light, amber for open judgment, green for verified evidence. The invoice app keeps its cream page and forest sidebar so the human's screen stays recognisably "the real work".
- **Type:** SF Pro Display for interface and headlines, Iowan Old Style italic for the human voice and editorial captions, Menlo for everything the machine writes (timecodes, events, hashes, files).
- **Camera:** a world coordinate system with a keyframed camera (position and zoom). Playhead-locked tracking during recording and running, a pull-back for understanding, a push-in for the question, a lateral pan for export, and a wide reveal at the end.
- **Score:** 84 BPM in D minor resolving to D major on the lockup. Karplus–Strong plucked motif, filtered saw arpeggio, detuned pad through a state-variable filter, sub bass, kick, rim and hats, all synthesised in `soundtrack.mjs` with sound design locked to picture. It shares nothing with the launch film's score.

## Timeline (82 s at 30 fps)

| Time | Beat | What the viewer sees | Product truth |
| --- | --- | --- | --- |
| 0–8.6 | Cold open | A rose dot, a running timecode, two serif lines: *Every click has a reason.* / *Nobody writes it down.* | The judgment between clicks is the missing artefact. |
| 8.6–20.0 | Record | Replay records. The expert opens INV-1048, checks the totals, narrates the rule, approves. Frames, events and the narration transcript land on the strip in real time. | Screen, input events and optional narration are captured on the Mac. |
| 20.0–25.7 | Stop and Build | The recording is saved locally. A boundary panel shows exactly what stays (video, audio, redacted events) and what crosses only when Build is pressed (condensed actions, narration text, selected frames, frame plan). | Raw video and audio never leave the Mac; the model boundary opens only on Build. |
| 25.7–33.6 | Understand | Three step cards develop out of frames 0:03, 0:08 and 0:16, each with its evidence and success check. Step 2 carries the decision point. | Every step links back to the moment it came from. |
| 31.6–41.4 | Review | The decision drops to low confidence. Replay asks: *Should a difference under $1.00 still count as a match?* The reviewer types the rule. The decision becomes high confidence with the rule attached. | Unresolved low-confidence questions block approval; the reviewer's answer becomes part of the workflow. |
| 41.4–46.6 | Approve | Approve workflow. The cards fold into `workflow.v0002.json` with its sha256 and an APPROVED stamp on the downbeat. | Approval is content-hashed and bound to the exact revision. Any edit is a new draft. |
| 46.6–57.1 | Export | One REV 2 node fans into `SKILL.md`, `workflow.ts` with `compile-report.json`, and the computer-use bundle (`system-prompt.md`, `workflow.json`, `run-policy.json`, `manifest.json`, `assets/`). | All three export families come from the same approved revision. |
| 57.1–68.6 | Run and prove | Thursday, a supervised run of rev 2 on the Mac. Fresh screenshots per step. INV-1052 is $980.00 against a $995.00 PO, so the decision takes the NO branch on fresh evidence and flags it. Receipts land on a second strip: `screenshot-01..04.png`, `run.json`. | The runner decides on fresh evidence, pauses at decisions and handoffs, records receipts, and never repeats earlier successful actions. Emergency stop and mouse-pause stay visible. |
| 65.8–68.6 | Verified | Result card: *INV-1052 flagged for follow-up.* A clean test of this exact revision writes `trust.json`; a correction sends it back to draft. | Autonomy is earned per revision by a clean test. |
| 68.6–73.4 | Reveal | The camera pulls all the way back: record, understand, approve, export, run, one timeline. | Replay keeps the whole chain of custody. |
| 73.8–82 | Close | *Now the reason is on the record.* Then the lockup: Ivy · Replay, *Show the work. Teach the agent. Trust the result.* | The teaching layer for agents. |

## Accuracy guardrails

- The recording alone never becomes an agent; the film shows Build, a question, an answer, and an explicit approval before anything runs.
- Not all evidence stays local. The boundary panel states what crosses after Build, and the run sends fresh screenshots for verification.
- The run happens on the Mac, in supervised mode, with the emergency stop shortcut and mouse-pause behaviour on screen.
- The run demonstrates the branch that was never recorded, taken because a human wrote the rule, not because the model guessed.
- Approval, hashing and `trust.json` are shown as the outcome; autonomy is described as per-revision and revocable.

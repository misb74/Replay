# Replay pipeline fixtures

These are deliberately small, text-only stand-ins for recorded sessions.
Model responses are checked in so the understanding pipeline can run offline
and deterministically.

`recordings/invoice-match` is the shared north-star fixture for the real
`@replay/test-app` UI. The recording demonstrates the matching `INV-1048`
path and its narration grounds the untaken `INV-1049` mismatch path.
`full-loop-cases.json` is the machine-readable contract used to execute both
outcomes: `Approve invoice` → `Approved`, and `Flag difference` →
`Needs attention`. The harness selects a case's invoice before it runs the
same pipeline-derived compare-and-decide workflow.

`security/adversarial-secure-leak.jsonl` contains the literal marker
`SHOULD_NOT_SURVIVE`. It is not a credential. It simulates a broken capture
producer so defense-in-depth redaction can prove that the marker never reaches
an action, model request, cache, or error message.

Video and audio binaries are intentionally not committed. Tests inject frame
and transcription providers at those boundaries.

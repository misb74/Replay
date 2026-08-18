# `@replay/pipeline`

Replay's understanding pipeline keeps mechanical preprocessing deterministic
and all interpretation behind an injected structured-model interface.

The main entry point is `UnderstandingPipeline`. It accepts session artifacts
as values, uses injected transcription and frame providers, runs the two
versioned inference passes, and refuses to return a workflow until
`@replay/ir` validates it.

`FixtureModelAdapter` runs the complete flow without a network call. The
fixture cache under `packages/fixtures/model-outputs` is the regression source
for the invoice demo.

Frame providers can return `elementCrops` on a sampled frame. Each crop is
linked to one action, uses a session-relative asset path, and can carry its
screen bounds. The pipeline validates that linkage before the IR adapter adds
the evidence as the target's `screenshotCrop`. Screen-change observations may
also name the action that caused the change, preserving that link when nearby
frame requests are merged.

Security boundaries:

- secure text is redacted again during JSONL ingestion;
- DOM payloads on secure events are discarded;
- condensed secure typing stores only `{ param, vault: true }`;
- parser and model adapter errors never include source or model text;
- API credentials belong to the caller's `ClaudeMessagesTransport` and never
  enter pipeline requests.

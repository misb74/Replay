# Contributing to Replay

Thanks for helping improve Replay. Contributions of code, documentation, tests, bug reports, and product feedback are welcome.

## Before you start

- Search the existing issues before opening a new one.
- For a substantial change, open an issue first so the approach can be discussed.
- Never post recordings, screenshots, workflow files, logs, or credentials that contain private information.
- Report security problems privately by following [SECURITY.md](SECURITY.md).

## Set up the project

Replay development requires macOS 14 or newer, Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`, npm, and Swift 6.

```sh
git clone https://github.com/misb74/Replay.git
cd Replay
npm install
npm run check
```

Copy `.env.example` to `.env` only if you need a model-backed workflow build or visual verification. Keep all keys in `.env`; it is ignored by Git.

## Make a change

1. Create a focused branch from `main`.
2. Keep changes small enough to review and include tests for changed behaviour.
3. Run `npm run check` before opening a pull request.
4. Update the documentation when behaviour, setup, permissions, or privacy boundaries change.
5. Complete the pull request checklist and explain any test you could not run.

Replay handles sensitive screen and input data. Changes to capture, redaction, model requests, approval, execution, or logs should include tests for the relevant safety boundary. The raw recording must remain local, secure-field input must remain redacted, and actions must not run without the required approval and supervision.

## Pull requests

By submitting a pull request, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE). Maintainers may ask for changes when a contribution is unsafe, too broad, or does not have enough test coverage.

All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

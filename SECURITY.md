# Security policy

Replay records screens and can execute approved actions, so security and privacy reports need careful handling.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** option on the repository's Security page to create a private security advisory with the maintainers.

Please include:

- a clear description of the problem and its impact;
- the affected version or commit;
- the smallest safe set of reproduction steps;
- any suggested mitigation; and
- whether the report contains sensitive material.

Do not attach real recordings, secrets, personal data, or unredacted workflow artefacts. Use synthetic examples wherever possible. If sensitive evidence is essential, describe it first and wait for the maintainers to agree on a safe transfer method.

You should receive an acknowledgement within seven days. The maintainers will coordinate validation, a fix, and disclosure timing with you. Please do not disclose the issue publicly until a fix or agreed mitigation is available.

## Supported versions

Security fixes are applied to the latest commit on `main` while Replay is in early development. Tagged release support will be documented here when public releases begin.

## Scope

Examples of security-sensitive behaviour include:

- capture or log data escaping its stated local boundary;
- secrets or secure-field input appearing in recordings, logs, or model requests;
- execution without approval, supervision, or an effective emergency stop;
- permission checks that can be bypassed;
- unsafe generated workflows or exported automation; and
- dependency or build-chain compromise.

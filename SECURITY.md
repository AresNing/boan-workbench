# Security

Boan executes model-requested tools on your computer. Use projects you can restore and review permissions and results.

## Boundaries

- Desktop workers listen on loopback with an application token. The renderer has no Node integration and uses an isolated preload bridge.
- On macOS, project commands use a system sandbox by default. Network permission is scoped. Unsandboxed execution requires explicit one-time approval.
- Direct file tools restrict access to the selected project and exclude common credential paths. Commands do not inherit model API keys.
- Task requirements, permission records, verification, and acceptance are distinct. The model cannot accept its own results on the user's behalf.
- The host does not guarantee that arbitrary project files lack secrets. Read-only task content and attachments may be sent to the selected model provider as part of execution. Review what your task includes.

## Credentials and local files

Desktop data defaults to `~/Library/Application Support/Boan Workbench`. Credentials and task state must not be committed to source control.

ChatGPT sign-in supports system keychain with local-file fallback, a local file, or memory-only credentials. The local fallback file is restricted to the system user but is not additionally encrypted. Claude sign-in storage is managed by its upstream component. API keys use system-protected encrypted storage or memory-only storage.

Imported attachments are copied into `boan-inputs/` in the selected project. This repository ignores that directory; other projects should decide their own sharing policy. Removing an attachment chip does not delete its imported copy.

## Reporting

Do not disclose vulnerabilities or credentials in a public issue. Use the repository's **Security → Report a vulnerability** option for a private report. Include affected versions, impact, and a minimal reproduction using synthetic data. If private reporting is unavailable, open a public issue asking for a private reporting channel without sharing exploit details.

This MVP does not provide a production security guarantee. Binary builds are locally ad-hoc signed, not notarized.

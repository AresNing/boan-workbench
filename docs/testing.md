# Validation

The initial public MVP is version 0.8.0. Validation combines host tests, UI tests, and isolated macOS desktop tests.

## Commands

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:ui
npm run test:desktop
```

The desktop suite requires macOS. It launches hidden windows with temporary application data and local fixture model services. It does not need or use a real model account. Avoid running native tests against your own application data.

## Coverage

- Requirement persistence and acknowledgment, task dependencies, management identities and receipts, auxiliary boundaries, cancellation, handoff and recovery.
- File boundaries, sandbox/permission behavior, independently executed verification, stale evidence and explicit user acceptance.
- SDK/protocol adapters, parameter routing and credential-storage behavior with public synthetic fixtures.
- Project and draft isolation, grouped activity, result previews, attachments, small-window layout, model parameters and unsaved settings.
- Chinese/English UI and settings, preservation of user text, native menu switching, global preference persistence and workers continuing across a language change.
- Package/source consistency, excluded credentials, signing and local release retention are checked for local macOS builds.

Model outputs in integration tests are controlled fixtures. These tests verify host behavior and adapter integration, not the correctness of arbitrary live model output or every third-party service configuration. A local ad-hoc signature is not Apple notarization.

CI runs the backend, build, browser and hidden desktop suites on macOS. See the repository's Actions tab for results on each public commit.

## DeepSeek API (0.8.2)

`tests/deepseek.test.mjs` covers the official default endpoint, encrypted profile and project-setting recovery, provider-key isolation, and SDK-driven planning, streaming execution, verification and restart. The strict fixture rejects OpenAI-only fields and missing reasoning replay. It exercises V4 Flash/Pro and the legacy chat/reasoner aliases. `tests/desktop/deepseek.test.mjs` runs hidden Electron windows with isolated data to check provider defaults, task selection, execution, restart and session-key removal. These checks do not use or establish live DeepSeek account acceptance.

Validated locally on 2026-09-09: 143 host tests, 23 browser UI tests and 15 hidden desktop tests passed. The packaged 0.8.2 Apple Silicon app also passed the isolated DeepSeek desktop test; its changed runtime files match source, credential exclusions were checked and `codesign --verify --deep --strict` passed. The DeepSeek service form was visually inspected from a synthetic background-test screenshot. No external release was published.

## Searchable model settings (0.8.3)

Project API defaults use a searchable single-select picker; shared services use a searchable multi-select picker. Catalogs are read locally through private desktop IPC, without credentials or network calls, and preserve saved model IDs. Custom compatible endpoints can add private IDs from search. The UI tests cover filtering, empty results, keyboard selection, Escape, multi-select, small windows and draft isolation; hidden desktop tests exercise the real catalog and model execution.

Validated locally on 2026-09-09: 143 host tests and all 24 browser UI cases passed. All 15 hidden desktop scenarios and the packaged 0.8.3 DeepSeek scenario passed. The packaged runtime/preload files match source; credential exclusions and strict signature verification passed. The packaged searchable dropdown was visually inspected.

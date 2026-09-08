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

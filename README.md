# Boan Workbench

[简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

A local, task-first AI workbench for macOS. Assign a goal, review decisions and results, and let the workbench handle execution and verification. **Tasks advance automatically; you do not manage chat sessions.**

This is the first public MVP, version **0.8.0**. It is under active development.

## What it does

- Switch projects directly while other projects keep working. Drafts and task contexts stay separate.
- Submit tasks, add requirements, manage dependencies, pause and resume, and explicitly accept verified results.
- Review cross-project attention items, grouped activity, and task details with Overview, Results, and Execution tabs.
- Preview images, Markdown, text, and recorded code changes. Paste screenshots, attach files, or reference project files.
- Choose a model, reasoning effort, speed, and command permission mode from the task composer.
- Use Chinese or English UI, or follow the system language. User content is preserved in its original language.
- Connect via ChatGPT/Codex sign-in, Claude sign-in, or a supported API service. Availability and usage depend on your provider and account.

Boan is an independent project, not affiliated with OpenAI or Anthropic. Provider sign-in uses upstream components and is subject to their availability and terms.

## Run locally

Requirements: **macOS 13+**, **Node.js 22.19+** and npm. Apple Silicon is the primary tested desktop platform. The browser demo can also run on Linux; Windows is not currently supported.

```sh
git clone https://github.com/AresNing/boan-workbench.git
cd boan-workbench
npm ci
npm run build
npm run demo
```

Open [localhost:4317](http://127.0.0.1:4317). Demo mode needs no model account and only writes sample files under `.workbench/demo`. It demonstrates the workflow with limited rule-based requests; it is not a general AI agent.

To start the desktop application:

```sh
npm run desktop
```

Choose **Settings → Project** to select your folder. Configure the project's default connection under **Project model**, and manage shared sign-in and API providers under **Accounts & services**. Change language under **General → Language**. The initial language is Chinese; English and System are available.

For a browser-only API setup, copy `.env.example` to `.env`, fill in your local project and provider configuration, then run `npm start`. Never commit `.env` or credentials.

## Execution and permissions

The main task runs sequentially within each project; different projects can progress concurrently. Dependencies gate downstream work on current verified results or explicit acceptance. Bounded auxiliary work has its own scope; the main executor must review and integrate its results.

On macOS, project commands use the system sandbox by default. Network access requires permission; running outside the sandbox requires one-time approval. You can pause work and revoke future permissions. The host runs verification independently of the model, and the user explicitly accepts results. A passing command only proves what that command checks.

Credentials and project state are stored in application data outside your repository. ChatGPT credentials support keychain with local-file fallback, local-file storage, or memory-only storage. Local-file fallback is restricted to your system user but is not additionally encrypted. See [Security](SECURITY.md).

## Development and tests

```sh
npm test                     # Host and integration tests
npm run build
npx playwright install chromium
npm run test:ui              # Isolated browser UI tests
npm run test:desktop         # macOS only; hidden, isolated Electron tests
npm run desktop:pack         # Local Apple Silicon .app
```

`npm run dev` starts the browser development environment. Desktop tests use temporary projects and local fixture model services; they do not use your real account. End-to-end fixture tests do not guarantee the quality of arbitrary live model output.

Builds go under `release/<version>/`. Only the three newest versions are retained, with protection for running versions. Local builds use ad-hoc signing and are not notarized. Binary installers are not included in this source MVP.

## Current limits

- No Windows support, cloud project synchronization, or collaborative editing. Intel macOS builds are available as a script but are not part of the primary acceptance baseline.
- Imported files: up to 8 per submission, 8 MB each. Removing an attachment removes the reference, not the imported project copy.
- Image preview: up to 8 MB. Text preview: up to 500 KB. Change comparison covers writes recorded by Boan, not arbitrary command edits or historical files.
- UI language changes labels, menus, and notifications; task text and existing model output are not machine-translated. Models are instructed to follow the user's task language. Low-level diagnostics retain their original text.

## Architecture and license

React + Vite render the workbench. Electron provides the macOS shell and credential integration. Independent Node workers manage projects. The pi tool/agent runtime and official Codex/Claude components provide model execution behind host-enforced task and permission boundaries.

See [Architecture](docs/architecture.md) and [Third-party notices](THIRD_PARTY_NOTICES.md). Boan source is released under the [MIT License](LICENSE). Dependencies retain their own licenses.

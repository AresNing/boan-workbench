# Contributing

Thanks for helping improve Boan. Please keep changes task-centered: users should not need to create, name, or manage chat sessions to make progress.

## Workflow

1. Open an issue for substantial changes and describe the user problem.
2. Use Node.js 22.19+ and `npm ci`.
3. Make a focused change and preserve unrelated files and task data.
4. Run `npm test`, `npm run build`, and relevant UI tests. On macOS, run `npm run test:desktop` for desktop changes. Install Chromium with `npx playwright install chromium` before UI tests.
5. Describe the behavior change, validation performed, and known limits in your pull request.

Use temporary projects for tests. Do not submit private credentials, account data, real task records, local model endpoints, or screenshots containing personal information. Do not automatically approve commands or accept results on behalf of users.

## UI and languages

- Keep wording short and functional. Surface decisions and results first; expose details on demand.
- Add UI strings through `tr()` / `t()` and supply the English translation in `shared/en.json`. Chinese strings are the source keys. Keep parameters as `{0}`, `{1}`, etc.; do not translate interpolated user content.
- Pass only application-owned text to `translateSystem`. Never apply it to document contents or user messages.
- Keep Chinese and English README instructions consistent. Test switching languages without clearing drafts or restarting tasks.

By contributing, you agree to license your contribution under the project's MIT License. Third-party code must retain its original notices and compatible distribution terms.

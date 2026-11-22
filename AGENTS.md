# Filter Observatory

## Required reading

- [Workspace policy](../../../../../AGENTS.md)
- [Repository collection policy](../../../../../repos/AGENTS.md)
- [Public-project policy](../../../../../docs/okf/agent-policies/public-project.md)
- Automation category policy: `../AGENTS.md` is currently absent. Read it when restored;
  the linked workspace, collection, and public-project policies remain applicable.
- [Repository layout](../../../../../docs/okf/concepts/repository-layout.md)
- [Instruction conventions](../../../../../docs/okf/concepts/agent-instruction-conventions.md)
- Canonical [project index](../../../../../docs/okf/filter-observatory/index.md) and
  [design](../../../../../docs/okf/filter-observatory/design.md)

## Repository and documentation ownership

This public project is registered at `repos/own/public/automation/filter-observatory` in
`C:\ws\.gitmodules`, with origin `https://github.com/chirag127/filter-observatory.git`.
Preserve its repository identity and submodule registration during local path maintenance.

Canonical research, design, and operational notes belong only in
`C:\ws\docs\okf\filter-observatory\`. Link them from this repository; do not copy research
or create a project-local documentation mirror. Keep `CLAUDE.md` as exactly `@AGENTS.md`
followed by one LF newline.

## Scope and evidence

- The project has an initial implementation under delivery verification. Record
  verified implementation, installation, test, and model capabilities separately;
  the task ledger owns current outcomes and remaining runtime gaps.
- Audit installed content blockers and filter-list maintenance, delivery, compatibility,
  and effectiveness. Keep the audit focused on the recorded blocker/list configuration.
- The selected architecture is a WXT companion extension plus a local worker. Initial
  capture uses Ctrl+Q in the current signed-in Windows Chrome session; the AdGuard Chrome
  extension is the initial audit target.
- Keep top-300 cohorts reproducible: record ranking source/snapshot, selected pages, and
  blocker/list configuration alongside per-site outcomes. Do not imply universal list
  coverage from a bounded audit.
- Keep SAP and other AI providers configurable. A configured model is not evidence of
  working vision or classification; record the capabilities actually validated.
- Eligible automated reporting must follow verified maintainer requirements, deduplicate
  by finding and destination, retain submission receipts, and track follow-up. AdGuard
  findings target `AdguardTeam/AdguardFilters` directly; other destinations require their
  own routing and eligibility evidence.
- Preserve dry-run behavior, idempotency, rate limits, and last-known-good audit data.
  Discovery alone does not authorize live browser/configuration changes, provider calls,
  or upstream submissions; follow the task's explicit live-operation scope.

## Commands

Use the pinned Node release range in `package.json` and `companion/package.json`.
Verified focused checks use `node --test test/<name>.test.mjs`; full-root verification
is `npm test` and `npm run check`, with its completion recorded in the task ledger.
The companion's verified commands are `npm test`, `npm run compile`, `npm run build`,
`npm run build:firefox`, `npm run zip`, and `npm run zip:firefox`, from `companion/`.
Reuse matching package/test receipts rather than rebuilding because a session restarted.

Setup, local configuration and live-operation commands belong in the canonical
[operations guide](../../../../../docs/okf/filter-observatory/operations.md).
Live verification scripts require explicit opt-in and fresh evidence directories;
inspect their previous receipts before retrying. Do not infer commands from shared
scheduled-job policies.

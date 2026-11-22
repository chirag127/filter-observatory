# Filter Observatory

AI-assisted audits of installed content blockers and their filter lists: maintenance,
delivery, compatibility, and real-world effectiveness.

**Status: initial implementation; live readiness is partial.** Companion packages,
controlled current-Chrome capture, and desktop/narrow dashboard flows have verification
evidence. The pinned Tranco 46YVX cohort has 300 recorded attempts: **170 captures,
129 failures and one preserved cancellation**. Cleanup and historical-evidence preservation
passed; filter effectiveness remains unassessed. Native companion installation/Ctrl+Q and live upstream
delivery remain unverified. SAP production classification did not meet its bounded
qualification criteria. See the [delivery ledger](../../../../../docs/okf/filter-observatory/tasks/2026-11-21-initial-delivery.md)
for revision-bound checks, remaining work, and resumable run state.

## Workflow

- **Capture:** the WXT companion implements a Chrome-focused **Ctrl+Q** command,
  tab/document attribution checks, an offline queue, and authenticated worker delivery.
  The audit adapter captures owned tabs in the current signed-in **Windows Chrome**.
- **Inspect:** the local dashboard exposes captured evidence, measured context and
  redaction annotations, catalog health, per-site outcomes, and report receipts.
- **Compare:** import a pinned ranked manifest of up to **300 original entries** and
  resume it with durable outcomes. Authorized whole-extension AdGuard comparisons
  retain restoration journals. Per-list control is currently unsupported.
- **Classify:** configurable Chat Completions providers return validated findings using
  supplied image/text citations. Missing evidence, unusable pages, refusals and provider
  failures remain distinct from a capture with no observed issue.
- **Report and follow up:** owner-specific eligibility, deduplication, paced publication,
  uncertain-send reconciliation, and receipt-linked follow-up are implemented. Fresh
  installations keep provider calls, browser changes, and publication disabled.

Eligible AdGuard-specific findings target
[AdguardTeam/AdguardFilters](https://github.com/AdguardTeam/AdguardFilters) directly.
Other findings require the relevant list maintainer's supported route and evidence.
Observed effectiveness is specific to the recorded browser, list configuration,
pages and times; catalog maintenance and lexical compatibility checks are separate.

## Get started

Use Node.js **22.22.2+, 24.15+, or 26+** on the supported release lines. Runtime
captures, settings, tokens and SQLite data live outside this public checkout.
The canonical [setup and operations guide](../../../../../docs/okf/filter-observatory/operations.md)
covers installation, worker pairing, configuration, annotations and reproducible runs.
Run `node src/cli.mjs --help` for the implemented CLI.

## Canonical documentation

Workspace-relative links to the single-source OKF notes:

- [Project index](../../../../../docs/okf/filter-observatory/index.md)
- [Design](../../../../../docs/okf/filter-observatory/design.md)
- [Module interfaces](../../../../../docs/okf/filter-observatory/module-contracts.md)
- [Verification and continuation](../../../../../docs/okf/filter-observatory/tasks/2026-11-21-initial-delivery.md)

## License

[MIT](LICENSE)

<footer class="hire-me">
  <h3>Hire me</h3>
  <p>Chirag Singhal: building free, open APIs and tools.</p>
  <p>
    <a href="mailto:chirag@oriz.in">chirag@oriz.in</a> ·
    <a href="https://github.com/chirag127">GitHub</a> ·
    <a href="https://www.linkedin.com/in/chirag127/">LinkedIn</a> ·
    <a href="https://x.com/singhal127">X</a> ·
    <a href="https://www.youtube.com/@ChiragSinghal127">YouTube</a> ·
    <a href="https://www.instagram.com/chiragsinghal127/">Instagram</a> ·
    <a href="https://www.reddit.com/user/Far_Macaron_9910/">Reddit</a> ·
    <a href="https://buymeacoffee.com/chirag127">Buy me a coffee</a>
  </p>
</footer>

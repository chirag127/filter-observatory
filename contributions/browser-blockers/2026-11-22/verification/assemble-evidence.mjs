// Local artifact assembly only. This script does not execute the preserved verifiers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
assert.ok(process.argv[2] && process.argv[3], 'Supply the original task root and contribution output root');
assert.equal(path.basename(outputRoot), '2026-11-22');
const scriptFile = fileURLToPath(import.meta.url);
assert.equal(path.resolve(outputRoot, 'verification/assemble-evidence.mjs'), scriptFile);
const startedAt = new Date().toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const originals = new Map();
const inventory = [];
const actions = [];
const gaps = [];
const screenshotMappings = [];
const receiptPath = path.join(sourceRoot, 'browser-blocker-artifact-preparation.json');
assert.ok(!existsSync(receiptPath), 'Reconcile an existing preparation receipt before starting another assembly');
const readOriginal = relative => {
    if (!originals.has(relative)) {
        const bytes = readFileSync(path.join(sourceRoot, relative));
        originals.set(relative, { bytes, path: relative, sha256: digest(bytes) });
    }
    return originals.get(relative);
};
const jsonOriginal = relative => JSON.parse(readOriginal(relative).bytes.toString('utf8'));
const unix = value => value.replaceAll('\\', '/');
const userRoot = unix(sourceRoot).match(/^([A-Za-z]:\/Users\/[^/]+)/)?.[1];
const workspaceRoot = unix(outputRoot).split('/repos/')[0];
const roots = [
    [path.join(sourceRoot, 'AdguardBrowserExtension'), '${ADGUARD_ROOT}'],
    [path.join(sourceRoot, 'uBlock'), '${UBLOCK_ROOT}'],
    [path.join(sourceRoot, 'uBOL-home'), '${UBOL_DISTRIBUTION_ROOT}'],
    [sourceRoot, '${TASK_ROOT}'],
    [path.join(workspaceRoot, 'repos/own/public/automation/filter-observatory/node_modules'), '${JSDOM_MODULE_ROOT}'],
    [workspaceRoot, '${WORKSPACE_ROOT}'],
    [path.dirname(process.execPath), '${NODE_HOME}'],
    ...(userRoot ? [
        [path.join(userRoot, 'AppData/Roaming/npm/node_modules/@playwright/test'), '${PLAYWRIGHT_TEST_ROOT}'],
        [path.join(userRoot, 'AppData/Local/ms-playwright'), '${PLAYWRIGHT_BROWSER_ROOT}'],
        [path.join(userRoot, '.local/share/opencode'), '${TOOL_OUTPUT_ROOT}'],
        [userRoot, '${USER_HOME}'],
    ] : []),
].sort((a, b) => b[0].length - a[0].length);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rootPatterns = roots.map(([root, token]) => [
    new RegExp(unix(root).split('/').map(escapeRegex).join('[\\\\/]+'), 'gi'), token,
]);
function projectText(value) {
    let text = value;
    for (const [pattern, token] of rootPatterns) text = text.replace(pattern, token);
    text = text.replace(/(\$\{[A-Z_]+\})([^\s"'<>]*)/g, (_, root, tail) => root + unix(tail));
    text = text.replace(/https?:\/\/[^/\s"'<>]*\.int\.[^/\s"'<>]+\/npm\/npm-internal/gi, '${ADGUARD_INTERNAL_REGISTRY}');
    text = text.replace(/https?:\/\/[^/\s"'<>]*\.int\.[^/\s"'<>]+/gi, '${PRIVATE_SERVICE_ORIGIN}');
    return text.replace(/\b(?:ses|sh)_[A-Za-z0-9_-]+/g, '<execution-id-removed>')
        .replace(/\(node:\d+\)/g, '(node:<process-id-removed>)')
        .replace(/\bPID\s*[:=]?\s*\d+\b/gi, 'PID:<process-id-removed>');
}
const identityKeys = new Set([
    'pid', 'ppid', 'process_id', 'processId', 'job_id', 'jobId', 'shell_id', 'shellID',
    'session_id', 'sessionID', 'owner_session', 'duplicate_session', 'extension_id',
    'running_jobs', 'running_agents', 'job_disposition', 'skill_sources', 'skills', 'authorization',
]);
function project(value, omitted, prefix = '') {
    if (typeof value === 'string') return projectText(value);
    if (Array.isArray(value)) return value.map((item, i) => project(item, omitted, `${prefix}[${i}]`));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
            const field = prefix ? `${prefix}.${key}` : key;
            if (identityKeys.has(key)) { omitted.push(field); return []; }
            if (typeof item === 'string' && projectText(item).includes('${TOOL_OUTPUT_ROOT}')) {
                omitted.push(field);
                return [];
            }
            return [[projectText(key), project(item, omitted, field)]];
        }));
    }
    return value;
}
function publicTextCheck(text, relative) {
    assert.ok(!/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/m.test(text), `Absolute host path in ${relative}`);
    assert.ok(!/\b(?:ses|sh)_[A-Za-z0-9_-]+/.test(text), `Execution identity in ${relative}`);
    assert.ok(!/https?:\/\/[^/\s"'<>]*\.int\./i.test(text), `Private service URL in ${relative}`);
    if (userRoot) assert.ok(!text.includes(userRoot.split('/').at(-1)), `Local user identity in ${relative}`);
    assert.ok(!/npm_[A-Za-z0-9]{12,}/.test(text), `Unredacted token in ${relative}`);
}
function save(relative, bytes, provenance, text = true) {
    assert.ok(['patches', 'licenses', 'verification', 'screenshots'].includes(relative.split('/')[0]));
    const destination = path.join(outputRoot, relative);
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (text) publicTextCheck(data.toString('utf8'), relative);
    let action = 'created';
    if (existsSync(destination)) {
        assert.ok(readFileSync(destination).equals(data), `Different pre-existing artifact preserved: ${relative}`);
        action = 'reused_matching';
    } else {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, data, { flag: 'wx' });
    }
    assert.ok(readFileSync(destination).equals(data), `Write verification failed: ${relative}`);
    const role = relative.startsWith('patches/') ? 'accepted_contribution_patch'
        : relative.startsWith('licenses/') ? 'original_upstream_license'
        : relative.startsWith('screenshots/') ? 'recorded_browser_screenshot'
        : relative.endsWith('.mjs.txt') ? 'nonexecuted_verifier_source_reference'
        : relative.endsWith('distribution-sha256.json') ? 'original_distribution_input_inventory'
        : relative.endsWith('coverage-summary.json') ? 'derived_coverage_and_reference_index'
        : provenance.kind.includes('log') ? 'recorded_log_projection' : 'verification_receipt_projection';
    inventory.push({ path: relative, role, bytes: data.length, sha256: digest(data), provenance });
    actions.push({ path: relative, action });
}
const sourceInfo = original => ({ task_relative_path: original.path, sha256: original.sha256, bytes: original.bytes.length });
function copy(relative, destination, expectedHash, extra = {}) {
    const original = readOriginal(relative);
    assert.equal(original.sha256, expectedHash, `Original hash changed: ${relative}`);
    save(destination, original.bytes, { kind: 'exact_original_bytes', ...sourceInfo(original), ...extra }, !destination.endsWith('.png'));
}
function projection(relative, destination, fields, notes = [], transform) {
    const original = readOriginal(relative);
    const input = JSON.parse(original.bytes.toString('utf8'));
    const omitted = fields ? Object.keys(input).filter(key => !fields.includes(key)) : [];
    const selected = fields ? Object.fromEntries(fields.filter(key => key in input).map(key => [key, input[key]])) : input;
    const evidence = project(transform ? transform(selected) : selected, omitted);
    const wrapper = {
        schema_version: 1, kind: 'sanitized_verification_projection', source: sourceInfo(original),
        projection: {
            original_bytes_preserved: false, host_paths: 'Named portable placeholders replace local roots; original commands otherwise retained.',
            execution_identities: 'Session, process, extension-instance and job identifiers removed.',
            private_endpoints: 'Internal service origins replaced by named placeholders; package identity and failure outcome retained.',
            hash_semantics: 'Hashes inside evidence retain their original input/raw-artifact meaning. They are not hashes of these projected public files.',
            omitted_fields: omitted, not_reexecuted: true,
            reference_semantics: 'Embedded filenames refer to the original task layout. Public mappings and unshipped dependencies are recorded in coverage-summary.json.',
            notes,
        },
        evidence,
    };
    const text = JSON.stringify(wrapper, null, 2) + '\n';
    assert.deepEqual(JSON.parse(text).evidence, evidence);
    save(destination, text, { kind: 'sanitized_projection', ...sourceInfo(original), original_bytes_preserved: false });
}
function logProjection(relative, destination, format, summary, selectLines) {
    const original = readOriginal(relative);
    const lines = original.bytes.toString('utf8').split(/\r?\n/);
    const selected = selectLines ? lines.flatMap((text, i) => selectLines(text) ? [{ line: i + 1, text }] : []) : null;
    const content = selected ? selected.map(item => item.text).join('\n') : original.bytes.toString('utf8');
    const output = {
        schema_version: 1, kind: 'sanitized_log_projection', source: sourceInfo(original),
        projection: { original_bytes_preserved: false, host_path_redaction: true, execution_identity_redaction: true, private_endpoint_redaction: true, not_reexecuted: true,
            hash_semantics: 'source.sha256 identifies the original raw log; this projection has its own public-file hash in the inventory.',
            selection: selected ? 'Only the recorded dependency-access failure lines; installation progress and authentication configuration omitted.' : 'Complete log with only host-path and execution-identity projection.',
            selected_source_lines: selected?.map(item => item.line) ?? null },
        evidence: { format, summary, content: projectText(content) },
    };
    save(destination, JSON.stringify(output, null, 2) + '\n', { kind: 'sanitized_log_projection', ...sourceInfo(original), original_bytes_preserved: false });
}

const agRed = jsonOriginal('adguard-preflight-red.json');
const agGreen = jsonOriginal('adguard-preflight-green.json');
const agRequired = jsonOriginal('adguard-required-checks.json');
const agDependency = jsonOriginal('adguard-dependencies-attempt-2.json');
const lite = jsonOriginal('ubol-verification-supplement.json');
const browser = jsonOriginal('ubol-browser-supplement-receipt.json');
const lint = jsonOriginal('ubol-lint-supplement-receipt.json');
assert.equal(readOriginal('ubol-verification-supplement.json').sha256, '1dfaf5392907da3ab6ec62cd74fb11502c7c7bf1db05ff24ebb34a8a9fb072a5');
assert.deepEqual([agRed.passed, agRed.failed, agRed.exit_code], [8, 1, 1]);
assert.deepEqual([agGreen.passed, agGreen.failed, agGreen.exit_code], [9, 0, 0]);
assert.ok(agRequired.results.length === 2 && agRequired.results.every(item => item.value.exit_code === 1));
assert.equal(agDependency.lock_sha256_before, agDependency.lock_sha256_after);
assert.equal(agDependency.exit_code, 1);
for (const [relative, hash] of Object.entries(agGreen.inputs)) {
    assert.equal(digest(readFileSync(path.join(sourceRoot, 'AdguardBrowserExtension', relative))), hash);
}
for (const [relative, hash] of Object.entries(lite.accepted_inputs)) {
    assert.equal(digest(readFileSync(path.resolve(sourceRoot, 'uBlock', relative))), hash);
    assert.equal(browser.accepted_inputs_before[relative], hash);
    assert.equal(browser.accepted_inputs_after[relative], hash);
    assert.equal(lint.hashes_before[relative], hash);
    assert.equal(lint.hashes_after[relative], hash);
}
const baseline = browser.variants.find(item => item.name === 'baseline');
const patched = browser.variants.find(item => item.name === 'patched');
const busyBaseline = baseline.cases.filter(item => item.observed.busy).map(item => item.id);
assert.deepEqual(busyBaseline, ['read-error', 'native-read-abort', 'read-synchronous-throw', 'restore-storage-rejection', 'reset-storage-rejection']);
assert.equal(baseline.cases.length, 10);
assert.equal(patched.cases.length, 10);
assert.ok(patched.cases.every(item => item.status === 'passed' && !item.observed.busy && item.page_errors.length === 0 && item.observed.probe.unhandled.length === 0));
assert.ok(browser.variants.every(item => item.cleanup.context_close_event && !item.cleanup.browser_connected_after_close && item.cleanup.profile_removed));
assert.deepEqual([lint.focused_lint_exit_code, lint.upstream_lint_exit_code], [0, 1]);
assert.ok(lint.focused_results.every(item => item.errorCount === 0 && item.warningCount === 0));
const fullLint = readOriginal('ubol-upstream-lint-supplement.log').bytes.toString('utf8');
assert.equal((fullLint.match(/\berror\s+'(?:chrome|browser)' is not defined\s+no-undef/g) ?? []).length, 73);
const tapSummary = relative => {
    const text = readOriginal(relative).bytes.toString('utf8');
    return Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => [key, Number(text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1])]));
};
assert.deepEqual(tapSummary('ubol-red.tap'), { tests: 13, pass: 6, fail: 7, cancelled: 0, skipped: 0 });
for (const file of ['ubol-green-final.tap', 'ubol-package-dom-final.tap']) assert.deepEqual(tapSummary(file), { tests: 13, pass: 13, fail: 0, cancelled: 0, skipped: 0 });

copy('adguard-optional-stealth-import.patch', 'patches/adguard-optional-stealth-import.patch', '6154353ae7266b2ec9b0cff0c8d9a4ddb3f036e8f25854de37996d7b1cf36ca1', {
    upstream_repository: 'AdguardTeam/AdguardBrowserExtension', base_commit: '6beedf03743d53691162a11541360071cce5e55a',
    upstream_paths: ['Extension/src/pages/options/components/General/General.tsx', 'tests/src/pages/options/components/General/General.test.tsx'],
});
copy('ubol-settings-recovery.patch', 'patches/ubol-settings-recovery.patch', '78640595d49f8f85bfe7e6a12d309aa253585048463a1cdbbe4b5370e9ad5996', {
    upstream_repository: 'gorhill/uBlock', base_commit: '5934db2a0437a50182c4a8f3da2e0941cf806253',
    upstream_paths: ['platform/mv3/extension/js/settings.js', 'platform/mv3/tests/settings-recovery.test.mjs'],
});
for (const [relative, destination, rawHash, normalizedHash, url] of [
    ['AdguardBrowserExtension/LICENSE', 'licenses/adguard-GPL-3.0.txt', '230184f60bae2feaf244f10a8bac053c8ff33a183bcc365b4d8b876d2b7f4809', '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986', 'https://github.com/AdguardTeam/AdguardBrowserExtension/blob/6beedf03743d53691162a11541360071cce5e55a/LICENSE'],
    ['uBlock/LICENSE.txt', 'licenses/ublock-GPL-3.0.txt', '1b728b9ca80a6ea27fb9348c902dacf88b7fc7b12e22b693f4cb88bc8358985b', 'e73d33841f942fa73aa5a63d4a6399cc39a29564db1dbca0915485842fcb236d', 'https://github.com/gorhill/uBlock/blob/5934db2a0437a50182c4a8f3da2e0941cf806253/LICENSE.txt'],
]) {
    assert.equal(digest(readOriginal(relative).bytes.toString('utf8').replaceAll('\r\n', '\n')), normalizedHash);
    copy(relative, destination, rawHash, { upstream_url: url, upstream_lf_text_sha256: normalizedHash });
}
const agFields = ['status', 'observed_date', 'repository', 'checkout', 'base_commit', 'branch', 'initial_worktree', 'initial_lock_sha256', 'selected_correction', 'selected_contract_evidence', 'formal_spec_coverage', 'deferred_comma_investigation', 'operations', 'regression_state', 'offline_red_receipt', 'offline_green_receipt', 'required_checks_intent', 'patch_export_intent', 'review', 'final_files', 'worktree_disposition', 'deliverables', 'remaining_blockers'];
projection('adguard-implementation.json', 'verification/adguard-implementation.json', agFields, ['Helper red/green and TSX syntax only; full lint/tests were blocked. The deferred comma investigation is not a delivered fix or a packaged patch.']);
const liteFields = ['status', 'last_verified_at', 'final_patch_export', 'final_input_sha256', 'final_green_result', 'final_package_dom_result', 'independent_review', 'static_result', 'red_result', 'implementation_choice', 'task', 'repo', 'base', 'head_at_start', 'branch', 'origin', 'initial_dirty_state', 'tool_versions', 'root_cause', 'reachability', 'verification_limits'];
projection('ubol-implementation.json', 'verification/ubol-implementation.json', liteFields, ['Historical implementation handoff. The later verification supplement supersedes the old missing-lint and native-browser coverage gaps only to its stated scope.']);
const simpleReceipts = ['adguard-patch-receipt.json', 'adguard-preflight-red.json', 'adguard-preflight-green.json', 'adguard-required-checks.json', 'adguard-dependencies-attempt-2.json', 'adguard-toolchain.json', 'ubol-patch-receipt.json', 'ubol-red-receipt.json', 'ubol-green-final-receipt.json', 'ubol-package-dom-final-receipt.json', 'ubol-static-receipt.json', 'ubol-lint-supplement-receipt.json', 'ubol-dependencies-supplement-receipt.json'];
for (const relative of simpleReceipts) {
    const notes = [];
    if (relative === 'ubol-red-receipt.json' || relative === 'ubol-static-receipt.json') notes.push('Historical test hash precedes the final explicit node:process import. Retain its recorded input binding; final green and focused lint receipts bind the final test bytes.');
    if (relative === 'ubol-patch-receipt.json') notes.push('The referenced static receipt binds unchanged production source but an earlier test hash. Final source/overlay green and focused lint receipts bind the final regression-test bytes.');
    projection(relative, `verification/${relative}`, null, notes);
}
projection('ubol-verification-supplement.json', 'verification/ubol-verification-supplement.json', ['schema_version', 'status', 'last_verified_at', 'repo', 'base', 'distribution_base', 'branch', 'accepted_inputs', 'reused_evidence', 'completed_review', 'tooling_observation', 'dependency_result', 'lint_result', 'browser_result', 'screenshots', 'artifact_hashes', 'handoff', 'recovery_budget', 'limitations'], ['The 10 baseline matches are characterization outcomes including five stuck-busy failures, not product passes.']);
projection('ubol-browser-supplement-receipt.json', 'verification/ubol-browser-supplement-receipt.json', null, ['Baseline status passed means expected baseline behavior matched, including stuck busy. Only the patched 10 cases are recovery-regression passes.', 'copy_differences and copied_files describe pre-launch inputs. Retained fixture directories later gained Chromium-generated metadata; those directories are not part of this package.']);
logProjection('adguard-dependencies-attempt-2.log', 'verification/adguard-dependency-error.json', 'selected-install-log', { exit_code: 1, failure: 'ERR_PNPM_FETCH_403', locked_dependency: '@adguard/dnr-rulesets@6.1.1', frozen_lock_unchanged: true }, line => line.includes('ERR_PNPM_FETCH_403') || line.includes('No authorization header was set'));
for (const name of ['lint', 'test']) logProjection(`adguard-required-${name}.log`, `verification/adguard-required-${name}-log.json`, 'command-output', { exit_code: 1, checks_executed: false, reason: `${name === 'lint' ? 'eslint' : 'vitest'} executable unavailable after blocked frozen install` });
for (const phase of ['red', 'green-final', 'package-dom-final']) logProjection(`ubol-${phase}.tap`, `verification/ubol-${phase}-tap.json`, 'tap', tapSummary(`ubol-${phase}.tap`));
logProjection('ubol-upstream-lint-supplement.log', 'verification/ubol-upstream-lint-log.json', 'eslint-output', { exit_code: 1, errors: 73, warnings: 0, rule: 'no-undef', affected_bindings: ['chrome', 'browser'], attribution: 'Unchanged tracked files at the recorded base; focused changed-file lint passed.' });
const canonicalScreenshots = new Map();
for (const image of lite.screenshots) {
    const relative = image.path;
    const original = readOriginal(relative);
    assert.equal(original.sha256, image.sha256, `Screenshot changed: ${relative}`);
    let canonical = canonicalScreenshots.get(image.sha256);
    if (!canonical) {
        const basename = path.basename(relative).replace(/^baseline-(valid-restore|confirmed-reset)/, '$1');
        canonical = `screenshots/ubol-${basename}`;
        copy(relative, canonical, image.sha256);
        canonicalScreenshots.set(image.sha256, canonical);
    }
    screenshotMappings.push({ case: image.case, source: sourceInfo(original), public_path: canonical, public_sha256: image.sha256, exact_bytes: true });
}
copy('ubol-browser-ueQrVG/distribution-sha256.json', 'verification/ubol-distribution-sha256.json', '41dbd770c259e0ba2bb95886bc193496c015d1a211e9a20594563a1887ea91d4');
for (const relative of ['adguard-verify-preflight.mjs', 'adguard-final-checks.mjs', 'ubol-verify.mjs', 'ubol-browser-supplement.mjs', 'ubol-lint-supplement.mjs']) {
    const original = readOriginal(relative);
    const header = { kind: 'verifier_source_reference_projection', source: sourceInfo(original), host_path_redaction: true, execution_identity_redaction: true, private_endpoint_redaction: true, not_reexecuted: true, executable_as_packaged: false, note: 'Text reference only. Restore original task-relative layout and replace symbolic roots before any separately authorized reproduction.' };
    save(`verification/harnesses/${relative}.txt`, `/* ${JSON.stringify(header)} */\n${projectText(original.bytes.toString('utf8'))}`, { kind: 'verifier_reference_projection', ...sourceInfo(original), original_bytes_preserved: false, not_reexecuted: true });
}
gaps.push(
    'Preserved commands refer to the original task layout. Harnesses are .mjs.txt references, not executed or certified portable after path projection.',
    'Dependencies, upstream checkout trees, browser binaries/profiles and fixture extension directories are not packaged. Reproduction needs separately provisioned matching versions.',
    'Original helper and command logs can cite earlier task-owned receipt files that are not essential to this package; original source hashes and scope are retained.',
    'The AdGuard comma-investigation.patch reference is historical and explicitly deferred; that exploratory patch is not included.',
    'The uBO Lite static/red receipts use the earlier test hash; final greens and focused lint use the final explicit node:process-import test hash.',
    'The original distribution inventory has 933 pre-launch files. Prior read-only artifact inspection observed 56 additional generated-index metadata files in each retained fixture directory; only the original inventory is packaged.',
    'The independent supplement-review assignment returned conversation observations only before packaging superseded that scope. This package preserves their boundaries but does not invent a separate reviewer receipt.'
);
const summary = {
    schema_version: 1, kind: 'derived_coverage_and_reference_index', not_reexecuted: true,
    adguard: { base: '6beedf03743d53691162a11541360071cce5e55a', helper_red: { passed: 8, total: 9, exit_code: 1 }, helper_green: { passed: 9, total: 9, exit_code: 0 }, full_checks: 'blocked before lint/type/test execution by incomplete frozen dependency installation; internal ruleset URL returned HTTP 403', independent_review: 'Specific source diff and matching helper receipts; no full-suite or browser approval.' },
    ubol: { base: '5934db2a0437a50182c4a8f3da2e0941cf806253', distribution_base: '7a2e2fa8b79395d38b2c6f9098754f0037b0f6a7', host_red: tapSummary('ubol-red.tap'), source_dom_green: tapSummary('ubol-green-final.tap'), distribution_dom_green: tapSummary('ubol-package-dom-final.tap'), focused_lint: { errors: 0, warnings: 0, exit_code: 0 }, full_lint: { errors: 73, warnings: 0, exit_code: 1, unchanged_files: true }, chromium_overlay: { patched_cases: 10, patched_passed: 10, baseline_characterization_cases: 10, baseline_expected_outcomes_matched: 10, baseline_stuck_busy_cases: busyBaseline, baseline_product_pass_claim: false, cleanup: 'Both context-close events and profile removals recorded; absence corroborated by prior read-only artifact inspection.' }, independent_review: 'Initial production/host evidence review resolved one test-only Node import finding. Prior read-only supplement inspection corroborated counts, input hashes, failure boundaries and screenshots; no tests replayed and no separate supplement-review receipt produced.' },
    limitations: ['Browser run uses a one-file overlay on a pinned distribution, not a rebuilt or signed extension.', 'Reader errors and selected page-local storage rejections are controlled injections; abort calls native FileReader.abort. Successful browser paths use the actual fixture extension runtime.', 'Recovery releases dashboard busy state. Sequential restore can already have applied earlier preferences; atomicity, rollback and complete prior-settings preservation are not established.', 'No installed-user browser, cross-browser, effectiveness or performance claim follows from these checks.'],
    placeholders: { ...Object.fromEntries(roots.map(([, token]) => [token, 'Operator-supplied local root; original value redacted'])), '${ADGUARD_INTERNAL_REGISTRY}': 'Access-controlled upstream dependency registry; original origin withheld.', '${PRIVATE_SERVICE_ORIGIN}': 'Private service origin withheld.' },
    screenshot_mappings: screenshotMappings,
    original_to_public: inventory.filter(item => item.provenance.task_relative_path).map(item => ({ source: item.provenance.task_relative_path, source_sha256: item.provenance.sha256, public_path: item.path, public_sha256: item.sha256, kind: item.provenance.kind })),
    reference_gaps: gaps,
};
save('verification/coverage-summary.json', JSON.stringify(summary, null, 2) + '\n', { kind: 'derived_from_completed_receipts', newly_executed_tests: 0, original_sources: [...originals.values()].filter(item => /\.(json|tap|log)$/.test(item.path)).map(sourceInfo) });
const scriptBytes = readFileSync(scriptFile);
inventory.push({ path: 'verification/assemble-evidence.mjs', role: 'local_packaging_utility', bytes: scriptBytes.length, sha256: digest(scriptBytes), provenance: { kind: 'local_packaging_utility', runs_tests_or_browser: false } });
for (const item of inventory) assert.equal(digest(readFileSync(path.join(outputRoot, item.path))), item.sha256);
for (const original of originals.values()) assert.equal(digest(readFileSync(path.join(sourceRoot, original.path))), original.sha256, `Original changed during packaging: ${original.path}`);
const receipt = {
    schema_version: 1, status: 'complete', started_at: startedAt, completed_at: new Date().toISOString(),
    command: [process.execPath, scriptFile, sourceRoot, outputRoot], operation: 'Local copying, projection and hash/fact validation only',
    source_root: sourceRoot, public_root: outputRoot, writer_scope: ['patches/', 'licenses/', 'verification/', 'screenshots/'],
    upstream_source_mutations: false, git_mutations: false, remote_calls: false, tests_or_browser_replayed: false,
    inventory, actions, screenshot_mappings: screenshotMappings, reference_gaps: gaps, newly_executed_tests: 0,
    sanitizer: { raw_receipts_unchanged: true, projections_identified: true, original_raw_sha256_retained: true, portable_root_placeholders: true, private_service_origins_withheld: true, execution_identities_omitted: true, source_harnesses_nonexecuted_text: true },
    applicability_evidence: 'Reused accepted input-matching AdGuard Git diff/apply checks and uBO Lite reverse-apply receipt; no new Git command or index mutation.',
    prior_scope_disposition: 'Earlier scopes produced this task-owned assembler and conversation-only supplement-review observations. The assembler was reconciled and updated to the latest scope; no packaged artifact set or separate temp review receipt existed at reconciliation.',
    parent_owned_paths: ['NOTICE.txt', 'manifest.json', 'README files', 'request publication receipts', 'canonical notes'],
    ownership_released: true, running_jobs: [],
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: receipt.status, files: inventory.length, bytes: inventory.reduce((sum, item) => sum + item.bytes, 0), receipt: receiptPath, receipt_sha256: digest(readFileSync(receiptPath)), reference_gaps: gaps, ownership_released: true }, null, 2));

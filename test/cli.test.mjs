import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqlite from 'node:sqlite';
import { openStore } from '../src/store.mjs';
import { captureFixture } from './helpers/core-fixtures.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-cli-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, [cli, ...args, '--state-dir', directory], {
        encoding: 'utf8',
        timeout: 20000,
      }),
    );
  return { directory, run };
}

test('CLI initializes local state without exposing the token and persists an ingested capture', (t) => {
  const { directory, run } = fixture(t);
  const initialized = run('init');
  const token = readFileSync(initialized.tokenPath, 'utf8').trim();
  assert.equal(JSON.stringify(initialized).includes(token), false);
  const file = join(directory, 'fixture.json');
  writeFileSync(file, JSON.stringify(captureFixture()));
  assert.equal(run('ingest', file).duplicate, false);
  assert.equal(run('ingest', file).duplicate, true);
  assert.equal(run('status').totals.captures, 1);
  assert.equal(run('config').provider.enabled, false);
});

test('CLI errors are nonzero and do not echo malformed evidence', (t) => {
  const { directory, run } = fixture(t);
  run('init');
  const file = join(directory, 'bad.json');
  writeFileSync(file, '{"token":"sensitive-fixture"');
  const child = spawnSync(process.execPath, [cli, 'ingest', file, '--state-dir', directory], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(child.status, 1);
  assert.equal((child.stdout + child.stderr).includes('sensitive-fixture'), false);
  assert.equal(run('status').totals.captures, 0);
});

test('CLI imports source-attributed annotations without re-ingesting a capture', (t) => {
  const { directory, run } = fixture(t);
  run('init');
  const capture = captureFixture();
  const file = join(directory, 'capture.json');
  writeFileSync(file, JSON.stringify(capture));
  run('ingest', file);
  const annotationFile = join(directory, 'notes.json');
  writeFileSync(
    annotationFile,
    JSON.stringify({
      source: 'Fixture observation',
      observedAt: '2026-11-21T16:01:00.000Z',
      context: {},
      images: [],
    }),
  );
  assert.match(run('annotate', capture.id, annotationFile).revision, /^[a-f0-9]{64}$/);
  assert.equal(run('status').totals.captures, 1);
});

test('CLI corpus imports preserve embedded provenance and apply only explicit overrides', async (t) => {
  const { directory, run } = fixture(t);
  run('init');
  const file = join(directory, 'corpus.json');
  const snapshot = { listId: 'FIXED1', createdOn: '2026-11-21T00:00:00Z', sha256: 'b'.repeat(64) };
  const entries = [{ rank: 1, domain: 'example.com', url: 'https://example.com/article' }];
  for (const { name, input, args, source, expectedSnapshot } of [
    {
      name: 'embedded source and snapshot',
      input: { source: 'tranco', snapshot, entries },
      args: [],
      source: 'tranco',
      expectedSnapshot: snapshot,
    },
    {
      name: 'source-only override',
      input: { source: 'tranco', snapshot, entries },
      args: ['--source', 'operator-check'],
      source: 'operator-check',
      expectedSnapshot: snapshot,
    },
    {
      name: 'snapshot-only override',
      input: { source: 'tranco', snapshot, entries },
      args: ['--snapshot', 'fixed-override'],
      source: 'tranco',
      expectedSnapshot: 'fixed-override',
    },
    {
      name: 'both explicit overrides',
      input: { source: 'tranco', snapshot, entries },
      args: ['--source', 'operator-check', '--snapshot', 'fixed-override'],
      source: 'operator-check',
      expectedSnapshot: 'fixed-override',
    },
    {
      name: 'absent metadata retains parser defaults',
      input: entries,
      args: [],
      source: 'manual',
      expectedSnapshot: null,
    },
  ]) {
    await t.test(name, () => {
      writeFileSync(file, JSON.stringify(input));
      const imported = run('corpus', 'import', file, ...args);
      assert.equal(imported.corpus.source, source);
      assert.deepEqual(imported.corpus.snapshot, expectedSnapshot);
      assert.equal(imported.corpus.entries[0].url, 'https://example.com/article');
      const store = openStore(directory);
      try {
        assert.equal(store.run(imported.id).corpus.source, source);
        assert.deepEqual(store.run(imported.id).corpus.snapshot, expectedSnapshot);
      } finally {
        store.close();
      }
    });
  }
});

const browserOne = '11111111111111111111111111111111';
const browserTwo = '22222222222222222222222222222222';
const adguard = 'bgnkhhnnamicmpeenaelnjfhikgbkllg';

function recoverySnapshot(browser) {
  return {
    schemaVersion: 1,
    kind: 'filter-observatory-comparison',
    comparisonId: `recovery-${browser}`,
    browser: { instance: browser, name: 'Chrome', version: '158' },
    url: 'https://example.com/',
    createdAt: '2026-11-21T00:00:00Z',
    phase: 'adguard-off',
    isolateUbol: true,
    original: [{ id: adguard, name: 'AdGuard', version: '5.5', enabled: true }],
    intent: [{ id: adguard, enabled: false }],
    restore: [{ id: adguard, enabled: true }],
  };
}

function recover(directory, outcomes = {}) {
  // Keep CLI, worker, recovery and SQLite real; replace only the external sctl subprocess.
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const outcomes = JSON.parse(process.argv[2]);
    const enabled = new Map();
    childProcess.execFile = (file, args, options, callback) => {
      const browser = args[args.indexOf('--browser') + 1];
      const inventory = ['extensions', 'list', '--browser', browser, '-o', 'json'];
      const enable = ['extensions', 'enable', ${JSON.stringify(adguard)}, '--browser', browser];
      let body;
      if (!['sctl', 'sctl.exe'].includes(file) || !Object.hasOwn(outcomes, browser)) {
        return callback(Object.assign(new Error('Unexpected subprocess'), { code: 'fixture_unexpected_command' }));
      }
      if (JSON.stringify(args) === JSON.stringify(inventory)) {
        body = { items: [{ id: ${JSON.stringify(adguard)}, name: 'AdGuard', version: '5.5', enabled: enabled.get(browser) === true }] };
      } else if (JSON.stringify(args) === JSON.stringify(enable)) {
        if (outcomes[browser] === 'restored') enabled.set(browser, true);
        body = {};
      } else {
        return callback(Object.assign(new Error('Unexpected command arguments'), { code: 'fixture_unexpected_command' }));
      }
      queueMicrotask(() => callback(null, JSON.stringify(body), ''));
    };
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
    await main(['recover', '--state-dir', process.argv[1]]);
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script, directory, JSON.stringify(outcomes)],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  return { ...child, results: JSON.parse(child.stdout) };
}

test('CLI recovery is nonzero for a failed browser, retains its recovery data and permits a later retry', async (t) => {
  const { directory, run } = fixture(t);
  run('init');
  const store = openStore(directory);
  try {
    for (const browser of [browserOne, browserTwo]) {
      await store.journal(browser).write(recoverySnapshot(browser));
      store.acquireLease(`browser:${browser}`, `interrupted-${browser}`);
    }
  } finally {
    store.close();
  }
  const failed = recover(directory, { [browserOne]: 'restored', [browserTwo]: 'failed' });
  assert.equal(failed.results.find((item) => item.browser === browserOne).result.state, 'restored');
  const result = failed.results.find((item) => item.browser === browserTwo).result;
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'restoration_mismatch');
  const pending = openStore(directory);
  try {
    assert.deepEqual(pending.journals(), [
      { name: browserTwo, snapshot: recoverySnapshot(browserTwo) },
    ]);
    assert.deepEqual(
      pending.leases().map(({ name, owner }) => ({ name, owner })),
      [{ name: `browser:${browserTwo}`, owner: `interrupted-${browserTwo}` }],
    );
  } finally {
    pending.close();
  }
  assert.equal(failed.status, 1);
  assert.equal(run('status').recoveryRequired, true);
  const retry = recover(directory, { [browserTwo]: 'restored' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(retry.results[0].result.state, 'restored');
  const recovered = openStore(directory);
  try {
    assert.deepEqual(recovered.journals(), []);
    assert.deepEqual(recovered.leases(), []);
  } finally {
    recovered.close();
  }
  const noWork = recover(directory);
  assert.equal(noWork.status, 0, noWork.stderr);
  assert.deepEqual(noWork.results, []);
});

test('CLI recovery does not call a retained null journal a successful no-op', async (t) => {
  const { directory, run } = fixture(t);
  run('init');
  const store = openStore(directory);
  try {
    await store.journal(browserOne).write(null);
  } finally {
    store.close();
  }
  const child = recover(directory);
  assert.equal(child.results[0].result.state, 'not-needed');
  const pending = openStore(directory);
  try {
    assert.deepEqual(pending.journals(), [{ name: browserOne, snapshot: null }]);
  } finally {
    pending.close();
  }
  assert.equal(child.status, 1);
});

test('CLI recovery is nonzero when storage retains a browser lease without a journal', (t) => {
  const { directory, run } = fixture(t);
  run('init');
  const store = openStore(directory);
  try {
    store.acquireLease(`browser:${browserOne}`, 'interrupted-owner');
  } finally {
    store.close();
  }
  const Database = sqlite.Database ?? sqlite.DatabaseSync;
  const database = new Database(join(directory, 'observatory.sqlite'));
  try {
    database.exec(`CREATE TRIGGER retain_recovery_lease BEFORE DELETE ON leases
      WHEN OLD.name = 'browser:${browserOne}' BEGIN SELECT RAISE(IGNORE); END;`);
  } finally {
    database.close();
  }
  const child = recover(directory);
  assert.deepEqual(child.results, []);
  const pending = openStore(directory);
  try {
    assert.deepEqual(pending.journals(), []);
    assert.deepEqual(
      pending.leases().map(({ name, owner }) => ({ name, owner })),
      [{ name: `browser:${browserOne}`, owner: 'interrupted-owner' }],
    );
  } finally {
    pending.close();
  }
  assert.equal(child.status, 1);
});

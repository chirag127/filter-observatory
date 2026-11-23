import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  checkFeed,
  checkMaintenance,
  discoverCatalog,
  fetchPublicBytes,
  importCatalog,
  validatePublicUrl,
} from '../src/catalog.mjs';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/catalog/${name}.json`, import.meta.url), 'utf8'));
const observedAt = '2026-11-21T00:00:00.000Z';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const network = (fetchImpl, options = {}) => ({ fetchImpl, lookupImpl: publicLookup, ...options });
const response = (body, status = 200, headers = {}) =>
  new Response(
    typeof body === 'object' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body,
    { status, headers },
  );
const feed = (urls, variants = []) => ({ id: 'manual:list:sample', downloadUrls: urls, variants });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('FilterLists preserves native identities, original names, mirrors and declared relationships', async () => {
  const raw = await fixture('filterlists');
  raw.push({
    id: 9001,
    name: 'EasyList',
    dependencyFilterListIds: [301],
    includesFilterListIds: [242],
    viewUrls: [
      { segmentNumber: 1, primariness: 1, url: 'https://example.com/part-one.txt' },
      { segmentNumber: 2, primariness: 1, url: 'https://example.com/part-two.txt' },
    ],
  });
  const original = structuredClone(raw);
  const result = importCatalog('filterlists', raw, { snapshot: 'fixed', retrievedAt: observedAt });
  assert.deepEqual(
    result.records.map((record) => record.id),
    ['filterlists:list:301', 'filterlists:list:9001'],
  );
  assert.equal(result.records[0].name, 'EasyList');
  assert.equal(result.records[0].owner, 'easylist/easylist');
  assert.equal(result.records[0].snapshot, 'fixed');
  assert.equal(result.records[0].retrievedAt, observedAt);
  assert.equal(result.records[0].variants[1].role, 'mirror');
  assert.deepEqual(
    result.records[1].variants.map((variant) => variant.segmentNumber),
    [1, 2],
  );
  assert.ok(
    result.records[1].dependencies.some(
      (dependency) =>
        dependency.id === 'filterlists:list:301' && dependency.relationship === 'requires',
    ),
  );
  assert.ok(
    result.records[1].dependencies.some(
      (dependency) =>
        dependency.id === 'filterlists:list:242' && dependency.relationship === 'includes',
    ),
  );
  assert.deepEqual(raw, original);
  assert.deepEqual(result.records[0].raw, raw[0]);
  assert.deepEqual(result.errors, []);
});

test('uBO counts filter memberships independently from shared URLs, CDN locations and internal assets', async () => {
  const result = importCatalog('ubo', await fixture('ubo'));
  assert.equal(result.records.length, 3);
  assert.equal(result.counts.input, 4);
  assert.equal(result.counts.skipped, 1);
  const [first, second, adguard] = result.records;
  assert.notEqual(first.id, second.id);
  assert.equal(first.downloadUrls[0], second.downloadUrls[0]);
  assert.equal(first.owner, 'uBlockOrigin/uAssets');
  assert.equal(first.sourcePath, 'filters/annoyances-cookies.txt');
  assert.equal(first.status.offByDefault, true);
  assert.equal(first.status.disabled, null);
  assert.ok(second.variants.some((variant) => variant.kind === 'local-fallback'));
  assert.ok(second.variants.some((variant) => variant.kind === 'patch'));
  assert.ok(
    second.downloadUrls.every((url) => !url.startsWith('assets/') && !url.endsWith('/filters/')),
  );
  assert.ok(adguard.downloadUrls[0].endsWith('2_without_easylist.txt'));
  assert.equal(adguard.owner, 'AdguardTeam/AdguardFilters');
});

test('AdGuard preserves deprecated versus disabled and registry versus authoring paths', () => {
  const result = importCatalog('adguard', [
    {
      path: 'filters/filter_15_DnsFilter/metadata.json',
      metadata: {
        filterId: 15,
        name: 'AdGuard DNS filter',
        deprecated: true,
        subscriptionUrl: 'https://filters.adtidy.org/extension/chromium/filters/15.txt',
        platformsExcluded: ['ext_chromium_mv3'],
      },
    },
    {
      path: 'filters/filter_24_QuickFixes/metadata.json',
      metadata: {
        filterId: 24,
        name: '(Obsolete) AdGuard Quick Fixes filter',
        disabled: true,
        tags: ['obsolete'],
      },
    },
    {
      path: 'filters/ThirdParty/filter_101_EasyList/metadata.json',
      metadata: {
        filterId: 101,
        name: 'EasyList',
        homepage: 'https://easylist.to/',
        subscriptionUrl: 'https://filters.adtidy.org/extension/chromium/filters/101.txt',
      },
    },
  ]);
  assert.equal(result.records[0].status.deprecated, true);
  assert.equal(result.records[0].status.disabled, null);
  assert.equal(result.records[1].status.disabled, true);
  assert.equal(result.records[1].status.deprecated, null);
  assert.equal(result.records[0].owner, 'AdguardTeam/AdguardFilters');
  assert.equal(result.records[0].sourcePath, undefined);
  assert.equal(result.records[0].registryPath, 'filters/filter_15_DnsFilter/metadata.json');
  assert.notEqual(result.records[2].owner, 'AdguardTeam/AdguardFilters');
  assert.ok(
    result.records[0].variants.some(
      (variant) =>
        variant.kind === 'platform-policy' && variant.excluded.includes('ext_chromium_mv3'),
    ),
  );
});

test('deduplication uses source keys and reports conflicting records without name-based merging', () => {
  const one = {
    id: 1,
    name: 'Same name',
    viewUrls: [{ url: 'https://example.com/list.txt', segmentNumber: 1, primariness: 1 }],
  };
  const result = importCatalog('filterlists', [
    one,
    structuredClone(one),
    { ...one, name: 'Conflicting name' },
    { ...one, id: 2 },
    null,
  ]);
  assert.equal(result.records.length, 2);
  assert.equal(result.counts.input, 5);
  assert.equal(result.counts.duplicates, 2);
  assert.equal(result.counts.conflicts, 1);
  assert.equal(result.counts.invalid, 1);
  assert.equal(
    result.counts.input,
    result.counts.records +
      result.counts.duplicates +
      result.counts.invalid +
      result.counts.skipped,
  );
  assert.ok(result.errors.some((error) => error.code === 'conflicting-id'));
});

test('manual imports retain variants, dependencies and unknown facts while rejecting unsafe download targets', () => {
  const result = importCatalog('manual', [
    {
      id: 'edition',
      name: 'Official | Edition',
      family: 'Official',
      owner: 'author/project',
      sourcePath: 'lists/edition.txt',
      variants: [{ kind: 'edition', name: 'small' }],
      dependencies: [{ id: 'manual:list:base', relationship: 'requires' }],
      downloadUrls: [
        'https://example.com/list.txt',
        'https://example.com:443/list.txt',
        'http://127.1/list',
        'javascript:alert(1)',
      ],
    },
  ]);
  assert.equal(result.records[0].id, 'manual:list:edition');
  assert.deepEqual(result.records[0].downloadUrls, ['https://example.com/list.txt']);
  assert.equal(result.records[0].name, 'Official | Edition');
  assert.equal(result.records[0].variants[0].name, 'small');
  assert.equal(result.records[0].dependencies[0].id, 'manual:list:base');
  assert.equal(result.records[0].status.deprecated, null);
  assert.equal(result.errors.filter((error) => error.code === 'unsafe-url').length, 2);
  assert.equal(result.records[0].raw.downloadUrls.length, 4);
});

test('invalid JSON and unsupported sources produce explicit source-level errors', () => {
  assert.equal(importCatalog('filterlists', '{broken').errors[0].code, 'invalid-json');
  assert.equal(importCatalog('unknown', []).errors[0].code, 'unsupported-source');
});

test('public URL validation rejects private, credentialed, malformed and special-use destinations', () => {
  const rejected = [
    'http://localhost/',
    'http://LOCALHOST./',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://10.2.3.4/',
    'http://172.16.0.1/',
    'http://192.168.0.1/',
    'http://169.254.169.254/',
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://192.0.2.1/',
    'http://224.0.0.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[2001:db8::1]/',
    'https://corp.internal/',
    'https://printer.local/',
    'http://intranet/',
    'https://user:password@example.com/',
    'file:///etc/passwd',
    'https:example.com',
    'https://example.com\\@elsewhere.com',
    'https://exa\nmple.com',
  ];
  for (const url of rejected)
    assert.throws(() => validatePublicUrl(url), { code: 'unsafe-url' }, url);
  assert.equal(
    validatePublicUrl('https://EXAMPLE.com.:443/list.txt').href,
    'https://example.com/list.txt',
  );
  assert.equal(
    validatePublicUrl('https://[2606:4700:4700::1111]/').hostname,
    '[2606:4700:4700::1111]',
  );
});

test('public retrieval records redirects, bytes, digest and response validators', async () => {
  const body = '[Adblock Plus 2.0]\n||ads.example.com^\n';
  const fetched = await fetchPublicBytes(
    'https://example.com/old.txt',
    network(async (url, options) => {
      assert.equal(options.redirect, 'manual');
      return String(url).endsWith('/old.txt')
        ? response(null, 302, { location: '/new.txt' })
        : response(body, 200, {
            'content-type': 'text/plain',
            etag: '"one"',
            'last-modified': 'Fri, 20 Nov 2026 00:00:00 GMT',
          });
    }),
  );
  assert.equal(fetched.body.toString(), body);
  assert.equal(fetched.provenance.finalUrl, 'https://example.com/new.txt');
  assert.equal(fetched.provenance.redirects.length, 1);
  assert.equal(fetched.provenance.sha256, sha256(body));
  assert.equal(fetched.provenance.bytes, Buffer.byteLength(body));
  assert.equal(fetched.provenance.headers.etag, '"one"');
});

test('DNS and every redirect are validated before dispatch, including mixed public/private DNS answers', async () => {
  let dispatched = 0;
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(
        async () => {
          dispatched++;
          return response('unexpected');
        },
        {
          lookupImpl: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
          ],
        },
      ),
    ),
    { code: 'unsafe-address' },
  );
  assert.equal(dispatched, 0);
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => {
        dispatched++;
        return response(null, 302, { location: 'http://169.254.169.254/latest' });
      }),
    ),
    { code: 'unsafe-url' },
  );
  assert.equal(dispatched, 1);
});

test('retrieval bounds streamed bodies, redirects, stalled clients and cancellation', async () => {
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => response('123456'), { maxBytes: 5 }),
    ),
    { code: 'too-large' },
  );
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => response(null, 302, { location: '/loop' }), { maxRedirects: 1 }),
    ),
    (error) => ['redirect-limit', 'redirect-loop'].includes(error.code),
  );
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => new Promise(() => {}), { timeoutMs: 20 }),
    ),
    { code: 'timeout' },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => response('unused'), { signal: controller.signal }),
    ),
    { code: 'cancelled' },
  );
});

test('feed checks validate actual bodies and leave compatibility and effectiveness unknown', async () => {
  const body =
    '! Title: fixture\n[Adblock Plus 2.0]\n||ads.example.com^\n@@||good.example.com^\nexample.com##.sponsor\n';
  const result = await checkFeed(
    feed(['https://example.com/list']),
    network(async () => response(body, 200, { 'content-type': 'text/plain' })),
  );
  assert.equal(result.delivery.state, 'available');
  assert.equal(result.format.state, 'valid');
  assert.equal(result.format.method, 'lexical');
  assert.equal(result.format.ruleCount, 3);
  assert.equal(result.compatibility.state, 'unknown');
  assert.equal(result.effectiveness.state, 'unknown');
  assert.equal(result.segments[0].digest.sha256, sha256(body));
});

test('HTTP failures and HTML masquerading as a list never become valid feed results', async () => {
  const html = await checkFeed(
    feed(['https://example.com/list']),
    network(async () =>
      response('<!doctype html><html><body>Sign in</body></html>', 200, {
        'content-type': 'text/plain',
      }),
    ),
  );
  assert.equal(html.delivery.state, 'available');
  assert.equal(html.format.state, 'invalid');
  assert.equal(html.segments[0].format.reason, 'html-body');
  const failed = await checkFeed(
    feed(['https://example.com/list']),
    network(async () => response('Try later', 429, { 'retry-after': '120' })),
  );
  assert.equal(failed.delivery.state, 'unavailable');
  assert.equal(failed.format.state, 'unknown');
  assert.equal(failed.attempts[0].provenance.status, 429);
  assert.equal(failed.attempts[0].provenance.headers.retryAfter, '120');
});

test('ordered fingerprints ignore ordinary comments but retain preprocessing, exceptions and rule order', async () => {
  const check = async (body) =>
    (
      await checkFeed(
        feed(['https://example.com/list']),
        network(async () => response(body)),
      )
    ).segments[0].digest;
  const base =
    '! Last modified: yesterday\n! ordinary comment\n!#if env_chromium\n||ads.example.com^\n@@||good.example.com^\n!#endif\n';
  const one = await check(base);
  const two = await check(
    base.replace('yesterday', 'today').replace('ordinary comment', 'another comment'),
  );
  assert.notEqual(one.sha256, two.sha256);
  assert.equal(one.semanticSha256, two.semanticSha256);
  assert.notEqual(
    one.semanticSha256,
    (await check(base.replace('env_chromium', 'env_firefox'))).semanticSha256,
  );
  assert.notEqual(
    one.semanticSha256,
    (
      await check(
        base.replace(
          '||ads.example.com^\n@@||good.example.com^',
          '@@||good.example.com^\n||ads.example.com^',
        ),
      )
    ).semanticSha256,
  );
});

test('required multipart segments are assessed independently and incomplete coverage is visible', async () => {
  const record = importCatalog('filterlists', [
    {
      id: 9,
      name: 'Multipart',
      viewUrls: [
        { segmentNumber: 1, primariness: 1, url: 'https://example.com/one' },
        { segmentNumber: 1, primariness: 2, url: 'https://example.net/one' },
        { segmentNumber: 2, primariness: 1, url: 'https://example.com/two' },
      ],
    },
  ]).records[0];
  const result = await checkFeed(
    record,
    network(async (url) =>
      String(url).endsWith('/two') ? response('Gone', 410) : response('||ads.example.com^\n'),
    ),
  );
  assert.equal(result.segments.length, 2);
  assert.equal(result.delivery.state, 'partial');
  assert.equal(result.format.state, 'partial');
  assert.equal(result.counts.requiredSegments, 2);
  assert.equal(result.counts.availableSegments, 1);
  assert.equal(result.counts.requests, 2);
});

test('feed URL budgets retain skipped work rather than silently claiming full coverage', async () => {
  const record = feed(['https://example.com/first', 'https://example.com/second']);
  const result = await checkFeed(
    record,
    network(async () => response('unavailable', 503), { maxRequests: 1 }),
  );
  assert.equal(result.counts.requests, 1);
  assert.equal(result.counts.skippedUrls, 1);
  assert.ok(result.errors.some((error) => error.code === 'request-budget'));
});

test('FilterLists discovery hydrates summary records and accounts for partial detail failures', async () => {
  const result = await discoverCatalog(
    'filterlists',
    network(
      async (url) => {
        const path = new URL(url).pathname;
        if (path === '/lists')
          return response([
            { id: 1, name: 'One' },
            { id: 2, name: 'Two' },
            { id: 3, name: 'Three' },
          ]);
        if (path === '/lists/1')
          return response({
            id: 1,
            name: 'One',
            viewUrls: [{ url: 'https://example.com/one', segmentNumber: 1, primariness: 1 }],
          });
        if (path === '/lists/2') return response('Unavailable', 503);
        throw new Error('Unexpected request.');
      },
      { maxRequests: 3, snapshot: 'observed-api' },
    ),
  );
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].downloadUrls.length, 1);
  assert.equal(result.records[1].downloadUrls.length, 0);
  assert.equal(result.counts.discovered, 3);
  assert.equal(result.counts.requests, 3);
  assert.equal(result.counts.failedRequests, 1);
  assert.equal(result.counts.skippedRequests, 1);
  assert.equal(result.counts.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'http-error'));
  assert.ok(result.errors.some((error) => error.code === 'request-budget'));
});

test('AdGuard discovery follows enumerated metadata paths with bounds and tree-truncation evidence', async () => {
  const result = await discoverCatalog(
    'adguard',
    network(
      async (url) => {
        if (new URL(url).hostname === 'api.github.com')
          return response({
            sha: 'tree-pin',
            truncated: true,
            tree: [
              { type: 'blob', path: 'filters/filter_2_Base/metadata.json' },
              { type: 'blob', path: 'filters/ThirdParty/filter_101_EasyList/metadata.json' },
              { type: 'blob', path: 'README.md' },
            ],
          });
        if (String(url).includes('filter_2_Base'))
          return response({
            filterId: 2,
            name: 'AdGuard Base filter',
            subscriptionUrl: 'https://filters.adtidy.org/extension/chromium/filters/2.txt',
          });
        return response('Missing', 404);
      },
      { snapshot: '9411fe35873a0fed21ac99dddeff903e59ecffc1', maxRequests: 3 },
    ),
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'adguard:filter:2');
  assert.equal(result.counts.discovered, 2);
  assert.equal(result.counts.failedRequests, 1);
  assert.equal(result.counts.unresolved, 1);
  assert.equal(result.counts.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'source-truncated'));
});

test('discovery failures keep source-level counts and never appear as an empty successful catalog', async () => {
  const result = await discoverCatalog(
    'ubo',
    network(async () => response('<html>Not JSON</html>')),
  );
  assert.equal(result.records.length, 0);
  assert.equal(result.counts.requests, 1);
  assert.equal(result.counts.complete, false);
  assert.equal(result.errors[0].code, 'invalid-json');
});

test('maintenance collects path-specific commits and archive facts without converting recency into function', async () => {
  const result = await checkMaintenance(
    {
      id: 'manual:list:x',
      owner: 'example/project',
      sourcePath: 'lists/a b.txt',
      status: { deprecated: null, disabled: false },
    },
    network(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/commits')) {
        assert.equal(parsed.searchParams.get('path'), 'lists/a b.txt');
        assert.equal(parsed.searchParams.get('per_page'), '1');
        return response([
          {
            sha: 'a'.repeat(40),
            html_url: 'https://github.com/example/project/commit/' + 'a'.repeat(40),
            commit: { committer: { date: '2026-11-20T00:00:00Z' }, message: 'Update timestamp' },
          },
        ]);
      }
      return response({
        id: 123,
        full_name: 'example/project',
        archived: true,
        disabled: false,
        pushed_at: '2026-11-20T00:00:00Z',
        updated_at: '2026-11-21T00:00:00Z',
        default_branch: 'main',
      });
    }),
  );
  assert.equal(result.repository.archived, true);
  assert.equal(result.repository.id, 123);
  assert.equal(result.path.state, 'observed');
  assert.equal(result.path.latestCommit.message, 'Update timestamp');
  assert.ok(result.unknowns.includes('substantive-rule-change'));
  assert.ok(result.unknowns.includes('effectiveness'));
  assert.equal(result.effective, undefined);
  assert.equal(result.working, undefined);
});

test('maintenance with unknown ownership does not manufacture an activity failure or send requests', async () => {
  const result = await checkMaintenance(
    { id: 'manual:list:unknown' },
    network(async () => {
      assert.fail('Unknown ownership must not dispatch.');
    }),
  );
  assert.equal(result.repository.state, 'unknown');
  assert.equal(result.path.state, 'unknown');
  assert.ok(result.unknowns.includes('owner'));
});

test('explicit source revisions and custom URLs never inherit an unrelated default snapshot', async () => {
  const raw = await fixture('ubo');
  const body = JSON.stringify(raw);
  const revision = 'a'.repeat(40);
  const pinned = await discoverCatalog(
    'ubo',
    network(
      async (url) => {
        assert.ok(String(url).includes(`/${revision}/assets/assets.json`));
        return response(body);
      },
      { ref: revision },
    ),
  );
  assert.ok(pinned.records.every((record) => record.snapshot === revision));
  const url = 'https://publisher.example.com/assets.json';
  const custom = await discoverCatalog(
    'ubo',
    network(
      async (requested) => {
        assert.equal(String(requested), url);
        return response(body);
      },
      { url },
    ),
  );
  assert.deepEqual(custom.records[0].snapshot, { url, sha256: sha256(body) });
});

test('an unsafe detail endpoint preserves the discovered catalog and accounts for each unresolved identity', async () => {
  const result = await discoverCatalog(
    'filterlists',
    network(
      async () =>
        response([
          { id: 1, name: 'One' },
          { id: 2, name: 'Two' },
        ]),
      {
        detailBaseUrl: 'http://127.0.0.1/lists',
      },
    ),
  );
  assert.equal(result.records.length, 2);
  assert.equal(result.counts.requests, 1);
  assert.equal(result.counts.unresolved, 2);
  assert.equal(result.unresolved.length, 2);
  assert.equal(result.counts.complete, false);
  assert.equal(result.errors.filter((error) => error.code === 'unsafe-url').length, 2);
});

test('hydration is deduplicated without concealing conflicting summary identities', async () => {
  let details = 0;
  const result = await discoverCatalog(
    'filterlists',
    network(async (url) => {
      if (new URL(url).pathname === '/lists')
        return response([
          { id: 1, name: 'Original' },
          { id: 1, name: 'Conflicting' },
        ]);
      details++;
      return response({
        id: 1,
        name: 'Original',
        viewUrls: [{ url: 'https://example.com/list', segmentNumber: 1, primariness: 1 }],
      });
    }),
  );
  assert.equal(details, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].name, 'Original');
  assert.equal(result.counts.discovered, 2);
  assert.equal(result.counts.duplicates, 1);
  assert.equal(result.counts.conflicts, 1);
  assert.ok(result.errors.some((error) => error.code === 'conflicting-id'));
  assert.equal(result.counts.complete, false);
});

test('rate-limited discovery retains every summary and defers further reads to that origin', async () => {
  const result = await discoverCatalog(
    'filterlists',
    network(
      async (url) => {
        if (new URL(url).pathname === '/lists')
          return response([
            { id: 1, name: 'One' },
            { id: 2, name: 'Two' },
          ]);
        return response('Slow down', 429, { 'retry-after': '60' });
      },
      { concurrency: 1 },
    ),
  );
  assert.equal(result.records.length, 2);
  assert.equal(result.counts.requests, 2);
  assert.equal(result.counts.failedRequests, 1);
  assert.equal(result.counts.skippedRequests, 1);
  assert.equal(result.counts.unresolved, 2);
  assert.equal(result.counts.complete, false);
  assert.equal(result.errors[0].provenance.headers.retryAfter, '60');
  assert.ok(result.errors.some((error) => error.code === 'rate-limited'));
});

test('unknown enumeration and successful empty enumeration have different denominators', async () => {
  const failed = await discoverCatalog(
    'filterlists',
    network(async () => response('unavailable', 503)),
  );
  assert.equal(failed.counts.discovered, null);
  assert.equal(failed.counts.enumerationComplete, false);
  assert.equal(failed.counts.complete, false);
  const empty = await discoverCatalog(
    'filterlists',
    network(async () => response([])),
  );
  assert.equal(empty.counts.discovered, 0);
  assert.equal(empty.counts.enumerationComplete, true);
  assert.equal(empty.counts.complete, true);
});

test('transport rejects unsolicited partial bodies and clients that silently followed redirects', async () => {
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => response('part', 206)),
    ),
    { code: 'partial-response' },
  );
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => response('short', 200, { 'content-length': '10' })),
    ),
    { code: 'truncated-body' },
  );
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/list',
      network(async () => ({
        status: 200,
        headers: new Headers(),
        redirected: true,
        url: 'https://other.example.com/',
        body: null,
      })),
    ),
    { code: 'unverified-redirect' },
  );
});

test('shared byte and redirect budgets bound all requests and keep partial-source evidence', async () => {
  const budget = { limit: 1, requests: 0, bytes: 0, maxTotalBytes: 100 };
  await assert.rejects(
    fetchPublicBytes(
      'https://example.com/start',
      network(async () => response(null, 302, { location: '/end' }), { budget }),
    ),
    { code: 'request-budget' },
  );
  assert.equal(budget.requests, 1);
  const result = await discoverCatalog(
    'filterlists',
    network(
      async (url) =>
        new URL(url).pathname === '/lists'
          ? response([{ id: 1, name: 'One' }])
          : response('x'.repeat(128)),
      { maxTotalBytes: 64, concurrency: 1 },
    ),
  );
  assert.equal(result.records.length, 1);
  assert.equal(result.counts.unresolved, 1);
  assert.equal(result.counts.complete, false);
  assert.ok(result.errors.some((error) => error.code === 'byte-budget'));
});

test('a usable partial mirror is retained when an earlier mirror is HTML', async () => {
  const result = await checkFeed(
    feed(['https://example.com/original', 'https://example.net/mirror']),
    network(async (url) =>
      String(url).endsWith('/original')
        ? response('<html>Login</html>')
        : response('||ads.example.com^\nnot a filter rule\n'),
    ),
  );
  assert.equal(result.attempts.length, 2);
  assert.equal(result.format.state, 'partial');
  assert.equal(result.segments[0].delivery.url, 'https://example.net/mirror');
  assert.equal(result.segments[0].format.ruleCount, 1);
  assert.equal(result.segments[0].format.unknownLines, 1);
  assert.equal(result.counts.complete, false);
});

test('empty lists, templates, hosts and engine directives preserve distinct lexical results', async () => {
  const inspect = async (body) =>
    checkFeed(
      feed(['https://example.com/list']),
      network(async () => response(body)),
    );
  assert.equal((await inspect('')).segments[0].format.reason, 'empty-body');
  assert.equal((await inspect('! Title: An intentionally quiet list\n')).format.state, 'unknown');
  const template = await inspect('!#include child.txt\n');
  assert.equal(template.segments[0].format.reason, 'unresolved-template');
  assert.equal(template.compatibility.state, 'unknown');
  const hosts = await inspect('0.0.0.0 ads.example.com tracker.example.com\n');
  assert.equal(hosts.format.state, 'valid');
  assert.equal(hosts.segments[0].format.kinds.hosts, 1);
  const one = await inspect('!+ NOT_OPTIMIZED\n||ads.example.com^\n');
  const two = await inspect('||ads.example.com^\n');
  assert.notEqual(one.segments[0].digest.semanticSha256, two.segments[0].digest.semanticSha256);
});

test('maintenance retains repository facts when path history fails and never queries repository-wide commits', async () => {
  const result = await checkMaintenance(
    { id: 'manual:list:x', owner: 'example/project', sourcePath: 'list.txt' },
    network(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/commits')) {
        assert.equal(parsed.searchParams.get('path'), 'list.txt');
        return response('Try later', 503);
      }
      return response({ id: 123, full_name: 'example/project', archived: false });
    }),
  );
  assert.equal(result.repository.state, 'observed');
  assert.equal(result.repository.archived, false);
  assert.equal(result.path.state, 'unknown');
  assert.equal(result.counts.complete, false);
  assert.ok(result.unknowns.includes('list-path-activity'));
  assert.equal(result.errors[0].provenance.status, 503);
});

test('stalled WHATWG bodies are cancelled and unlocked on timeout and external cancellation', async () => {
  for (const mode of ['timeout', 'cancelled']) {
    const controller = new AbortController();
    let cancellations = 0;
    const body = new ReadableStream(
      {
        pull() {
          if (mode === 'cancelled') controller.abort();
          return new Promise(() => {});
        },
        cancel() {
          cancellations++;
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      fetchPublicBytes(
        'https://example.com/list',
        network(async () => new Response(body), {
          timeoutMs: 20,
          signal: controller.signal,
        }),
      ),
      { code: mode },
    );
    assert.equal(cancellations, 1, mode);
    assert.equal(body.locked, false, mode);
  }
});

test('hydrated detail content participates in snapshot identity, including named snapshots', async () => {
  const acquire = (edition, snapshot) =>
    discoverCatalog(
      'filterlists',
      network(
        async (url) =>
          new URL(url).pathname === '/lists'
            ? response([{ id: 1, name: 'One' }])
            : response({
                id: 1,
                name: 'One',
                viewUrls: [
                  { url: `https://example.com/${edition}.txt`, segmentNumber: 1, primariness: 1 },
                ],
              }),
        { snapshot, retrievedAt: observedAt },
      ),
    );
  for (const snapshot of [undefined, 'operator-label']) {
    const first = await acquire('one', snapshot);
    const changed = await acquire('two', snapshot);
    const repeat = await acquire('one', snapshot);
    assert.equal(first.counts.complete, true);
    assert.equal(changed.counts.complete, true);
    assert.notDeepEqual(first.records[0].downloadUrls, changed.records[0].downloadUrls);
    assert.notDeepEqual(first.records[0].snapshot, changed.records[0].snapshot);
    assert.deepEqual(first.records[0].snapshot, repeat.records[0].snapshot);
  }
});

test('in-flight cancellation is accounted as a dispatched cancelled request, never a success or skip', async () => {
  const controller = new AbortController();
  const result = await checkFeed(
    feed(['https://example.com/list']),
    network(
      async () => {
        controller.abort();
        return new Promise(() => {});
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(result.counts.requests, 1);
  assert.equal(result.counts.successfulRequests, 0);
  assert.equal(result.counts.failedRequests, 0);
  assert.equal(result.counts.cancelledRequests, 1);
  assert.equal(result.counts.skippedRequests, 0);
  assert.equal(result.counts.fetchedResources, 0);
  assert.equal(result.errors[0].code, 'cancelled');
  assert.equal(result.counts.complete, false);
});

test('HTML-looking filter comments stay valid while actual HTML bodies are rejected', async () => {
  const inspect = (body) =>
    checkFeed(
      feed(['https://example.com/list']),
      network(async () => response(body)),
    );
  const result = await inspect(
    '! Example markup: <html>\n# Explanation of <body>\n[Adblock Plus 2.0]\n||ads.example.com^\n',
  );
  assert.equal(result.format.state, 'valid');
  assert.equal(result.format.ruleCount, 1);
  const html = await inspect('  \n<!-- error document -->\n<html><body>Sign in</body></html>');
  assert.equal(html.format.state, 'invalid');
  assert.equal(html.segments[0].format.reason, 'html-body');
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { fetchTrancoCorpus, parseCorpus } from '../src/corpus.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const pages = (corpus) =>
  corpus.entries.map(({ rank, domain, url, ordinal }) => ({ rank, domain, url, ordinal }));

test('retains original ranks and order while canonicalizing homepage and explicit page URLs', () => {
  const input = [
    { rank: 41, domain: 'Example.com' },
    { rank: 10, url: 'https://News.Example.org:443/story?a=1#comments' },
    'bücher.de',
  ];
  const original = structuredClone(input);
  const corpus = parseCorpus(input);
  assert.deepEqual(pages(corpus), [
    { rank: 41, domain: 'example.com', url: 'https://example.com/', ordinal: 1 },
    {
      rank: 10,
      domain: 'news.example.org',
      url: 'https://news.example.org/story?a=1#comments',
      ordinal: 2,
    },
    { rank: 3, domain: 'xn--bcher-kva.de', url: 'https://xn--bcher-kva.de/', ordinal: 3 },
  ]);
  assert.deepEqual(input, original);
  assert.deepEqual(corpus.errors, []);
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.source, 'manual');
  assert.equal(corpus.snapshot, null);
});

test('the default cohort consumes exactly the first 300 original slots without backfilling', () => {
  const input = Array.from({ length: 305 }, (_, index) => ({
    rank: index + 1,
    domain: `site${index + 1}.example.com`,
  }));
  input[0].domain = 'localhost';
  input[2].domain = input[1].domain;
  const corpus = parseCorpus(input);
  assert.equal(corpus.entries.length, 299);
  assert.equal(corpus.entries[0].ordinal, 2);
  assert.equal(corpus.entries.at(-1).ordinal, 300);
  assert.equal(corpus.entries.at(-1).rank, 300);
  assert.ok(corpus.entries.every((entry) => entry.rank <= 300));
  assert.deepEqual(
    corpus.errors.map(({ ordinal, code }) => ({ ordinal, code })),
    [
      { ordinal: 1, code: 'unsafe-url' },
      { ordinal: 3, code: 'duplicate-url' },
    ],
  );
});

test('duplicate URLs, domains and ranks stay in place and receive distinct entry identities', () => {
  const corpus = parseCorpus([
    { rank: 9, url: 'https://EXAMPLE.com:443/' },
    { rank: 7, domain: 'example.com' },
    { rank: 9, url: 'https://example.com/article' },
  ]);
  assert.equal(corpus.entries.length, 3);
  assert.deepEqual(
    corpus.entries.map((entry) => entry.rank),
    [9, 7, 9],
  );
  assert.equal(new Set(corpus.entries.map((entry) => entry.id)).size, 3);
  assert.deepEqual(
    corpus.errors.map((error) => [error.ordinal, error.code, error.duplicateOf]),
    [
      [2, 'duplicate-url', corpus.entries[0].id],
      [3, 'duplicate-domain', corpus.entries[0].id],
      [3, 'duplicate-rank', corpus.entries[0].id],
    ],
  );
  assert.ok(corpus.errors.every((error) => error.excluded === false));
});

test('invalid rows keep original ordinals and supplied ranks in errors, with no substitution', () => {
  const corpus = parseCorpus(
    [
      { rank: 81, domain: 'good.example.com' },
      { rank: 'bad', domain: 'bad-rank.example.com' },
      null,
      { rank: 10, domain: 'example.com', url: 'https://other.example.com/path' },
      { rank: 11, domain: 'never-selected.example.com' },
    ],
    { limit: 4 },
  );
  assert.equal(corpus.entries.length, 1);
  assert.deepEqual(
    corpus.errors.map(({ ordinal, rank, code }) => ({ ordinal, rank, code })),
    [
      { ordinal: 2, rank: 'bad', code: 'invalid-rank' },
      { ordinal: 3, rank: 3, code: 'invalid-row' },
      { ordinal: 4, rank: 10, code: 'domain-mismatch' },
    ],
  );
  assert.ok(corpus.errors.every((error) => error.excluded === true));
  assert.equal(new Set([...corpus.entries, ...corpus.errors].map((item) => item.id)).size, 4);
});

test('only absent ranks are inferred; malformed, fractional and unsafe ranks are invalid', () => {
  const invalid = [0, -1, 1.5, true, null, '', '1e2', '1.5', Number.MAX_SAFE_INTEGER + 1];
  const corpus = parseCorpus([
    ...invalid.map((rank, index) => ({ rank, domain: `rank${index}.example.com` })),
    { rank: '0012', domain: 'numeric.example.com' },
    { domain: 'inferred.example.com' },
  ]);
  assert.equal(corpus.errors.length, invalid.length);
  assert.ok(corpus.errors.every((error) => error.code === 'invalid-rank'));
  assert.deepEqual(
    corpus.entries.map((entry) => entry.rank),
    [12, 11],
  );
});

test('JSON object metadata is retained and explicit options override it without mutating input', () => {
  const input = {
    source: 'operator-ranking',
    snapshot: { date: '2026-11-20', region: 'global' },
    entries: ['example.com'],
  };
  const original = structuredClone(input);
  const corpus = parseCorpus(JSON.stringify(input), { format: 'json' });
  assert.equal(corpus.source, input.source);
  assert.deepEqual(corpus.snapshot, input.snapshot);
  const override = parseCorpus(input, { source: 'selected-ranking', snapshot: 'pinned-42' });
  assert.equal(override.source, 'selected-ranking');
  assert.equal(override.snapshot, 'pinned-42');
  assert.deepEqual(input, original);
  const copy = parseCorpus(input);
  copy.snapshot.region = 'changed';
  assert.deepEqual(input, original);
});

test('IDs are deterministic, metadata-key-order independent and source/snapshot/order sensitive', () => {
  const input = ['example.com', 'example.net'];
  const first = parseCorpus(input, { source: 'operator', snapshot: { day: 20, month: 11 } });
  const repeat = parseCorpus([...input], { source: 'operator', snapshot: { month: 11, day: 20 } });
  assert.deepEqual(first, repeat);
  assert.match(first.id, /^[A-Za-z0-9_-]{1,96}$/);
  assert.ok(first.entries.every((entry) => /^[A-Za-z0-9_-]{1,96}$/.test(entry.id)));
  assert.notEqual(first.id, parseCorpus(input, { source: 'other', snapshot: first.snapshot }).id);
  assert.notEqual(
    first.id,
    parseCorpus(input, { source: 'operator', snapshot: { day: 21, month: 11 } }).id,
  );
  assert.notEqual(
    first.id,
    parseCorpus([...input].reverse(), { source: 'operator', snapshot: first.snapshot }).id,
  );
  assert.equal(
    first.id,
    parseCorpus([...input, 'outside.example.com'], {
      source: 'operator',
      snapshot: first.snapshot,
      limit: 2,
    }).id,
  );
});

test('equivalent JSON and CSV rows have the same deterministic cohort and entry IDs', () => {
  const options = { source: 'operator', snapshot: 'fixed' };
  const json = parseCorpus(
    [
      { rank: 21, domain: 'example.com' },
      { rank: 31, url: 'https://example.net/path' },
    ],
    options,
  );
  const csv = parseCorpus('rank,domain,url\n21,example.com,\n31,,https://example.net/path\n', {
    ...options,
    format: 'csv',
  });
  assert.equal(csv.id, json.id);
  assert.deepEqual(csv.entries, json.entries);
});

test('CSV supports headerless Tranco rows and reordered case-insensitive headers', () => {
  const plain = parseCorpus('20,Example.com\r\n7,example.net\r\n', { format: 'csv' });
  assert.deepEqual(
    plain.entries.map((entry) => [entry.rank, entry.domain]),
    [
      [20, 'example.com'],
      [7, 'example.net'],
    ],
  );
  const headers = parseCorpus(
    '\uFEFFURL,Rank,Domain\r\n"https://example.com/a?x=a,b#part",20,example.com\r\n,7,example.net\r\n',
  );
  assert.equal(headers.entries[0].url, 'https://example.com/a?x=a,b#part');
  assert.equal(headers.entries[1].url, 'https://example.net/');
  assert.deepEqual(headers.errors, []);
});

test('headerlike values in a ranked CSV row never discard an original cohort slot', () => {
  for (const domain of ['domain', 'url', 'rank']) {
    const corpus = parseCorpus(`1,${domain}\n2,example.com\n3,outside.example.com\n`, {
      format: 'csv',
      limit: 2,
    });
    assert.deepEqual(
      corpus.entries.map((entry) => [entry.ordinal, entry.rank, entry.domain]),
      [[2, 2, 'example.com']],
    );
    assert.equal(corpus.errors.length, 1);
    assert.equal(corpus.errors[0].ordinal, 1);
    assert.equal(corpus.errors[0].excluded, true);
  }
});

test('CSV selection stops at the original boundary even when subsequent data is malformed', () => {
  const original = 'rank,domain\n1,example.com\n2,example.net\n';
  const prefix = parseCorpus(original, { limit: 2 });
  const trailing = parseCorpus(`${original}3,"unterminated\n4,example.org`, { limit: 2 });
  assert.deepEqual(trailing, prefix);
});

test('a malformed first rank does not turn a data row into a CSV header', () => {
  const corpus = parseCorpus('rank,example.com\n2,example.net\n3,outside.example.com\n', {
    format: 'csv',
    limit: 2,
  });
  assert.deepEqual(
    corpus.entries.map((entry) => [entry.ordinal, entry.rank, entry.domain]),
    [[2, 2, 'example.net']],
  );
  assert.deepEqual(
    corpus.errors.map((error) => [error.ordinal, error.rank, error.code]),
    [[1, 'rank', 'invalid-rank']],
  );
});

test('CSV headers may put an auxiliary column before an unranked URL column', () => {
  const corpus = parseCorpus('notes,url\n"first\nsecond",https://example.com/article\n', {
    format: 'csv',
  });
  assert.deepEqual(pages(corpus), [
    { ordinal: 1, rank: 1, domain: 'example.com', url: 'https://example.com/article' },
  ]);
  assert.deepEqual(corpus.errors, []);
});

test('CSV quoted commas, doubled quotes and multiline fields do not shift original ordinals', () => {
  const input =
    'rank,domain,url,notes\r\n5,example.com,"https://example.com/a?q=one,two","first line\r\nsecond ""quoted"" line"\r\n6,example.net,,plain\r\n7,example.org,,outside\r\n';
  const corpus = parseCorpus(input, { limit: 2 });
  assert.deepEqual(
    corpus.entries.map((entry) => [entry.ordinal, entry.rank, entry.url]),
    [
      [1, 5, 'https://example.com/a?q=one,two'],
      [2, 6, 'https://example.net/'],
    ],
  );
  assert.deepEqual(corpus.errors, []);
});

test('interior blank CSV records consume slots; a final line terminator is not an extra row', () => {
  const input = 'rank,domain\n1,example.com\n\n3,example.net\n4,outside.example.com\n';
  const corpus = parseCorpus(input, { limit: 3 });
  assert.deepEqual(
    corpus.entries.map((entry) => entry.ordinal),
    [1, 3],
  );
  assert.equal(corpus.errors.length, 1);
  assert.equal(corpus.errors[0].ordinal, 2);
  assert.equal(corpus.errors[0].line, 3);
  const trailing = parseCorpus('1,example.com\n', { format: 'csv' });
  assert.equal(trailing.entries.length, 1);
  assert.deepEqual(trailing.errors, []);
});

test('malformed CSV quoting is accounted per original record instead of silently repaired', () => {
  const corpus = parseCorpus(
    'rank,domain,url\n1,example.com,"https://example.com/"junk\n2,example.net,https://example.net/\n',
    { format: 'csv' },
  );
  assert.deepEqual(
    corpus.entries.map((entry) => entry.ordinal),
    [2],
  );
  assert.equal(corpus.errors[0].code, 'invalid-csv');
  assert.equal(corpus.errors[0].ordinal, 1);
  const unterminated = parseCorpus('rank,domain\n1,"example.com\n2,example.net', { format: 'csv' });
  assert.equal(unterminated.entries.length, 0);
  assert.equal(unterminated.errors.length, 1);
  assert.equal(unterminated.errors[0].code, 'invalid-csv');
  assert.equal(unterminated.errors[0].ordinal, 1);
});

test('ambiguous CSV headers and inconsistent column counts are errors', () => {
  const headers = parseCorpus('rank,domain,domain\n1,example.com,example.net', { format: 'csv' });
  assert.equal(headers.entries.length, 0);
  assert.equal(headers.errors[0].code, 'invalid-csv-header');
  const rows = parseCorpus('rank,domain\n1,example.com,unexpected\n2,example.net\n', {
    format: 'csv',
  });
  assert.deepEqual(
    rows.entries.map((entry) => entry.ordinal),
    [2],
  );
  assert.equal(rows.errors[0].ordinal, 1);
  assert.equal(rows.errors[0].code, 'invalid-csv');
});

test('empty cohorts, malformed JSON and invalid formats are explicit and deterministic', () => {
  assert.deepEqual(parseCorpus([]).entries, []);
  assert.deepEqual(parseCorpus('').errors, []);
  assert.deepEqual(parseCorpus(['example.com'], { limit: 0 }).entries, []);
  for (const input of ['{"entries":', 'null', '{"entries":{}}', '42']) {
    const corpus = parseCorpus(input, { format: 'json' });
    assert.equal(corpus.entries.length, 0);
    assert.equal(corpus.errors.length, 1);
    assert.equal(corpus.errors[0].code, 'invalid-json');
    assert.equal(corpus.id, parseCorpus(input, { format: 'json' }).id);
  }
  for (const limit of [-1, 1.5, NaN, Infinity, '3']) {
    assert.throws(() => parseCorpus([], { limit }), { code: 'invalid-options' });
  }
  assert.throws(() => parseCorpus([], { format: 'xml' }), { code: 'invalid-options' });
});

test('UTF-8 BOM input is supported and undecodable bytes are not silently replaced', () => {
  assert.equal(parseCorpus(Buffer.from('\uFEFF["example.com"]')).entries[0].domain, 'example.com');
  const invalid = parseCorpus(Buffer.from([0xc3, 0x28]), { format: 'csv' });
  assert.equal(invalid.entries.length, 0);
  assert.equal(invalid.errors[0].code, 'invalid-encoding');
});

test('explicit paths, searches and fragments are retained; malformed URLs are never repaired into targets', () => {
  const valid = parseCorpus([
    'https://example.com/article%2Fpart?q=a%2Fb#comments',
    { domain: 'example.net.', url: 'http://example.net./news?day=2' },
    'https://8.8.8.8/dns-query',
    'https://[2606:4700:4700::1111]/dns-query',
  ]);
  assert.equal(valid.entries.length, 4);
  assert.equal(valid.entries[0].url, 'https://example.com/article%2Fpart?q=a%2Fb#comments');
  assert.equal(valid.entries[1].domain, 'example.net');
  assert.equal(valid.entries[1].url, 'http://example.net/news?day=2');
  for (const value of [
    'https:example.com',
    'https:///example.com',
    'https:////example.com',
    'https://example.com\\@other.com',
    'https://exa\nmple.com/',
    'https://under_score.example.com/',
    'https://-bad.example.com/',
    'example.com/path',
  ]) {
    const result = parseCorpus([value]);
    assert.equal(result.entries.length, 0, value);
    assert.equal(result.errors.length, 1, value);
  }
});

test('IPv6 domain fields and their canonical entries can be re-imported without changing the cohort', () => {
  const corpus = parseCorpus([
    { rank: 1, domain: '2606:4700:4700::1111' },
    { rank: 2, domain: '[2606:4700:4700::1001]', url: 'https://[2606:4700:4700::1001]/dns-query' },
  ]);
  assert.deepEqual(pages(corpus), [
    { ordinal: 1, rank: 1, domain: '2606:4700:4700::1111', url: 'https://[2606:4700:4700::1111]/' },
    {
      ordinal: 2,
      rank: 2,
      domain: '2606:4700:4700::1001',
      url: 'https://[2606:4700:4700::1001]/dns-query',
    },
  ]);
  assert.deepEqual(corpus.errors, []);
  assert.deepEqual(parseCorpus(corpus), corpus);
});

test('credentialed, internal, special-use and alternate-spelling IP targets are rejected offline', () => {
  const unsafe = [
    'https://user:secret@example.com/',
    'http://localhost/',
    'http://LOCALHOST./',
    'http://service.local/',
    'http://corp.internal/',
    'http://intranet/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://192.0.2.1/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[fe80::1]/',
    'http://[2001:db8::1]/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://example.com/file',
  ];
  const corpus = parseCorpus(unsafe);
  assert.equal(corpus.entries.length, 0);
  assert.equal(corpus.errors.length, unsafe.length);
  assert.deepEqual(
    corpus.errors.map((error) => error.ordinal),
    unsafe.map((_, index) => index + 1),
  );
  assert.ok(corpus.errors.every((error) => error.excluded));
  assert.ok(!JSON.stringify(corpus).includes('secret'));
});

const listId = '6P7X';
const metadataUrl = `https://tranco-list.eu/api/lists/id/${listId}`;
const downloadUrl = `https://tranco-list.eu/download/${listId}/1000000`;
const csvBody = '1,example.com\n2,example.net\n3,example.org\n';
const metadata = () => ({
  list_id: listId,
  available: true,
  download: downloadUrl,
  created_on: '2026-11-20T00:00:00.000000',
  configuration: { providers: ['crux', 'majestic'], endDate: '2026-11-19', filterPLD: 'on' },
  failed: false,
  jobs_ahead: 0,
});

function transport({
  meta = metadata(),
  body = csvBody,
  downloadStatus = 200,
  contentType = 'text/csv',
} = {}) {
  return async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (String(url) === metadataUrl)
      return new Response(JSON.stringify(meta), {
        headers: { 'content-type': 'application/json' },
      });
    if (String(url) === downloadUrl)
      return new Response(body, {
        status: downloadStatus,
        headers: { 'content-type': contentType, etag: '"fixed-list"' },
      });
    throw new Error('The fixed-ID acquisition attempted an unexpected endpoint.');
  };
}

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const networkOptions = (fetchImpl, rest = {}) => ({ fetchImpl, lookupImpl: publicLookup, ...rest });

test('fetchTrancoCorpus pins metadata, download digest and first original positions', async () => {
  const corpus = await fetchTrancoCorpus(listId, networkOptions(transport(), { limit: 2 }));
  assert.equal(corpus.source, 'tranco');
  assert.equal(corpus.snapshot.listId, listId);
  assert.equal(corpus.snapshot.createdOn, metadata().created_on);
  assert.deepEqual(corpus.snapshot.configuration, metadata().configuration);
  assert.equal(corpus.snapshot.sha256, sha256(csvBody));
  assert.deepEqual(
    corpus.entries.map((entry) => [entry.ordinal, entry.rank, entry.domain]),
    [
      [1, 1, 'example.com'],
      [2, 2, 'example.net'],
    ],
  );
  assert.equal(corpus.provenance.metadata.requestedUrl, metadataUrl);
  assert.equal(corpus.provenance.download.requestedUrl, downloadUrl);
  assert.equal(corpus.provenance.download.sha256, sha256(csvBody));
  assert.equal(corpus.provenance.download.bytes, Buffer.byteLength(csvBody));
  assert.ok(Number.isFinite(Date.parse(corpus.provenance.download.retrievedAt)));
  const repeated = await fetchTrancoCorpus(
    listId.toLowerCase(),
    networkOptions(transport(), { limit: 2 }),
  );
  assert.equal(corpus.id, repeated.id);
  assert.deepEqual(corpus.entries, repeated.entries);
});

let dailyListCsv;
function dailyListSizedCsv() {
  if (dailyListCsv) return dailyListCsv;
  // Match the scale of the retained 46YVX response without a live fetch or a large checked-in fixture.
  const measuredBytes = 22_678_162;
  const buffer = Buffer.alloc(measuredBytes + 256);
  let offset = 0;
  for (let rank = 1; offset < measuredBytes; rank += 1) {
    offset += buffer.write(`${rank},site${rank}.example.com\n`, offset);
  }
  dailyListCsv = buffer.subarray(0, offset);
  return dailyListCsv;
}

test('fetchTrancoCorpus defaults accept a daily-list-size CSV and retain the first 300 original slots', async () => {
  const body = dailyListSizedCsv();
  assert.ok(body.length >= 22_678_162);
  const corpus = await fetchTrancoCorpus(listId, networkOptions(transport({ body })));
  assert.deepEqual(
    pages(corpus),
    Array.from({ length: 300 }, (_, index) => ({
      ordinal: index + 1,
      rank: index + 1,
      domain: `site${index + 1}.example.com`,
      url: `https://site${index + 1}.example.com/`,
    })),
  );
  assert.deepEqual(corpus.errors, []);
  assert.equal(corpus.source, 'tranco');
  assert.equal(corpus.snapshot.listId, listId);
  assert.equal(corpus.snapshot.sha256, sha256(body));
  assert.equal(corpus.provenance.download.sha256, sha256(body));
  assert.equal(corpus.provenance.download.bytes, body.length);
  assert.equal(corpus.provenance.download.requestedUrl, downloadUrl);
});

test('fetchTrancoCorpus honors explicit maxBytes for daily-list-size responses', async () => {
  const body = dailyListSizedCsv();
  await assert.rejects(
    fetchTrancoCorpus(listId, networkOptions(transport({ body }), { maxBytes: 8 * 1024 * 1024 })),
    (error) => {
      assert.equal(error.code, 'too-large');
      assert.equal(error.provenance.stage, 'download');
      assert.equal(error.provenance.metadata.status, 200);
      assert.equal(error.provenance.requestedUrl, downloadUrl);
      return true;
    },
  );
  const corpus = await fetchTrancoCorpus(
    listId,
    networkOptions(transport({ body }), { maxBytes: body.length }),
  );
  assert.equal(corpus.entries.length, 300);
  assert.equal(corpus.provenance.download.bytes, body.length);
  assert.equal(corpus.snapshot.sha256, sha256(body));
});

const deadlineCsv = Array.from(
  { length: 301 },
  (_, index) => `${index + 1},deadline${index + 1}.example.com\n`,
).join('');

async function virtualTrancoDownload(t, finishAfterMs, overrides = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let beganReading;
  const reading = new Promise((resolve) => {
    beganReading = resolve;
  });
  let deliveryTimer;
  let finishPull;
  let delivered = 0;
  let cancelled = 0;
  let downloadSignal;
  const body = new ReadableStream(
    {
      pull(stream) {
        return new Promise((resolve) => {
          finishPull = resolve;
          if (finishAfterMs !== undefined)
            deliveryTimer = setTimeout(() => {
              delivered += 1;
              stream.enqueue(Buffer.from(deadlineCsv));
              stream.close();
              resolve();
            }, finishAfterMs);
          beganReading();
        });
      },
      cancel() {
        cancelled += 1;
        clearTimeout(deliveryTimer);
        finishPull?.();
      },
    },
    { highWaterMark: 0 },
  );
  let outcome;
  const result = fetchTrancoCorpus(
    listId,
    networkOptions(
      async (url, options) => {
        assert.equal(options.redirect, 'manual');
        if (String(url) === metadataUrl)
          return new Response(JSON.stringify(metadata()), {
            headers: { 'content-type': 'application/json' },
          });
        assert.equal(String(url), downloadUrl);
        downloadSignal = options.signal;
        return new Response(body, { headers: { 'content-type': 'text/csv' } });
      },
      { signal: controller.signal, ...overrides },
    ),
  ).then(
    (corpus) => (outcome = { state: 'fulfilled', corpus }),
    (error) => (outcome = { state: 'rejected', error }),
  );
  t.after(async () => {
    controller.abort();
    await result;
  });
  await Promise.race([
    reading,
    result.then(({ error }) => {
      throw error ?? new Error('The download ended before reading its body.');
    }),
  ]);
  return {
    body,
    result,
    get outcome() {
      return outcome;
    },
    get signal() {
      return downloadSignal;
    },
    get delivered() {
      return delivered;
    },
    get cancelled() {
      return cancelled;
    },
    async advance(milliseconds) {
      t.mock.timers.tick(milliseconds);
      // tick() invokes timer callbacks synchronously; drain their promise work on the next event-loop turn.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test(
  'fetchTrancoCorpus virtual-deadline defaults accept a body finishing after 15 and before 30 seconds',
  { timeout: 5000 },
  async (t) => {
    const download = await virtualTrancoDownload(t, 20_000);
    await download.advance(15_001);
    assert.equal(download.outcome, undefined);
    assert.equal(download.signal.aborted, false);
    await download.advance(4_999);
    const outcome = await download.result;
    assert.equal(outcome.state, 'fulfilled');
    const corpus = outcome.corpus;
    assert.deepEqual(
      pages(corpus),
      Array.from({ length: 300 }, (_, index) => ({
        ordinal: index + 1,
        rank: index + 1,
        domain: `deadline${index + 1}.example.com`,
        url: `https://deadline${index + 1}.example.com/`,
      })),
    );
    assert.equal(new Set(corpus.entries.map((entry) => entry.id)).size, 300);
    assert.deepEqual(corpus.errors, []);
    assert.equal(corpus.snapshot.listId, listId);
    assert.equal(corpus.snapshot.sha256, sha256(deadlineCsv));
    assert.equal(corpus.provenance.download.sha256, sha256(deadlineCsv));
    assert.equal(corpus.provenance.download.bytes, Buffer.byteLength(deadlineCsv));
    assert.equal(download.body.locked, false);
    assert.equal(download.delivered, 1);
    assert.equal(download.cancelled, 0);
    await download.advance(30_000);
    assert.equal(download.signal.aborted, false, 'Completed retrieval must clear its deadline.');
  },
);

test(
  'fetchTrancoCorpus virtual-deadline explicit 15000 override rejects the same delayed body and releases it',
  { timeout: 5000 },
  async (t) => {
    const download = await virtualTrancoDownload(t, 20_000, { timeoutMs: 15_000 });
    await download.advance(14_999);
    assert.equal(download.outcome, undefined);
    await download.advance(1);
    const outcome = await download.result;
    assert.equal(outcome.state, 'rejected');
    assert.equal(outcome.error.code, 'timeout');
    assert.equal(outcome.error.provenance.stage, 'download');
    assert.equal(outcome.error.provenance.metadata.status, 200);
    assert.equal(outcome.error.provenance.requestedUrl, downloadUrl);
    assert.equal(download.signal.aborted, true);
    assert.equal(download.body.locked, false);
    assert.equal(download.cancelled, 1);
    await download.advance(20_000);
    assert.equal(
      download.delivered,
      0,
      'Cancelled bodies must not deliver after their timer becomes due.',
    );
    assert.equal(download.cancelled, 1);
  },
);

test(
  'fetchTrancoCorpus virtual-deadline stalled body times out at 30000 and cleans up',
  { timeout: 5000 },
  async (t) => {
    const download = await virtualTrancoDownload(t);
    await download.advance(29_999);
    assert.equal(download.outcome, undefined);
    assert.equal(download.signal.aborted, false);
    await download.advance(1);
    const outcome = await download.result;
    assert.equal(outcome.state, 'rejected');
    assert.equal(outcome.error.code, 'timeout');
    assert.equal(outcome.error.provenance.stage, 'download');
    assert.equal(outcome.error.provenance.bytes, 0);
    assert.equal(download.signal.reason.code, 'timeout');
    assert.equal(download.body.locked, false);
    assert.equal(download.cancelled, 1);
    await download.advance(60_000);
    assert.equal(download.delivered, 0);
    assert.equal(download.cancelled, 1);
  },
);

test('fetchTrancoCorpus refuses moving or malformed list IDs before dispatch', async () => {
  for (const id of [
    'latest',
    'LATEST',
    'current',
    '',
    undefined,
    '../6P7X',
    '6P7X?x=1',
    'a'.repeat(65),
  ]) {
    await assert.rejects(
      fetchTrancoCorpus(
        id,
        networkOptions(async () => {
          throw new Error('Unexpected dispatch.');
        }),
      ),
      { code: 'invalid-tranco-id' },
    );
  }
});

test('fetchTrancoCorpus rejects mismatched, unavailable and malformed metadata', async () => {
  await assert.rejects(
    fetchTrancoCorpus(
      listId,
      networkOptions(transport({ meta: { ...metadata(), list_id: 'OTHER' } })),
    ),
    { code: 'invalid-tranco-metadata' },
  );
  await assert.rejects(
    fetchTrancoCorpus(
      listId,
      networkOptions(transport({ meta: { ...metadata(), available: false } })),
    ),
    { code: 'tranco-unavailable' },
  );
  await assert.rejects(
    fetchTrancoCorpus(listId, networkOptions(transport({ meta: { ...metadata(), failed: true } }))),
    { code: 'tranco-unavailable' },
  );
  await assert.rejects(
    fetchTrancoCorpus(
      listId,
      networkOptions(transport({ meta: { ...metadata(), configuration: null } })),
    ),
    { code: 'invalid-tranco-metadata' },
  );
});

test('fetchTrancoCorpus never follows a metadata-provided latest, external or unpinned download URL', async () => {
  for (const download of [
    'https://tranco-list.eu/top-1m.csv.zip',
    'https://tranco-list.eu/latest_list',
    'https://other.example.com/download/6P7X',
    'http://tranco-list.eu/download/6P7X/1000000',
    'https://tranco-list.eu/download/OTHER/1000000',
    'https://user:secret@tranco-list.eu/download/6P7X/1000000',
  ]) {
    await assert.rejects(
      fetchTrancoCorpus(listId, networkOptions(transport({ meta: { ...metadata(), download } }))),
      { code: 'invalid-tranco-download' },
    );
  }
});

test('fetchTrancoCorpus retains invalid and duplicate original-row accounting without replacing them', async () => {
  const body = '1,localhost\n2,example.com\n3,example.com\n4,outside.example.com\n';
  const corpus = await fetchTrancoCorpus(listId, networkOptions(transport({ body }), { limit: 3 }));
  assert.deepEqual(
    corpus.entries.map((entry) => entry.rank),
    [2, 3],
  );
  assert.deepEqual(
    corpus.errors.map((error) => [error.ordinal, error.code]),
    [
      [1, 'unsafe-url'],
      [3, 'duplicate-url'],
    ],
  );
});

test('fetchTrancoCorpus surfaces HTTP errors, body limits, cancellation and unsafe redirects', async () => {
  await assert.rejects(
    fetchTrancoCorpus(listId, networkOptions(transport({ downloadStatus: 503 }))),
    (error) => error.status === 503 || error.provenance?.status === 503,
  );
  await assert.rejects(
    fetchTrancoCorpus(listId, networkOptions(transport(), { maxBytes: 10 })),
    (error) => typeof error.code === 'string' && error.code !== 'ERR_ASSERTION',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchTrancoCorpus(listId, networkOptions(transport(), { signal: controller.signal })),
    (error) => typeof error.code === 'string',
  );
  const fetchImpl = async () =>
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
  await assert.rejects(
    fetchTrancoCorpus(listId, networkOptions(fetchImpl)),
    (error) => typeof error.code === 'string',
  );
});

function zipCsv(text, { compress = true, name = 'top-1m.csv' } = {}) {
  const body = Buffer.from(text);
  const data = compress ? deflateRawSync(body) : body;
  const filename = Buffer.from(name);
  const method = compress ? 8 : 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc32(body), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(body), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

test('fetchTrancoCorpus reads stored and deflated Tranco CSV ZIPs and pins archive and CSV digests', async () => {
  for (const compress of [false, true]) {
    const body = zipCsv(csvBody, { compress });
    const corpus = await fetchTrancoCorpus(
      listId,
      networkOptions(transport({ body, contentType: 'application/zip' })),
    );
    assert.deepEqual(
      corpus.entries.map((entry) => entry.domain),
      ['example.com', 'example.net', 'example.org'],
    );
    assert.equal(corpus.snapshot.sha256, sha256(csvBody));
    assert.equal(corpus.provenance.download.sha256, sha256(body));
    assert.equal(corpus.provenance.archive.entry, 'top-1m.csv');
    assert.equal(corpus.provenance.archive.uncompressedBytes, Buffer.byteLength(csvBody));
  }
});

test('fetchTrancoCorpus rejects corrupt archives and bounds decompression rather than accepting partial lists', async () => {
  const corrupt = zipCsv(csvBody, { compress: false });
  corrupt[30 + Buffer.byteLength('top-1m.csv')] ^= 1;
  await assert.rejects(fetchTrancoCorpus(listId, networkOptions(transport({ body: corrupt }))), {
    code: 'invalid-tranco-archive',
  });
  const large = zipCsv('1,example.com\n'.repeat(100));
  await assert.rejects(
    fetchTrancoCorpus(
      listId,
      networkOptions(transport({ body: large }), { maxUncompressedBytes: 64 }),
    ),
    { code: 'too-large' },
  );
  const wrongFile = zipCsv(csvBody, { name: '../top-1m.csv' });
  await assert.rejects(fetchTrancoCorpus(listId, networkOptions(transport({ body: wrongFile }))), {
    code: 'invalid-tranco-archive',
  });
});

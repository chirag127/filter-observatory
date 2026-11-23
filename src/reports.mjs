import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { PNG } from 'pngjs';

const AG = 'AdguardTeam/AdguardFilters';
const EL = 'easylist/easylist';
const UA = 'uBlockOrigin/uAssets';
const REPOSITORIES = new Map(
  [
    [AG, 'adguard'],
    [EL, 'easylist'],
    [UA, 'uassets'],
    ['ryanbr/fanboy-adblock', 'fanboy'],
    ['easylist/easylistgermany', 'germany'],
    ['abpvn/abpvn', 'abpvn'],
    ['easylist/ruadlist', 'ruadlist'],
    ['DandelionSprout/adfilt', 'dandelion'],
  ].map(([repo, policy]) => [repo.toLowerCase(), { repo, policy }]),
);
const CATEGORIES = {
  'missed-ads': 'Missed ads or ad leftovers',
  'ad-leftover': 'Missed ads or ad leftovers',
  tracker: 'Missed analytics or tracker',
  'social-widget': 'Social media buttons — share, like, tweet, etc.',
  'cookie-notice': 'Annoyances — pop-ups, cookie warnings, etc.',
  annoyance: 'Annoyances — pop-ups, cookie warnings, etc.',
  'incorrect-blocking': "Website or app doesn't work properly",
  'anti-adblock': 'AdGuard gets detected on a website',
  'feature-request': 'Feature request',
};
const ID = /^[A-Za-z0-9_-]{1,96}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const NODE_ID = /^[A-Za-z0-9_+=/-]{1,256}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const SENSITIVE_KEY =
  /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|key|auth(?:orization)?|password|passwd|secret|session(?:id)?|jwt|email|code|signature|sig|x-amz-.+)$/i;
const PRIVATE_TEXT =
  /(?:\b(?:authorization\s*:\s*|bearer\s+)[^\s]+|\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[:=]\s*\S+|\bgh[pousr]_[A-Za-z0-9]{12,}|\bgithub_pat_[A-Za-z0-9_]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b[A-Z]:[\\/]|file:\/\/|\/(?:Users|home)\/[^\s/]+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b)/i;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const string = (value) => (typeof value === 'string' ? value : '');
const normalizedText = (value) => string(value).normalize('NFKC').trim().replace(/\s+/g, ' ');
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const canonicalRepo = (value) => REPOSITORIES.get(string(value).toLowerCase());

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

function validRepo(repo) {
  return typeof repo === 'string' && REPO.test(repo) && !['.', '..'].includes(repo.split('/')[1]);
}

function loopback(host) {
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return undefined;
    if (
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      loopback(url.hostname) ||
      !url.hostname.includes('.') ||
      /\.(?:local|localhost|internal|invalid|test)$/i.test(url.hostname)
    )
      return undefined;
    if ([...url.searchParams.keys()].some((key) => SENSITIVE_KEY.test(key))) return undefined;
    return url.href.replace(
      /[()[\]\\`<>]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return undefined;
  }
}

function scrubUrlParts(url) {
  let sensitive = Boolean(url.username || url.password);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_KEY.test(key)) {
      sensitive = true;
      url.searchParams.delete(key);
    }
    if (/^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key))
      url.searchParams.delete(key);
  }
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  if (
    /\/(?:reset-password|password-reset|auth|oauth|token)(?:\/|$)/i.test(path) ||
    PRIVATE_TEXT.test(path)
  ) {
    sensitive = true;
    url.pathname = '/[redacted]';
  }
  url.searchParams.sort();
  return sensitive;
}

function affectedUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol))
      return { valid: false, url: '', sensitive: false };
    let sensitive = scrubUrlParts(url);
    if (/^#!?\//.test(url.hash)) {
      const prefix = url.hash.startsWith('#!') ? '#!' : '#';
      const fragment = new URL(`${url.origin}${url.hash.slice(prefix.length)}`);
      const fragmentSensitive = scrubUrlParts(fragment) || Boolean(fragment.hash);
      sensitive ||= fragmentSensitive;
      url.hash = sensitive ? '' : `${prefix}${fragment.pathname}${fragment.search}`;
    } else {
      if (/(?:token|password|secret|auth|session)[=/]|eyJ[A-Za-z0-9_-]+\./i.test(url.hash))
        sensitive = true;
      url.hash = '';
    }
    return {
      valid: true,
      url: url.href.replace(/`/g, '%60'),
      hostname: url.hostname.replace(/^www\./, ''),
      sensitive,
    };
  } catch {
    return { valid: false, url: '', sensitive: false };
  }
}

function containsPrivateData(value) {
  const text = string(value);
  if (PRIVATE_TEXT.test(text)) return true;
  return [...text.matchAll(/https?:\/\/[^\s<>"`]+/g)].some(([url]) => affectedUrl(url).sensitive);
}

function markdown(value) {
  return string(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#!|]/g, '\\$&')
    .replace(/@/g, '@\u200b');
}

function strongestSensitivity(values) {
  if (values.includes('nsfw')) return 'nsfw';
  return values.every((value) => value === 'ordinary') ? 'ordinary' : 'unknown';
}

function productFamily(product) {
  const name = string(product?.name).toLowerCase();
  if (/^(?:ublock origin lite|ubo lite|ubol)$/.test(name)) return 'ubol';
  if (/^(?:ublock origin|ubo)$/.test(name)) return 'ubo';
  if (/^adguard(?:\b|$)/.test(name)) return 'adguard';
  if (/^adblock plus$/.test(name)) return 'abp';
  return name || 'unknown';
}

function routeForList(record) {
  const owner = canonicalRepo(record?.owner);
  if (!owner) return undefined;
  // Core Fanboy subscriptions publish at EasyList's official host; a filename alone is not provenance.
  if (owner.policy === 'fanboy') {
    const core = (record.downloadUrls ?? []).some((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          url.hostname === 'easylist-downloads.adblockplus.org' &&
          /^\/(?:fanboy-social|fanboy-annoyance|fanboy-notifications|easylist-cookie)\.txt$/.test(
            url.pathname,
          )
        );
      } catch {
        return false;
      }
    });
    if (core) return canonicalRepo(EL);
    const support = record.supportUrl ?? record.homepage;
    if (
      !/^https:\/\/(?:secure\.)?fanboy\.co\.nz(?:\/|$)/i.test(string(support)) &&
      !/^https:\/\/github\.com\/ryanbr\/fanboy-adblock(?:\/|$)/i.test(string(support))
    )
      return undefined;
  }
  return owner;
}

function matchesHost(issue, hostname) {
  if (!hostname) return false;
  const host = hostname.replace(/^www\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9.-])(?:www\\.)?${host}(?=$|[^a-z0-9.-])`, 'i').test(
    `${string(issue.title)}\n${string(issue.body)}`,
  );
}

function belongsToRepo(issue, repo) {
  if (!issue || Object.hasOwn(issue, 'pull_request') || !positiveInteger(issue.number))
    return false;
  if (typeof issue.repo === 'string') return issue.repo.toLowerCase() === repo.toLowerCase();
  try {
    const url = new URL(issue.html_url ?? issue.url);
    return (
      url.origin === 'https://github.com' &&
      url.pathname.toLowerCase() === `/${repo}/issues/${issue.number}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

function issueCategory(issue) {
  if (Object.hasOwn(CATEGORIES, issue.category)) return issue.category;
  const labels = (issue.labels ?? []).map((label) =>
    string(typeof label === 'string' ? label : label.name).toLowerCase(),
  );
  if (labels.includes('exist ads')) return 'missed-ads';
  if (labels.includes('inccorect block')) return 'incorrect-blocking';
  return undefined;
}

function specialThread(hostname, family, policy) {
  const domain = (host) => hostname === host || hostname?.endsWith(`.${host}`);
  if (domain('youtube.com') || domain('youtu.be'))
    return {
      key: family === 'ubol' ? 'youtube-lite' : 'youtube-ubo',
      number: family === 'ubol' ? 30158 : 30157,
      kind: 'issue-comment',
    };
  for (const [host, key, number] of [
    ['facebook.com', 'facebook', 3367],
    ['twitch.tv', 'twitch', 5184],
    ['spotify.com', 'spotify', 22198],
  ]) {
    if (domain(host)) return { key, number, kind: 'issue-comment' };
  }
  if (['shortener', 'file-hosting', 'link-hosting'].includes(policy.siteKind))
    return { key: 'shortener', number: 27472, kind: 'discussion-comment' };
  return undefined;
}

function contextValue(context, path) {
  if (typeof path !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,120}$/.test(path)) return undefined;
  const parts = path.split('.');
  if (parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)))
    return undefined;
  return parts.reduce(
    (value, key) => (value && Object.hasOwn(value, key) ? value[key] : undefined),
    context,
  );
}

/** Context and listIds are worker-owned facts; model destinations and suggestedListIds have no authority here. */
export function prepareReport(finding, { catalog = [], config = {}, existingIssues = [] } = {}) {
  finding = finding && typeof finding === 'object' ? finding : {};
  const context = finding.context ?? {};
  const prerequisites = context.prerequisites ?? {};
  const policy = context.policy ?? {};
  const reasons = [];
  let unsupported = false;
  const defer = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const exclude = (reason) => {
    unsupported = true;
    defer(reason);
  };
  const requireFact = (key) => {
    if (prerequisites[key] !== true)
      defer(`prerequisite:${key}:${prerequisites[key] === false ? 'not-met' : 'unknown'}`);
  };
  const safeText = (value, limit = 10000) => {
    if (containsPrivateData(value)) {
      defer('private-data-in-report-text');
      return '[redacted]';
    }
    if (string(value).length > limit) defer('report-field-too-long');
    return string(value).slice(0, limit);
  };
  const location = affectedUrl(finding.url);
  if (!location.valid) defer('invalid-affected-url');
  if (location.sensitive) defer('sensitive-url');
  if (
    location.valid &&
    (loopback(new URL(location.url).hostname) || isIP(new URL(location.url).hostname))
  )
    defer('nonpublic-affected-url');
  const category = string(finding.category);
  if (category === 'configuration-gap') exclude('configuration-gap-is-not-a-maintainer-defect');
  else if (!Object.hasOwn(CATEGORIES, category)) exclude('unsupported-category');
  const feature = category === 'feature-request';
  const listIds = [...new Set(Array.isArray(finding.listIds) ? finding.listIds : [])];
  const selected = [];
  if (!listIds.length) defer('attribution-list-missing');
  for (const id of listIds) {
    const key = /^[A-Za-z0-9_:./-]{1,160}$/.test(string(id)) ? id : '(invalid-id)';
    const record = catalog.find((item) => item.id === id && item.retired !== true);
    if (!record) {
      defer(`unknown-list:${key}`);
      continue;
    }
    selected.push(record);
    if (!feature && !context.lists?.some((list) => list.id === id && list.enabled === true))
      defer(`list-not-enabled:${key}`);
  }
  const routes = selected.map(routeForList);
  if (routes.some((route) => !route)) exclude('owner-intake-unverified');
  const owners = [...new Set(routes.filter(Boolean).map((route) => route.repo))];
  if (owners.length > 1) defer('multiple-owners:separate-attribution-required');
  const route = owners.length === 1 ? canonicalRepo(owners[0]) : undefined;
  if (route && config.ownerPolicy && config.ownerPolicy !== route.policy)
    defer('owner-policy-mismatch');
  if (
    route &&
    Array.isArray(config.allowedRepositories) &&
    !config.allowedRepositories.some(
      (repo) => string(repo).toLowerCase() === route.repo.toLowerCase(),
    )
  )
    defer('repository-not-allowed');
  const enabledBlockers = Array.isArray(context.blockers)
    ? context.blockers.filter((item) => item.enabled === true)
    : [];
  const product = context.product ?? (enabledBlockers.length === 1 ? enabledBlockers[0] : {});
  const family = productFamily(product);
  const browser = context.browser ?? {};
  const os = context.os ?? {};
  const observation = safeText(finding.observation);
  const expectedBehavior = safeText(finding.expectedBehavior);
  const reproduction = Array.isArray(finding.reproduction)
    ? finding.reproduction.map((step) => safeText(step, 2000))
    : [];
  if (!normalizedText(observation)) defer('observation-missing');
  if (!normalizedText(expectedBehavior)) defer('expected-behavior-missing');
  if (!feature && (!reproduction.length || reproduction.some((step) => !normalizedText(step))))
    defer('reproduction-missing');
  if (context.privacyChecked !== true) defer('privacy-check-missing');
  if (!feature) {
    if (context.pageState !== 'usable')
      defer(
        `page-not-usable:${['login-required', 'challenge'].includes(context.pageState) ? context.pageState : 'unknown'}`,
      );
    for (const [key, value] of [
      ['product', product],
      ['browser', browser],
      ['os', os],
    ]) {
      if (
        !normalizedText(typeof value === 'string' ? value : value.name) ||
        (typeof value !== 'string' && !normalizedText(value.version))
      )
        defer(`environment:${key}-unknown`);
    }
    if (!enabledBlockers.some((blocker) => productFamily(blocker) === family))
      defer('product-not-observed-enabled');
    if (category === 'incorrect-blocking') requireFact('breakageResolvedWhenDisabled');
  }

  let destination = route ? { kind: 'issue', repo: route.repo } : undefined;
  let threadPolicy;
  let omitScreenshots = feature;
  if (route?.policy === 'adguard') {
    if (!feature && family !== 'adguard')
      exclude('unsupported-product:adguard-reproduction-required');
    if (feature) {
      requireFact('documentationChecked');
      requireFact('notAdOrBugReport');
    } else {
      for (const key of ['filtersCurrent', 'browserCurrent', 'productCurrent']) requireFact(key);
    }
    if (['missed-ads', 'ad-leftover'].includes(category) && policy.selfPromotion === true)
      exclude('policy-exclusion:self-promotion');
    if (category === 'ad-leftover') {
      if (policy.conspicuous === false) exclude('policy-exclusion:inconspicuous-leftover');
      else if (policy.conspicuous !== true) defer('policy-context:conspicuous-leftover-unknown');
    }
    if (category === 'social-widget') {
      if (
        ['social-login', 'comments', 'embedded-post', 'poll', 'own-social-link'].includes(
          policy.widgetKind,
        )
      )
        exclude('policy-exclusion:functional-social-content');
      else if (!['sharing', 'group', 'recommendation'].includes(policy.widgetKind))
        defer('policy-context:social-widget-purpose-unknown');
    }
    if (
      category === 'tracker' &&
      (policy.errorTracking === true ||
        policy.necessaryAntiBot === true ||
        policy.fraudPrevention === true)
    )
      exclude('policy-exclusion:necessary-antibot-or-error-tracking');
    if (category === 'anti-adblock') {
      if (policy.paywall === true) exclude('policy-exclusion:paywall');
      else if (policy.nonObstructive === true) exclude('policy-exclusion:non-obstructive-message');
      else if (
        ![
          policy.obstructive,
          policy.aggressive,
          policy.misleading,
          policy.privacyInvasive,
          policy.malvertisingRisk,
        ].includes(true)
      )
        defer('policy-context:anti-adblock-impact-unknown');
    }
    if (
      ['cookie-notice', 'annoyance'].includes(category) &&
      (policy.paywall === true ||
        policy.integratedContent === true ||
        policy.practicalPush === true ||
        policy.unobtrusiveAppBanner === true)
    )
      exclude('policy-exclusion:functional-or-unobtrusive-content');
    if (policy.intentionallyAllowed === true) exclude('configuration-policy:intentionally-allowed');
    if (
      policy.siteSpecific === true &&
      typeof policy.monthlyVisits === 'number' &&
      policy.monthlyVisits < 100000 &&
      policy.maintainerException !== true
    )
      defer('policy-context:low-traffic-site-needs-maintainer-exception');
  }
  if (route && ['easylist', 'fanboy', 'germany', 'ruadlist'].includes(route.policy)) {
    requireFact('isolated');
    if (enabledBlockers.length !== 1) defer('single-blocker-reproduction-required');
    if (feature) exclude('feature-intake-not-qualified-for-this-owner');
  }
  if (route?.policy === 'easylist') {
    if (['missed-ads', 'ad-leftover'].includes(category) && policy.selfPromotion === true)
      exclude('policy-exclusion:self-promotion');
    if (category === 'ad-leftover') {
      if (policy.placeholder && (policy.placeholder.width < 50 || policy.placeholder.height < 50))
        exclude('policy-exclusion:insubstantial-ad-placeholder');
      else if (!policy.placeholder) defer('policy-context:placeholder-dimensions-unknown');
    }
    if (
      category === 'anti-adblock' &&
      ![
        'adult',
        'file-hosting',
        'link-hosting',
        'shortener',
        'streaming',
        'torrent',
        'comic',
      ].includes(policy.siteKind) &&
      policy.historicalRule !== true
    ) {
      if (policy.siteKind) exclude('policy-exclusion:easylist-anti-adblock-site-scope');
      else defer('policy-context:anti-adblock-site-kind-unknown');
    }
  }
  if (route?.policy === 'germany') {
    if (category === 'anti-adblock') exclude('policy-exclusion:germany-anti-adblock');
    if (
      !context.lists?.some(
        (list) =>
          list.enabled === true &&
          (list.id === 'easylist' ||
            catalog.some(
              (record) =>
                record.id === list.id &&
                record.name === 'EasyList' &&
                canonicalRepo(record.owner)?.repo === EL,
            )),
      )
    )
      defer('required-list:easylist');
  }
  if (route?.policy === 'abpvn') {
    requireFact('filtersCurrent');
    if (policy.vietnameseSite === false || policy.translatedGlobalSite === true)
      exclude('policy-exclusion:not-a-vietnamese-site');
    else if (policy.vietnameseSite !== true) defer('policy-context:vietnamese-site-unknown');
    if (
      !Number.isFinite(context.reproductionRate) ||
      context.reproductionRate <= 0.5 ||
      context.reproductionRate > 1
    )
      defer('reproduction-rate-must-exceed-50-percent');
    if (!['missed-ads', 'ad-leftover', 'incorrect-blocking', 'anti-adblock'].includes(category))
      exclude('unsupported-category:abpvn-intake');
  }
  if (route?.policy === 'dandelion') {
    if (product.manifestVersion === 3 || family === 'ubol')
      exclude('unsupported-product:dandelion-mv3');
    else if (product.manifestVersion !== 2 && !['dns', 'hosts'].includes(context.productType))
      defer('manifest-version-unknown');
    if (feature) exclude('use-list-entry-intake-with-tested-entry');
    if (policy.antiMalwareList === true) omitScreenshots = true;
  }
  if (route?.policy === 'uassets') {
    if (!['ubo', 'ubol'].includes(family))
      exclude('unsupported-product:ubo-or-ubol-reproduction-required');
    for (const key of [
      'browserCurrent',
      'isolated',
      'defaultsTested',
      'customRulesExcluded',
      'interferenceExcluded',
    ])
      requireFact(key);
    if (category === 'anti-adblock') requireFact('detectionResolvedWhenDisabled');
    if (!normalizedText(context.troubleshooting)) defer('troubleshooting-information-missing');
    if (family === 'ubol') {
      requireFact('developerModeDisabled');
      if (!['optimal', 'complete'].includes(string(product.filteringMode).toLowerCase()))
        defer('ubol-filtering-mode-must-be-optimal-or-complete');
    }
    if (policy.newFilterList === true) exclude('policy-exclusion:uassets-new-filter-list');
    if (
      category !== 'incorrect-blocking' &&
      (['social-widget', 'cookie-notice', 'annoyance', 'feature-request'].includes(category) ||
        policy.paywall === true ||
        policy.pornFarm === true ||
        policy.selfPromotion === true ||
        policy.restyle === true)
    )
      exclude('policy-exclusion:uassets-intake');
    const special = specialThread(location.hostname, family, policy);
    if (special) {
      const snapshot = config.specialThreads?.[special.key];
      const number = positiveInteger(snapshot?.number) ? snapshot.number : special.number;
      destination = { kind: special.kind, repo: UA, number };
      if (special.kind === 'discussion-comment' && NODE_ID.test(string(snapshot?.nodeId)))
        destination.nodeId = snapshot.nodeId;
      if (
        !snapshot ||
        !SHA256.test(string(snapshot.bodyHash)) ||
        !Number.isFinite(Date.parse(snapshot.verifiedAt)) ||
        !Array.isArray(snapshot.requirements)
      )
        defer(`thread-policy-unverified:${special.key}`);
      else {
        threadPolicy = {
          key: special.key,
          bodyHash: snapshot.bodyHash,
          verifiedAt: snapshot.verifiedAt,
        };
        if (
          snapshot.expiresAt &&
          (!Number.isFinite(Date.parse(snapshot.expiresAt)) ||
            Date.parse(snapshot.expiresAt) <= Date.now())
        )
          defer('thread-policy-expired');
        for (const requirement of snapshot.requirements) {
          const path =
            typeof requirement === 'string' ? `prerequisites.${requirement}` : requirement?.path;
          const expected = typeof requirement === 'string' ? true : requirement?.equals;
          if (expected === undefined || contextValue(context, path) !== expected)
            defer(
              `thread-prerequisite:${/^[A-Za-z0-9_.]+$/.test(string(path)) ? path : 'invalid'}`,
            );
        }
      }
      if (special.key === 'shortener') {
        if (family !== 'ubo' || product.manifestVersion !== 2)
          exclude('unsupported-product:shortener-thread-requires-ubo-mv2');
        if (!destination.nodeId) defer('discussion-node-id-missing');
        omitScreenshots = snapshot?.screenshotsRequested !== true;
      }
    }
  }
  if (category === 'tracker' && !normalizedText(context.networkEvidence))
    defer('network-evidence-required:tracking-is-not-established-by-a-screenshot');

  const categoryGroups = {
    'missed-ads': ['ads', 'advertising'],
    'ad-leftover': ['ads', 'advertising'],
    tracker: ['privacy', 'tracking', 'trackers'],
    'social-widget': ['social', 'social-widgets', 'annoyances', 'annoyance'],
    'cookie-notice': ['cookies', 'cookie-notices', 'annoyances', 'annoyance'],
    annoyance: ['annoyances', 'annoyance'],
    'anti-adblock': ['anti-adblock', 'ads', 'advertising'],
  };
  if (
    categoryGroups[category] &&
    selected.length &&
    !selected.some((record) =>
      (record.categories ?? []).some((entry) =>
        categoryGroups[category].includes(string(entry).toLowerCase()),
      ),
    )
  )
    defer('selected-list-policy-does-not-cover-category');

  const ids = Array.isArray(finding.evidenceIds) ? [...new Set(finding.evidenceIds)] : [];
  const imageIds = ids.filter((id) => id !== 'text');
  const textEvidence = finding.textEvidence;
  if (
    ids.includes('text') &&
    (!textEvidence ||
      typeof textEvidence !== 'object' ||
      Array.isArray(textEvidence) ||
      textEvidence.id !== 'text' ||
      textEvidence.available !== true)
  )
    defer('missing-evidence:text');
  const allImages = Array.isArray(finding.images) ? finding.images : [];
  const referenced = imageIds.map((id) => allImages.find((image) => image.id === id));
  const sensitivity = strongestSensitivity([
    finding.sensitivity,
    context.sensitivity,
    ...referenced.filter(Boolean).map((image) => image.sensitivity),
  ]);
  if (sensitivity === 'unknown') defer('sensitivity-unknown');
  if (sensitivity === 'nsfw')
    defer(
      route?.policy === 'adguard'
        ? 'nsfw-requires-official-label-capable-intake:https://reports.adguard.com/new_issue.html'
        : 'nsfw-publication-transport-not-qualified',
    );
  const evidence = [];
  const uploadEvidenceIds = [];
  if (!omitScreenshots) {
    if (!imageIds.length) defer('screenshot-evidence-required');
    for (const [index, id] of imageIds.entries()) {
      if (!ID.test(string(id))) {
        defer('invalid-evidence-id');
        continue;
      }
      const image = referenced[index];
      if (!image) {
        defer(`missing-evidence:${id}`);
        continue;
      }
      const url = publicUrl(image.url);
      if (
        sensitivity === 'ordinary' &&
        image.sanitized === true &&
        (!url || image.verifiedPublic !== true)
      )
        uploadEvidenceIds.push(id);
      if (!url) {
        defer(`evidence-url-missing-or-nonpublic:${id}`);
        continue;
      }
      if (image.verifiedPublic !== true) {
        defer(`evidence-url-unverified:${id}`);
        continue;
      }
      if (image.sanitized !== true) {
        defer(`evidence-not-sanitized:${id}`);
        continue;
      }
      if (sensitivity === 'ordinary')
        evidence.push({ id, url, verifiedPublic: true, sanitized: true, sensitivity: 'ordinary' });
    }
  }

  const fingerprint = sha256(
    JSON.stringify(
      stable({
        version: 1,
        url: location.url,
        category,
        observation: normalizedText(observation),
        expectedBehavior: normalizedText(expectedBehavior),
        reproduction: reproduction.map(normalizedText),
        product: family,
        manifestVersion: product.manifestVersion,
        filteringMode: product.filteringMode,
        listIds: listIds.filter((id) => typeof id === 'string').sort(),
        enabledLists: (context.lists ?? [])
          .filter((list) => list.enabled === true)
          .map((list) => list.id)
          .sort(),
        owners: owners.map((repo) => repo.toLowerCase()).sort(),
      }),
    ),
  );
  const marker = `<!-- filter-observatory:v1:${fingerprint} -->`;
  const issueList = Array.isArray(existingIssues) ? existingIssues : (existingIssues?.issues ?? []);
  if (!Array.isArray(existingIssues) && existingIssues?.complete !== true)
    defer('duplicate-search-incomplete');
  const matching = destination
    ? issueList
        .filter(
          (item) => belongsToRepo(item, destination.repo) && matchesHost(item, location.hostname),
        )
        .sort((a, b) => a.number - b.number)
    : [];
  if (
    route?.policy === 'uassets' &&
    !threadPolicy &&
    destination?.kind === 'issue' &&
    matching.length
  )
    destination = { kind: 'issue-comment', repo: route.repo, number: matching[0].number };
  if (destination?.number) {
    const thread = issueList.find(
      (item) => belongsToRepo(item, destination.repo) && item.number === destination.number,
    );
    if (thread?.locked === true) defer('thread-locked');
  } else if (matching.length && route?.policy !== 'uassets') {
    const duplicates =
      route?.policy === 'abpvn'
        ? matching.filter((item) => {
            const type = issueCategory(item);
            return (
              !type ||
              (['incorrect-blocking', 'anti-adblock'].includes(category)
                ? ['incorrect-blocking', 'anti-adblock'].includes(type)
                : ['missed-ads', 'ad-leftover'].includes(type))
            );
          })
        : matching;
    if (duplicates.length && !duplicates.some((item) => string(item.body).includes(marker)))
      defer(`possible-duplicate:${duplicates[0].number}`);
  }

  let title =
    route?.policy === 'ruadlist'
      ? (location.hostname ?? 'Website report')
      : `${location.hostname ?? 'Website report'}: ${category || 'unclassified'}`;
  if (sensitivity === 'nsfw') title = `[NSFW] ${title}`;
  const label = route?.policy === 'adguard' ? (CATEGORIES[category] ?? category) : category;
  const valueText = (value) => markdown(safeText(value, 3000));
  const environment = [
    ['Product', `${product.name ?? 'unknown'} ${product.version ?? 'unknown'}`],
    [
      'Manifest',
      product.manifestVersion === undefined ? 'unknown' : String(product.manifestVersion),
    ],
    ['Browser', `${browser.name ?? 'unknown'} ${browser.version ?? 'unknown'}`],
    ['OS', typeof os === 'string' ? os : `${os.name ?? 'unknown'} ${os.version ?? 'unknown'}`],
    [
      'Other extensions',
      Array.isArray(context.otherExtensions)
        ? context.otherExtensions
            .map((item) => (typeof item === 'string' ? item : item.name))
            .join(', ') || 'None observed'
        : 'unknown',
    ],
  ];
  const enabledLists = (context.lists ?? [])
    .filter((list) => list.enabled === true)
    .map(
      (list) =>
        `- ${valueText(list.name ?? list.id)}${list.version ? ` (${valueText(list.version)})` : ''}`,
    );
  const sections = [
    `### ${label}`,
    `Affected URL: \`${location.url || 'unknown'}\``,
    `### Description\n${valueText(observation)}`,
    `### Expected behavior${feature ? ' / proposed solution' : ''}\n${valueText(expectedBehavior)}`,
    `### Reproduction\n${reproduction.map((step, index) => `${index + 1}. ${valueText(step)}`).join('\n') || 'Not supplied'}`,
    `### Environment\n${environment.map(([key, value]) => `- ${key}: ${valueText(value)}`).join('\n')}`,
    `### Enabled filter lists\n${enabledLists.join('\n') || 'Unknown'}`,
    `### Reproduction checks\n${
      Object.entries(prerequisites)
        .filter(
          ([key, value]) => /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(key) && typeof value === 'boolean',
        )
        .map(([key, value]) => `- ${key}: ${value ? 'measured true' : 'measured false'}`)
        .join('\n') || 'Not supplied; no checks are assumed'
    }`,
  ];
  if (context.troubleshooting)
    sections.push(`### Troubleshooting information\n${valueText(context.troubleshooting)}`);
  if (context.networkEvidence)
    sections.push(`### Network evidence\n${valueText(context.networkEvidence)}`);
  if (Number.isFinite(context.reproductionRate))
    sections.push(`Reproduction rate: ${context.reproductionRate * 100}%`);
  if (context.accountRequirements)
    sections.push(`Account requirements: ${valueText(context.accountRequirements)}`);
  if (evidence.length)
    sections.push(
      `### Screenshots\n${evidence.map((image) => `<details>\n<summary>${image.id}</summary>\n\n![${image.id}](${image.url})\n\n</details>`).join('\n\n')}`,
    );
  if (Array.isArray(context.limitations) && context.limitations.length)
    sections.push(
      `### Limitations\n${context.limitations.map((item) => `- ${valueText(item)}`).join('\n')}`,
    );
  sections.push(marker);
  const body = sections.join('\n\n');
  if (Buffer.byteLength(body) > 60000) defer('report-body-too-large');
  return {
    id: ID.test(string(finding.id)) ? finding.id : `report-${fingerprint.slice(0, 24)}`,
    fingerprint,
    state: unsupported ? 'unsupported' : reasons.length ? 'deferred' : 'ready',
    reasons,
    ...(destination ? { destination } : {}),
    title,
    body,
    marker,
    evidence,
    uploadEvidenceIds: unsupported ? [] : uploadEvidenceIds,
    url: location.url,
    hostname: location.hostname,
    category,
    sensitivity,
    policyName: route?.policy,
    ...(threadPolicy ? { threadPolicy } : {}),
    duplicateSearchComplete: !Array.isArray(existingIssues) && existingIssues?.complete === true,
  };
}

const API_VERSION = '2026-03-10';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_DUPLICATE_THREADS = 50;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function apiOrigin(apiBase) {
  let url;
  try {
    url = new URL(apiBase);
  } catch {
    throw new TypeError('Invalid GitHub apiBase');
  }
  if (
    typeof apiBase !== 'string' ||
    /[\u0000-\u0020\u007f\\]/u.test(apiBase) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !(
      url.origin === 'https://api.github.com' ||
      (['http:', 'https:'].includes(url.protocol) && loopback(url.hostname))
    )
  ) {
    throw new TypeError('apiBase must be https://api.github.com or a loopback origin');
  }
  return url.origin;
}

function remoteUrl(value, repo, kind, number, commentId) {
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.pathname.toLowerCase() !== `/${repo}/${kind}/${number}`.toLowerCase()
    )
      return undefined;
    if (
      commentId !== undefined &&
      url.hash !== `#${kind === 'issues' ? 'issuecomment' : 'discussioncomment'}-${commentId}`
    )
      return undefined;
    if (commentId === undefined && url.hash) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function publicationKey(report) {
  return `${string(report?.destination?.repo).toLowerCase()}:${string(report?.fingerprint)}`;
}

function contentHash(report, operation) {
  return sha256(
    JSON.stringify(
      operation === 'issue' ? { title: report.title, body: report.body } : { body: report.body },
    ),
  );
}

function receiptFor(report, record, destination, parent = {}, submittedContentHash = null) {
  const discussion = destination.kind === 'discussion-comment';
  const issueCreation = destination.kind === 'issue';
  const number = issueCreation ? record?.number : destination.number;
  const commentId = discussion ? record?.databaseId : issueCreation ? undefined : record?.id;
  if (
    !positiveInteger(number) ||
    (discussion ? !NODE_ID.test(string(record?.id)) : !positiveInteger(record?.id))
  )
    return undefined;
  let url;
  if (discussion) {
    if (positiveInteger(commentId))
      url = remoteUrl(record?.url, destination.repo, 'discussions', number, commentId);
    else {
      const match = string(record?.url).match(/#discussioncomment-(\d+)$/);
      if (match)
        url = remoteUrl(record.url, destination.repo, 'discussions', number, Number(match[1]));
    }
  } else url = remoteUrl(record?.html_url, destination.repo, 'issues', number, commentId);
  if (!url) return undefined;
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const hasBody = typeof record.body === 'string';
  const missingEvidenceIds = evidence
    .filter((image) => !hasBody || !record.body.includes(image.url))
    .map((image) => image.id);
  const actual = issueCreation ? { title: record.title, body: record.body } : { body: record.body };
  return {
    repo: destination.repo,
    operation: destination.kind,
    url,
    ...(discussion
      ? {
          discussionNumber: number,
          discussionNodeId: destination.nodeId,
          commentNodeId: record.id,
          ...(positiveInteger(commentId) ? { commentId } : {}),
        }
      : {
          issueNumber: number,
          ...(issueCreation
            ? { issueId: record.id }
            : {
                commentId: record.id,
                ...(positiveInteger(parent.id) ? { issueId: parent.id } : {}),
              }),
        }),
    fingerprint: report.fingerprint,
    marker: report.marker,
    submittedContentHash,
    draftContentHash: contentHash(report, destination.kind),
    ...(hasBody ? { remoteContentHash: sha256(JSON.stringify(actual)) } : {}),
    attachmentCompleteness: {
      state: !hasBody ? 'unknown' : missingEvidenceIds.length ? 'partial' : 'complete',
      missingEvidenceIds,
    },
    observedAt: new Date().toISOString(),
  };
}

function reportProblem(report, forWrite = false) {
  const destination = report?.destination;
  if (
    !destination ||
    !validRepo(destination.repo) ||
    !canonicalRepo(destination.repo) ||
    !['issue', 'issue-comment', 'discussion-comment'].includes(destination.kind)
  )
    return 'invalid-report-destination';
  if (destination.kind === 'issue-comment' && !positiveInteger(destination.number))
    return 'issue-number-missing';
  if (
    destination.kind === 'discussion-comment' &&
    (!NODE_ID.test(string(destination.nodeId)) ||
      (destination.number !== undefined && !positiveInteger(destination.number)))
  )
    return 'discussion-identity-missing';
  if (
    !SHA256.test(string(report.fingerprint)) ||
    report.marker !== `<!-- filter-observatory:v1:${report.fingerprint} -->` ||
    typeof report.body !== 'string' ||
    !report.body.includes(report.marker)
  )
    return 'invalid-report-marker';
  if (forWrite) {
    if (report.sensitivity !== 'ordinary') return 'sensitive-publication-not-supported';
    if (
      !normalizedText(report.title) ||
      report.title.length > 256 ||
      Buffer.byteLength(report.body) > 60000
    )
      return 'invalid-report-content-size';
    if (containsPrivateData(report.title) || containsPrivateData(report.body))
      return 'private-data-in-report-text';
    if (
      !Array.isArray(report.evidence) ||
      report.evidence.some(
        (image) =>
          !ID.test(string(image?.id)) ||
          image.id === 'text' ||
          image.sensitivity !== 'ordinary' ||
          image.sanitized !== true ||
          image.verifiedPublic !== true ||
          !publicUrl(image.url),
      )
    )
      return 'unverified-public-evidence';
  }
  return undefined;
}

function duplicateCandidates(issues, report, commentSiteNumbers = []) {
  return issues.filter(
    (item) =>
      (matchesHost(item, report.hostname) || commentSiteNumbers.includes(item.number)) &&
      (report.policyName !== 'abpvn' ||
        (() => {
          const type = issueCategory(item);
          return (
            !type ||
            (['incorrect-blocking', 'anti-adblock'].includes(report.category)
              ? ['incorrect-blocking', 'anti-adblock'].includes(type)
              : ['missed-ads', 'ad-leftover'].includes(type))
          );
        })()),
  );
}

/** The caller owns durable sending/outbox state. This adapter never retries a dispatched mutation. */
export function createGitHubPublisher({
  token,
  fetchImpl = fetch,
  apiBase = 'https://api.github.com',
} = {}) {
  const origin = apiOrigin(apiBase);
  if (
    token !== undefined &&
    (typeof token !== 'string' || !token.length || token.length > 2048 || /\s/.test(token))
  )
    throw new TypeError('Invalid GitHub token');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  let queue = Promise.resolve();
  let blockedUntil = 0;
  let nextMutationAt = 0;
  const publications = new Map();
  const uploadAttempts = new Map();
  const observations = new Map();
  const serial = (task) => {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  };
  const failure = (state, reason, extra = {}) => ({ failure: { state, reason, ...extra } });
  const safeText = (value) =>
    containsPrivateData(value) || (token && string(value).includes(token))
      ? '[redacted: possible private data]'
      : string(value).slice(0, 60000);

  function rateFailure(response, data) {
    const retryAfter = response.headers.get('retry-after');
    const remaining = response.headers.get('x-ratelimit-remaining');
    const graphRateLimit =
      Array.isArray(data?.errors) && data.errors.some((error) => error?.type === 'RATE_LIMITED');
    if (
      response.status !== 429 &&
      !(
        response.status === 403 &&
        (retryAfter ||
          remaining === '0' ||
          /rate limit|secondary limit/i.test(string(data?.message)))
      ) &&
      !graphRateLimit
    )
      return undefined;
    let until = Date.now() + 60000;
    if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter))
      until = Date.now() + Number(retryAfter) * 1000;
    else if (retryAfter && Number.isFinite(Date.parse(retryAfter))) until = Date.parse(retryAfter);
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
    if (remaining === '0' && Number.isFinite(reset)) until = Math.max(until, reset);
    if (!Number.isFinite(until) || until > 8640000000000000) until = Date.now() + 86400000;
    blockedUntil = Math.max(blockedUntil, until, Date.now() + 1000);
    return {
      state: 'deferred',
      reason: 'rate-limited',
      retryAt: new Date(blockedUntil).toISOString(),
      httpStatus: response.status,
    };
  }

  async function request(
    path,
    { method = 'GET', body, signal, mutation = false, headers = {}, beforeMutation } = {},
  ) {
    if (signal?.aborted) return failure('deferred', 'cancelled-before-dispatch');
    if (Date.now() < blockedUntil)
      return failure('deferred', 'rate-limited', { retryAt: new Date(blockedUntil).toISOString() });
    if (mutation && Date.now() < nextMutationAt)
      return failure('deferred', 'mutation-paced', {
        retryAt: new Date(nextMutationAt).toISOString(),
      });
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, origin).origin !== origin)
      return failure('failed', 'invalid-api-path');
    const timeout = AbortSignal.timeout(15000);
    const currentSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    let data;
    const options = {
      method,
      redirect: 'manual',
      signal: currentSignal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': 'Filter-Observatory',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    if (mutation && beforeMutation !== undefined) {
      try {
        const allowed = typeof beforeMutation === 'function' ? beforeMutation() : false;
        if (allowed !== true) {
          if (allowed instanceof Promise) allowed.catch(() => undefined);
          return failure('deferred', 'publication-inputs-changed');
        }
      } catch {
        return failure('deferred', 'publication-inputs-changed');
      }
    }
    // No await between the worker's validity check and dispatch of the unsafe method.
    if (currentSignal.aborted) return failure('deferred', 'cancelled-before-dispatch');
    try {
      if (mutation) nextMutationAt = Date.now() + 1000;
      response = await fetchImpl(`${origin}${path}`, options);
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400 && response.status !== 304)
      ) {
        await response.body?.cancel();
        return failure('deferred', 'github-redirect-requires-route-refresh', {
          httpStatus: response.status,
        });
      }
      if (response.status === 304) return { status: 304, headers: response.headers };
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        return failure(mutation ? 'uncertain' : 'deferred', 'github-response-too-large', {
          httpStatus: response.status,
        });
      }
      const reader = response.body?.getReader();
      const chunks = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            return failure(mutation ? 'uncertain' : 'deferred', 'github-response-too-large', {
              httpStatus: response.status,
            });
          }
          chunks.push(Buffer.from(next.value));
        }
      }
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        data = undefined;
      }
    } catch {
      return failure(
        mutation ? 'uncertain' : 'deferred',
        mutation ? 'submission-response-unavailable' : 'github-read-unavailable',
      );
    }
    const limited = rateFailure(response, data);
    // GraphQL can return a created identity and errors together; the operation examines both.
    if (limited && !(mutation && response.status === 200 && data?.data))
      return { failure: limited };
    if (![200, 201].includes(response.status)) {
      const status = response.status;
      const reason =
        {
          401: 'github-authentication-failed',
          403: 'github-permission-denied',
          404: 'github-resource-unavailable',
          409: 'github-conflict',
          410: 'github-issues-disabled',
          422: 'github-validation-rejected',
        }[status] ?? 'github-http-error';
      return failure(
        mutation && (status >= 500 || status === 408 || (status >= 200 && status < 300))
          ? 'uncertain'
          : [403, 404, 409, 410].includes(status) || status >= 500
            ? 'deferred'
            : 'failed',
        reason,
        { httpStatus: status },
      );
    }
    if (!data || typeof data !== 'object')
      return failure(mutation ? 'uncertain' : 'deferred', 'github-invalid-json-response', {
        httpStatus: response.status,
      });
    return {
      data,
      status: response.status,
      headers: response.headers,
      ...(limited ? { rateLimit: limited } : {}),
    };
  }

  async function repository(repo, operation, signal) {
    const result = await request(`/repos/${repo}`, { signal });
    if (result.failure) return result;
    const metadata = result.data;
    if (string(metadata.full_name).toLowerCase() !== repo.toLowerCase())
      return failure('deferred', 'repository-identity-changed');
    if (metadata.archived === true || metadata.disabled === true)
      return failure('deferred', 'repository-read-only');
    if (metadata.private !== false || metadata.archived !== false || metadata.disabled !== false)
      return failure('deferred', 'public-repository-state-unverified');
    if (
      operation === 'discussion-comment'
        ? metadata.has_discussions !== true
        : operation !== 'evidence-upload' && metadata.has_issues !== true
    )
      return failure('deferred', 'repository-intake-disabled');
    return result;
  }

  async function searchIssues(repo, hostname, { signal } = {}) {
    const issues = [];
    const coverage = { pages: 0, examined: 0, total: null, scope: 'github-search-index' };
    if (
      !validRepo(repo) ||
      typeof hostname !== 'string' ||
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname)
    )
      return { issues, complete: false, reason: 'invalid-duplicate-query', coverage };
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = new URLSearchParams({
        q: `repo:${repo} is:issue "${hostname}" in:title,body,comments`,
        sort: 'created',
        order: 'asc',
        per_page: String(PAGE_SIZE),
        page: String(page),
      });
      const result = await request(`/search/issues?${query}`, { signal });
      if (result.failure)
        return {
          issues,
          complete: false,
          reason: result.failure.reason,
          ...result.failure,
          coverage,
        };
      const data = result.data;
      coverage.pages++;
      if (
        !Array.isArray(data.items) ||
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        typeof data.incomplete_results !== 'boolean'
      )
        return { issues, complete: false, reason: 'invalid-search-response', coverage };
      coverage.total = data.total_count;
      let repeatedOrForeign = false;
      for (const item of data.items) {
        coverage.examined++;
        if (item && Object.hasOwn(item, 'pull_request')) continue;
        if (!belongsToRepo(item, repo) || seen.has(item.number)) {
          repeatedOrForeign = true;
          continue;
        }
        seen.add(item.number);
        issues.push(item);
      }
      if (data.incomplete_results || repeatedOrForeign)
        return {
          issues,
          complete: false,
          reason: data.incomplete_results ? 'github-search-incomplete' : 'unstable-search-page',
          coverage,
        };
      if (coverage.examined >= data.total_count && data.total_count <= PAGE_SIZE * MAX_PAGES)
        return { issues, complete: true, coverage };
      if (data.items.length < PAGE_SIZE)
        return { issues, complete: false, reason: 'search-count-mismatch', coverage };
    }
    return { issues, complete: false, reason: 'search-result-cap', coverage };
  }

  async function readIssue(repo, number, { signal, etag } = {}) {
    const result = await request(`/repos/${repo}/issues/${number}`, {
      signal,
      headers: etag ? { 'If-None-Match': etag } : {},
    });
    if (result.failure || result.status === 304) return result;
    if (!belongsToRepo(result.data, repo) || result.data.number !== number)
      return failure('deferred', 'issue-identity-mismatch');
    return result;
  }

  async function issueComments(repo, number, { signal, onComment, etag } = {}) {
    const comments = [];
    const seen = new Set();
    let firstHeaders;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await request(
        `/repos/${repo}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
        {
          signal,
          headers: page === 1 && etag ? { 'If-None-Match': etag } : {},
        },
      );
      if (result.failure) return { comments, complete: false, ...result };
      if (page === 1) firstHeaders = result.headers;
      if (result.status === 304)
        return { comments, complete: false, notModified: true, headers: firstHeaders };
      if (!Array.isArray(result.data))
        return {
          comments,
          complete: false,
          failure: { state: 'deferred', reason: 'invalid-comments-response' },
        };
      for (const item of result.data) {
        if (
          !positiveInteger(item?.id) ||
          !remoteUrl(item.html_url, repo, 'issues', number, item.id) ||
          seen.has(item.id)
        )
          return {
            comments,
            complete: false,
            failure: { state: 'deferred', reason: 'comment-identity-mismatch' },
          };
        seen.add(item.id);
        comments.push(item);
        if (onComment?.(item))
          return { comments, complete: false, match: item, headers: firstHeaders };
      }
      const hasNext = /;\s*rel="?next"?/.test(result.headers.get('link') ?? '');
      if (!hasNext && result.data.length < PAGE_SIZE)
        return { comments, complete: true, headers: firstHeaders };
    }
    return {
      comments,
      complete: false,
      headers: firstHeaders,
      failure: { state: 'deferred', reason: 'comments-result-cap' },
    };
  }

  async function readDiscussion(destination, { signal, onComment, includeComments = true } = {}) {
    const [owner, name] = destination.repo.split('/');
    const fields = `id number url title body locked isAnswered updatedAt repository { nameWithOwner }
      ${includeComments ? 'comments(first:100,after:$cursor) { nodes { id databaseId url body createdAt updatedAt author { login } authorAssociation } pageInfo { hasNextPage endCursor } }' : ''}`;
    const byNumber = positiveInteger(destination.number);
    const query = byNumber
      ? `query($owner:String!,$name:String!,$number:Int!${includeComments ? ',$cursor:String' : ''}) { repository(owner:$owner,name:$name) { discussion(number:$number) { ${fields} } } }`
      : `query($id:ID!${includeComments ? ',$cursor:String' : ''}) { node(id:$id) { ... on Discussion { ${fields} } } }`;
    let cursor = null;
    let discussion;
    const comments = [];
    const cursors = new Set();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await request('/graphql', {
        method: 'POST',
        signal,
        body: {
          query,
          variables: {
            ...(byNumber
              ? { owner, name, number: destination.number }
              : { id: destination.nodeId }),
            ...(includeComments ? { cursor } : {}),
          },
        },
      });
      if (result.failure) return { discussion, comments, complete: false, ...result };
      const value = byNumber ? result.data.data?.repository?.discussion : result.data.data?.node;
      if (
        !value ||
        !positiveInteger(value.number) ||
        !NODE_ID.test(string(value.id)) ||
        value.id !== destination.nodeId ||
        (byNumber && value.number !== destination.number) ||
        string(value.repository?.nameWithOwner).toLowerCase() !== destination.repo.toLowerCase() ||
        !remoteUrl(value.url, destination.repo, 'discussions', value.number)
      )
        return {
          discussion,
          comments,
          complete: false,
          failure: { state: 'deferred', reason: 'discussion-identity-unverified' },
        };
      discussion = value;
      if (Array.isArray(result.data.errors) && result.data.errors.length)
        return {
          discussion,
          comments,
          complete: false,
          failure: { state: 'deferred', reason: 'graphql-read-incomplete' },
        };
      if (!includeComments) return { discussion, comments, complete: true };
      const connection = value.comments;
      if (
        !Array.isArray(connection?.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== 'boolean'
      )
        return {
          discussion,
          comments,
          complete: false,
          failure: { state: 'deferred', reason: 'invalid-discussion-comments' },
        };
      for (const item of connection.nodes) {
        if (
          !receiptFor({ evidence: [], body: '', fingerprint: '', marker: '' }, item, {
            ...destination,
            number: value.number,
          })
        )
          return {
            discussion,
            comments,
            complete: false,
            failure: { state: 'deferred', reason: 'discussion-comment-identity-mismatch' },
          };
        comments.push(item);
        if (onComment?.(item)) return { discussion, comments, complete: false, match: item };
      }
      if (!connection.pageInfo.hasNextPage) return { discussion, comments, complete: true };
      cursor = connection.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor))
        return {
          discussion,
          comments,
          complete: false,
          failure: { state: 'deferred', reason: 'invalid-discussion-cursor' },
        };
      cursors.add(cursor);
    }
    return {
      discussion,
      comments,
      complete: false,
      failure: { state: 'deferred', reason: 'discussion-comments-result-cap' },
    };
  }

  async function findIssueMarker(report, issues, signal, alwaysReadComments = false) {
    let complete = issues.length <= MAX_DUPLICATE_THREADS;
    const commentSiteNumbers = [];
    for (const issue of issues.slice(0, MAX_DUPLICATE_THREADS)) {
      if (string(issue.body).includes(report.marker)) {
        const destination = { kind: 'issue', repo: report.destination.repo };
        const receipt = receiptFor(
          report,
          issue,
          destination,
          {},
          knownSubmittedHash(report, destination),
        );
        if (receipt) return { state: 'created', receipt, reconciled: true };
        complete = false;
      }
      if (alwaysReadComments || issue.comments !== 0 || !matchesHost(issue, report.hostname)) {
        const result = await issueComments(report.destination.repo, issue.number, {
          signal,
          onComment: (item) => string(item.body).includes(report.marker),
        });
        if (result.comments.some((item) => matchesHost(item, report.hostname)))
          commentSiteNumbers.push(issue.number);
        if (result.match) {
          const destination = {
            kind: 'issue-comment',
            repo: report.destination.repo,
            number: issue.number,
          };
          const receipt = receiptFor(
            report,
            result.match,
            destination,
            issue,
            knownSubmittedHash(report, destination),
          );
          if (receipt) return { state: 'appended', receipt, reconciled: true };
        }
        if (!result.complete) {
          complete = false;
          if (result.failure)
            return {
              complete,
              commentSiteNumbers,
              reason: result.failure.reason,
              retryAt: result.failure.retryAt,
            };
        }
      }
    }
    return {
      complete,
      commentSiteNumbers,
      ...(complete ? {} : { reason: 'duplicate-comment-coverage-incomplete' }),
    };
  }

  function attemptFor(report, destination) {
    return {
      repo: destination.repo,
      operation: destination.kind,
      fingerprint: report.fingerprint,
      ...(destination.number ? { number: destination.number } : {}),
      ...(destination.nodeId ? { nodeId: destination.nodeId } : {}),
      submittedContentHash: contentHash(report, destination.kind),
    };
  }

  function attemptDestination(report, attempt) {
    if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) return null;
    const nested = attempt.destination;
    if (nested !== undefined && (!nested || typeof nested !== 'object' || Array.isArray(nested)))
      return null;
    const repo = attempt.repo ?? nested?.repo;
    const kind = attempt.operation ?? nested?.kind;
    const number = attempt.number ?? nested?.number;
    const nodeId =
      attempt.nodeId ??
      nested?.nodeId ??
      (kind === 'discussion-comment' ? report.destination.nodeId : undefined);
    if (
      !validRepo(repo) ||
      repo.toLowerCase() !== report.destination.repo.toLowerCase() ||
      !['issue', 'issue-comment', 'discussion-comment'].includes(kind) ||
      (attempt.fingerprint === undefined
        ? attempt.marker !== report.marker
        : attempt.fingerprint !== report.fingerprint) ||
      (attempt.marker !== undefined && attempt.marker !== report.marker) ||
      (attempt.submittedContentHash != null &&
        !SHA256.test(string(attempt.submittedContentHash))) ||
      (nested &&
        ((attempt.repo && string(nested.repo).toLowerCase() !== repo.toLowerCase()) ||
          (attempt.operation && nested.kind !== kind) ||
          (attempt.number !== undefined && nested.number !== number) ||
          (attempt.nodeId !== undefined && nested.nodeId !== nodeId)))
    )
      return null;
    if (
      (number !== undefined && !positiveInteger(number)) ||
      (kind === 'issue-comment' && !positiveInteger(number)) ||
      (kind === 'discussion-comment' && !NODE_ID.test(string(nodeId)))
    )
      return null;
    const original = report.destination;
    if (
      original.kind !== kind &&
      !(
        original.kind === 'issue' &&
        kind === 'issue-comment' &&
        canonicalRepo(repo)?.policy === 'uassets'
      )
    )
      return null;
    if (original.number !== undefined && original.number !== number) return null;
    if (original.kind === 'discussion-comment' && original.nodeId !== nodeId) return null;
    return {
      kind,
      repo: original.repo,
      ...(number !== undefined ? { number } : {}),
      ...(nodeId ? { nodeId } : {}),
    };
  }

  function knownSubmittedHash(report, destination) {
    for (const value of [publications.get(publicationKey(report))?.attempt, report.attempt]) {
      const attempted = attemptDestination(report, value);
      if (
        attempted &&
        attempted.kind === destination.kind &&
        attempted.repo === destination.repo &&
        (!destination.number || attempted.number === destination.number) &&
        SHA256.test(string(value.submittedContentHash))
      )
        return value.submittedContentHash;
    }
    const receipt = report.receipt;
    if (
      string(receipt?.repo).toLowerCase() === destination.repo.toLowerCase() &&
      receipt?.operation === destination.kind &&
      receipt?.fingerprint === report.fingerprint &&
      SHA256.test(string(receipt?.submittedContentHash)) &&
      (!destination.number ||
        (receipt.issueNumber ?? receipt.discussionNumber) === destination.number)
    )
      return receipt.submittedContentHash;
    return null;
  }

  function remember(report, result) {
    if (['created', 'appended', 'uncertain'].includes(result.state)) {
      const key = publicationKey(report);
      const attempt = result.attempt ?? publications.get(key)?.attempt;
      if (attempt) result = { ...result, attempt };
      publications.set(key, structuredClone(result));
    }
    return result;
  }

  async function publish(report, { signal, beforeMutation } = {}) {
    if (report?.state === 'dry-run' || report?.dryRun === true)
      return { state: 'dry-run', reason: 'publication-disabled' };
    if (report?.state !== 'ready')
      return {
        state: report?.state === 'unsupported' ? 'unsupported' : 'deferred',
        reason: 'report-not-ready',
      };
    const problem = reportProblem(report, true);
    if (problem) return { state: 'deferred', reason: problem };
    if (!token) return { state: 'deferred', reason: 'github-token-missing' };
    if (report.body.includes(token) || report.title.includes(token))
      return { state: 'deferred', reason: 'private-data-in-report-text' };
    const previous = publications.get(publicationKey(report));
    if (previous) return structuredClone(previous);
    let destination = { ...report.destination };
    const metadata = await repository(destination.repo, destination.kind, signal);
    if (metadata.failure) return metadata.failure;
    let issue;
    if (destination.kind === 'issue') {
      const search = await searchIssues(destination.repo, report.hostname, { signal });
      const found = await findIssueMarker(report, search.issues, signal);
      if (found.receipt) return remember(report, found);
      if (!search.complete || !found.complete)
        return {
          state: 'deferred',
          reason: 'duplicate-search-incomplete',
          detail: search.reason ?? found.reason,
          ...(search.retryAt || found.retryAt ? { retryAt: search.retryAt ?? found.retryAt } : {}),
        };
      const candidates = duplicateCandidates(search.issues, report, found.commentSiteNumbers).sort(
        (a, b) => a.number - b.number,
      );
      if (candidates.length) {
        if (canonicalRepo(destination.repo).policy !== 'uassets')
          return {
            state: 'deferred',
            reason: 'possible-duplicate',
            issueNumber: candidates[0].number,
          };
        destination = {
          kind: 'issue-comment',
          repo: destination.repo,
          number: candidates[0].number,
        };
      }
    }
    if (destination.kind === 'issue-comment') {
      const result = await readIssue(destination.repo, destination.number, { signal });
      if (result.failure) return result.failure;
      issue = result.data;
      const found = await findIssueMarker(report, [issue], signal, true);
      if (found.receipt) return remember(report, found);
      if (!found.complete)
        return {
          state: 'deferred',
          reason: found.reason ?? 'duplicate-search-incomplete',
          ...(found.retryAt ? { retryAt: found.retryAt } : {}),
        };
      if (issue.locked !== false)
        return {
          state: 'deferred',
          reason: issue.locked === true ? 'thread-locked' : 'thread-lock-state-unknown',
        };
      if (report.threadPolicy && sha256(string(issue.body)) !== report.threadPolicy.bodyHash)
        return { state: 'deferred', reason: 'thread-policy-changed' };
    }
    if (destination.kind === 'discussion-comment') {
      const result = await readDiscussion(destination, {
        signal,
        onComment: (item) => string(item.body).includes(report.marker),
      });
      if (result.discussion) destination.number = result.discussion.number;
      if (result.match)
        return remember(report, {
          state: 'appended',
          receipt: receiptFor(
            report,
            result.match,
            destination,
            {},
            knownSubmittedHash(report, destination),
          ),
          reconciled: true,
        });
      if (!result.complete)
        return (
          result.failure ?? { state: 'deferred', reason: 'discussion-duplicate-search-incomplete' }
        );
      if (result.discussion.locked !== false) return { state: 'deferred', reason: 'thread-locked' };
      if (
        report.threadPolicy &&
        sha256(string(result.discussion.body)) !== report.threadPolicy.bodyHash
      )
        return { state: 'deferred', reason: 'thread-policy-changed' };
      const query =
        'mutation($input:AddDiscussionCommentInput!) { addDiscussionComment(input:$input) { clientMutationId comment { id databaseId url body discussion { id number } } } }';
      const attempt = attemptFor(report, destination);
      const write = await request('/graphql', {
        method: 'POST',
        mutation: true,
        signal,
        beforeMutation,
        body: {
          query,
          variables: {
            input: {
              discussionId: destination.nodeId,
              body: report.body,
              clientMutationId: report.fingerprint,
            },
          },
        },
      });
      if (write.failure)
        return remember(report, {
          ...write.failure,
          ...(write.failure.state === 'uncertain' ? { attempt } : {}),
        });
      const record = write.data.data?.addDiscussionComment?.comment;
      const receipt =
        record?.discussion?.id === destination.nodeId &&
        record.discussion.number === destination.number
          ? receiptFor(report, record, destination, {}, attempt.submittedContentHash)
          : undefined;
      if (!receipt)
        return remember(report, {
          state: 'uncertain',
          reason: 'graphql-mutation-outcome-unknown',
          httpStatus: write.status,
          attempt,
        });
      return remember(report, {
        state: 'appended',
        receipt,
        httpStatus: write.status,
        ...(write.data.errors?.length ? { partial: true, reason: 'graphql-partial-response' } : {}),
      });
    }
    const attempt = attemptFor(report, destination);
    const write = await request(
      `/repos/${destination.repo}/issues${destination.kind === 'issue-comment' ? `/${destination.number}/comments` : ''}`,
      {
        method: 'POST',
        mutation: true,
        signal,
        beforeMutation,
        body:
          destination.kind === 'issue'
            ? { title: report.title, body: report.body }
            : { body: report.body },
      },
    );
    if (write.failure)
      return remember(report, {
        ...write.failure,
        ...(write.failure.state === 'uncertain' ? { attempt } : {}),
      });
    const receipt = receiptFor(
      report,
      write.data,
      destination,
      issue,
      attempt.submittedContentHash,
    );
    if (!receipt)
      return remember(report, {
        state: 'uncertain',
        reason: 'submission-identity-unverified',
        httpStatus: write.status,
        attempt,
      });
    return remember(report, {
      state: destination.kind === 'issue' ? 'created' : 'appended',
      receipt,
      httpStatus: write.status,
    });
  }

  async function reconcile(report, { signal } = {}) {
    const problem = reportProblem(report);
    let retainedAttempt;
    const retain = (result) =>
      remember(report, { ...result, ...(retainedAttempt ? { attempt: retainedAttempt } : {}) });
    const unresolved = (result) => retain({ ...result, state: 'uncertain' });
    if (problem) return unresolved({ reason: problem });
    const previous = publications.get(publicationKey(report));
    if (previous?.receipt) return structuredClone(previous);
    const attempt = report.attempt !== undefined ? report.attempt : previous?.attempt;
    const destination =
      attempt === undefined ? report.destination : attemptDestination(report, attempt);
    if (!destination) return unresolved({ reason: 'invalid-persisted-attempt' });
    if (attempt !== undefined)
      retainedAttempt = {
        repo: destination.repo,
        operation: destination.kind,
        fingerprint: report.fingerprint,
        ...(destination.number !== undefined ? { number: destination.number } : {}),
        ...(destination.nodeId ? { nodeId: destination.nodeId } : {}),
        submittedContentHash: SHA256.test(string(attempt.submittedContentHash))
          ? attempt.submittedContentHash
          : null,
      };
    if (destination.kind === 'discussion-comment') {
      const result = await readDiscussion(destination, {
        signal,
        onComment: (item) => string(item.body).includes(report.marker),
      });
      if (result.match) {
        const resolvedDestination = { ...destination, number: result.discussion.number };
        const receipt = receiptFor(
          report,
          result.match,
          resolvedDestination,
          {},
          knownSubmittedHash(report, resolvedDestination),
        );
        if (receipt) return retain({ state: 'appended', receipt, reconciled: true });
      }
      return unresolved({
        ...result.failure,
        reason: result.failure?.reason ?? 'submission-not-found-in-bounded-read',
        coverageComplete: result.complete,
      });
    }
    let issues;
    let complete;
    let searchFailure;
    if (destination.number || report.receipt?.issueNumber) {
      const number = destination.number ?? report.receipt.issueNumber;
      if (!positiveInteger(number)) return unresolved({ reason: 'invalid-issue-identity' });
      const result = await readIssue(destination.repo, number, { signal });
      if (result.failure) return unresolved(result.failure);
      issues = [result.data];
      complete = true;
    } else {
      const result = await searchIssues(destination.repo, report.hostname, { signal });
      if (!result.complete && result.reason)
        searchFailure = {
          reason: result.reason,
          ...(result.retryAt ? { retryAt: result.retryAt } : {}),
          ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        };
      issues = result.issues;
      complete = result.complete;
    }
    const found = await findIssueMarker(report, issues, signal, true);
    if (found.receipt) return retain(found);
    return unresolved({
      ...searchFailure,
      reason: found.reason ?? searchFailure?.reason ?? 'submission-not-found-in-bounded-read',
      ...(found.retryAt ? { retryAt: found.retryAt } : {}),
      coverageComplete: complete && found.complete,
    });
  }

  function observedComment(item, discussion = false) {
    return {
      id: item.id,
      ...(positiveInteger(item.databaseId) ? { databaseId: item.databaseId } : {}),
      url: discussion ? item.url : item.html_url,
      body: safeText(item.body),
      author: safeText(discussion ? item.author?.login : item.user?.login),
      authorAssociation: safeText(item.authorAssociation ?? item.author_association),
      createdAt: item.createdAt ?? item.created_at,
      updatedAt: item.updatedAt ?? item.updated_at,
      untrusted: true,
    };
  }

  async function discussionReplies(destination, commentNodeId, signal) {
    const replies = [];
    const seen = new Set();
    const cursors = new Set();
    let cursor = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const query = `query($id:ID!,$cursor:String) { node(id:$id) { ... on DiscussionComment {
        id discussion { id number repository { nameWithOwner } }
        replies(first:100,after:$cursor) { nodes { id databaseId url body createdAt updatedAt author { login } authorAssociation }
          pageInfo { hasNextPage endCursor } }
      } } }`;
      const result = await request('/graphql', {
        method: 'POST',
        signal,
        body: { query, variables: { id: commentNodeId, cursor } },
      });
      if (result.failure) return { replies, complete: false, ...result };
      const node = result.data.data?.node;
      if (
        node?.id !== commentNodeId ||
        node?.discussion?.id !== destination.nodeId ||
        node.discussion.number !== destination.number ||
        string(node.discussion.repository?.nameWithOwner).toLowerCase() !==
          destination.repo.toLowerCase()
      ) {
        return {
          replies,
          complete: false,
          failure: { state: 'deferred', reason: 'discussion-reply-parent-mismatch' },
        };
      }
      if (result.data.errors?.length)
        return {
          replies,
          complete: false,
          failure: { state: 'deferred', reason: 'graphql-read-incomplete' },
        };
      const connection = node.replies;
      if (
        !Array.isArray(connection?.nodes) ||
        typeof connection.pageInfo?.hasNextPage !== 'boolean'
      ) {
        return {
          replies,
          complete: false,
          failure: { state: 'deferred', reason: 'invalid-discussion-replies' },
        };
      }
      for (const item of connection.nodes) {
        if (
          seen.has(item?.id) ||
          !receiptFor({ evidence: [], body: '', fingerprint: '', marker: '' }, item, destination)
        ) {
          return {
            replies,
            complete: false,
            failure: { state: 'deferred', reason: 'discussion-reply-identity-mismatch' },
          };
        }
        seen.add(item.id);
        replies.push(item);
      }
      if (!connection.pageInfo.hasNextPage) return { replies, complete: true };
      cursor = connection.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor))
        return {
          replies,
          complete: false,
          failure: { state: 'deferred', reason: 'invalid-discussion-cursor' },
        };
      cursors.add(cursor);
    }
    return {
      replies,
      complete: false,
      failure: { state: 'deferred', reason: 'discussion-replies-result-cap' },
    };
  }

  async function followUp(receipt, { signal } = {}) {
    if (
      !validRepo(receipt?.repo) ||
      !canonicalRepo(receipt.repo) ||
      !['issue', 'issue-comment', 'discussion-comment'].includes(receipt.operation)
    )
      return { state: 'deferred', reason: 'invalid-followup-receipt' };
    const observedAt = new Date().toISOString();
    const lifecycle = {
      upstreamClosed: null,
      sourceFix: 'unknown',
      publishedFix: 'unknown',
      installedRevision: 'unknown',
      retest: 'not-run',
      resolved: false,
    };
    if (receipt.operation === 'discussion-comment') {
      if (
        !NODE_ID.test(string(receipt.discussionNodeId)) ||
        !positiveInteger(receipt.discussionNumber) ||
        !NODE_ID.test(string(receipt.commentNodeId))
      )
        return { state: 'deferred', reason: 'discussion-receipt-identity-missing' };
      const destination = {
        kind: 'discussion-comment',
        repo: receipt.repo,
        number: receipt.discussionNumber,
        nodeId: receipt.discussionNodeId,
      };
      const result = await readDiscussion(destination, { signal });
      if (!result.discussion)
        return result.failure ?? { state: 'deferred', reason: 'discussion-read-unavailable' };
      const replies = await discussionReplies(destination, receipt.commentNodeId, signal);
      const discussion = result.discussion;
      return {
        state: 'observed',
        observedAt,
        repo: receipt.repo,
        operation: receipt.operation,
        discussion: {
          id: discussion.id,
          number: discussion.number,
          url: discussion.url,
          title: safeText(discussion.title),
          body: safeText(discussion.body),
          locked: discussion.locked,
          isAnswered: discussion.isAnswered,
          updatedAt: discussion.updatedAt,
          untrusted: true,
        },
        comments: result.comments.map((item) => observedComment(item, true)),
        replies: replies.replies.map((item) => observedComment(item, true)),
        lifecycle: { ...lifecycle, upstreamAnswered: discussion.isAnswered === true },
        coverage: { discussion: true, comments: result.complete, replies: replies.complete },
        ...(!result.complete || !replies.complete
          ? {
              partial: true,
              reason:
                result.failure?.reason ?? replies.failure?.reason ?? 'followup-coverage-incomplete',
            }
          : {}),
      };
    }
    if (!positiveInteger(receipt.issueNumber))
      return { state: 'deferred', reason: 'issue-receipt-identity-missing' };
    const key = `${receipt.repo.toLowerCase()}:${receipt.issueNumber}`;
    const previous = observations.get(key);
    const result = await readIssue(receipt.repo, receipt.issueNumber, {
      signal,
      etag: previous?.validators.issue,
    });
    if (result.failure) return result.failure;
    if (result.status === 304 && !previous)
      return { state: 'deferred', reason: 'conditional-response-without-baseline' };
    const issue = result.status === 304 ? previous.issue : result.data;
    // A first-page validator cannot establish that later comment pages are unchanged.
    const etag =
      previous?.complete && previous.comments.length < PAGE_SIZE
        ? previous.validators.comments
        : undefined;
    const commentResult = await issueComments(receipt.repo, receipt.issueNumber, { signal, etag });
    const reuseComments = commentResult.notModified === true && Boolean(etag);
    const comments = reuseComments ? previous.comments : commentResult.comments;
    const complete = reuseComments || commentResult.complete;
    const validators = {
      issue: result.headers?.get('etag') ?? previous?.validators.issue,
      comments:
        commentResult.headers?.get('etag') ??
        (reuseComments ? previous.validators.comments : undefined),
    };
    const pollSeconds = Math.max(
      60,
      ...[result.headers, commentResult.headers].map((headers) => {
        const seconds = Number(headers?.get('x-poll-interval'));
        return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 0;
      }),
    );
    observations.set(key, { issue, comments, complete, validators });
    return {
      state: 'observed',
      observedAt,
      repo: receipt.repo,
      operation: receipt.operation,
      issue: {
        id: issue.id,
        number: issue.number,
        url: issue.html_url,
        title: safeText(issue.title),
        body: safeText(issue.body),
        state: issue.state,
        stateReason: issue.state_reason ?? null,
        locked: issue.locked,
        labels: (issue.labels ?? []).map((label) =>
          safeText(typeof label === 'string' ? label : label.name),
        ),
        updatedAt: issue.updated_at,
        untrusted: true,
      },
      comments: comments.map((item) => observedComment(item)),
      lifecycle: { ...lifecycle, upstreamClosed: issue.state === 'closed' },
      validators,
      nextCheckAt: new Date(Date.now() + pollSeconds * 1000).toISOString(),
      notModified: result.status === 304 && reuseComments,
      coverage: { issue: true, comments: complete },
      ...(!complete
        ? {
            partial: true,
            reason: commentResult.failure?.reason ?? 'followup-comment-coverage-incomplete',
            ...(commentResult.failure?.retryAt ? { retryAt: commentResult.failure.retryAt } : {}),
          }
        : {}),
    };
  }

  async function uploadEvidence(
    image,
    config = {},
    { signal, reconcileOnly = false, readOnly = false, beforeMutation } = {},
  ) {
    if (config.enabled === false || config.dryRun === true)
      return { state: 'dry-run', reason: 'publication-disabled' };
    const reconciliationOnly =
      readOnly === true || reconcileOnly === true || config.reconcileOnly === true;
    if (
      image?.sensitivity !== 'ordinary' ||
      (image?.context?.sensitivity !== undefined && image.context.sensitivity !== 'ordinary') ||
      (config.sensitivity !== undefined && config.sensitivity !== 'ordinary')
    )
      return { state: 'deferred', reason: 'sensitive-evidence-upload-not-supported' };
    if (image.sanitized !== true) return { state: 'deferred', reason: 'evidence-not-sanitized' };
    if (!ID.test(string(image.id)) || image.id === 'text' || image.mimeType !== 'image/png')
      return { state: 'failed', reason: 'invalid-image-evidence' };
    const maxBytes = 10 * 1024 * 1024;
    const encoded = string(image.dataBase64);
    if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4) {
      return { state: 'failed', reason: 'png-bytes-required' };
    }
    let bytes = Buffer.from(encoded, 'base64');
    // A repeated-group regex over a valid multi-megabyte screenshot exhausts V8's stack.
    if (bytes.toString('base64') !== encoded)
      return { state: 'failed', reason: 'png-bytes-required' };
    if (
      bytes.length < 33 ||
      bytes.length > maxBytes ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR'
    )
      return { state: 'failed', reason: 'invalid-png' };
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width > 32768 ||
      height > 32768 ||
      width * height > 16777216 ||
      (image.width !== undefined && image.width !== width) ||
      (image.height !== undefined && image.height !== height)
    ) {
      return { state: 'failed', reason: 'png-dimensions-invalid-or-too-large' };
    }
    const sourceSha256 = sha256(bytes);
    try {
      // Re-encoding preserves pixels while discarding textual/ancillary PNG metadata.
      const png = PNG.sync.read(bytes, { checkCRC: true });
      bytes = PNG.sync.write({ width: png.width, height: png.height, data: png.data });
    } catch {
      return { state: 'failed', reason: 'invalid-png' };
    }
    if (bytes.length > maxBytes) return { state: 'failed', reason: 'png-too-large' };
    const configured = config.evidenceRepository;
    const settings = typeof configured === 'string' ? { repo: configured } : configured;
    if (!validRepo(settings?.repo))
      return { state: 'deferred', reason: 'evidence-repository-not-configured' };
    if (canonicalRepo(settings.repo))
      return { state: 'deferred', reason: 'evidence-repository-must-be-operator-owned' };
    if (settings.owned === false)
      return { state: 'deferred', reason: 'evidence-repository-ownership-unverified' };
    if (!token) return { state: 'deferred', reason: 'github-token-missing' };
    const repo = settings.repo;
    const metadata = await repository(repo, 'evidence-upload', signal);
    if (metadata.failure) return metadata.failure;
    if (settings.owned !== true && metadata.data.permissions?.admin !== true)
      return { state: 'deferred', reason: 'evidence-repository-ownership-unverified' };
    const branch = settings.branch ?? metadata.data.default_branch;
    if (
      typeof branch !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch) ||
      branch.includes('..') ||
      branch
        .split('/')
        .some(
          (part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'),
        )
    ) {
      return { state: 'deferred', reason: 'invalid-evidence-branch' };
    }
    const digest = sha256(bytes);
    const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const path = `screenshots/${digest}.png`;
    const key = `${repo.toLowerCase()}:${branch}:${digest}`;
    const prior = uploadAttempts.get(key);
    const endpoint = `/repos/${repo}/contents/${path}`;
    const receipt = (commitSha) => ({
      repo,
      operation: 'evidence-upload',
      path,
      branch,
      blobSha,
      contentHash: digest,
      sourceSha256,
      ...(GIT_SHA.test(string(commitSha)) ? { commitSha } : {}),
      observedAt: new Date().toISOString(),
    });
    const uploadedImage = (commitSha) => ({
      id: image.id,
      mimeType: 'image/png',
      width,
      height,
      sensitivity: 'ordinary',
      sanitized: true,
      verifiedPublic: true,
      sha256: digest,
      url: `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(commitSha ?? branch)}/${path}`,
    });
    const matches = (content) =>
      content?.type === 'file' && content.path === path && content.sha === blobSha;
    const existing = await request(`${endpoint}?${new URLSearchParams({ ref: branch })}`, {
      signal,
    });
    if (!existing.failure) {
      if (!matches(existing.data))
        return { state: 'deferred', reason: 'evidence-content-conflict', receipt: receipt() };
      const commitSha = prior?.receipt?.commitSha;
      const result = {
        state: 'existing',
        image: uploadedImage(commitSha),
        receipt: receipt(commitSha),
      };
      uploadAttempts.set(key, result);
      return result;
    }
    if (existing.failure.httpStatus !== 404)
      return { ...existing.failure, receipt: prior?.receipt ?? receipt() };
    if (
      reconciliationOnly ||
      prior?.state === 'uncertain' ||
      prior?.state === 'uploaded' ||
      prior?.state === 'existing'
    ) {
      const result = {
        state: 'uncertain',
        reason: 'evidence-not-found-after-dispatch',
        receipt: prior?.receipt ?? receipt(),
      };
      uploadAttempts.set(key, result);
      return result;
    }
    if (metadata.data.permissions?.push !== true)
      return { state: 'deferred', reason: 'evidence-repository-not-writable' };
    const write = await request(endpoint, {
      method: 'PUT',
      signal,
      mutation: true,
      beforeMutation,
      body: {
        message: `Store sanitized screenshot ${digest}`,
        branch,
        content: bytes.toString('base64'),
      },
    });
    if (write.failure) {
      const result = {
        ...write.failure,
        ...(write.failure.state === 'uncertain' ? { receipt: receipt() } : {}),
      };
      if (result.state === 'uncertain') uploadAttempts.set(key, result);
      return result;
    }
    const commitSha = GIT_SHA.test(string(write.data.commit?.sha))
      ? write.data.commit.sha
      : undefined;
    if (!matches(write.data.content)) {
      const result = {
        state: 'uncertain',
        reason: 'upload-content-identity-unverified',
        receipt: receipt(commitSha),
        httpStatus: write.status,
      };
      uploadAttempts.set(key, result);
      return result;
    }
    const result = {
      state: 'uploaded',
      image: uploadedImage(commitSha),
      receipt: receipt(commitSha),
      httpStatus: write.status,
    };
    uploadAttempts.set(key, result);
    return result;
  }

  return {
    publish: (report, options) => serial(() => publish(structuredClone(report), options)),
    reconcile: (report, options) => serial(() => reconcile(structuredClone(report), options)),
    searchIssues: (repo, hostname, options) => serial(() => searchIssues(repo, hostname, options)),
    followUp: (receipt, options) => serial(() => followUp(structuredClone(receipt), options)),
    uploadEvidence: (image, config, options) =>
      serial(() => uploadEvidence(structuredClone(image), structuredClone(config), options)),
  };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateAudit, RULES, RULE_CONDITIONS, scoreAudit } from './rules.js';
import type { Finding, PageSnapshot, SiteSignals } from './types.js';

function page(url = 'https://example.com/post'): PageSnapshot {
  const text = '직접 방문한 장소의 이동 방법과 운영 시간, 방문할 때 주의할 점을 정리했습니다. '.repeat(12);
  return {
    url, finalUrl: url, fetchedAt: '2026-09-28T00:00:00.000Z', statusCode: 200,
    contentType: 'text/html', rawHtml: `<html lang="ko"><head><title>방문 안내</title></head><body><a href="/">홈</a><main>${text}</main></body></html>`,
    renderedText: text, mainText: text, title: '방문 안내', metaDescription: '직접 방문한 장소 안내',
    canonical: url, robotsMeta: '', lang: 'ko', headings: ['방문 안내'], links: ['https://example.com/'],
    navLinks: ['https://example.com/', 'https://example.com/about'], imageCount: 0, imagesWithoutAlt: 0,
    mediaCount: 0, adElementCount: 0, hasAdsenseScript: false, hasAdsenseMeta: false,
    hasPrivacyLink: true, hasAboutLink: true, hasContactLink: true, hasCookieTerms: true,
    hasAdClickPrompt: false, desktopOverflow: false, mobileOverflow: false, popupCount: 0,
    jsErrors: [], resourceFailures: [], redirectCount: 0,
    desktopRender: { viewport: 'desktop', attempted: true, success: true, finalUrl: url,
      statusCode: 200, title: '방문 안내', mainTextPresent: true, errorScreen: false },
    mobileRender: { viewport: 'mobile', attempted: true, success: true, finalUrl: url,
      statusCode: 200, title: '방문 안내', mainTextPresent: true, errorScreen: false },
  };
}

function signals(): SiteSignals {
  return {
    rootUrl: 'https://example.com/', host: 'example.com', robotsUrl: 'https://example.com/robots.txt',
    robotsText: 'User-agent: *\nAllow: /', robotsAllowsAdsense: true, sitemapUrls: [],
    adsTxtUrl: 'https://example.com/ads.txt', adsTxtText: null, discoveryMethod: 'links-only',
    technicalFiles: {
      robots: { url: 'https://example.com/robots.txt', finalUrl: 'https://example.com/robots.txt', statusCode: 200,
        bodyPresent: true, responseTimeMs: 20, redirectChain: [], checkedAt: '2026-09-29T01:00:00.000Z' },
      sitemap: { url: 'https://example.com/sitemap.xml', finalUrl: 'https://example.com/sitemap.xml', statusCode: 404,
        bodyPresent: false, responseTimeMs: 20, redirectChain: [], checkedAt: '2026-09-29T01:00:00.000Z' },
      ads: { url: 'https://example.com/ads.txt', finalUrl: 'https://example.com/ads.txt', statusCode: 404,
        bodyPresent: false, responseTimeMs: 20, redirectChain: [], checkedAt: '2026-09-29T01:00:00.000Z' },
    },
  };
}

function find(items: Finding[], id: string, url?: string): Finding {
  const item = items.find((candidate) => candidate.id === id && (!url || candidate.pageUrl === url));
  assert.ok(item, `missing ${id}`);
  return item;
}

function completeGoodFindings(): Finding[] {
  const samples = evaluateAudit([page()], signals());
  return Object.entries(RULES)
    .filter(([, rule]) => rule.weight > 0)
    .map(([id]) => ({ ...find(samples, id), verdict: 'good' as const }));
}

test('published area weights stay at 40/20/15/15/10', () => {
  const totals: Record<string, number> = {};
  for (const rule of Object.values(RULES)) totals[rule.area] = (totals[rule.area] ?? 0) + rule.weight;
  assert.deepEqual([totals.content, totals.navigation, totals.access, totals.trust, totals.adsense], [40, 20, 15, 15, 10]);
  assert.deepEqual(Object.keys(RULE_CONDITIONS).sort(), Object.keys(RULES).sort());
  const sample = evaluateAudit([page()], signals())[0];
  assert.equal(sample.ruleVersion, '2026.09.29-6');
  assert.ok(sample.appliesTo);
  assert.ok(sample.decisionCondition);
});

test('real placeholder text is flagged, ordinary input placeholder is not', () => {
  const normal = page();
  normal.rawHtml = '<main>완성된 내용입니다.</main><input placeholder="검색어를 입력하세요">';
  const unfinished = page('https://example.com/unfinished');
  unfinished.mainText = 'Lorem ipsum dolor sit amet';
  unfinished.renderedText = unfinished.mainText;
  unfinished.rawHtml = '<main>Lorem ipsum dolor sit amet</main>';
  const items = evaluateAudit([normal, unfinished], signals());
  assert.equal(find(items, 'content.placeholder', normal.url).verdict, 'good');
  assert.equal(find(items, 'content.placeholder', unfinished.url).verdict, 'issue');
  assert.equal(find(items, 'content.empty', unfinished.url).verdict, 'caution');
});

test('successful raw HTML with renderer failure does not become an empty or mobile issue', () => {
  const rawOnly = page('https://example.com/raw-only');
  rawOnly.mainText = '';
  rawOnly.renderedText = '';
  rawOnly.title = '원본 제목';
  rawOnly.desktopRender = { viewport: 'desktop', attempted: true, success: false, error: 'browser unavailable', failureCategory: 'render_failed' };
  rawOnly.mobileRender = { viewport: 'mobile', attempted: true, success: false, error: 'browser unavailable', failureCategory: 'render_failed' };
  const items = evaluateAudit([rawOnly], signals());
  for (const id of ['content.empty', 'content.substance', 'content.duplicate', 'content.media', 'content.promotion', 'navigation.menu', 'navigation.mobile', 'access.render', 'adsense.emptyAds']) {
    assert.equal(find(items, id, rawOnly.url).verdict, 'unknown', id);
  }
  assert.equal(find(items, 'access.response', rawOnly.url).verdict, 'good');
  assert.equal(find(items, 'trust.identity').verdict, 'unknown');
  const score = scoreAudit(items, 1);
  assert.notEqual(score.value, null, 'direct HTML still supports a provisional score');
  assert.ok(score.unknownWeight > 0);
});

test('legacy raw HTML without a verified browser body does not become an empty-page defect', () => {
  const rawOnly = page('https://example.com/raw-only');
  rawOnly.mainText = '';
  rawOnly.renderedText = '';
  rawOnly.rawHtml = '<html><body><main></main></body></html>';
  rawOnly.desktopRender = undefined;
  rawOnly.mobileRender = undefined;
  const findings = evaluateAudit([rawOnly], signals());
  for (const id of ['content.empty', 'content.substance', 'navigation.menu', 'navigation.mobile', 'access.render', 'adsense.emptyAds']) {
    assert.equal(find(findings, id, rawOnly.url).verdict, 'unknown', id);
  }
  assert.equal(find(findings, 'access.response', rawOnly.url).verdict, 'good');
});

test('scanner-limited data request does not turn a loading shell into a site defect', () => {
  const shell = page('https://example.com/dynamic');
  shell.mainText = '';
  shell.renderedText = '로딩 중';
  shell.resourceFailures = ['검사기 제한: POST https://example.com/graphql 읽기 전용 요청 차단'];
  const findings = evaluateAudit([shell], signals());
  for (const id of ['content.empty', 'content.substance', 'navigation.menu', 'navigation.mobile', 'access.render']) {
    assert.equal(find(findings, id, shell.url).verdict, 'unknown', id);
  }
  assert.equal(find(findings, 'trust.identity').verdict, 'unknown');
});

test('missing robots file never instructs removal of an unverified block', () => {
  const observed = signals();
  observed.robotsText = null;
  observed.robotsAllowsAdsense = null;
  const file = (url: string) => ({ url, finalUrl: url, statusCode: 404, bodyPresent: false,
    responseTimeMs: 25, redirectChain: [], checkedAt: '2026-09-29T01:00:00.000Z' });
  observed.technicalFiles = {
    robots: file(observed.robotsUrl),
    sitemap: file('https://example.com/sitemap.xml'),
    ads: file(observed.adsTxtUrl),
  };
  const result = find(evaluateAudit([page()], observed), 'access.robots');
  assert.equal(result.verdict, 'unknown');
  assert.match(result.evidence, /HTTP 404/);
  assert.match(result.action, /실제 차단 규칙이 확인된 경우에만/);
});

test('a draft link label does not mark the linking article as unfinished', () => {
  const article = page('https://example.com/ko/article');
  article.rawHtml = '<main><p>방문 경로와 이용 방법을 정리한 완성된 안내입니다.</p><a href="/ko/draft">새 안내 준비 중</a></main>';
  article.mainText = '방문 경로와 이용 방법을 정리한 완성된 안내입니다. 새 안내 준비 중';
  article.renderedText = article.mainText;
  const draft = page('https://example.com/ko/draft');
  draft.rawHtml = '<main><h1>새 안내</h1><p>준비 중</p></main>';
  draft.mainText = '새 안내 준비 중';
  draft.renderedText = draft.mainText;
  const items = evaluateAudit([article, draft], signals());
  assert.equal(find(items, 'content.placeholder', article.url).verdict, 'good');
  assert.equal(find(items, 'content.placeholder', draft.url).verdict, 'issue');
});

test('same-language near duplicates are detected without comparing translated pages', () => {
  const original = page('https://example.com/ko/a');
  const copy = page('https://example.com/ko/b');
  copy.mainText = `${original.mainText} 추가 정보`;
  const translated = page('https://example.com/en/a');
  translated.lang = 'en';
  translated.mainText = original.mainText;
  const items = evaluateAudit([original, copy, translated], signals());
  assert.ok(['issue', 'caution'].includes(find(items, 'content.duplicate', original.url).verdict));
  assert.equal(find(items, 'content.duplicate', translated.url).verdict, 'good');
});

test('missing ads.txt alone is not a failure and a valid connection method suffices', () => {
  const withoutConnection = evaluateAudit([page()], signals());
  assert.equal(find(withoutConnection, 'adsense.connection').verdict, 'caution');
  const connected = page();
  connected.hasAdsenseMeta = true;
  assert.equal(find(evaluateAudit([connected], signals()), 'adsense.connection').verdict, 'good');
  const txt = signals();
  txt.adsTxtText = 'google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0';
  assert.equal(find(evaluateAudit([page()], txt), 'adsense.connection').verdict, 'good');
});

test('failed ads.txt request is not a scored missing-connection warning', () => {
  const failed = signals();
  failed.technicalFiles!.ads = { url: failed.adsTxtUrl, finalUrl: failed.adsTxtUrl, statusCode: null,
    bodyPresent: false, responseTimeMs: 100, redirectChain: [], checkedAt: '2026-09-29T01:00:00.000Z',
    error: 'ENETUNREACH', failureCategory: 'scanner_network_restricted' };
  const result = find(evaluateAudit([page()], failed), 'adsense.connection');
  assert.equal(result.verdict, 'unknown');
  assert.match(result.evidence, /직접 확인 불가/);
});

test('sitewide identity and privacy are not downgraded from a partial sample alone', () => {
  const sample = page('https://example.com/article');
  sample.hasPrivacyLink = false;
  sample.hasAboutLink = false;
  sample.hasContactLink = false;
  const findings = evaluateAudit([sample], signals());
  assert.equal(find(findings, 'trust.privacy').verdict, 'unknown');
  assert.equal(find(findings, 'trust.identity').verdict, 'unknown');
});

test('meaningful query parameters keep checked links and cache failures distinct', () => {
  const source = page('https://example.com/list');
  source.links = ['https://example.com/article?id=1'];
  source.navLinks = [];
  const good = page('https://example.com/article?id=1');
  const missing = page('https://example.com/article?id=2');
  missing.statusCode = 404;
  missing.error = 'HTTP 404';
  let findings = evaluateAudit([source, good, missing], signals());
  assert.equal(find(findings, 'navigation.links', source.url).verdict, 'good');
  good.statusCode = 404;
  good.error = 'Cache miss from intermediary';
  good.failureCategory = 'cache_only_direct_failed';
  findings = evaluateAudit([source, good, missing], signals());
  assert.equal(find(findings, 'navigation.links', source.url).verdict, 'unknown');
  assert.equal(find(findings, 'access.response', good.url).verdict, 'unknown');
});

test('broken links use only inspected targets; uncertain failures are not treated as 404', () => {
  const source = page('https://example.com/guide');
  source.links = ['https://example.com/missing', 'https://example.com/unchecked'];
  const missing = page('https://example.com/missing');
  missing.statusCode = 404;
  missing.error = 'Not found';
  const items = evaluateAudit([source, missing], signals());
  assert.equal(find(items, 'navigation.links', source.url).verdict, 'issue');
  assert.match(find(items, 'navigation.links', source.url).evidence, /missing/);
  assert.equal(find(items, 'access.response', missing.url).verdict, 'issue');
  assert.equal(find(items, 'content.empty', missing.url).verdict, 'unknown');
});

test('unchecked links stay unknown without score deduction and external failures do not imply broken rendering', () => {
  const source = page('https://example.com/guide');
  source.links = ['https://example.com/checked', 'https://example.com/unchecked'];
  source.resourceFailures = ['https://cdn.third-party.example/image.jpg: robots.txt에서 크롤링을 제한한 리소스입니다.'];
  const checked = page('https://example.com/checked');
  const items = evaluateAudit([source, checked], signals());
  assert.equal(find(items, 'navigation.links', source.url).verdict, 'unknown');
  assert.equal(find(items, 'access.render', source.url).verdict, 'good');
  const linkScore = scoreAudit(items, 2).ruleScores.find((row) => row.id === 'navigation.links');
  assert.ok(linkScore);
  assert.equal(linkScore.measuredCount, 0);
  assert.equal(linkScore.unknownCount, 2);
  assert.equal(linkScore.earnedWeight, 0);
  assert.equal(linkScore.measuredWeight, 0);
  assert.equal(linkScore.unknownWeight, 6);
});

test('one verified link page and one unvisited link page split measured and unknown weight', () => {
  const complete = completeGoodFindings();
  const link = find(complete, 'navigation.links');
  const score = scoreAudit([
    ...complete.filter((item) => item.id !== 'navigation.links'),
    { ...link, pageUrl: 'https://example.com/a', verdict: 'good' },
    { ...link, pageUrl: 'https://example.com/b', verdict: 'unknown' },
  ], 2);
  const row = score.ruleScores.find((item) => item.id === 'navigation.links');
  assert.ok(row);
  assert.equal(row.measuredWeight, 3);
  assert.equal(row.unknownWeight, 3);
  assert.equal(row.earnedWeight, 3);
  assert.equal(score.measuredWeight, 97);
  assert.equal(score.unknownWeight, 3);
  assert.equal(score.verificationRate, 97);
});

test('future privacy notice without observed ads needs verification, not an automatic rewrite', () => {
  const home = page('https://example.com/ko');
  const privacy = page('https://example.com/ko/privacy');
  privacy.mainText = '개인정보 처리방침입니다. 분석 쿠키는 거부 설정이 가능합니다. 심사 승인 뒤 Google AdSense 광고를 시작하기 전에는 광고 쿠키와 거부 방법을 이 문서에 반영하겠습니다.';
  privacy.renderedText = privacy.mainText;
  const future = find(evaluateAudit([home, privacy], signals()), 'trust.privacy');
  assert.equal(future.verdict, 'unknown');
  assert.match(future.evidence, /향후 보완 표현/);
  assert.match(future.evidence, /승인 뒤 Google AdSense 광고를 시작하기 전에는/);
  assert.match(future.action, /아직 운영 전이고 광고 게재가 차단돼 있다면/);
  home.hasAdsenseScript = true;
  assert.equal(find(evaluateAudit([home, privacy], signals()), 'trust.privacy').verdict, 'caution');
  assert.equal(find(evaluateAudit([home], signals()), 'trust.privacy').verdict, 'unknown');
});

test('unknown and NA findings stay outside the measured-only score with visible verification range', () => {
  const items = evaluateAudit([page()], signals());
  const score = scoreAudit(items, 1);
  assert.equal(score.value, score.percentage);
  assert.equal(score.measuredWeight, 81); // media, unchecked links, and uninspected privacy content are excluded
  assert.equal(score.nonApplicableWeight, 6);
  assert.equal(score.applicableWeight, 94);
  assert.equal(score.unknownWeight, 13);
  assert.equal(score.ruleScores.length, 19);
  assert.ok(Math.abs((score.measuredWeight + score.unknownWeight + score.nonApplicableWeight) - 100) < 1e-9);
  assert.equal(score.value, Math.round(1000 * score.earnedWeight / score.measuredWeight) / 10);
  assert.equal(score.holdReason, null);
  assert.ok(score.possibleMin! < score.value && score.value < score.possibleMax!);
  assert.equal(score.criticalCapApplied, false);

  const complete = completeGoodFindings();
  const flagged = complete.find((item) => item.id === 'adsense.emptyAds');
  assert.ok(flagged);
  flagged.critical = true;
  assert.equal(scoreAudit(complete, 1).criticalCapApplied, false); // a good verdict is not a violation
  flagged.verdict = 'issue';
  const capped = scoreAudit(complete, 1);
  assert.equal(capped.value, 39);
  assert.equal(capped.percentage, 39);
  assert.equal(capped.criticalCapApplied, true);
});

test('a partially unknown page rule reduces verified weight and widens the possible interval', () => {
  const complete = completeGoodFindings();
  const sample = find(complete, 'content.placeholder');
  const score = scoreAudit([
    ...complete.filter((item) => item.id !== 'content.placeholder'),
    { ...sample, pageUrl: 'https://example.com/a', verdict: 'good' },
    { ...sample, pageUrl: 'https://example.com/b', verdict: 'unknown' },
  ], 2);
  assert.equal(score.measuredWeight, 96);
  assert.equal(score.earnedWeight, 96);
  assert.equal(score.unknownWeight, 4);
  assert.equal(score.verificationRate, 96);
  assert.equal(score.possibleMin, 96);
  assert.equal(score.possibleMax, 100);
  assert.equal(score.value, 100);
  assert.equal(score.ruleScores.find((item) => item.id === 'content.placeholder')?.applicableCount, 2);
  assert.equal(score.ruleScores.find((item) => item.id === 'content.placeholder')?.measuredCount, 1);
});

test('a real scored issue cannot round a near-perfect result up to 100', () => {
  const complete = completeGoodFindings();
  const sample = find(complete, 'content.placeholder');
  const many = Array.from({ length: 1000 }, (_, index): Finding => ({
    ...sample, pageUrl: `https://example.com/article/${index}`, verdict: index === 999 ? 'issue' : 'good',
  }));
  const score = scoreAudit([...complete.filter((item) => item.id !== 'content.placeholder'), ...many], 1000);
  assert.equal(score.value, 99.9);
  assert.equal(score.percentage, 99.9);
  assert.equal(score.measuredWeight, 100);
  assert.equal(score.unknownWeight, 0);
  assert.equal(score.possibleMin, 99.99); // interval retains hundredth precision; single score still caps at 99
});

test('all confirmed NA removes a rule from T; partial NA does not', () => {
  const complete = completeGoodFindings();
  const media = find(complete, 'content.media');
  const allNa = scoreAudit([...complete.filter((item) => item.id !== 'content.media'), { ...media, verdict: 'na' }], 1);
  assert.equal(allNa.nonApplicableWeight, 6);
  assert.equal(allNa.applicableWeight, 94);
  assert.equal(allNa.measuredWeight, 94);
  assert.equal(allNa.unknownWeight, 0);
  assert.equal(allNa.verificationRate, 100);
  assert.equal(allNa.value, 100);

  const partialNa = scoreAudit([
    ...complete.filter((item) => item.id !== 'content.media'),
    { ...media, pageUrl: 'https://example.com/a', verdict: 'good' },
    { ...media, pageUrl: 'https://example.com/b', verdict: 'na' },
  ], 2);
  assert.equal(partialNa.nonApplicableWeight, 0);
  assert.equal(partialNa.applicableWeight, 100);
  assert.equal(partialNa.measuredWeight, 100);
  assert.equal(partialNa.ruleScores.find((item) => item.id === 'content.media')?.applicableCount, 1);
});

test('missing findings count as unknown without assumed points and leave core gaps visible', () => {
  const complete = completeGoodFindings();
  const withoutRobots = scoreAudit(complete.filter((item) => item.id !== 'access.robots'), 1);
  assert.equal(withoutRobots.measuredWeight, 96);
  assert.equal(withoutRobots.unknownWeight, 4);
  assert.equal(withoutRobots.verificationRate, 96);
  assert.deepEqual(withoutRobots.unmeasuredCoreRuleIds, ['access.robots']);
  assert.equal(withoutRobots.value, 100);
  assert.equal(withoutRobots.holdReason, null);
  assert.equal(withoutRobots.possibleMin, 96);
  assert.equal(withoutRobots.possibleMax, 100);

  const belowThreshold = scoreAudit(complete.filter((item) => !['content.media', 'navigation.links'].includes(item.id)), 1);
  assert.equal(belowThreshold.measuredWeight, 88);
  assert.equal(belowThreshold.value, 100);
  assert.equal(belowThreshold.holdReason, null);
});

test('no HTML pages or no applicable rules yields no single score', () => {
  const complete = completeGoodFindings();
  const noHtml = scoreAudit(complete, 0);
  assert.equal(noHtml.value, null);
  assert.equal(noHtml.possibleMin, null);
  assert.equal(noHtml.possibleMax, null);
  assert.match(noHtml.holdReason ?? '', /HTML/);
  const noApplicable = scoreAudit(complete.map((item) => ({ ...item, verdict: 'na' as const })), 1);
  assert.equal(noApplicable.nonApplicableWeight, 100);
  assert.equal(noApplicable.applicableWeight, 0);
  assert.equal(noApplicable.possibleMin, null);
  assert.equal(noApplicable.possibleMax, null);
  assert.equal(noApplicable.value, null);
});

test('inaccessible audit has no numerical score', () => {
  const denied = page();
  denied.statusCode = 403;
  denied.error = 'Blocked';
  const findings = evaluateAudit([denied], null);
  assert.equal(scoreAudit(findings, 0).value, null);
  assert.equal(scoreAudit(findings, 0).percentage, null);
  assert.equal(find(findings, 'access.response').verdict, 'unknown');
});

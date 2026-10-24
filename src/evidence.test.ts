import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceBundle, hasDirectPageEvidence } from './evidence.js';
import type { AuditJob, PageSnapshot, ReportData, SiteSignals } from './types.js';

const checkedAt = '2026-09-29T00:10:00.000Z';

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://public.example.org/kr/', finalUrl: 'https://public.example.org/kr/', fetchedAt: checkedAt,
    statusCode: 200, contentType: 'text/html; charset=utf-8', rawHtml: '<html><main>직접 확인한 본문</main></html>',
    renderedText: '직접 확인한 본문', mainText: '직접 확인한 본문', title: '한국어 홈', metaDescription: '',
    canonical: '', robotsMeta: '', lang: 'ko', headings: ['홈'], links: ['https://public.example.org/en/'],
    navLinks: [], imageCount: 0, imagesWithoutAlt: 0, mediaCount: 0, adElementCount: 0,
    hasAdsenseScript: false, hasAdsenseMeta: false, hasPrivacyLink: false, hasAboutLink: false,
    hasContactLink: false, hasCookieTerms: false, hasAdClickPrompt: false,
    desktopOverflow: false, mobileOverflow: false, popupCount: 0, jsErrors: [], resourceFailures: [], redirectCount: 0,
    http: { requestedUrl: 'https://public.example.org/kr/', finalUrl: 'https://public.example.org/kr/',
      statusCode: 200, redirectChain: [], responseTimeMs: 142, htmlCollected: true, checkedAt },
    desktopRender: { viewport: 'desktop', attempted: true, success: true, finalUrl: 'https://public.example.org/kr/',
      statusCode: 200, title: '한국어 홈', mainTextPresent: true, errorScreen: false },
    mobileRender: { viewport: 'mobile', attempted: true, success: true, finalUrl: 'https://public.example.org/kr/',
      statusCode: 200, title: '한국어 홈', mainTextPresent: true, errorScreen: false },
    ...overrides,
  };
}

function job(pages: PageSnapshot[], signals: SiteSignals | null = null): AuditJob {
  return {
    id: '12345678-1234-1234-1234-123456789abc', inputUrl: 'https://public.example.org/kr/',
    rootUrl: 'https://public.example.org/', host: 'public.example.org', mode: 'quick', limit: 20,
    excludedPaths: [], status: 'complete', createdAt: checkedAt, updatedAt: checkedAt,
    startedAt: checkedAt, completedAt: checkedAt, discovered: pages.map((item) => item.url),
    queue: [], visited: pages.map((item) => item.url), pages, signals, error: null,
  };
}

test('direct evidence bundle records HTTP, render, technical files, and no full raw HTML', () => {
  const current = page({ rawHtml: `<html><main>${'확인한 콘텐츠 '.repeat(100)}</main></html>`,
    http: { requestedUrl: 'https://public.example.org/kr/', finalUrl: 'https://public.example.org/kr/',
      statusCode: 200, redirectChain: [{ url: 'https://public.example.org/kr/', statusCode: 301,
        location: 'https://public.example.org/kr' }], responseTimeMs: 142, htmlCollected: true, checkedAt } });
  const file = (url: string, statusCode: number) => ({ url, finalUrl: url, statusCode,
    bodyPresent: statusCode === 200, responseTimeMs: 63, redirectChain: [], checkedAt });
  const signals: SiteSignals = {
    rootUrl: 'https://public.example.org/', host: 'public.example.org',
    robotsUrl: 'https://public.example.org/robots.txt', robotsText: 'User-agent: *', robotsAllowsAdsense: true,
    sitemapUrls: ['https://public.example.org/sitemap.xml'], adsTxtUrl: 'https://public.example.org/ads.txt',
    adsTxtText: null, discoveryMethod: 'sitemap-and-links', technicalFiles: {
      robots: file('https://public.example.org/robots.txt', 200),
      sitemap: file('https://public.example.org/sitemap.xml', 200),
      ads: file('https://public.example.org/ads.txt', 404),
    },
  };
  const scan = job([current], signals);
  const report: ReportData = {
    job: scan, generatedAt: checkedAt, findings: [], score: {
      value: 80, percentage: 80, areaScores: { content: 30, navigation: 15, access: 12, trust: 13, adsense: 10 },
      nonApplicableWeight: 0, applicableWeight: 100, measuredWeight: 100, earnedWeight: 80, unknownWeight: 0,
      verificationRate: 100, possibleMin: 80, possibleMax: 80, holdReason: null,
      unmeasuredCoreRuleIds: [], ruleScores: [], criticalCapApplied: false,
    },
  };
  const bundle = buildEvidenceBundle(scan, report);
  assert.equal(bundle.scan.directSuccessUrlCount, 1);
  assert.equal(bundle.scan.attemptedUrlCount, 1);
  assert.equal(bundle.pages[0].http.statusCode, 200);
  assert.equal(bundle.pages[0].render.desktop.success, true);
  assert.equal(bundle.pages[0].render.mobile.success, true);
  assert.equal(bundle.technicalFiles.robots.statusCode, 200);
  assert.equal(bundle.technicalFiles.ads.statusCode, 404);
  assert.equal(bundle.score.value, 80);
  assert.equal(bundle.score.unofficialReadinessIndexPercent, 80);
  assert.equal(bundle.pages[0].content.htmlSha256?.length, 64);
  assert.ok(!JSON.stringify(bundle).includes(current.rawHtml));
});

test('cache-only/direct failure stays unscored and identifies scanner environment separately', () => {
  const failed = page({ statusCode: null, rawHtml: '', renderedText: '', mainText: '', error: '외부 요청 차단',
    failureCategory: 'scanner_network_restricted',
    http: { requestedUrl: 'https://public.example.org/kr/', finalUrl: 'https://public.example.org/kr/',
      statusCode: null, redirectChain: [], responseTimeMs: 18, htmlCollected: false, checkedAt,
      error: '외부 요청 차단', failureCategory: 'scanner_network_restricted' },
    desktopRender: { viewport: 'desktop', attempted: false, success: false },
    mobileRender: { viewport: 'mobile', attempted: false, success: false },
  });
  assert.equal(hasDirectPageEvidence(failed), false);
  const bundle = buildEvidenceBundle(job([failed]));
  assert.equal(bundle.scan.directSuccessUrlCount, 0);
  assert.equal(bundle.score.value, null);
  assert.match(bundle.score.holdReason ?? '', /0건/);
  assert.equal(bundle.pages[0].failure?.scannerEnvironmentIssue, true);
  assert.match(bundle.pages[0].failure?.retryAction ?? '', /사이트 자체 오류로 단정하지/);
});

test('older saved pages do not invent missing HTTP or viewport details', () => {
  const old = page({ http: undefined, desktopRender: undefined, mobileRender: undefined });
  const bundle = buildEvidenceBundle(job([old]));
  assert.equal(bundle.pages[0].http.evidenceSource, 'legacy-local-scan');
  assert.equal(bundle.pages[0].http.responseTimeMs, null);
  assert.equal(bundle.pages[0].render.desktop.success, null);
  assert.equal(bundle.technicalFiles.sitemap.statusCode, null);
});

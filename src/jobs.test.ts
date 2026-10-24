import assert from 'node:assert/strict';
import test from 'node:test';
import { reportData } from './jobs.js';
import type { AuditJob, PageSnapshot, SiteSignals } from './types.js';

function page(url: string, finalUrl = url, mainText = '페이지 목적과 이용 방법을 자세히 설명한 본문입니다. '.repeat(12)): PageSnapshot {
  return {
    url, finalUrl, fetchedAt: '2026-09-28T00:00:00.000Z', statusCode: 200, contentType: 'text/html',
    rawHtml: `<html lang="ko"><head><title>안내</title></head><body><main>${mainText}</main></body></html>`,
    renderedText: mainText, mainText, title: '안내', metaDescription: '', canonical: finalUrl,
    robotsMeta: '', lang: 'ko', headings: ['안내'], links: [], navLinks: [], imageCount: 0,
    imagesWithoutAlt: 0, mediaCount: 0, adElementCount: 0, hasAdsenseScript: false,
    hasAdsenseMeta: false, hasPrivacyLink: false, hasAboutLink: false, hasContactLink: false,
    hasCookieTerms: false, hasAdClickPrompt: false, desktopOverflow: false, mobileOverflow: false,
    popupCount: 0, jsErrors: [], resourceFailures: [], redirectCount: 0,
    desktopRender: { viewport: 'desktop', attempted: true, success: true, finalUrl,
      statusCode: 200, title: '안내', mainTextPresent: true, errorScreen: false },
    mobileRender: { viewport: 'mobile', attempted: true, success: true, finalUrl,
      statusCode: 200, title: '안내', mainTextPresent: true, errorScreen: false },
  };
}

function job(pages: PageSnapshot[]): AuditJob {
  const signals: SiteSignals = {
    rootUrl: 'https://example.com/', host: 'example.com', robotsUrl: 'https://example.com/robots.txt',
    robotsText: 'User-agent: *\nAllow: /', robotsAllowsAdsense: true, sitemapUrls: [],
    adsTxtUrl: 'https://example.com/ads.txt', adsTxtText: null, discoveryMethod: 'links-only',
  };
  return {
    id: '00000000-0000-4000-8000-000000000001', inputUrl: 'https://example.com/',
    rootUrl: 'https://example.com/', host: 'example.com', mode: 'quick', limit: 20,
    excludedPaths: [], status: 'complete', createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z', startedAt: '2026-09-28T00:00:00.000Z',
    completedAt: '2026-09-28T00:00:00.000Z', discovered: pages.map((item) => item.url),
    queue: [], visited: pages.map((item) => item.url), pages, signals, error: null,
  };
}

test('report data scores one representative per normalized final URL while retaining raw visit records', () => {
  const alias = page('https://example.com/', 'https://example.com/ko/?utm_source=menu', '준비 중');
  const direct = page('https://example.com/ko/', 'https://example.com/ko/');
  const contact = page('https://example.com/contact/');
  const original = job([alias, direct, contact]);
  const report = reportData(original);
  assert.equal(report.job.pages.length, 3);
  assert.equal(original.pages.length, 3);
  const placeholders = report.findings.filter((item) => item.id === 'content.placeholder');
  assert.equal(placeholders.length, 2);
  assert.deepEqual(placeholders.map((item) => item.pageUrl), ['https://example.com/ko/', 'https://example.com/contact/']);
  assert.equal(placeholders[0].verdict, 'good'); // the direct, complete snapshot represents /ko/
  assert.equal(report.score.ruleScores.find((item) => item.id === 'content.placeholder')?.applicableCount, 2);
  assert.equal(report.findings.filter((item) => item.id === 'access.response').length, 2);
});

test('a successful redirect snapshot takes precedence over a failed direct retry', () => {
  const alias = page('https://example.com/', 'https://example.com/ko/');
  const direct = page('https://example.com/ko/', 'https://example.com/ko/');
  direct.statusCode = 503;
  direct.error = 'Timed out';
  direct.rawHtml = '';
  direct.renderedText = '';
  direct.mainText = '';
  direct.desktopRender = { viewport: 'desktop', attempted: true, success: false, error: 'Timed out' };
  direct.mobileRender = { viewport: 'mobile', attempted: true, success: false, error: 'Timed out' };
  const report = reportData(job([direct, alias]));
  assert.equal(report.findings.filter((item) => item.id === 'access.response').length, 1);
  assert.equal(report.findings.find((item) => item.id === 'access.response')?.verdict, 'good');
  assert.equal(report.score.ruleScores.find((item) => item.id === 'access.response')?.applicableCount, 1);
});

test('a visited redirect alias remains a confirmed internal link after final-page deduplication', () => {
  const alias = page('https://example.com/', 'https://example.com/ko/');
  const failedRetry = page('https://example.com/ko/', 'https://example.com/ko/');
  failedRetry.statusCode = 503;
  failedRetry.error = 'Timed out';
  failedRetry.rawHtml = '';
  failedRetry.renderedText = '';
  failedRetry.mainText = '';
  const guide = page('https://example.com/guide/');
  guide.links = ['https://example.com/', 'https://example.com/ko/'];
  const report = reportData(job([alias, failedRetry, guide]));
  const link = report.findings.find((item) => item.id === 'navigation.links' && item.pageUrl === guide.url);
  assert.equal(link?.verdict, 'good');
  assert.match(link?.evidence ?? '', /확인된 링크 2개 \/ 방문 시도 2개 \/ 전체 링크 2개/);
  assert.equal(report.findings.filter((item) => item.id === 'access.response').length, 2);
  assert.equal(report.score.ruleScores.find((item) => item.id === 'navigation.links')?.measuredCount, 1);
  assert.equal(report.job.pages.length, 3);
});

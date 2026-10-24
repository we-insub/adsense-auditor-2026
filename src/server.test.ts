import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './server.js';
import { Store } from './storage.js';
import type { PageSnapshot, SiteSignals } from './types.js';

test('local screen opens without a password; unsafe requests are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-server-'));
  const app = createApp(new Store(dir));
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('port unavailable');
    const base = `http://127.0.0.1:${address.port}`;
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /새 검사/);
    const usage = await fetch(`${base}/usage`);
    const usageHtml = await usage.text();
    assert.match(usageHtml, /고객 공지·신청 안내/);
    assert.match(usageHtml, /코딩 AI에게 수정 요청/);
    assert.match(usageHtml, /첨부한 애드센스 준비 진단 PDF/);

    const csrf = await fetch(`${base}/api/jobs`, { method: 'POST', body: '{}' });
    assert.equal(csrf.status, 403);
    const privateTarget = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/', mode: 'standard' }),
    });
    assert.equal(privateTarget.status, 400);
    assert.match(await privateTarget.text(), /내부망|예약 IP/);

    const job = app.store.createJob('https://example.com/', 'https://example.com/', 'standard', []);
    const detail = await fetch(`${base}/jobs/${job.id}`);
    const html = await detail.text();
    assert.match(html, /새로 재검사/);
    assert.match(html, /ChatGPT용 직접 검증자료 JSON/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
  } finally {
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completed job shows verification fields and regenerates stale downloads with current rules', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-server-export-'));
  const store = new Store(dir);
  const job = store.createJob('https://example.com/', 'https://example.com/', 'quick', []);
  const signals: SiteSignals = {
    rootUrl: 'https://example.com/', host: 'example.com', robotsUrl: 'https://example.com/robots.txt',
    robotsText: null, robotsAllowsAdsense: null, sitemapUrls: [], adsTxtUrl: 'https://example.com/ads.txt',
    adsTxtText: null, discoveryMethod: 'links-only',
  };
  const page: PageSnapshot = {
    url: 'https://example.com/', finalUrl: 'https://example.com/', fetchedAt: '2026-09-28T00:00:00.000Z',
    statusCode: 200, contentType: 'text/html', rawHtml: '<html lang="ko"><main>예시 본문</main></html>',
    renderedText: '예시 본문', mainText: '예시 본문', mainProseText: '예시 본문', title: '예시',
    metaDescription: '', canonical: '', robotsMeta: '', lang: 'ko', headings: ['예시'], links: [], navLinks: [],
    imageCount: 0, imagesWithoutAlt: 0, mediaCount: 0, adElementCount: 0, hasAdsenseScript: false,
    hasAdsenseMeta: false, hasPrivacyLink: false, hasAboutLink: false, hasContactLink: false,
    hasCookieTerms: false, hasAdClickPrompt: false, desktopOverflow: false, mobileOverflow: false,
    popupCount: 0, jsErrors: [], resourceFailures: [], redirectCount: 0,
  };
  store.setSignals(job.id, signals);
  store.enqueue(job.id, [page.url]);
  store.savePage(job.id, page);
  store.setStatus(job.id, 'complete');
  const reportDir = join(dir, 'reports', job.id);
  mkdirSync(reportDir, { recursive: true });
  for (const ext of ['html', 'json', 'pdf']) writeFileSync(join(reportDir, `report-${job.id}.${ext}`), 'stale prior report');
  const app = createApp(store);
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('port unavailable');
    const base = `http://127.0.0.1:${address.port}`;
    const api = await fetch(`${base}/api/jobs/${job.id}`);
    assert.equal(api.status, 200);
    const summary = await api.json() as Record<string, unknown>;
    assert.ok(summary.score === null || typeof summary.score === 'number');
    for (const field of ['nonApplicableWeight', 'applicableWeight', 'measuredWeight', 'earnedWeight', 'unknownWeight']) {
      assert.equal(typeof summary[field], 'number', field);
    }
    assert.ok(summary.verificationRate === null || typeof summary.verificationRate === 'number');
    assert.ok(summary.possibleMin === null || typeof summary.possibleMin === 'number');
    assert.ok(summary.possibleMax === null || typeof summary.possibleMax === 'number');
    assert.ok(summary.rawEstimate === null || typeof summary.rawEstimate === 'number');
    assert.equal(typeof summary.criticalCapApplied, 'boolean');
    assert.ok(summary.holdReason === null || typeof summary.holdReason === 'string');
    if (typeof summary.holdReason === 'string') assert.doesNotMatch(summary.holdReason, /access\.robots|trust\.privacy|content\.empty/);
    assert.ok(Array.isArray(summary.unmeasuredCoreRuleIds));

    const jsonResponse = await fetch(`${base}/report/${job.id}/json`);
    if (!jsonResponse.ok) assert.fail(`JSON export failed: ${jsonResponse.status} ${await jsonResponse.text()}`);
    const exported = await jsonResponse.json() as { score: Record<string, unknown> };
    assert.equal(exported.score.value, summary.score);
    assert.equal(exported.score.verificationRate, summary.verificationRate);
    assert.equal(exported.score.possibleMin, summary.possibleMin);
    assert.equal(exported.score.possibleMax, summary.possibleMax);
    const evidenceResponse = await fetch(`${base}/report/${job.id}/evidence`);
    assert.equal(evidenceResponse.status, 200);
    assert.match(evidenceResponse.headers.get('content-disposition') ?? '', /direct-evidence-.*\.json/);
    const evidence = await evidenceResponse.json() as {
      scan: { id: string; attemptedUrlCount: number; directSuccessUrlCount: number };
      pages: Array<{ http: { evidenceSource: string; statusCode: number | null } }>;
      score: { value: number | null };
    };
    assert.equal(evidence.scan.id, job.id);
    assert.equal(evidence.scan.attemptedUrlCount, 1);
    assert.equal(evidence.scan.directSuccessUrlCount, 1);
    assert.equal(evidence.pages[0].http.evidenceSource, 'legacy-local-scan');
    assert.equal(evidence.pages[0].http.statusCode, 200);
    assert.equal(evidence.score.value, summary.score);
    assert.match(readFileSync(join(reportDir, `report-${job.id}.html`), 'utf8'), /검증률|산출 보류/);
    assert.equal(readFileSync(join(reportDir, `report-${job.id}.pdf`)).subarray(0, 5).toString(), '%PDF-');

    writeFileSync(join(reportDir, `report-${job.id}.json`), 'stale again');
    const renewed = await fetch(`${base}/report/${job.id}/json`);
    assert.equal(renewed.status, 200);
    assert.equal((await renewed.json() as { score: { value: unknown } }).score.value, summary.score);
  } finally {
    await new Promise<void>(resolve => app.server.close(() => resolve()));
    app.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './storage.js';
import type { PageSnapshot } from './types.js';

function page(url: string): PageSnapshot {
  return {
    url, finalUrl: url, fetchedAt: new Date().toISOString(), statusCode: 200,
    contentType: 'text/html', rawHtml: '<main>확인</main>', renderedText: '확인', mainText: '확인',
    title: '확인', metaDescription: '', canonical: '', robotsMeta: '', lang: 'ko',
    headings: [], links: [], navLinks: [], imageCount: 0, imagesWithoutAlt: 0,
    mediaCount: 0, adElementCount: 0, hasAdsenseScript: false, hasAdsenseMeta: false,
    hasPrivacyLink: false, hasAboutLink: false, hasContactLink: false, hasCookieTerms: false,
    hasAdClickPrompt: false, desktopOverflow: false, mobileOverflow: false, popupCount: 0,
    jsErrors: [], resourceFailures: [], redirectCount: 0,
  };
}

test('full job stores each page in local files and resumes after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const first = new Store(dir);
    const job = first.createJob('https://example.com/', 'https://example.com/', 'full', ['/skip/']);
    assert.equal(job.limit, 0);
    assert.equal(first.enqueue(job.id, ['https://example.com/', 'https://example.com/a', 'https://www.example.com/b', 'https://example.com/skip/x']), 3);
    first.setStatus(job.id, 'running');
    const next = first.nextUrl(job.id)!;
    first.savePage(job.id, page(next));
    first.close();
    appendFileSync(join(dir, 'jobs', job.id, 'urls.ndjson'), '{"url":"incomplete');

    const reopened = new Store(dir);
    reopened.pauseInterrupted();
    const restored = reopened.getJob(job.id)!;
    assert.equal(restored.status, 'paused');
    assert.equal(restored.discovered.length, 3);
    assert.equal(restored.pages.length, 1);
    assert.equal(restored.queue.length, 2);
    assert.notEqual(reopened.nextUrl(job.id), next);
    assert.equal(reopened.enqueue(job.id, ['https://example.com/new']), 1);
    assert.equal(new Store(dir).summary(job.id)?.discoveredCount, 4);
    assert.deepEqual(readdirSync(dir), ['jobs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standard jobs keep 201 discovered URLs while the inspection limit is 200', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const store = new Store(dir);
    const job = store.createJob('https://example.com/', 'https://example.com/', 'standard', []);
    const urls = Array.from({ length: 201 }, (_, index) => `https://example.com/post/${index + 1}`);
    assert.equal(store.enqueue(job.id, urls), 201);
    assert.equal(store.summary(job.id)?.discoveredCount, 201);
    assert.equal(store.summary(job.id)?.limit, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quick jobs inspect at most 20 pages without changing the standard limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const store = new Store(dir);
    const quick = store.createJob('https://example.com/', 'https://example.com/', 'quick', []);
    const standard = store.createJob('https://example.com/', 'https://example.com/', 'standard', []);
    assert.equal(quick.limit, 20);
    assert.equal(store.summary(quick.id)?.limit, 20);
    assert.equal(standard.limit, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quick scan inspects the requested language URL and samples another language', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const store = new Store(dir);
    const job = store.createJob('https://example.com/kr/', 'https://example.com/', 'quick', []);
    store.enqueue(job.id, [
      'https://example.com/', 'https://example.com/en/about', 'https://example.com/en/post',
      'https://example.com/kr/', 'https://example.com/kr/about', 'https://example.com/kr/post',
    ]);
    assert.equal(store.nextUrl(job.id), 'https://example.com/kr');
    store.savePage(job.id, page('https://example.com/kr'));
    assert.equal(store.nextUrl(job.id), 'https://example.com/');
    store.savePage(job.id, page('https://example.com/'));
    assert.equal(store.nextUrl(job.id), 'https://example.com/en/about');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quick scan includes a discovered English locale homepage before repeating Korean articles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const store = new Store(dir);
    const job = store.createJob('https://example.com/kr/', 'https://example.com/', 'quick', []);
    store.enqueue(job.id, ['https://example.com/kr/', 'https://example.com/',
      'https://example.com/en/', ...Array.from({ length: 25 }, (_, n) => `https://example.com/kr/post-${n}`)]);
    store.savePage(job.id, page(store.nextUrl(job.id)!));
    store.savePage(job.id, page(store.nextUrl(job.id)!));
    assert.equal(store.nextUrl(job.id), 'https://example.com/en');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('redirect aliases count once and remain deduplicated after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const store = new Store(dir);
    const job = store.createJob('https://example.com/', 'https://example.com/', 'quick', []);
    store.enqueue(job.id, ['https://example.com/', 'https://example.com/ko', 'https://example.com/start']);
    const redirected = page('https://example.com/');
    redirected.finalUrl = 'https://example.com/ko/';
    store.savePage(job.id, redirected);
    assert.equal(store.summary(job.id)?.inspectedCount, 1);
    assert.equal(store.nextUrl(job.id), 'https://example.com/start');
    const alias = page('https://example.com/start');
    alias.finalUrl = 'https://example.com/ko/';
    store.savePage(job.id, alias);
    assert.equal(store.summary(job.id)?.inspectedCount, 1);
    assert.equal(new Store(dir).summary(job.id)?.inspectedCount, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quick sampling visits another section before repeating a section', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-store-'));
  try {
    const store = new Store(dir);
    const job = store.createJob('https://example.com/ko/', 'https://example.com/', 'quick', []);
    store.enqueue(job.id, [
      'https://example.com/ko/', 'https://example.com/ko/category/a',
      'https://example.com/ko/category/b', 'https://example.com/ko/guide/a',
    ]);
    store.savePage(job.id, page('https://example.com/ko'));
    const first = store.nextUrl(job.id)!;
    store.savePage(job.id, page(first));
    const next = store.nextUrl(job.id)!;
    assert.notEqual(new URL(next).pathname.split('/')[2], new URL(first).pathname.split('/')[2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a fresh recheck is a separate persisted job linked to its earlier scan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-recheck-'));
  try {
    const store = new Store(dir);
    const prior = store.createJob('https://example.com/ko/', 'https://example.com/', 'quick', ['/skip']);
    store.enqueue(prior.id, [prior.inputUrl]);
    store.savePage(prior.id, page(prior.inputUrl));
    store.setStatus(prior.id, 'complete');
    const next = store.createJob(prior.inputUrl, prior.rootUrl, prior.mode, prior.excludedPaths, prior.id);
    assert.notEqual(next.id, prior.id);
    assert.equal(next.recheckOfJobId, prior.id);
    assert.equal(next.pages.length, 0);
    const reopened = new Store(dir);
    assert.equal(reopened.getJob(next.id)?.recheckOfJobId, prior.id);
    assert.equal(reopened.summary(next.id)?.recheckOfJobId, prior.id);
    assert.equal(reopened.getJob(prior.id)?.pages.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

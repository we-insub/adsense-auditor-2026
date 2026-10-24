import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { Store } from './storage.js';
import { classifyFailure, discoverSite, inspectPage, normalizePageUrl } from './scanner.js';
import { evaluateAudit, scoreAudit } from './rules.js';
import { exportReport } from './report.js';
import { hasDirectPageEvidence } from './evidence.js';
import type { AuditJob, PageSnapshot, ReportData } from './types.js';

function pageQuality(page: PageSnapshot, key: string): [number, number, number] {
  const observed = Number(Boolean(page.rawHtml)) + Number(Boolean(page.renderedText.trim())) + Number(Boolean(page.mainText.trim()));
  return [Number(hasDirectPageEvidence(page)), observed, Number(normalizePageUrl(page.url) === key)];
}

function uniqueFinalPages(pages: PageSnapshot[]): PageSnapshot[] {
  const byFinal = new Map<string, PageSnapshot>();
  for (const page of pages) {
    const key = normalizePageUrl(page.finalUrl || page.url) ?? normalizePageUrl(page.url) ?? (page.finalUrl || page.url);
    const previous = byFinal.get(key);
    if (!previous) { byFinal.set(key, page); continue; }
    const currentQuality = pageQuality(page, key);
    const previousQuality = pageQuality(previous, key);
    for (let index = 0; index < currentQuality.length; index++) {
      if (currentQuality[index] === previousQuality[index]) continue;
      if (currentQuality[index] > previousQuality[index]) byFinal.set(key, page);
      break;
    }
  }
  return [...byFinal.values()];
}

export function reportData(job: AuditJob): ReportData {
  const signals = job.signals;
  if (!signals) throw new Error('사이트 정보가 아직 수집되지 않았습니다.');
  // Old jobs may retain a redirect alias and its final URL as two snapshots.
  // Keep the raw records in the job, but evaluate each normalized final page once.
  const pages = uniqueFinalPages(job.pages);
  const findings = evaluateAudit(pages, signals, job.pages);
  const accessible = pages.filter(hasDirectPageEvidence).length;
  return { job, findings, score: scoreAudit(findings, accessible), generatedAt: new Date().toISOString() };
}

async function launchBrowser(): Promise<Browser> {
  try { return await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { return chromium.launch({ headless: true }); }
}

export class JobRunner {
  private active: string | null = null;
  private browser: Browser | null = null;
  private scheduling = false;
  private paused = new Set<string>();
  private cancelled = new Set<string>();

  constructor(private readonly store: Store) {
    this.store.pauseInterrupted();
  }

  start(id: string): void {
    const summary = this.store.summary(id);
    if (!summary) throw new Error('작업을 찾을 수 없습니다.');
    if (!['queued', 'paused', 'failed'].includes(summary.status)) throw new Error('이 작업은 시작할 수 없습니다.');
    this.paused.delete(id);
    this.cancelled.delete(id);
    this.store.setStatus(id, 'queued');
    void this.schedule();
  }

  pause(id: string): void {
    const summary = this.store.summary(id);
    if (!summary) throw new Error('작업을 찾을 수 없습니다.');
    if (summary.status === 'complete' || summary.status === 'cancelled') throw new Error('종료된 작업은 일시 중지할 수 없습니다.');
    this.paused.add(id);
    if (this.active !== id) this.store.setStatus(id, 'paused');
  }

  cancel(id: string): void {
    const summary = this.store.summary(id);
    if (!summary) throw new Error('작업을 찾을 수 없습니다.');
    if (summary.status === 'complete') throw new Error('완료된 작업은 취소할 수 없습니다.');
    if (summary.status === 'cancelled') return;
    this.cancelled.add(id);
    this.paused.add(id);
    if (this.active !== id) this.store.setStatus(id, 'cancelled');
  }

  private stopIfRequested(id: string): boolean {
    if (this.cancelled.has(id)) { this.store.setStatus(id, 'cancelled'); return true; }
    if (this.paused.has(id)) { this.store.setStatus(id, 'paused'); return true; }
    return false;
  }

  private async schedule(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (!this.active) {
        const queued = this.store.listSummaries().filter(x => x.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (!queued.length) break;
        const id = queued[0].id;
        this.active = id;
        try { await this.run(id); }
        catch (error) { this.store.setStatus(id, 'failed', error instanceof Error ? error.message : String(error)); }
        finally { this.active = null; }
      }
    } finally { this.scheduling = false; }
  }

  private async run(id: string): Promise<void> {
    this.store.setStatus(id, 'running');
    let job = this.store.getJob(id)!;
    if (!job.signals) {
      try {
        const result = await discoverSite(job.rootUrl, job.excludedPaths, job.inputUrl);
        this.store.setSignals(id, result.signals);
        this.store.enqueue(id, [job.inputUrl, ...result.urls]);
      } catch (error) {
        // A failed discovery must still leave a traceable URL attempt and a
        // zero-evidence report. It is not proof that the publisher's site is bad.
        const origin = new URL(job.rootUrl).origin;
        this.store.setSignals(id, {
          rootUrl: job.rootUrl, host: job.host, robotsUrl: new URL('/robots.txt', origin).href,
          robotsText: null, robotsAllowsAdsense: null, sitemapUrls: [], adsTxtUrl: new URL('/ads.txt', origin).href,
          adsTxtText: null, discoveryMethod: 'links-only',
          discoveryError: error instanceof Error ? error.message : String(error),
          discoveryFailureCategory: classifyFailure(error),
        });
        this.store.enqueue(id, [job.inputUrl]);
      }
    }
    job = this.store.getJob(id)!;
    if (this.stopIfRequested(id)) return;
    try {
      let browserFailure: string | undefined;
      try { this.browser = await launchBrowser(); }
      catch (error) { this.browser = null; browserFailure = error instanceof Error ? error.message : String(error); }
      while (true) {
        if (this.stopIfRequested(id)) return;
        const progress = this.store.summary(id)!;
        if (progress.limit > 0 && progress.inspectedCount >= progress.limit) break;
        const next = this.store.nextUrl(id);
        if (!next) break;
        const page = await inspectPage(this.browser, next, job.host, job.excludedPaths,
          join(this.store.dir, 'jobs', id, 'screenshots'), browserFailure);
        this.store.savePage(id, page);
        this.store.enqueue(id, page.links);
      }
    } finally {
      await this.browser?.close();
      this.browser = null;
    }
    if (this.stopIfRequested(id)) return;
    this.store.setStatus(id, 'complete');
    job = this.store.getJob(id)!;
    const data = reportData(job);
    const output = join(this.store.dir, 'reports', job.id);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    await exportReport(data, output);
  }

  resumeQueued(): void { void this.schedule(); }
  isActive(id: string): boolean { return this.active === id; }
}

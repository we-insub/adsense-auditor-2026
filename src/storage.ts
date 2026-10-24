import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, truncateSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { isExcludedPath, isSameSite, normalizePageUrl } from './scanner.js';
import type { AuditJob, JobStatus, PageSnapshot, ScanMode, SiteSignals } from './types.js';

export function dataDirectory(): string {
  return process.env.ADSENSE_AUDITOR_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'AdSense Auditor');
}

interface JobRecord {
  id: string; inputUrl: string; rootUrl: string; host: string; mode: ScanMode;
  limit: number; excludedPaths: string[]; status: JobStatus; createdAt: string;
  updatedAt: string; startedAt: string | null; completedAt: string | null;
  signals: SiteSignals | null; error: string | null;
  recheckOfJobId?: string | null;
}

export interface JobSummary {
  id: string; inputUrl: string; rootUrl: string; mode: ScanMode; limit: number;
  status: JobStatus; createdAt: string; updatedAt: string; startedAt: string | null;
  completedAt: string | null; discoveredCount: number; inspectedCount: number;
  failedCount: number; pendingCount: number; error: string | null;
  recheckOfJobId?: string | null;
}

function atomicWrite(file: string, content: string | Buffer): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

function logLines(file: string): string[] {
  const content = readFileSync(file, 'utf8');
  if (!content) return [];
  const finalNewline = content.lastIndexOf('\n');
  if (finalNewline !== content.length - 1) truncateSync(file, Buffer.byteLength(content.slice(0, finalNewline + 1)));
  return content.slice(0, finalNewline + 1).split('\n').filter(Boolean);
}

function pageFile(dir: string, url: string): string {
  return join(dir, 'pages', `${createHash('sha256').update(url).digest('hex')}.json.gz`);
}

function classify(url: string): { lang: string; section: string; type: string } {
  const segments = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  const lang = /^[a-z]{2}(?:-[a-z]{2})?$/.test(segments[0] || '') ? segments.shift()! : 'default';
  const section = segments[0] || 'home';
  const type = /\.(pdf|xml|txt|jpg|jpeg|png|webp|zip)$/.test(segments.at(-1) || '') ? 'asset'
    : /^(blog|post|article|news|guide|review|archive|category)/.test(section) ? 'article' : 'page';
  return { lang, section, type };
}

function essentialRank(url: string): number {
  const path = new URL(url).pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (path === '/' || /^\/[a-z]{2}(?:-[a-z]{2})?$/.test(path)) return 0;
  if (/(^|\/)(about|intro|company|소개|회사)(\/|$)/.test(path)) return 1;
  if (/(^|\/)(contact|문의|연락)(\/|$)/.test(path)) return 2;
  if (/(privacy|개인정보|terms|이용약관|policy|정책|cookie|쿠키)/.test(path)) return 3;
  return 10;
}

export class Store {
  readonly dir: string;
  private jobs = new Map<string, JobRecord>();
  private urls = new Map<string, Map<string, 'pending' | 'visited'>>();
  private pages = new Map<string, Map<string, boolean>>();
  private finalUrls = new Map<string, Set<string>>();

  constructor(dir = dataDirectory()) {
    process.umask(0o077);
    this.dir = dir;
    mkdirSync(join(dir, 'jobs'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(join(dir, 'jobs'), 0o700);
    for (const id of readdirSync(join(dir, 'jobs'))) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const folder = this.folder(id);
        const job = JSON.parse(readFileSync(join(folder, 'job.json'), 'utf8')) as JobRecord;
        if (job.id !== id) continue;
        this.jobs.set(id, job);
        const urls = new Map<string, 'pending' | 'visited'>();
        for (const line of logLines(join(folder, 'urls.ndjson'))) {
          try {
            const row = JSON.parse(line) as { url: string; state: 'pending' | 'visited' };
            if (row.url && ['pending', 'visited'].includes(row.state)) urls.set(row.url, row.state);
          } catch { /* A partial final line after an interruption is ignored. */ }
        }
        this.urls.set(id, urls);
        const pages = new Map<string, boolean>();
        const finalUrls = new Set<string>();
        for (const line of logLines(join(folder, 'pages.ndjson'))) {
          try {
            const row = JSON.parse(line) as { url: string; failed: boolean; finalUrl?: string };
            if (row.url && existsSync(pageFile(folder, row.url))) {
              pages.set(row.url, row.failed);
              if (!row.failed) {
                let final = row.finalUrl;
                if (!final) {
                  const saved = JSON.parse(gunzipSync(readFileSync(pageFile(folder, row.url))).toString('utf8')) as PageSnapshot;
                  final = saved.finalUrl;
                }
                const normalized = final ? normalizePageUrl(final) : null;
                if (normalized) finalUrls.add(normalized);
              }
            }
          } catch { /* Ignore an incomplete final record. */ }
        }
        this.pages.set(id, pages);
        this.finalUrls.set(id, finalUrls);
      } catch { /* An incomplete job directory is not loaded. */ }
    }
  }

  private folder(id: string): string { return join(this.dir, 'jobs', id); }
  private saveJob(job: JobRecord): void { atomicWrite(join(this.folder(job.id), 'job.json'), JSON.stringify(job)); }
  close(): void { /* Files are closed after each write. */ }

  createJob(inputUrl: string, rootUrl: string, mode: ScanMode, excludedPaths: string[], recheckOfJobId: string | null = null): AuditJob {
    if (recheckOfJobId && !this.jobs.has(recheckOfJobId)) throw new Error('비교할 이전 작업을 찾을 수 없습니다.');
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: randomUUID(), inputUrl, rootUrl, host: new URL(rootUrl).hostname, mode,
      limit: mode === 'quick' ? 20 : mode === 'standard' ? 200 : 0, excludedPaths, status: 'queued',
      createdAt: now, updatedAt: now, startedAt: null, completedAt: null, signals: null, error: null, recheckOfJobId,
    };
    const folder = this.folder(job.id);
    mkdirSync(join(folder, 'pages'), { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, 'urls.ndjson'), '', { mode: 0o600 });
    writeFileSync(join(folder, 'pages.ndjson'), '', { mode: 0o600 });
    this.saveJob(job);
    this.jobs.set(job.id, job);
    this.urls.set(job.id, new Map());
    this.pages.set(job.id, new Map());
    this.finalUrls.set(job.id, new Set());
    return this.getJob(job.id)!;
  }

  setSignals(id: string, signals: SiteSignals): void {
    const job = this.requireJob(id);
    job.signals = signals;
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
  }

  setStatus(id: string, status: JobStatus, error: string | null = null): void {
    const job = this.requireJob(id);
    const now = new Date().toISOString();
    job.status = status;
    job.updatedAt = now;
    job.error = error;
    if (status === 'running') job.startedAt ||= now;
    if (status === 'complete') job.completedAt = now;
    this.saveJob(job);
  }

  pauseInterrupted(): void {
    for (const job of this.jobs.values()) if (job.status === 'running') this.setStatus(job.id, 'paused');
  }

  enqueue(id: string, candidates: string[]): number {
    const job = this.requireJob(id);
    const state = this.urls.get(id)!;
    let count = 0;
    const records: string[] = [];
    for (const candidate of candidates) {
      const normalized = normalizePageUrl(candidate);
      if (!normalized || state.has(normalized)) continue;
      const url = new URL(normalized);
      if (!isSameSite(url, job.host) || isExcludedPath(url, job.excludedPaths)) continue;
      state.set(normalized, 'pending');
      records.push(JSON.stringify({ url: normalized, state: 'pending' }));
      count++;
    }
    if (records.length) appendFileSync(join(this.folder(id), 'urls.ndjson'), records.join('\n') + '\n');
    return count;
  }

  nextUrl(id: string): string | null {
    const state = this.urls.get(id);
    if (!state) throw new Error('작업을 찾을 수 없습니다.');
    const job = this.requireJob(id);
    const requested = normalizePageUrl(job.inputUrl);
    const root = normalizePageUrl(job.rootUrl);
    const pending = [...state].filter(([, s]) => s === 'pending').map(([url]) => url);
    if (!pending.length) return null;
    const counts = { lang: new Map<string, number>(), section: new Map<string, number>(), type: new Map<string, number>() };
    for (const [url, status] of state) {
      if (status !== 'visited') continue;
      const c = classify(url);
      for (const key of ['lang', 'section', 'type'] as const) counts[key].set(c[key], (counts[key].get(c[key]) || 0) + 1);
    }
    pending.sort((a, b) => {
      const inputRank = (url: string): number => {
        if (url === requested) return -3;
        if (url === root) return -2;
        return 0;
      };
      const scope = inputRank(a) - inputRank(b);
      if (scope) return scope;
      const rank = essentialRank(a) - essentialRank(b);
      if (rank) return rank;
      const aa = classify(a), bb = classify(b);
      for (const key of ['lang', 'section', 'type'] as const) {
        const difference = (counts[key].get(aa[key]) || 0) - (counts[key].get(bb[key]) || 0);
        if (difference) return difference;
      }
      return a.localeCompare(b);
    });
    return pending[0];
  }

  savePage(id: string, page: PageSnapshot): void {
    this.requireJob(id);
    const folder = this.folder(id);
    const failed = Boolean(page.error) || page.statusCode === null || page.statusCode >= 400;
    const finalUrl = failed ? null : normalizePageUrl(page.finalUrl);
    const finalUrls = this.finalUrls.get(id)!;
    if (!this.pages.get(id)!.has(page.url) && (!finalUrl || !finalUrls.has(finalUrl))) {
      atomicWrite(pageFile(folder, page.url), gzipSync(Buffer.from(JSON.stringify(page)), { level: 3 }));
      appendFileSync(join(folder, 'pages.ndjson'), JSON.stringify({ url: page.url, failed, finalUrl }) + '\n');
      this.pages.get(id)!.set(page.url, failed);
      if (finalUrl) finalUrls.add(finalUrl);
    }
    const state = this.urls.get(id)!;
    const visited = new Set([page.url]);
    if (finalUrl) visited.add(finalUrl);
    appendFileSync(join(folder, 'urls.ndjson'), [...visited].map((url) => JSON.stringify({ url, state: 'visited' })).join('\n') + '\n');
    for (const url of visited) state.set(url, 'visited');
    const job = this.requireJob(id);
    job.updatedAt = new Date().toISOString();
    this.saveJob(job);
  }

  getJob(id: string): AuditJob | null {
    const row = this.jobs.get(id);
    if (!row) return null;
    const urls = this.urls.get(id)!;
    const pages = [...this.pages.get(id)!.keys()].map(url => {
      const compressed = readFileSync(pageFile(this.folder(id), url));
      return JSON.parse(gunzipSync(compressed).toString('utf8')) as PageSnapshot;
    });
    return {
      ...row, discovered: [...urls.keys()], queue: [...urls].filter(([, status]) => status === 'pending').map(([url]) => url),
      visited: [...urls].filter(([, status]) => status === 'visited').map(([url]) => url), pages,
    };
  }

  summary(id: string): JobSummary | null {
    const row = this.jobs.get(id);
    if (!row) return null;
    const urls = this.urls.get(id)!;
    const pages = this.pages.get(id)!;
    let pendingCount = 0, failedCount = 0;
    for (const status of urls.values()) if (status === 'pending') pendingCount++;
    for (const failed of pages.values()) if (failed) failedCount++;
    return {
      id, inputUrl: row.inputUrl, rootUrl: row.rootUrl, mode: row.mode, limit: row.limit,
      status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      startedAt: row.startedAt, completedAt: row.completedAt,
      discoveredCount: urls.size, pendingCount, inspectedCount: pages.size, failedCount, error: row.error,
      recheckOfJobId: row.recheckOfJobId ?? null,
    };
  }

  listSummaries(): JobSummary[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(row => this.summary(row.id)!);
  }

  private requireJob(id: string): JobRecord {
    const job = this.jobs.get(id);
    if (!job) throw new Error('작업을 찾을 수 없습니다.');
    return job;
  }
}

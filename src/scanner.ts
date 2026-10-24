import dns from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import zlib from 'node:zlib';
import type { Browser, BrowserContext, Page, Request, Route } from 'playwright';
import type { FailureCategory, FileCheck, HttpTrace, PageSnapshot, RedirectHop, RenderCheck, SiteSignals } from './types.js';

const USER_AGENT = 'AdSenseReadOnlyAudit/2026.09.28 (+local administrator)';
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 25_000;
const PAGE_RESOURCE_LIMIT = 120;
const PAGE_BYTES_LIMIT = 18 * 1024 * 1024;
const RESOURCE_BYTES_LIMIT = 3 * 1024 * 1024;
const DOCUMENT_BYTES_LIMIT = 8 * 1024 * 1024;
const SITEMAP_BYTES_LIMIT = 24 * 1024 * 1024;
const THROTTLE_MS = 150;
const CACHE_MS = 10_000;
const SCANNER_LIMITATION_MARKER = '검사기 제한:';

type HttpResult = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  redirectCount: number;
  redirectChain: RedirectHop[];
  responseTimeMs: number;
  cacheMiss?: boolean;
};

type RobotsRule = { agent: string; allow: boolean; pattern: string };
type RobotsState = { text: string | null; rules: RobotsRule[]; sitemaps: string[]; crawlDelayMs: number; syntheticBlock?: boolean; file?: FileCheck };

class DirectRequestError extends Error {
  constructor(message: string, readonly finalUrl: string, readonly redirectChain: RedirectHop[], readonly responseTimeMs: number,
    readonly failureCategory: FailureCategory) {
    super(message);
  }
}

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof DirectRequestError) return error.failureCategory;
  const message = error instanceof Error ? `${error.message} ${(error as NodeJS.ErrnoException).code ?? ''}` : String(error);
  if (/cache miss/i.test(message)) return 'cache_only_direct_failed';
  if (/robots\.txt|crawl-delay/i.test(message)) return 'robots_blocked';
  if (/ENOTFOUND|EAI_AGAIN|DNS 조회/i.test(message)) return 'dns_error';
  if (/CERT_|ERR_TLS|TLS|SSL|certificate|self.signed/i.test(message)) return 'ssl_error';
  if (/ETIMEDOUT|timeout|요청 시간이 초과|시간이 초과됐/i.test(message)) return 'timeout';
  if (/ENETUNREACH|EACCES|EPERM|network is unreachable|external network|외부 네트워크/i.test(message)) return 'scanner_network_restricted';
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|socket hang up/i.test(message)) return 'target_unreachable';
  if (/HTTP 5\d\d|HTTP 429/i.test(message)) return 'server_error';
  if (/HTML 페이지가 아니|non.html/i.test(message)) return 'non_html';
  if (/제외한 경로/i.test(message)) return 'excluded';
  if (/내부망|공개 IP|외부로|공개 인터넷|차단했습니다/i.test(message)) return 'security_blocked';
  if (/browser|page\.goto|render|브라우저|렌더링/i.test(message)) return 'render_failed';
  return 'unknown';
}

function fileCheck(url: string): FileCheck {
  return { url, finalUrl: url, statusCode: null, bodyPresent: false, responseTimeMs: 0, redirectChain: [], checkedAt: new Date().toISOString() };
}

function checkedFile(url: string, response: HttpResult): FileCheck {
  return { ...fileCheck(url), finalUrl: response.url, statusCode: response.status,
    // Record bytes received, including an HTTP error body. Whether that body
    // is a usable robots/sitemap/ads file is decided separately by status.
    bodyPresent: response.body.length > 0,
    responseTimeMs: response.responseTimeMs, redirectChain: response.redirectChain,
    ...(response.cacheMiss ? { error: `HTTP ${response.status} cache miss 응답이 재시도 후에도 계속됐습니다.`, failureCategory: 'cache_only_direct_failed' as const } : {}) };
}

function failedFile(url: string, error: unknown): FileCheck {
  return { ...fileCheck(url), finalUrl: error instanceof DirectRequestError ? error.finalUrl : url,
    redirectChain: error instanceof DirectRequestError ? error.redirectChain : [],
    responseTimeMs: error instanceof DirectRequestError ? error.responseTimeMs : 0,
    error: error instanceof Error ? error.message : String(error), failureCategory: classifyFailure(error) };
}

function robotsDeniedFile(url: string, robots: RobotsState): FileCheck {
  if (!robots.syntheticBlock) return failedFile(url, new Error('robots.txt에서 해당 기술 파일 요청을 제한했습니다.'));
  const category = robots.file?.failureCategory ?? 'unknown';
  return { ...fileCheck(url), error: `robots.txt 확인 실패로 요청을 중단했습니다: ${robots.file?.error ?? `HTTP ${robots.file?.statusCode ?? '미확인'}`}`,
    failureCategory: category };
}

const robotsCache = new Map<string, { state: RobotsState; expires: number }>();
const dnsCache = new Map<string, { ip: string; family: 4 | 6; expires: number }>();
const throttleUntil = new Map<string, number>();
const resourceCache = new Map<string, { response: HttpResult; expires: number; bytes: number }>();
let resourceCacheBytes = 0;
const RESOURCE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

function cachedResource(key: string): HttpResult | null {
  const item = resourceCache.get(key);
  if (!item) return null;
  if (item.expires <= Date.now()) {
    resourceCache.delete(key);
    resourceCacheBytes -= item.bytes;
    return null;
  }
  resourceCache.delete(key);
  resourceCache.set(key, item);
  return item.response;
}

function cacheResource(key: string, response: HttpResult): void {
  if (response.status !== 200 || response.body.length > 1024 * 1024) return;
  const directives = response.headers['cache-control'] ?? '';
  if (/\b(?:no-store|no-cache|private)\b/i.test(directives) || response.headers['set-cookie']) return;
  if (/\b(?:origin|cookie|authorization|user-agent|\*)\b/i.test(response.headers.vary ?? '')) return;
  const maxAge = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(directives)?.[1];
  const ttl = maxAge === undefined ? 120_000 : Math.min(Number(maxAge) * 1000, 300_000);
  if (ttl <= 0) return;
  const bytes = response.body.length + key.length * 2 + 1024;
  if (bytes > RESOURCE_CACHE_MAX_BYTES) return;
  const previous = resourceCache.get(key);
  if (previous) { resourceCache.delete(key); resourceCacheBytes -= previous.bytes; }
  while (resourceCacheBytes + bytes > RESOURCE_CACHE_MAX_BYTES && resourceCache.size) {
    const oldest = resourceCache.keys().next().value!;
    resourceCacheBytes -= resourceCache.get(oldest)!.bytes;
    resourceCache.delete(oldest);
  }
  resourceCache.set(key, { response, expires: Date.now() + ttl, bytes });
  resourceCacheBytes += bytes;
}

function hostWithoutDot(hostname: string): string {
  return hostname.replace(/\.$/, '').toLowerCase();
}

function bareHost(hostname: string): string {
  return hostWithoutDot(hostname).replace(/^www\./, '');
}

export function isSameSite(candidate: URL | string, rootHost: string): boolean {
  const url = typeof candidate === 'string' ? new URL(candidate) : candidate;
  return bareHost(url.hostname) === bareHost(rootHost);
}

export function isPublicIpAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) {
    const p = ip.split('.').map(Number);
    const [a, b, c] = p;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version !== 6) return false;
  // Only native global-unicast IPv6 is accepted. Transition/mapped ranges can
  // conceal IPv4 destinations and are intentionally excluded.
  const parts = ip.split(':');
  const first = Number.parseInt(parts[0], 16);
  const second = Number.parseInt(parts[1] || '0', 16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return false;
  return !(first === 0x2002 || (first === 0x2001 && (second === 0 || second === 0x0db8)));
}

function checkUrlSyntax(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('유효한 http 또는 https URL을 입력해 주세요.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http 또는 https URL만 검사할 수 있습니다.');
  if (url.username || url.password) throw new Error('계정 정보가 포함된 URL은 검사할 수 없습니다.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('80 또는 443 포트의 공개 URL만 검사할 수 있습니다.');
  const host = hostWithoutDot(url.hostname.replace(/^\[|\]$/g, ''));
  if (!host || host === 'localhost' || host.endsWith('.localhost') ||
      /\.(local|internal|invalid|test|example|onion|lan)$/.test(host) ||
      (net.isIP(host) === 0 && !host.includes('.'))) {
    throw new Error('공개 인터넷 호스트만 검사할 수 있습니다.');
  }
  if (net.isIP(host) && !isPublicIpAddress(host)) throw new Error('내부망 또는 예약 IP 주소는 검사할 수 없습니다.');
  url.hash = '';
  return url;
}

/** Validate URL format and SSRF-sensitive literal hosts without requiring DNS. */
export function validateTargetSyntax(input: string): URL { return checkUrlSyntax(input); }

async function resolvePublicIp(url: URL): Promise<{ ip: string; family: 4 | 6 }> {
  const host = hostWithoutDot(url.hostname.replace(/^\[|\]$/g, ''));
  const literal = net.isIP(host);
  if (literal) {
    if (!isPublicIpAddress(host)) throw new Error('내부망 또는 예약 IP 주소는 검사할 수 없습니다.');
    return { ip: host, family: literal as 4 | 6 };
  }
  const cached = dnsCache.get(host);
  if (cached && cached.expires > Date.now()) return { ip: cached.ip, family: cached.family };
  let resolved: { address: string; family: number }[];
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`DNS 조회에 실패했습니다: ${host}`);
  }
  if (!resolved.length || resolved.some((item) => !isPublicIpAddress(item.address))) {
    throw new Error(`공개 IP로만 연결되는 호스트가 아닙니다: ${host}`);
  }
  const selected = resolved.find((item) => item.family === 4) ?? resolved[0];
  const entry = { ip: selected.address, family: selected.family as 4 | 6, expires: Date.now() + CACHE_MS };
  dnsCache.set(host, entry);
  return { ip: entry.ip, family: entry.family };
}

export async function validateTarget(input: string): Promise<URL> {
  const url = checkUrlSyntax(input);
  await resolvePublicIp(url);
  return url;
}

export async function isSafePublicUrl(input: string): Promise<boolean> {
  try {
    await validateTarget(input);
    return true;
  } catch {
    return false;
  }
}

export function isExcludedPath(input: URL | string, excludedPaths: string[]): boolean {
  const encodedPath = typeof input === 'string' ? new URL(input, 'https://path.invalid').pathname : input.pathname;
  let path = encodedPath;
  try { path = decodeURIComponent(encodedPath); } catch { /* Keep encoded path. */ }
  return excludedPaths.some((raw) => {
    let prefix = raw.trim();
    try { prefix = decodeURIComponent(prefix); } catch { /* Keep encoded prefix. */ }
    if (!prefix || prefix === '/') return prefix === '/';
    if (!prefix.startsWith('/')) return false;
    const normalized = prefix.replace(/\/$/, '');
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

export function normalizePageUrl(input: string, base?: string): string | null {
  try {
    const url = new URL(input, base);
    checkUrlSyntax(url.href);
    if (/\.(?:pdf|xml|txt|json|jpg|jpeg|png|gif|webp|svg|avif|ico|css|js|mjs|map|woff2?|ttf|otf|eot|zip|gz|mp4|webm|mp3|wav)(?:$)/i.test(url.pathname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/$/, '');
    url.searchParams.sort();
    return url.href;
  } catch {
    return null;
  }
}

function decodeXml(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] ?? match;
  });
}

export function extractSitemapLocs(xml: string): { kind: 'index' | 'urlset' | 'unknown'; locs: string[] } {
  const kind = /<(?:\w+:)?sitemapindex\b/i.test(xml) ? 'index' : /<(?:\w+:)?urlset\b/i.test(xml) ? 'urlset' : 'unknown';
  const locs: string[] = [];
  const re = /<(?:(\w+):)?loc(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?loc\s*>/gi;
  for (const match of xml.matchAll(re)) {
    if (/^(image|video|news)$/i.test(match[1] || '')) continue;
    const value = decodeXml(match[2]).trim();
    if (value) locs.push(value);
  }
  return { kind, locs };
}

function parseRobots(text: string): RobotsState {
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let agents: string[] = [];
  let seenDirective = false;
  const delays: { agent: string; milliseconds: number }[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/\s+#.*$/, '').trim();
    const colon = cleaned.indexOf(':');
    if (colon < 0) continue;
    const key = cleaned.slice(0, colon).trim().toLowerCase();
    const value = cleaned.slice(colon + 1).trim();
    if (key === 'sitemap' && value) { sitemaps.push(value); continue; }
    if (key === 'user-agent') {
      if (seenDirective) { agents = []; seenDirective = false; }
      agents.push(value.toLowerCase());
      continue;
    }
    if (!agents.length) continue;
    if (key === 'allow' || key === 'disallow') {
      seenDirective = true;
      if (value) for (const agent of agents) rules.push({ agent, allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      seenDirective = true;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        for (const agent of agents) delays.push({ agent, milliseconds: seconds * 1000 });
      }
    }
  }
  const specific = delays.filter((item) => item.agent !== '*' && USER_AGENT.toLowerCase().includes(item.agent));
  const applicable = specific.length ? specific : delays.filter((item) => item.agent === '*');
  const crawlDelayMs = Math.max(0, ...applicable.map((item) => item.milliseconds));
  return { text, rules, sitemaps, crawlDelayMs };
}

export function robotsAllows(robotsText: string | null, userAgent: string, path: string): boolean {
  if (!robotsText) return true;
  const rules = parseRobots(robotsText).rules;
  const lowerAgent = userAgent.toLowerCase();
  const specificAgents = [...new Set(rules.map((rule) => rule.agent).filter((agent) => agent !== '*' && lowerAgent.includes(agent)))];
  const applicable = rules.filter((rule) => specificAgents.length ? specificAgents.includes(rule.agent) : rule.agent === '*');
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of applicable) {
    const pattern = rule.pattern;
    const atEnd = pattern.endsWith('$');
    const body = atEnd ? pattern.slice(0, -1) : pattern;
    const regex = new RegExp(`^${body.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${atEnd ? '$' : ''}`);
    if (regex.test(path)) {
      const length = body.replace(/\*/g, '').length;
      if (!best || length > best.length || (length === best.length && rule.allow)) best = { length, allow: rule.allow };
    }
  }
  return best?.allow ?? true;
}

async function throttle(host: string, delay = THROTTLE_MS): Promise<void> {
  const now = Date.now();
  const next = Math.max(now, throttleUntil.get(host) ?? 0);
  throttleUntil.set(host, next + Math.max(THROTTLE_MS, delay));
  if (next > now) await new Promise((resolve) => setTimeout(resolve, next - now));
}

function decodeBody(body: Buffer, encoding: string, limit: number): Buffer {
  const kind = encoding.toLowerCase().split(',')[0]?.trim();
  if (!kind || kind === 'identity') return body;
  const options = { maxOutputLength: limit };
  if (kind === 'gzip' || kind === 'x-gzip') return zlib.gunzipSync(body, options);
  if (kind === 'br') return zlib.brotliDecompressSync(body, options);
  if (kind === 'deflate') return zlib.inflateSync(body, options);
  throw new Error(`지원하지 않는 압축 형식: ${kind}`);
}

async function requestOnce(urlInput: string, limit: number, requestHeaders: Record<string, string> = {}, method = 'GET', crawlDelay = 0): Promise<HttpResult> {
  const started = Date.now();
  if (crawlDelay > 60_000) throw new Error('robots.txt crawl-delay가 60초를 초과해 요청을 건너뛰었습니다.');
  const url = checkUrlSyntax(urlInput);
  const { ip, family } = await resolvePublicIp(url);
  await throttle(hostWithoutDot(url.hostname), crawlDelay);
  const headers: Record<string, string> = {
    ...requestHeaders,
    host: url.host,
    'user-agent': USER_AGENT,
    'accept-encoding': 'identity',
  };
  delete headers.cookie;
  delete headers.authorization;
  delete headers['proxy-authorization'];
  const result = await new Promise<HttpResult>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method,
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address: ip, family }]);
        else callback(null, ip, family);
      }) as any,
      maxHeaderSize: 32 * 1024,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (part: Buffer) => {
        size += part.length;
        if (size > limit) { req.destroy(new Error('응답 크기 제한을 초과했습니다.')); return; }
        chunks.push(part);
      });
      res.on('end', () => {
        try {
          const rawHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string') rawHeaders[key.toLowerCase()] = value;
          const body = decodeBody(Buffer.concat(chunks), rawHeaders['content-encoding'] ?? '', limit);
          delete rawHeaders['content-encoding'];
          delete rawHeaders['content-length'];
          delete rawHeaders['transfer-encoding'];
          delete rawHeaders.connection;
          resolve({ url: url.href, status: res.statusCode ?? 0, headers: rawHeaders, body, redirectCount: 0,
            redirectChain: [], responseTimeMs: Date.now() - started });
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('요청 시간이 초과됐습니다.')));
    req.on('error', reject);
    req.end();
  });
  return result;
}

function retryableDirectFailure(error: unknown): boolean {
  const category = classifyFailure(error);
  return category === 'cache_only_direct_failed' || category === 'timeout' || category === 'target_unreachable' || category === 'dns_error';
}

export function isCacheMissResponse(status: number, body: Buffer): boolean {
  return status >= 400 && body.length < 100_000 && /\bcache miss\b/i.test(body.toString('utf8'));
}

async function requestWithRetry(url: string, limit: number, crawlDelay: number): Promise<HttpResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await requestOnce(url, limit, {}, 'GET', crawlDelay);
      const cacheMiss = isCacheMissResponse(response.status, response.body);
      if (attempt === 0 && (cacheMiss || response.status === 502 || response.status === 503 || response.status === 504)) continue;
      return cacheMiss ? { ...response, cacheMiss: true } : response;
    } catch (error) {
      if (attempt || !retryableDirectFailure(error)) throw error;
    }
  }
  throw new Error('직접 요청 재시도에 실패했습니다.');
}

async function requestFollowing(urlInput: string, limit: number, rootHost: string, crawlDelay = 0, respectRobots = false, excludedPaths: string[] = []): Promise<HttpResult> {
  let current = urlInput;
  const started = Date.now();
  const redirectChain: RedirectHop[] = [];
  try {
    for (let redirectCount = 0; redirectCount <= 8; redirectCount++) {
      if (isExcludedPath(new URL(current), excludedPaths)) throw new Error('관리자가 제외한 경로로 이동했습니다.');
      if (respectRobots) {
        const page = new URL(current);
        const siteRobots = await getRobots(page.origin);
        if (!robotsAllows(siteRobots.text, USER_AGENT, `${page.pathname}${page.search}`)) {
          throw new Error('robots.txt에서 크롤링을 제한한 주소로 이동했습니다.');
        }
      }
      const response = await requestWithRetry(current, limit, crawlDelay);
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) {
        return { ...response, redirectCount, redirectChain, responseTimeMs: Date.now() - started };
      }
      const next = new URL(response.headers.location, current);
      redirectChain.push({ url: current, statusCode: response.status, location: next.href });
      if (!isSameSite(next, rootHost)) throw new Error('사이트 외부로 리다이렉트되어 검사를 중단했습니다.');
      await validateTarget(next.href);
      current = next.href;
    }
    throw new Error('리다이렉트가 8회를 초과했습니다.');
  } catch (error) {
    throw new DirectRequestError(error instanceof Error ? error.message : String(error), current, redirectChain,
      Date.now() - started, classifyFailure(error));
  }
}

function textFromResponse(response: HttpResult): string {
  const type = response.headers['content-type'] ?? '';
  const charset = /charset=([^;\s]+)/i.exec(type)?.[1]?.replace(/["']/g, '').toLowerCase() ?? 'utf-8';
  try { return new TextDecoder(charset).decode(response.body); }
  catch { return response.body.toString('utf8'); }
}

export function isHtmlRobotsResponse(contentType: string, body: string): boolean {
  return /<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(body.slice(0, 2048))
    || (/html|xhtml/i.test(contentType) && !/^\s*(?:#|user-agent\s*:|sitemap\s*:|allow\s*:|disallow\s*:|crawl-delay\s*:)/im.test(body));
}

function rawAttribute(tag: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return decodeXml(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

export function sourceMetadata(html: string, base: string): Pick<PageSnapshot,
  'title' | 'metaDescription' | 'canonical' | 'robotsMeta' | 'lang' | 'hasAdsenseScript' | 'hasAdsenseMeta'> {
  const title = decodeXml((/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
  const meta = (name: string) => rawAttribute(tags.find((tag) => rawAttribute(tag, 'name').toLowerCase() === name) ?? '', 'content');
  const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0])
    .find((tag) => /(?:^|\s)canonical(?:\s|$)/i.test(rawAttribute(tag, 'rel')));
  let canonical = '';
  try { if (canonicalTag && rawAttribute(canonicalTag, 'href')) canonical = new URL(rawAttribute(canonicalTag, 'href'), base).href; }
  catch { /* Keep invalid canonical absent; the technical rule can flag it after rendering. */ }
  return {
    title, metaDescription: meta('description'), canonical, robotsMeta: meta('robots'),
    lang: rawAttribute(/<html\b[^>]*>/i.exec(html)?.[0] ?? '', 'lang'),
    hasAdsenseScript: /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i.test(html),
    hasAdsenseMeta: Boolean(meta('google-adsense-account')),
  };
}

async function getRobots(origin: string): Promise<RobotsState> {
  const cached = robotsCache.get(origin);
  if (cached && cached.expires > Date.now()) return cached.state;
  const robotsUrl = new URL('/robots.txt', origin).href;
  let state: RobotsState = { text: null, rules: [], sitemaps: [], crawlDelayMs: 0, file: fileCheck(robotsUrl) };
  try {
    const response = await requestFollowing(robotsUrl, 1024 * 1024, new URL(origin).hostname);
    const file = checkedFile(robotsUrl, response);
    const body = textFromResponse(response);
    const htmlResponse = response.status >= 200 && response.status < 300
      && isHtmlRobotsResponse(response.headers['content-type'] ?? '', body);
    if (response.status >= 200 && response.status < 300 && !htmlResponse) state = { ...parseRobots(body), file };
    else state.file = file;
    if (htmlResponse || response.cacheMiss || response.status === 401 || response.status === 403 || response.status === 429 || response.status >= 500) {
      // Stop this crawler conservatively, but never report the synthetic rule
      // as if it were an actual robots.txt instruction from the publisher.
      const uncertainFile = htmlResponse
        ? { ...file, error: 'robots.txt가 HTTP 200 HTML 화면을 반환해 크롤러 규칙을 확인하지 못했습니다.', failureCategory: 'unknown' as const }
        : file;
      state = { ...parseRobots('User-agent: *\nDisallow: /'), syntheticBlock: true, file: uncertainFile };
    }
  } catch (error) {
    // A network failure leaves the access policy unknown, so pause crawling
    // rather than treating the unavailable file as an explicit Allow rule.
    state = { ...parseRobots('User-agent: *\nDisallow: /'), syntheticBlock: true, file: failedFile(robotsUrl, error) };
  }
  robotsCache.set(origin, { state, expires: Date.now() + 10 * 60_000 });
  return state;
}

function extractHtmlLinks(html: string, base: string, rootHost: string, excludedPaths: string[]): string[] {
  const links = new Set<string>();
  const regex = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(regex)) {
    const value = decodeXml(match[1] ?? match[2] ?? match[3] ?? '');
    const normalized = normalizePageUrl(value, base);
    if (!normalized) continue;
    const url = new URL(normalized);
    if (isSameSite(url, rootHost) && !isExcludedPath(url, excludedPaths)) links.add(normalized);
  }
  return [...links];
}

function contentPathParts(url: string): string[] {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0] ?? '')) parts.shift();
  return parts;
}

function isUtilityProbe(url: string): boolean {
  const parts = contentPathParts(url);
  return parts.length === 0 || /^(?:about|contact|privacy|policy|terms|cookies?|legal|login|signin|signup|account|search|소개|문의|개인정보|이용약관)$/i.test(parts[0]);
}

/** Pick shallow representatives from distinct sections before probing deep links. */
export function selectDiscoveryProbeSeeds(urls: string[], limit = 6, preferredUrl?: string): string[] {
  const selected: string[] = [];
  const sections = new Set<string>();
  const preferredFirst = preferredUrl ? new URL(preferredUrl).pathname.split('/').filter(Boolean)[0]?.toLowerCase() : '';
  const preferredLocale = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(preferredFirst ?? '') ? preferredFirst : null;
  const preferredSection = preferredUrl && !preferredLocale ? contentPathParts(preferredUrl)[0] : null;
  const sorted = [...new Set(urls)].filter((url) => {
    try { return !isUtilityProbe(url); } catch { return false; }
  }).sort((a, b) => {
    const inScope = (url: string) => {
      if (preferredLocale) return new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() === preferredLocale ? 0 : 1;
      return preferredSection && contentPathParts(url)[0] === preferredSection ? 0 : 1;
    };
    return inScope(a) - inScope(b) || contentPathParts(a).length - contentPathParts(b).length || a.localeCompare(b);
  });
  for (const url of sorted) {
    const section = contentPathParts(url)[0];
    if (sections.has(section)) continue;
    selected.push(url);
    sections.add(section);
    if (selected.length >= limit) break;
  }
  return selected;
}

export async function discoverSite(rootUrl: string, excludedPaths: string[], preferredUrl = rootUrl): Promise<{ signals: SiteSignals; urls: string[] }> {
  const root = await validateTarget(rootUrl);
  const rootHost = root.hostname;
  const origin = root.origin;
  // A new job is a new observation. Never reuse a previous run's robots state.
  robotsCache.delete(origin);
  const robots = await getRobots(origin);
  const found = new Set<string>();
  const sitemapUrls = new Set<string>();
  const sitemapUrl = new URL('/sitemap.xml', origin).href;
  let sitemapCheck = fileCheck(sitemapUrl);
  const queue = [...robots.sitemaps, sitemapUrl, new URL('/sitemap_index.xml', origin).href];
  const seenSitemaps = new Set<string>();
  let sitemapWorked = false;
  while (queue.length) {
    const candidate = queue.shift()!;
    let sitemap: URL;
    try { sitemap = await validateTarget(candidate); }
    catch (error) { if (candidate === sitemapUrl) sitemapCheck = failedFile(sitemapUrl, error); continue; }
    if (seenSitemaps.has(sitemap.href)) continue;
    seenSitemaps.add(sitemap.href);
    const sitemapRobots = await getRobots(sitemap.origin);
    if (!robotsAllows(sitemapRobots.text, USER_AGENT, `${sitemap.pathname}${sitemap.search}`)) {
      if (candidate === sitemapUrl) sitemapCheck = robotsDeniedFile(sitemapUrl, sitemapRobots);
      continue;
    }
    try {
      const response = await requestFollowing(sitemap.href, SITEMAP_BYTES_LIMIT, sitemap.hostname, sitemapRobots.crawlDelayMs, true);
      if (candidate === sitemapUrl) sitemapCheck = checkedFile(sitemapUrl, response);
      if (response.status < 200 || response.status >= 300) continue;
      let body = response.body;
      if ((sitemap.pathname.endsWith('.gz') || response.headers['content-type']?.includes('gzip')) && body[0] === 0x1f && body[1] === 0x8b) {
        body = zlib.gunzipSync(body, { maxOutputLength: SITEMAP_BYTES_LIMIT });
      }
      const parsed = extractSitemapLocs(body.toString('utf8'));
      if (parsed.kind === 'unknown') continue;
      sitemapWorked = true;
      sitemapUrls.add(sitemap.href);
      for (const loc of parsed.locs) {
        if (parsed.kind === 'index') {
          try { queue.push(new URL(loc, sitemap.href).href); } catch { /* Invalid child sitemap URL. */ }
          continue;
        }
        const normalized = normalizePageUrl(loc);
        if (!normalized) continue;
        const url = new URL(normalized);
        if (isSameSite(url, rootHost) && !isExcludedPath(url, excludedPaths) && robotsAllows(robots.text, USER_AGENT, `${url.pathname}${url.search}`)) found.add(normalized);
      }
    } catch (error) {
      if (candidate === sitemapUrl) sitemapCheck = failedFile(sitemapUrl, error);
      /* Individual sitemap errors are not page failures. */
    }
  }
  const normalizedRoot = normalizePageUrl(root.href)!;
  if (!isExcludedPath(root, excludedPaths) && robotsAllows(robots.text, USER_AGENT, `${root.pathname}${root.search}`)) found.add(normalizedRoot);
  try {
    if (robotsAllows(robots.text, USER_AGENT, `${root.pathname}${root.search}`)) {
      const home = await requestFollowing(root.href, DOCUMENT_BYTES_LIMIT, rootHost, robots.crawlDelayMs, true);
      if (home.status >= 200 && home.status < 300 && /html/i.test(home.headers['content-type'] ?? 'text/html')) {
        const finalHome = normalizePageUrl(home.url);
        if (finalHome && !isExcludedPath(new URL(finalHome), excludedPaths)) {
          if (finalHome !== normalizedRoot) found.delete(normalizedRoot);
          found.add(finalHome);
        }
        for (const link of extractHtmlLinks(textFromResponse(home), home.url, rootHost, excludedPaths)) {
          const target = new URL(link);
          if (robotsAllows(robots.text, USER_AGENT, `${target.pathname}${target.search}`)) found.add(link);
        }
      }
    }
  } catch { /* The page inspection will record the home-page failure. */ }

  // A small read-only discovery pass reaches pages linked from section hubs.
  // These fetches identify candidates; only inspectPage results count as audited pages.
  const discoveredFrom = new Set<string>([normalizedRoot]);
  const seeds = selectDiscoveryProbeSeeds([...found], 6, preferredUrl);
  const probe = async (candidate: string): Promise<void> => {
    if (discoveredFrom.has(candidate)) return;
    discoveredFrom.add(candidate);
    const target = new URL(candidate);
    if (!robotsAllows(robots.text, USER_AGENT, `${target.pathname}${target.search}`)) return;
    try {
      const response = await requestFollowing(candidate, DOCUMENT_BYTES_LIMIT, rootHost, robots.crawlDelayMs, true, excludedPaths);
      if (response.status < 200 || response.status >= 300 || !/html|xhtml/i.test(response.headers['content-type'] ?? 'text/html')) return;
      const final = normalizePageUrl(response.url);
      if (final) {
        if (final !== candidate) found.delete(candidate);
        found.add(final);
      }
      for (const link of extractHtmlLinks(textFromResponse(response), response.url, rootHost, excludedPaths)) {
        const url = new URL(link);
        if (robotsAllows(robots.text, USER_AGENT, `${url.pathname}${url.search}`)) found.add(link);
      }
    } catch { /* Discovery failures are retried during page inspection if selected. */ }
  };
  for (const seed of seeds) {
    await probe(seed);
    const seedPath = new URL(seed).pathname.replace(/\/+$/, '');
    const child = [...found]
      .filter((url) => !discoveredFrom.has(url) && new URL(url).pathname.startsWith(`${seedPath}/`))
      .sort((a, b) => contentPathParts(a).length - contentPathParts(b).length || a.localeCompare(b))[0];
    if (child) await probe(child);
  }
  let adsTxtText: string | null = null;
  const adsTxtUrl = new URL('/ads.txt', origin).href;
  let adsCheck = fileCheck(adsTxtUrl);
  try {
    if (robotsAllows(robots.text, USER_AGENT, '/ads.txt')) {
      const response = await requestFollowing(adsTxtUrl, 1024 * 1024, rootHost, robots.crawlDelayMs, true);
      adsCheck = checkedFile(adsTxtUrl, response);
      if (response.status >= 200 && response.status < 300) adsTxtText = textFromResponse(response);
    } else adsCheck = robotsDeniedFile(adsTxtUrl, robots);
  } catch (error) { adsCheck = failedFile(adsTxtUrl, error); }
  return {
    signals: {
      rootUrl: root.href,
      host: rootHost,
      robotsUrl: new URL('/robots.txt', origin).href,
      robotsText: robots.syntheticBlock ? null : robots.text,
      robotsAllowsAdsense: robots.syntheticBlock || robots.text === null ? null : robotsAllows(robots.text, 'Mediapartners-Google', '/'),
      sitemapUrls: [...sitemapUrls],
      adsTxtUrl,
      adsTxtText,
      discoveryMethod: sitemapWorked ? 'sitemap-and-links' : 'links-only',
      technicalFiles: { robots: robots.file ?? fileCheck(new URL('/robots.txt', origin).href), sitemap: sitemapCheck, ads: adsCheck },
    },
    urls: [...found],
  };
}

function blankSnapshot(url: string): PageSnapshot {
  return {
    url, finalUrl: url, fetchedAt: new Date().toISOString(), statusCode: null, contentType: '',
    rawHtml: '', renderedText: '', mainText: '', mainProseText: '', title: '', metaDescription: '', canonical: '',
    robotsMeta: '', lang: '', headings: [], links: [], navLinks: [], imageCount: 0,
    imagesWithoutAlt: 0, mediaCount: 0, adElementCount: 0, hasAdsenseScript: false,
    hasAdsenseMeta: false, hasPrivacyLink: false, hasAboutLink: false, hasContactLink: false,
    hasCookieTerms: false, hasAdClickPrompt: false, desktopOverflow: false, mobileOverflow: false,
    popupCount: 0, jsErrors: [], resourceFailures: [], redirectCount: 0,
  };
}

type DomMetrics = Omit<PageSnapshot, 'url' | 'finalUrl' | 'fetchedAt' | 'statusCode' | 'contentType' | 'rawHtml' | 'desktopOverflow' | 'mobileOverflow' | 'jsErrors' | 'resourceFailures' | 'redirectCount' | 'error'> & { overflow: boolean };

async function measurePage(page: Page): Promise<DomMetrics> {
  return page.evaluate(() => {
    const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const links = allLinks.map((a) => a.href).filter(Boolean);
    const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('nav a[href], header a[href]')).map((a) => a.href).filter(Boolean);
    const linkSignal = (pattern: RegExp) => allLinks.some((a) => pattern.test(`${a.href} ${text(a)}`));
    const main = document.querySelector('main, article, [role="main"]') ?? document.body;
    const clean = main.cloneNode(true) as Element;
    clean.querySelectorAll('nav, header, footer, aside, script, style, noscript').forEach((el) => el.remove());
    const prose = clean.cloneNode(true) as Element;
    prose.querySelectorAll('a').forEach((el) => el.remove());
    const visible = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], dialog, .modal, .popup')).filter((el) => {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 60 && box.height > 60;
    });
    const images = Array.from(document.images);
    const bodyText = document.body?.innerText ?? '';
    const html = document.documentElement.outerHTML;
    return {
      renderedText: bodyText.slice(0, 120_000),
      mainText: text(clean).slice(0, 120_000),
      mainProseText: text(prose).slice(0, 120_000),
      title: document.title,
      metaDescription: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
      robotsMeta: document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? '',
      lang: document.documentElement.lang ?? '',
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(text).filter(Boolean).slice(0, 100),
      links,
      navLinks,
      imageCount: images.length,
      imagesWithoutAlt: images.filter((img) => !img.hasAttribute('alt')).length,
      mediaCount: document.querySelectorAll('video, audio, iframe[src*="youtube"], iframe[src*="vimeo"]').length,
      adElementCount: document.querySelectorAll('ins.adsbygoogle, [data-ad-client], [id*="ad-slot"], [class*="ad-slot"]').length,
      hasAdsenseScript: /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/i.test(html),
      hasAdsenseMeta: Boolean(document.querySelector('meta[name="google-adsense-account"][content]')),
      hasPrivacyLink: linkSignal(/privacy|개인정보|プライバシー|隱私/i),
      hasAboutLink: linkSignal(/about|소개|회사|運営者|关于/i),
      hasContactLink: linkSignal(/contact|문의|연락|お問い合わせ|联系/i),
      hasCookieTerms: /쿠키|cookie|개인정보|privacy/i.test(bodyText),
      hasAdClickPrompt: /광고를\s*(클릭|눌러)|click\s+(the\s+)?ads?/i.test(bodyText),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 8,
      popupCount: visible.length,
    };
  });
}

export function isLoadingShellText(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= 100 && /^(?:loading(?:\s+(?:content|data|page))?|please\s+wait|로딩(?:\s*중)?|불러오는\s*중|잠시만\s*기다려|読み込み中|加载中|正在加载)(?:[\s.…!！]*)$/i.test(text);
}

function filteredSameSiteLinks(links: string[], rootHost: string, excludedPaths: string[], robotsText: string | null): string[] {
  const output = new Set<string>();
  for (const link of links) {
    const normalized = normalizePageUrl(link);
    if (!normalized) continue;
    const url = new URL(normalized);
    if (isSameSite(url, rootHost) && !isExcludedPath(url, excludedPaths) && robotsAllows(robotsText, USER_AGENT, `${url.pathname}${url.search}`)) output.add(normalized);
  }
  return [...output];
}

export async function configureReadOnlyRoutes(context: BrowserContext, rootHost: string, excludedPaths: string[], resourceFailures: string[]): Promise<void> {
  let requestCount = 0;
  let byteCount = 0;
  const recordFailure = (request: Request, detail: string) => {
    const essential = ['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(request.resourceType());
    const entry = essential
      ? `${SCANNER_LIMITATION_MARKER} ${request.resourceType()} ${request.method()} ${request.url()}: ${detail}`
      : `${request.url()}: ${detail}`;
    if (resourceFailures.length < 30) resourceFailures.push(entry);
    else if (essential && !resourceFailures.some((failure) => failure.startsWith(SCANNER_LIMITATION_MARKER))) {
      resourceFailures[resourceFailures.length - 1] = entry;
    }
  };
  await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = request.url();
    if (!['GET', 'HEAD'].includes(request.method())) {
      recordFailure(request, '읽기 전용 검사에서 GET/HEAD 이외 요청을 보내지 않았습니다.');
      await route.abort('blockedbyclient');
      return;
    }
    if (++requestCount > PAGE_RESOURCE_LIMIT || byteCount >= PAGE_BYTES_LIMIT) {
      recordFailure(request, `검사 요청 ${PAGE_RESOURCE_LIMIT}개 또는 총 리소스 ${PAGE_BYTES_LIMIT}바이트 한도에 도달했습니다.`);
      await route.abort('blockedbyclient');
      return;
    }
    try {
      // Every browser request is made by our pinned-DNS HTTP client. Browser
      // routing never continues to an independently resolved network target.
      const target = await validateTarget(url);
      if (request.isNavigationRequest() && !isSameSite(target, rootHost)) {
        throw new Error('외부 페이지로의 이동은 차단했습니다.');
      }
      if (request.isNavigationRequest() && isExcludedPath(target, excludedPaths)) {
        throw new Error('관리자가 제외한 경로로의 이동은 차단했습니다.');
      }
      const robots = await getRobots(target.origin);
      if (robots.syntheticBlock) throw new Error(`robots.txt 확인 실패로 리소스 요청을 보류했습니다: ${robots.file?.error ?? `HTTP ${robots.file?.statusCode ?? '미확인'}`}`);
      if (!robotsAllows(robots.text, USER_AGENT, `${target.pathname}${target.search}`)) {
        throw new Error('robots.txt에서 크롤링을 제한한 리소스입니다.');
      }
      const safeHeaders = request.headers();
      const limit = request.resourceType() === 'document' ? DOCUMENT_BYTES_LIMIT : RESOURCE_BYTES_LIMIT;
      const reusable = request.method() === 'GET' && ['script', 'stylesheet', 'font', 'image'].includes(request.resourceType());
      const cacheKey = `${url}\n${safeHeaders.accept ?? ''}`;
      let response = reusable ? cachedResource(cacheKey) : null;
      if (!response) {
        response = await requestOnce(url, limit, safeHeaders, request.method(), robots.crawlDelayMs);
        if (reusable) cacheResource(cacheKey, response);
      }
      byteCount += response.body.length;
      if (byteCount > PAGE_BYTES_LIMIT) throw new Error('페이지 리소스 용량 제한을 초과했습니다.');
      await route.fulfill({ status: response.status, headers: response.headers, body: response.body });
    } catch (error) {
      recordFailure(request, error instanceof Error ? error.message : String(error));
      await route.abort('blockedbyclient').catch(() => undefined);
    }
  });
}

async function render(browser: Browser, url: string, rootHost: string, excludedPaths: string[], mobile: boolean,
  failures: string[], jsErrors: string[], screenshotPath?: string): Promise<{ metrics: DomMetrics; finalUrl: string; redirects: number; status: number | null; screenshotPath?: string; errorScreen: boolean }> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    acceptDownloads: false,
    serviceWorkers: 'block',
    javaScriptEnabled: true,
  });
  // The tsx development runner may annotate serialized evaluate callbacks
  // with esbuild's __name helper. Supply it inside this isolated context.
  await context.addInitScript({ content: 'window.__name = (value) => value;' });
  await configureReadOnlyRoutes(context, rootHost, excludedPaths, failures);
  const page = await context.newPage();
  const pendingContentRequests = new Set<Request>();
  const contentRequest = (request: Request) => ['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(request.resourceType());
  page.on('request', (request) => { if (contentRequest(request)) pendingContentRequests.add(request); });
  page.on('requestfinished', (request) => pendingContentRequests.delete(request));
  page.on('requestfailed', (request) => pendingContentRequests.delete(request));
  page.on('pageerror', (error) => { if (jsErrors.length < 20) jsErrors.push(error.message.slice(0, 500)); });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(500);
    let metrics = await measurePage(page);
    // A DOMContentLoaded shell may still be waiting for its public content.
    // Re-measure for a bounded period before treating short text as final.
    for (let retry = 0; retry < 4 && (metrics.mainText.trim().length < 20 || isLoadingShellText(metrics.mainText)); retry++) {
      await page.waitForTimeout(500);
      metrics = await measurePage(page);
    }
    if (isLoadingShellText(metrics.mainText) || (metrics.mainText.trim().length < 20 && pendingContentRequests.size > 0)) {
      const reason = `${SCANNER_LIMITATION_MARKER} ${url}: 본문 로딩 또는 주요 자원 요청이 검사 대기 시간 안에 완료되지 않았습니다.`;
      if (failures.length < 30) failures.push(reason);
      else if (!failures.some((item) => item.startsWith(SCANNER_LIMITATION_MARKER))) failures[failures.length - 1] = reason;
      throw new Error(reason);
    }
    if (!isSameSite(new URL(page.url()), rootHost)) throw new Error('사이트 외부로 이동하여 렌더링 검사를 중단했습니다.');
    let savedScreenshot: string | undefined;
    if (screenshotPath) {
      try {
        await page.screenshot({ path: screenshotPath, type: 'jpeg', quality: 68, fullPage: false, timeout: 8_000 });
        savedScreenshot = screenshotPath;
      } catch { /* Screenshot is supporting evidence, not a condition for render success. */ }
    }
    let redirects = 0;
    let previous = response?.request().redirectedFrom();
    while (previous && redirects < 20) { redirects++; previous = previous.redirectedFrom(); }
    const errorScreen = (response?.status() ?? 0) >= 400
      || /^(?:404\b|not found\b|페이지를 찾을 수 없|server error\b|error 500\b)/i.test(metrics.title.trim())
      || /^(?:404\b|not found\b|페이지를 찾을 수 없|server error\b|error 500\b)/i.test(metrics.mainText.trim().slice(0, 160));
    return { metrics, finalUrl: page.url(), redirects, status: response?.status() ?? null, screenshotPath: savedScreenshot, errorScreen };
  } finally {
    await context.close();
  }
}

async function captureRenders(snapshot: PageSnapshot, browser: Browser | null, startUrl: string, rootHost: string,
  excludedPaths: string[], robotsText: string | null, evidenceDir?: string, browserFailure?: string): Promise<void> {
  if (!browser) {
    const error = browserFailure ?? '브라우저를 시작하지 못해 화면을 검사하지 못했습니다.';
    snapshot.desktopRender = { viewport: 'desktop', attempted: false, success: false, error, failureCategory: 'render_failed' };
    snapshot.mobileRender = { viewport: 'mobile', attempted: false, success: false, error, failureCategory: 'render_failed' };
    return;
  }
  if (evidenceDir) {
    try { mkdirSync(evidenceDir, { recursive: true, mode: 0o700 }); }
    catch { evidenceDir = undefined; }
  }
  const screenshotBase = createHash('sha256').update(snapshot.url).digest('hex');
  const checkRender = async (viewport: 'desktop' | 'mobile') => {
    const priorFailures = snapshot.resourceFailures.length;
    try {
      const result = await render(browser, startUrl, rootHost, excludedPaths, viewport === 'mobile', snapshot.resourceFailures,
        snapshot.jsErrors, evidenceDir ? join(evidenceDir, `${screenshotBase}-${viewport}.jpg`) : undefined);
      const check: RenderCheck = { viewport, attempted: true, success: true, finalUrl: result.finalUrl,
        statusCode: result.status, title: result.metrics.title, mainTextPresent: Boolean(result.metrics.mainText.trim()),
        errorScreen: result.errorScreen, ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}) };
      return { result, check };
    } catch (error) {
      const navigationFailure = snapshot.resourceFailures.slice(priorFailures).find((item) => item.startsWith(`${startUrl}:`));
      const underlyingCategory = navigationFailure ? classifyFailure(navigationFailure) : classifyFailure(error);
      const check: RenderCheck = { viewport, attempted: true, success: false,
        error: `${error instanceof Error ? error.message : String(error)}${navigationFailure ? ` · 원본 요청: ${navigationFailure}` : ''}`,
        failureCategory: underlyingCategory === 'unknown' ? 'render_failed' : underlyingCategory };
      return { result: null, check };
    }
  };
  const desktop = await checkRender('desktop');
  const mobile = await checkRender('mobile');
  snapshot.desktopRender = desktop.check;
  snapshot.mobileRender = mobile.check;
  const primary = desktop.result ?? mobile.result;
  if (primary) {
    Object.assign(snapshot, primary.metrics);
    snapshot.finalUrl = primary.finalUrl;
    snapshot.redirectCount += primary.redirects;
    snapshot.links = [...new Set([...snapshot.links, ...filteredSameSiteLinks(primary.metrics.links, rootHost, excludedPaths, robotsText)])];
    snapshot.navLinks = filteredSameSiteLinks(primary.metrics.navLinks, rootHost, excludedPaths, robotsText);
    if (!snapshot.http?.htmlCollected && primary.status !== null && primary.status >= 200 && primary.status < 300
      && !primary.errorScreen && primary.metrics.mainText.trim()) {
      // The browser route also makes a pinned-DNS direct request. Record the
      // original HTTP failure, while allowing this later direct observation.
      snapshot.error = undefined;
      snapshot.failureCategory = undefined;
      snapshot.statusCode = primary.status;
      snapshot.contentType ||= 'text/html';
    }
  }
  if (desktop.result) snapshot.desktopOverflow = desktop.result.metrics.overflow;
  if (mobile.result) snapshot.mobileOverflow = mobile.result.metrics.overflow;
  snapshot.popupCount = Math.max(desktop.result?.metrics.popupCount ?? 0, mobile.result?.metrics.popupCount ?? 0);
}

export async function inspectPage(browser: Browser | null, url: string, rootHost: string, excludedPaths: string[], evidenceDir?: string,
  browserFailure?: string): Promise<PageSnapshot> {
  const snapshot = blankSnapshot(url);
  const started = Date.now();
  let robotsText: string | null = null;
  try {
    const parsed = await validateTarget(url);
    if (!isSameSite(parsed, rootHost)) throw new Error('검사 대상 사이트 외부 URL입니다.');
    if (isExcludedPath(parsed, excludedPaths)) throw new Error('관리자가 제외한 경로입니다.');
    const robots = await getRobots(parsed.origin);
    robotsText = robots.text;
    if (!robotsAllows(robots.text, USER_AGENT, `${parsed.pathname}${parsed.search}`)) {
      if (robots.syntheticBlock) {
        snapshot.error = `robots.txt를 확인하지 못해 페이지 요청을 보류했습니다: ${robots.file?.error ?? `HTTP ${robots.file?.statusCode ?? '미확인'}`}`;
        snapshot.failureCategory = robots.file?.failureCategory ?? 'unknown';
        snapshot.http = { requestedUrl: url, finalUrl: url, statusCode: null, redirectChain: [],
          responseTimeMs: Date.now() - started, htmlCollected: false, checkedAt: snapshot.fetchedAt,
          error: snapshot.error, failureCategory: snapshot.failureCategory };
        return snapshot;
      }
      throw new Error('robots.txt에서 크롤링을 제한한 페이지입니다.');
    }
    const raw = await requestFollowing(parsed.href, DOCUMENT_BYTES_LIMIT, rootHost, robots.crawlDelayMs, true, excludedPaths);
    snapshot.finalUrl = raw.url;
    snapshot.redirectCount = raw.redirectCount;
    snapshot.statusCode = raw.status;
    snapshot.contentType = raw.headers['content-type'] ?? '';
    const directTrace: HttpTrace = { requestedUrl: url, finalUrl: raw.url, statusCode: raw.status,
      redirectChain: raw.redirectChain, responseTimeMs: raw.responseTimeMs, htmlCollected: false,
      checkedAt: snapshot.fetchedAt };
    snapshot.http = directTrace;
    if (raw.status < 200 || raw.status >= 300) {
      snapshot.error = raw.cacheMiss
        ? `HTTP ${raw.status} cache miss 응답이 재시도 후에도 계속돼 페이지 내용을 검사할 수 없습니다.`
        : `HTTP ${raw.status} 응답으로 내용을 검사할 수 없습니다.`;
      snapshot.failureCategory = raw.cacheMiss ? 'cache_only_direct_failed' : 'server_error';
      directTrace.error = snapshot.error;
      directTrace.failureCategory = snapshot.failureCategory;
      if (raw.status >= 500) await captureRenders(snapshot, browser, raw.url, rootHost, excludedPaths, robotsText, evidenceDir, browserFailure);
      return snapshot;
    }
    const decodedBody = textFromResponse(raw);
    const htmlSignature = /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(decodedBody.slice(0, 2048));
    if (!/html|xhtml/i.test(snapshot.contentType) && !htmlSignature) {
      snapshot.error = 'HTML 페이지가 아니어서 본문 검사를 건너뛰었습니다.';
      snapshot.failureCategory = 'non_html';
      directTrace.error = snapshot.error;
      directTrace.failureCategory = snapshot.failureCategory;
      await captureRenders(snapshot, browser, raw.url, rootHost, excludedPaths, robotsText, evidenceDir, browserFailure);
      return snapshot;
    }
    if (htmlSignature && !/html|xhtml/i.test(snapshot.contentType)) {
      snapshot.contentType = `text/html (본문 형식으로 식별; 원 응답: ${snapshot.contentType || '미제공'})`;
    }
    snapshot.rawHtml = decodedBody.slice(0, DOCUMENT_BYTES_LIMIT);
    directTrace.htmlCollected = snapshot.rawHtml.length > 0;
    if (!directTrace.htmlCollected) {
      snapshot.error = 'HTTP 응답은 성공했지만 HTML 본문이 비어 있습니다.';
      snapshot.failureCategory = 'server_error';
      directTrace.error = snapshot.error;
      directTrace.failureCategory = snapshot.failureCategory;
      return snapshot;
    }
    Object.assign(snapshot, sourceMetadata(snapshot.rawHtml, raw.url));
    const rawLinks = extractHtmlLinks(snapshot.rawHtml, raw.url, rootHost, excludedPaths);
    snapshot.links = rawLinks;
    await captureRenders(snapshot, browser, raw.url, rootHost, excludedPaths, robotsText, evidenceDir, browserFailure);
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error);
    snapshot.failureCategory = classifyFailure(error);
    snapshot.http ??= { requestedUrl: url, finalUrl: error instanceof DirectRequestError ? error.finalUrl : url,
      statusCode: null, redirectChain: error instanceof DirectRequestError ? error.redirectChain : [],
      responseTimeMs: error instanceof DirectRequestError ? error.responseTimeMs : Date.now() - started,
      htmlCollected: false, checkedAt: snapshot.fetchedAt, error: snapshot.error, failureCategory: snapshot.failureCategory };
    if (!['robots_blocked', 'excluded', 'security_blocked', 'non_html'].includes(snapshot.failureCategory) && snapshot.http.statusCode === null) {
      await captureRenders(snapshot, browser, url, rootHost, excludedPaths, robotsText, evidenceDir, browserFailure);
    }
  }
  return snapshot;
}

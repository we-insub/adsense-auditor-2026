import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Route } from 'playwright';
import {
  classifyFailure,
  configureReadOnlyRoutes,
  extractSitemapLocs,
  isCacheMissResponse,
  isExcludedPath,
  isHtmlRobotsResponse,
  isLoadingShellText,
  isPublicIpAddress,
  isSafePublicUrl,
  isSameSite,
  normalizePageUrl,
  robotsAllows,
  selectDiscoveryProbeSeeds,
  sourceMetadata,
  validateTarget,
} from './scanner.js';

test('network and render failures are classified without blaming the target for scanner restrictions', () => {
  assert.equal(classifyFailure(Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' })), 'scanner_network_restricted');
  assert.equal(classifyFailure(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })), 'dns_error');
  assert.equal(classifyFailure(Object.assign(new Error('certificate mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })), 'ssl_error');
  assert.equal(classifyFailure(new Error('robots.txt에서 크롤링을 제한한 페이지입니다.')), 'robots_blocked');
  assert.equal(classifyFailure(new Error('요청 시간이 초과됐습니다.')), 'timeout');
  assert.equal(classifyFailure(new Error('리다이렉트가 8회를 초과했습니다.')), 'unknown');
  assert.equal(classifyFailure(new Error('Browser page.goto failed')), 'render_failed');
});

test('cache-miss HTTP bodies and HTML robots challenges are not treated as publisher rules', () => {
  assert.equal(isCacheMissResponse(502, Buffer.from('upstream cache miss')), true);
  assert.equal(isCacheMissResponse(200, Buffer.from('cache miss')), false);
  assert.equal(isHtmlRobotsResponse('text/html', '<!doctype html><html><title>Checking your browser</title></html>'), true);
  assert.equal(isHtmlRobotsResponse('text/plain', 'User-agent: *\nDisallow: /private'), false);
  assert.equal(isHtmlRobotsResponse('text/html', 'User-agent: *\nDisallow: /private'), false);
});

test('loading text is distinguished from stable short content during bounded render settling', () => {
  assert.equal(isLoadingShellText('Loading...'), true);
  assert.equal(isLoadingShellText('불러오는 중…'), true);
  assert.equal(isLoadingShellText('직접 작성한 안내입니다.'), false);
  assert.equal(isLoadingShellText(''), false);
});

test('read-only POST and resource caps leave an explicit scanner limitation for content requests', async () => {
  let handle: (route: Route) => Promise<void> = async () => {};
  const context = {
    routeWebSocket: async () => {},
    route: async (_pattern: string, callback: (route: Route) => Promise<void>) => { handle = callback; },
  } as unknown as BrowserContext;
  const failures: string[] = [];
  await configureReadOnlyRoutes(context, 'example.com', [], failures);
  let aborts = 0;
  const route = (type: string, method: string, url: string) => ({
    request: () => ({ resourceType: () => type, method: () => method, url: () => url }),
    abort: async () => { aborts++; },
  }) as unknown as Route;

  await handle(route('fetch', 'POST', 'https://example.com/graphql'));
  assert.equal(aborts, 1);
  assert.match(failures[0], /^검사기 제한: fetch POST https:\/\/example\.com\/graphql:/);

  failures.length = 0;
  for (let index = 0; index < 120; index++) await handle(route('image', 'GET', 'http://127.0.0.1/image.png'));
  await handle(route('script', 'GET', 'https://example.com/app.js'));
  assert.equal(aborts, 122);
  assert.ok(failures.some((failure) => failure.startsWith('검사기 제한: script GET https://example.com/app.js:') && failure.includes('한도')));
});

test('direct HTML preserves source metadata even when browser rendering is unavailable', () => {
  const metadata = sourceMetadata('<html lang="ko"><head><title>직접 확인한 &amp; 제목</title><meta content="설명" name="description"><meta name="robots" content="index, follow"><meta name="google-adsense-account" content="ca-pub-123"><link href="/ko/" rel="canonical"><script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script></head></html>', 'https://example.com/ko/page');
  assert.equal(metadata.title, '직접 확인한 & 제목');
  assert.equal(metadata.metaDescription, '설명');
  assert.equal(metadata.canonical, 'https://example.com/ko/');
  assert.equal(metadata.lang, 'ko');
  assert.equal(metadata.robotsMeta, 'index, follow');
  assert.equal(metadata.hasAdsenseScript, true);
  assert.equal(metadata.hasAdsenseMeta, true);
});

test('private, loopback, credentialed, and non-web URLs are rejected before network access', async () => {
  for (const value of [
    'http://127.0.0.1/', 'http://2130706433/', 'http://10.2.3.4/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/',
    'http://localhost/', 'https://user:pass@example.com/',
    'file:///etc/passwd', 'http://example.com:8080/',
  ]) {
    assert.equal(await isSafePublicUrl(value), false, value);
    await assert.rejects(validateTarget(value), { name: 'Error' }, value);
  }
});

test('public address test rejects transition and reserved ranges', () => {
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
  for (const address of ['100.64.1.2', '172.16.1.1', '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '203.0.113.1', '2001:db8::1', '2001:0db8::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test('sitemap index and URL set locations are extracted and XML decoded', () => {
  assert.deepEqual(extractSitemapLocs('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://example.com/one.xml</loc></sitemap></sitemapindex>'), {
    kind: 'index', locs: ['https://example.com/one.xml'],
  });
  assert.deepEqual(extractSitemapLocs('<urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc></url><url><loc><![CDATA[https://example.com/b]]></loc></url></urlset>'), {
    kind: 'urlset', locs: ['https://example.com/a?x=1&y=2', 'https://example.com/b'],
  });
  assert.deepEqual(extractSitemapLocs('<urlset xmlns:image="x"><url><loc>https://example.com/a</loc><image:image><image:loc>https://example.com/a.jpg</image:loc></image:image></url></urlset>').locs, ['https://example.com/a']);
});

test('exclusions match path segments, while host scope allows only apex/www', () => {
  assert.equal(isExcludedPath('/private/post', ['/private']), true);
  assert.equal(isExcludedPath('/private%2Fpost', ['/private']), true);
  assert.equal(isExcludedPath('/private2', ['/private']), false);
  assert.equal(isExcludedPath('/foo', ['/']), true);
  assert.equal(isSameSite('https://www.example.com/a', 'example.com'), true);
  assert.equal(isSameSite('https://blog.example.com/a', 'example.com'), false);
});

test('robots allows the more specific path and agent rule', () => {
  const text = 'User-agent: *\nDisallow: /private\nAllow: /private/public\n\nUser-agent: Mediapartners-Google\nDisallow: /ads';
  assert.equal(robotsAllows(text, 'AdSenseReadOnlyAudit', '/private/a'), false);
  assert.equal(robotsAllows(text, 'AdSenseReadOnlyAudit', '/private/public/a'), true);
  assert.equal(robotsAllows(text, 'Mediapartners-Google', '/ads'), false);
  assert.equal(robotsAllows(text, 'Mediapartners-Google', '/private/a'), true);
});

test('URL normalization removes fragments and tracking parameters', () => {
  assert.equal(normalizePageUrl('/story/?utm_source=x&a=1#top', 'https://example.com/'), 'https://example.com/story?a=1');
  assert.equal(normalizePageUrl('mailto:hello@example.com'), null);
  assert.equal(normalizePageUrl('https://example.com/guide.pdf'), null);
});

test('discovery probes cover distinct shallow sections in the requested language', () => {
  const urls = [
    'https://example.com/en/catalog', 'https://example.com/en/journal',
    'https://example.com/ko/about', 'https://example.com/ko/catalog/item-a',
    'https://example.com/ko/catalog', 'https://example.com/ko/journal',
    'https://example.com/ko/tools', 'https://example.com/ko/privacy',
  ];
  assert.deepEqual(selectDiscoveryProbeSeeds(urls, 3, 'https://example.com/ko/'), [
    'https://example.com/ko/catalog', 'https://example.com/ko/journal', 'https://example.com/ko/tools',
  ]);
});

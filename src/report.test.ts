import assert from 'node:assert/strict';
import test from 'node:test';
import { DELIVERY_TEXT, FEATURES_TEXT, NOTICE_TEXT, QUICK_SCOPE_TEXT, REPAIR_PROMPT_TEXT, fillDeliveryText, renderReport } from './report.js';
import type { AuditJob, Finding, PageSnapshot, ReportData } from './types.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportReport } from './report.js';

const page: PageSnapshot = {
  url: 'https://example.com/', finalUrl: 'https://example.com/', fetchedAt: '2026-09-28T00:00:00.000Z',
  statusCode: 200, contentType: 'text/html', rawHtml: '<html></html>', renderedText: '내용', mainText: '내용',
  title: '제목', metaDescription: '', canonical: '', robotsMeta: '', lang: 'ko', headings: [], links: [], navLinks: [],
  imageCount: 0, imagesWithoutAlt: 0, mediaCount: 0, adElementCount: 0, hasAdsenseScript: false, hasAdsenseMeta: false,
  hasPrivacyLink: false, hasAboutLink: false, hasContactLink: false, hasCookieTerms: false, hasAdClickPrompt: false,
  desktopOverflow: false, mobileOverflow: false, popupCount: 0, jsErrors: [], resourceFailures: [], redirectCount: 0,
};

function fixture(overrides: Partial<ReportData> = {}): ReportData {
  const job: AuditJob = {
    id: 'sample', inputUrl: 'https://example.com/', rootUrl: 'https://example.com/', host: 'example.com',
    mode: 'standard', limit: 200, excludedPaths: [], status: 'complete', createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z', startedAt: '2026-09-28T00:00:00.000Z', completedAt: '2026-09-28T00:00:00.000Z',
    discovered: ['https://example.com/'], queue: [], visited: ['https://example.com/'], pages: [page], signals: null, error: null,
  };
  return {
    job,
    findings: [],
    score: {
      value: 82, percentage: 82, areaScores: { content: 34, navigation: 17, access: 11, trust: 12, adsense: 8 },
      nonApplicableWeight: 0, applicableWeight: 100, measuredWeight: 100, earnedWeight: 82, unknownWeight: 0,
      verificationRate: 100, possibleMin: 82, possibleMax: 82, holdReason: null,
      unmeasuredCoreRuleIds: [], ruleScores: [], criticalCapApplied: false,
    },
    generatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

test('escapes untrusted page content and refuses script source links', () => {
  const finding: Finding = {
    id: 'content-1', area: 'content', title: '<img src=x onerror=alert(1)>', verdict: 'issue',
    sourceKind: 'heuristic', sourceUrl: 'javascript:alert(1)', pageUrl: 'https://example.com/',
    good: '<b>good</b>', bad: '<script>alert(1)</script>', why: '보완', evidence: '" onmouseover="alert(1)',
    action: '고치기', weight: 8,
  };
  const html = renderReport(fixture({ findings: [finding] }));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot; onmouseover=&quot;alert(1)'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('href="javascript:'));
});

test('shows the 200-page banner only for a sampled standard scan', () => {
  const data = fixture();
  data.job.discovered = Array.from({ length: 201 }, (_, index) => `https://example.com/${index}`);
  assert.ok(renderReport(data).includes('기본 기준인 200페이지까지만 검수하여 채점했습니다'));
  assert.ok(renderReport(data).includes('애드센스 준비 상태 표본 검사 보고서'));
  data.job.mode = 'full';
  assert.ok(!renderReport(data).includes('기본 기준인 200페이지까지만 검수하여 채점했습니다'));
  assert.ok(renderReport(data).includes('애드센스 준비 상태 전체 검사 보고서'));
  data.job.mode = 'quick';
  data.job.limit = 20;
  const quickHtml = renderReport(data);
  assert.ok(quickHtml.includes(QUICK_SCOPE_TEXT));
  assert.ok(quickHtml.includes('빠른 표본 검사 (최대 20페이지)'));
  assert.ok(!quickHtml.includes('기본 기준인 200페이지까지만 검수하여 채점했습니다'));
});

test('score and percentage display the same unofficial index; footer never guesses registration status', () => {
  const data = fixture();
  const html = renderReport(data);
  assert.ok(html.includes('82/100점 <small class="grade-chip">B등급</small>'));
  assert.ok(html.includes('<strong>82%</strong>'));
  assert.ok(html.includes('비공식 승인 가능성 추정 지수 · 실제 승인 확률 아님'));
  assert.ok(html.includes('100점 채점 기준 · 5개 영역'));
  assert.ok(html.includes('미완성 문구 8 · 빈 본문 8'));
  assert.ok(html.includes('Google Search Console'));
  assert.ok(html.includes('Bing Webmaster Tools'));
  assert.ok(html.includes('네이버 서치어드바이저'));
  assert.ok(html.includes('등록·제출 여부는 이번 공개 페이지 검사로 확인하지 않았습니다'));
  assert.ok(html.includes('AdSense 점수에 반영하지 않았습니다'));
  assert.ok(!html.includes('신청 완료'));
  assert.ok(!html.includes('미신청'));
});

test('report shows direct file, HTTP, desktop, mobile, and failure facts without guessing old results', () => {
  const data = fixture();
  data.job.signals = {
    rootUrl: 'https://example.com/', host: 'example.com', robotsUrl: 'https://example.com/robots.txt',
    robotsText: '', robotsAllowsAdsense: true, sitemapUrls: [], adsTxtUrl: 'https://example.com/ads.txt',
    adsTxtText: null, discoveryMethod: 'links-only',
    technicalFiles: {
      robots: { url: 'https://example.com/robots.txt', finalUrl: 'https://example.com/robots.txt',
        statusCode: 200, bodyPresent: true, responseTimeMs: 72, redirectChain: [], checkedAt: page.fetchedAt },
      sitemap: { url: 'https://example.com/sitemap.xml', finalUrl: 'https://example.com/sitemap.xml',
        statusCode: 404, bodyPresent: false, responseTimeMs: 61, redirectChain: [], checkedAt: page.fetchedAt },
      ads: { url: 'https://example.com/ads.txt', finalUrl: 'https://example.com/ads.txt',
        statusCode: 404, bodyPresent: false, responseTimeMs: 58, redirectChain: [], checkedAt: page.fetchedAt },
    },
  };
  data.job.pages[0] = {
    ...page,
    http: { requestedUrl: page.url, finalUrl: page.finalUrl, statusCode: 200,
      redirectChain: [], responseTimeMs: 124, htmlCollected: true, checkedAt: page.fetchedAt },
    desktopRender: { viewport: 'desktop', attempted: true, success: true, title: '제목', mainTextPresent: true },
    mobileRender: { viewport: 'mobile', attempted: true, success: false, error: '렌더링 중단', failureCategory: 'render_failed' },
  };
  const html = renderReport(data);
  assert.match(html, /직접 접속·기술 파일·브라우저 검증 기록/);
  assert.match(html, /실제 접속으로 HTML 또는 본문 화면을 확인한 URL 1\/1건/);
  assert.match(html, /robots\.txt/);
  assert.match(html, /HTTP 200 · 124ms/);
  assert.match(html, /HTML 수집/);
  assert.match(html, /렌더링 중단/);
  assert.match(html, /브라우저 렌더링 실패/);
});

test('report calls out scanner-limited browser resources beside the affected URL', () => {
  const data = fixture();
  data.job.pages[0] = {
    ...page,
    resourceFailures: ['검사기 제한: fetch POST https://example.com/data: 읽기 전용 검사에서 요청하지 않았습니다.'],
    desktopRender: { viewport: 'desktop', attempted: true, success: true, title: '제목', mainTextPresent: false },
  };
  const html = renderReport(data);
  assert.match(html, /화면 일부 확인 불가: 검사기 제한: fetch POST/);
});

test('zero-direct report is a concise diagnosis without score cards or the 19-rule appendix', () => {
  const data = fixture();
  data.job.pages = [{ ...page, statusCode: null, rawHtml: '', renderedText: '', mainText: '',
    error: 'Cache miss: 직접 요청을 완료하지 못했습니다.', failureCategory: 'scanner_network_restricted',
    http: { requestedUrl: page.url, finalUrl: page.url, statusCode: null, redirectChain: [],
      responseTimeMs: 146, htmlCollected: false, checkedAt: page.fetchedAt,
      error: '외부 요청 차단', failureCategory: 'scanner_network_restricted' },
    desktopRender: { viewport: 'desktop', attempted: false, success: false },
    mobileRender: { viewport: 'mobile', attempted: false, success: false },
  }];
  data.job.signals = {
    rootUrl: page.url, host: 'example.com', robotsUrl: 'https://example.com/robots.txt',
    robotsText: null, robotsAllowsAdsense: null, sitemapUrls: [], adsTxtUrl: 'https://example.com/ads.txt',
    adsTxtText: null, discoveryMethod: 'links-only', discoveryError: '외부 네트워크 접근 제한',
    discoveryFailureCategory: 'scanner_network_restricted',
  };
  data.score.value = null;
  data.score.percentage = null;
  data.score.holdReason = '접근 가능한 HTML 페이지가 없습니다.';
  data.score.measuredWeight = 0;
  data.score.earnedWeight = 0;
  data.score.unknownWeight = 100;
  data.score.possibleMin = 0;
  data.score.possibleMax = 100;
  const html = renderReport(data);
  assert.match(html, /직접 접속 검사 결과 · 점수 산출 보류/);
  assert.match(html, /검사 환경의 외부 네트워크 제한/);
  assert.match(html, /사이트 자체 오류로 단정하지/);
  assert.match(html, /Cache miss: 직접 요청을 완료하지 못했습니다/);
  assert.match(html, /직접 확인 성공 URL \/ 방문 시도 URL/);
  assert.match(html, /robots\.txt/);
  assert.match(html, /네이버 서치어드바이저/);
  assert.ok(html.indexOf('검색엔진 등록·색인 자가 확인 안내') > html.indexOf('기술 파일 직접 요청 결과'));
  assert.ok(!html.includes('가능한 총점 범위'));
  assert.ok(!html.includes('5영역'));
  assert.ok(!html.includes('19개 규칙'));
  const delivery = fillDeliveryText(data);
  assert.match(delivery, /발견한 후보 URL/);
  assert.match(delivery, /직접 확인한 HTML 또는 브라우저 본문은 0건/);
  assert.match(delivery, /산출 보류 이유/);
  assert.match(delivery, /검사 환경의 외부 네트워크 제한: 외부 네트워크 접근 제한/);
  assert.match(delivery, /재검사 조치:/);
  assert.ok(!delivery.includes('..'));
  assert.ok(!delivery.includes('우선 수정할 사항은'));
});

test('report shows measured score coverage and separates requests from unique final URLs', () => {
  const data = fixture();
  data.score.measuredWeight = 67;
  data.score.earnedWeight = 61.5;
  data.score.unknownWeight = 33;
  data.score.verificationRate = 67;
  data.score.possibleMin = 61.5;
  data.score.possibleMax = 94.5;
  data.score.value = 91.8;
  data.score.percentage = 91.8;
  data.score.holdReason = null;
  data.job.pages.push({ ...page, url: 'https://example.com/alias' });
  const html = renderReport(data);
  assert.ok(html.includes('검증률 67.0% · W 67 / T 100'));
  assert.ok(html.includes('전체 확인 시 가능한 점수 구간'));
  assert.ok(html.includes('61.50~94.50점'));
  assert.ok(html.includes('고유 최종 URL 1개'));
  assert.ok(html.includes('방문 시도 2건 중 직접 확인 2건'));
  assert.ok(html.includes('방문 요청 URL·최종 URL'));
  assert.ok(html.includes('https://example.com/alias'));
  assert.ok(html.includes('91.8/100점 <small class="grade-chip">A등급</small>'));
  assert.ok(html.includes('비공식 승인 가능성 추정 지수'));
  assert.ok(fillDeliveryText(data).includes('고유 최종 URL 1개'));
  assert.ok(fillDeliveryText(data).includes('91.8/100점'));
});

test('measured-only report explains verified points, exact bounds, and missing core checks', () => {
  const data = fixture();
  data.score.value = 98.8;
  data.score.percentage = 98.8;
  data.score.nonApplicableWeight = 3;
  data.score.applicableWeight = 97;
  data.score.measuredWeight = 69;
  data.score.earnedWeight = 68.15;
  data.score.unknownWeight = 28;
  data.score.verificationRate = 69 / 97 * 100;
  data.score.possibleMin = 70.26;
  data.score.possibleMax = 99.12;
  data.score.holdReason = null;
  data.score.unmeasuredCoreRuleIds = ['access.response', 'access.robots', 'adsense.connection'];
  const html = renderReport(data);
  assert.ok(html.includes('획득 E 68.15 / 판정 배점 W 69'));
  assert.ok(html.includes('70.26~99.12점'));
  assert.ok(html.includes('98.8/100점 <small class="grade-chip">A등급</small>'));
  assert.ok(html.includes('100 × E ÷ W'));
  assert.ok(html.includes('미확인 U 28점에는 가정 점수를 넣지 않았습니다'));
  assert.ok(html.includes('검증률은 71.1%'));
  assert.ok(html.includes('AdSense 크롤러의 robots 접근'));
  assert.ok(html.includes('실제 Google 승인 확률이나 심사 결과가 아닙니다'));
});

test('provisional grades are explicit and an entirely unmeasured area has no F grade', () => {
  for (const [score, expected] of [[90, 'A'], [80, 'B'], [70, 'C'], [60, 'D'], [59.9, 'F']] as const) {
    const data = fixture();
    data.score.value = score;
    data.score.percentage = score;
    const html = renderReport(data);
    assert.ok(html.includes(`${score}/100점 <small class="grade-chip">${expected}등급</small>`));
  }
  assert.ok(renderReport(fixture()).includes('<strong>미검증</strong>'));
});

test('confirmed official critical finding shows the score cap and original estimate', () => {
  const data = fixture();
  data.score.value = 39;
  data.score.percentage = 39;
  data.score.criticalCapApplied = true;
  data.findings = [{
    id: 'adsense.emptyAds', area: 'adsense', title: '콘텐츠 없는 화면의 광고', verdict: 'issue',
    sourceKind: 'official', sourceUrl: 'https://support.google.com/publisherpolicies/answer/11112688',
    pageUrl: page.url, good: '', bad: '빈 화면에 광고가 있습니다.', why: '공식 정책 문제입니다.',
    evidence: '광고 요소 확인', action: '광고를 제거하세요.', weight: 3, critical: true,
  }];
  const html = renderReport(data);
  assert.ok(html.includes('산식 원값 82.0점 대신 39점'));
  assert.ok(html.includes('공식 정책 관련 문제'));
  assert.ok(html.includes('공식 근거'));
});

test('action guide gives a natural page-specific repair request before score details', () => {
  const finding: Finding = {
    id: 'content.empty', area: 'content', title: '빈 본문', verdict: 'issue', sourceKind: 'heuristic',
    sourceUrl: 'https://support.google.com/adsense/answer/81904', pageUrl: page.url,
    good: '', bad: '본문이 비어 있습니다.', why: '방문자가 내용을 확인할 수 없습니다.',
    evidence: '제목 아래 본문 없음', action: '페이지 목적에 맞는 본문을 작성하세요.', weight: 8,
  };
  const html = renderReport(fixture({ findings: [finding] }));
  assert.ok(html.includes('페이지별 수정 목록'));
  for (const label of ['페이지 주소(페이지 이름)', '현재 상황', '지적 사항', '관찰 증거', '공개 HTML', '보완 방법', '코드 변경 예시', '근거·이유', '완료 확인']) assert.ok(html.includes(label));
  assert.ok(html.indexOf('페이지별 수정 목록') < html.indexOf('영역별 획득 배점 E'));
  assert.ok(html.includes('제목 아래 본문 없음'));
  assert.ok(html.includes('해당 URL의 데스크톱·모바일 화면에서 페이지 목적에 맞는 실제 본문'));
  assert.ok(html.includes('href="https://example.com/"'));
});

test('customer report groups only actionable findings and quotes observed public markup conservatively', () => {
  const data = fixture();
  data.job.pages[0] = {
    ...page,
    rawHtml: '<html lang="ko"><head><title>예전 제목</title></head><body><main><p>TODO 글 작성</p></main></body></html>',
  };
  data.findings = [
    { id: 'adsense.emptyAds', area: 'adsense', title: '빈 화면 광고', verdict: 'issue', sourceKind: 'official',
      sourceUrl: 'https://support.google.com/publisherpolicies/answer/11112688', pageUrl: page.url,
      good: '', bad: '확인된 광고가 본문 없는 화면에 표시됩니다.', why: '정책상 제한입니다.', evidence: '광고 요소 확인',
      action: '광고를 제거하세요.', weight: 3, critical: true },
    { id: 'access.robots', area: 'access', title: '크롤러 차단', verdict: 'issue', sourceKind: 'official',
      sourceUrl: 'https://support.google.com/adsense/answer/10532', pageUrl: page.url,
      good: '', bad: '차단 규칙 확인.', why: '광고 크롤러 접근 필요.', evidence: 'robots.txt: AdSense 크롤러 차단/미확인',
      action: '차단 규칙을 확인하세요.', weight: 4 },
    { id: 'content.placeholder', area: 'content', title: '미완성 문구', verdict: 'issue', sourceKind: 'heuristic',
      sourceUrl: 'https://support.google.com/adsense/answer/81904', pageUrl: page.url,
      good: '', bad: '임시 문구가 보입니다.', why: '방문자가 미완성으로 볼 수 있습니다.',
      evidence: '본문/원본에서 "TODO 글 작성" 발견', action: '실제 본문으로 바꾸세요.', weight: 8 },
    { id: 'technical.title', area: 'technical', title: 'HTML title', verdict: 'caution', sourceKind: 'recommendation',
      sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link', pageUrl: page.url,
      good: '', bad: '제목이 포괄적입니다.', why: '검색 결과에서 구별하기 어렵습니다.', evidence: '예전 제목',
      action: '고유 제목을 쓰세요.', weight: 0 },
    { id: 'content.empty', area: 'content', title: '양호한 본문', verdict: 'good', sourceKind: 'heuristic',
      sourceUrl: 'https://support.google.com/adsense/answer/81904', pageUrl: page.url,
      good: '이 문장은 고객 PDF에 나오면 안 됩니다.', bad: '', why: '', evidence: '본문 있음', action: '', weight: 8 },
  ];
  const html = renderReport(data);
  assert.ok(html.indexOf('크리티컬 · 확인된 중대 항목') < html.indexOf('긴급 · 공식 근거 확인 항목'));
  assert.ok(html.indexOf('긴급 · 공식 근거 확인 항목') < html.indexOf('수정 필요 · 수정 여부 검토'));
  assert.ok(html.includes('사이트 공통 설정'));
  assert.ok(html.includes('&lt;title&gt;예전 제목&lt;/title&gt;'));
  assert.ok(html.includes('TODO 글 작성'));
  assert.ok(html.includes('코드 저장소에서 위치 확인 필요'));
  assert.ok(html.includes('href="https://support.google.com/adsense/answer/10532"'));
  assert.ok(!html.includes('이 문장은 고객 PDF에 나오면 안 됩니다.'));
  assert.ok(!html.includes('<th>좋은 점</th>'));
});

test('compact report lists every visited URL without repeating every passing rule card', () => {
  const data = fixture();
  data.job.pages = Array.from({ length: 20 }, (_, index) => ({ ...page, url: `https://example.com/${index}`, finalUrl: `https://example.com/${index}` }));
  data.findings = data.job.pages.map((item) => ({
    id: 'content.empty', area: 'content', title: '빈 본문·제목뿐인 페이지', verdict: 'good', sourceKind: 'heuristic',
    sourceUrl: 'https://support.google.com/adsense/answer/81904', pageUrl: item.url,
    good: '페이지 목적을 설명할 본문이 있습니다.', bad: '', why: '', evidence: '본문 231자', action: '', weight: 8,
  }));
  const html = renderReport(data);
  assert.ok(html.includes('실제 접속으로 HTML 또는 본문 화면을 확인한 URL 20/20건'));
  assert.ok(html.includes('https://example.com/19'));
  assert.ok(!html.includes('페이지 목적을 설명할 본문이 있습니다.'));
  assert.ok(!html.includes('finding-card finding-good'));
});

test('unmeasured core rules are separated from confirmed repair requests', () => {
  const data = fixture();
  data.score.value = null;
  data.score.percentage = null;
  data.score.unmeasuredCoreRuleIds = ['access.robots'];
  data.findings = [{
    id: 'access.robots', area: 'access', title: 'AdSense 크롤러의 robots 접근', verdict: 'unknown', sourceKind: 'official',
    sourceUrl: 'https://support.google.com/adsense/answer/10532', pageUrl: page.url,
    good: '', bad: '접근 정책을 확인하지 못했습니다.', why: '차단 여부를 확인해야 합니다.',
    evidence: 'robots.txt를 확인하지 못했습니다.', action: 'robots.txt를 확인하세요.', weight: 4,
  }];
  const html = renderReport(data);
  assert.ok(html.includes('추가 확인 필요 · 오류로 단정하지 마세요'));
  assert.ok(html.indexOf('추가 확인 필요 · 오류로 단정하지 마세요') > html.indexOf('페이지별 수정 목록'));
  assert.ok(html.includes('오류로 단정하거나 자동 수정 대상으로 취급하지 마세요'));
  assert.ok(!html.includes('class="action-card unknown"'));
});

test('unvisited internal links are a verification task, not a confirmed defect card', () => {
  const data = fixture();
  data.findings = [{
    id: 'navigation.links', area: 'navigation', title: '검사 범위의 내부 링크 오류', verdict: 'unknown', sourceKind: 'heuristic',
    sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable', pageUrl: page.url,
    good: '', bad: '방문하지 않은 대상이 남았습니다.', why: '실제 상태를 확인해야 합니다.',
    evidence: '이 페이지의 검사된 링크 1개 / 전체 링크 3개', action: '대상 링크를 실제로 방문하세요.', weight: 6,
  }];
  const html = renderReport(data);
  assert.ok(html.includes('미검사 내부 링크의 실제 상태'));
  assert.ok(html.includes('이 페이지의 내부 링크 3개 중 1개 대상만 검사했습니다'));
  assert.ok(html.includes('깨진 링크라고 단정하지 마세요'));
  assert.ok(!html.includes('class="action-card issue"'));
});

test('heuristic cautions require a human check before adding filler content', () => {
  const data = fixture();
  data.findings = [{
    id: 'content.substance', area: 'content', title: '페이지 유형에 맞는 실질 콘텐츠', verdict: 'caution', sourceKind: 'heuristic',
    sourceUrl: 'https://support.google.com/adsense/answer/9724', pageUrl: page.url,
    good: '', bad: '설명이 짧을 수 있습니다.', why: '자체 길이 기준입니다.',
    evidence: 'article 유형 · 본문 231자 · 자체 기준 350자', action: '필요한 설명을 보강하세요.', weight: 8,
  }];
  const html = renderReport(data);
  assert.ok(html.includes('이 페이지를 글 유형으로 분류했고, 공개 본문 231자를 확인했습니다'));
  assert.ok(html.includes('페이지 목적을 충족한다면 불필요한 내용을 덧붙이지 마세요'));
});

test('future privacy notice shows observed wording and conditional verification', () => {
  const data = fixture();
  data.score.value = null;
  data.score.percentage = null;
  data.score.unmeasuredCoreRuleIds = ['trust.privacy'];
  data.findings = [{
    id: 'trust.privacy', area: 'trust', title: '개인정보·광고 쿠키 안내', verdict: 'unknown', sourceKind: 'recommendation',
    sourceUrl: 'https://support.google.com/adsense/answer/1348695', pageUrl: page.url,
    good: '개인정보 문서와 광고 안내를 확인했습니다.', bad: '현재 운영과 일치하는지 확인해야 합니다.',
    why: '실제 광고 운영 여부는 공개 자료만으로 확정할 수 없습니다.',
    evidence: '개인정보 링크 있음 · 문서 검사 https://example.com/privacy · 광고 안내 있음 · 쿠키 안내 있음 · 선택/거부 안내 있음 · 향후 보완 표현 "광고 시작 전 안내에 반영" · 공개 광고 신호 미감지',
    action: '운영 중이면 현재 상태에 맞게 고치고, 운영 전이면 그대로 유지하세요.', weight: 7,
  }];
  const html = renderReport(data);
  assert.ok(html.includes('개인정보 문서 https://example.com/privacy를 검사했습니다'));
  assert.ok(html.includes('“광고 시작 전 안내에 반영”라는 향후 보완 표현'));
  assert.ok(html.includes('운영 중이면 현재 상태에 맞게 고치고, 운영 전이면 그대로 유지하세요'));
  assert.ok(!html.includes('class="action-card unknown"'));
});

test('copy templates and filled delivery message are ready for administrator', () => {
  const message = fillDeliveryText(fixture());
  assert.ok(NOTICE_TEXT.includes('사이트 URL을 보내주시면'));
  assert.ok(FEATURES_TEXT.includes('최대 200페이지'));
  assert.ok(REPAIR_PROMPT_TEXT.includes('첨부한 애드센스 준비 진단 PDF'));
  assert.ok(DELIVERY_TEXT.includes('[사이트 URL]'));
  assert.ok(message.includes('https://example.com/'));
  assert.ok(message.includes('1개 중 1개'));
  assert.ok(message.includes('82/100점'));
  assert.ok(!message.includes('[점수]'));
  const quick = fixture();
  quick.job.mode = 'quick';
  quick.job.limit = 20;
  const quickMessage = fillDeliveryText(quick);
  assert.ok(quickMessage.includes('빠른 표본 검사(최대 20페이지)'));
  assert.ok(!quickMessage.includes('200페이지 제한이 적용된 경우'));
});

test('exports HTML, JSON and a readable PDF file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adsense-report-'));
  try {
    const paths = await exportReport(fixture(), dir);
    assert.match(readFileSync(paths.htmlPath, 'utf8'), /Google Search Console/);
    assert.equal(JSON.parse(readFileSync(paths.jsonPath, 'utf8')).score.value, 82);
    assert.equal(readFileSync(paths.pdfPath).subarray(0, 5).toString(), '%PDF-');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

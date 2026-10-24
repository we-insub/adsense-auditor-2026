import { createHash } from 'node:crypto';
import type { AuditJob, FailureCategory, FileCheck, PageSnapshot, ReportData, RenderCheck } from './types.js';
import { RULESET_VERSION } from './types.js';

const FAILURE_LABELS: Record<FailureCategory, string> = {
  target_unreachable: '대상 사이트 접속 실패',
  dns_error: 'DNS 오류',
  ssl_error: 'SSL 오류',
  server_error: '서버 응답 오류',
  robots_blocked: 'robots 차단',
  scanner_network_restricted: '검사 환경의 외부 네트워크 제한',
  render_failed: '브라우저 렌더링 실패',
  timeout: '타임아웃',
  cache_only_direct_failed: '캐시 정보만 있고 직접 접속 실패',
  non_html: 'HTML이 아닌 응답',
  excluded: '검사 제외 경로',
  security_blocked: '안전하지 않은 목적지 차단',
  unknown: '원인 확인 필요',
};

const RETRY_ACTIONS: Record<FailureCategory, string> = {
  target_unreachable: '사이트 주소와 공개 접속 가능 여부를 확인한 뒤 새 검사를 실행하세요.',
  dns_error: 'DNS가 공개 IP로 확인되는지 점검한 뒤 새 검사를 실행하세요.',
  ssl_error: '대상 사이트의 HTTPS 인증서와 연결 설정을 확인한 뒤 새 검사를 실행하세요.',
  server_error: '기록된 HTTP 상태와 서버 로그를 확인한 뒤 새 검사를 실행하세요.',
  robots_blocked: 'robots.txt의 해당 검사 경로 제한을 확인하세요. 제한을 우회하지 않습니다.',
  scanner_network_restricted: '이 컴퓨터 또는 검사 환경의 외부 네트워크 접근을 확인한 뒤 로컬 검사기를 다시 실행하세요. 사이트 자체 오류로 단정하지 마세요.',
  render_failed: 'HTML 응답과 브라우저 오류를 확인하고 데스크톱·모바일 렌더링을 다시 검사하세요.',
  timeout: '네트워크와 서버 응답 속도를 확인하고 새 검사를 실행하세요.',
  cache_only_direct_failed: '검색 캐시는 직접 방문 근거가 아닙니다. 공개 URL에 직접 연결되는 환경에서 다시 검사하세요.',
  non_html: '검사 URL이 공개 HTML 페이지를 가리키는지 확인하세요.',
  excluded: '검사 제외 경로 설정을 확인하세요.',
  security_blocked: '내부망·예약 주소나 안전하지 않은 리다이렉트가 없는 공개 URL인지 확인하세요.',
  unknown: '상세 오류 기록을 검토하고 네트워크·서버 상태를 확인한 뒤 다시 검사하세요.',
};

function isSuccessfulHttpHtml(page: PageSnapshot): boolean {
  const status = page.http?.statusCode ?? page.statusCode;
  const html = page.http?.htmlCollected ?? Boolean(page.rawHtml);
  return !page.error && status !== null && status >= 200 && status < 300 && html
    && (!page.contentType || /html|xhtml/i.test(page.contentType));
}

function isSuccessfulRender(render: RenderCheck | undefined): boolean {
  return Boolean(render?.success && !render.errorScreen && render.mainTextPresent);
}

export function hasDirectPageEvidence(page: PageSnapshot): boolean {
  return isSuccessfulHttpHtml(page) || isSuccessfulRender(page.desktopRender) || isSuccessfulRender(page.mobileRender);
}

function failureCategory(page: PageSnapshot): FailureCategory | null {
  return page.failureCategory ?? page.http?.failureCategory
    ?? page.desktopRender?.failureCategory ?? page.mobileRender?.failureCategory
    ?? (page.error ? 'unknown' : null);
}

function fileEvidence(file: FileCheck | undefined, fallbackUrl: string | null) {
  return file ? {
    evidenceSource: 'direct-http' as const,
    ...file,
    failureLabel: file.failureCategory ? FAILURE_LABELS[file.failureCategory] : null,
  } : {
    evidenceSource: 'not-recorded' as const,
    url: fallbackUrl,
    finalUrl: null,
    statusCode: null,
    bodyPresent: null,
    responseTimeMs: null,
    redirectChain: [],
    checkedAt: null,
    error: '이 검사 기록에는 기술 파일의 직접 요청 상태가 저장되지 않았습니다.',
    failureCategory: null,
    failureLabel: null,
  };
}

function renderEvidence(render: RenderCheck | undefined, viewport: 'desktop' | 'mobile') {
  return render ? {
    ...render,
    failureLabel: render.failureCategory ? FAILURE_LABELS[render.failureCategory] : null,
    screenshotNote: render.screenshotPath ? '스크린샷은 관리자 컴퓨터에 저장됩니다. ChatGPT에 사용하려면 별도로 첨부하세요.' : null,
  } : {
    viewport,
    attempted: null,
    success: null,
    finalUrl: null,
    statusCode: null,
    title: null,
    mainTextPresent: null,
    errorScreen: null,
    screenshotPath: null,
    error: '이 검사 기록에는 뷰포트별 렌더링 결과가 저장되지 않았습니다.',
    failureCategory: null,
    failureLabel: null,
    screenshotNote: null,
  };
}

/** A compact, auditable handoff for ChatGPT. It never upgrades search/cache data to a direct visit. */
export function buildEvidenceBundle(job: AuditJob, report: ReportData | null = null) {
  const pages = job.pages.map((page) => {
    const category = failureCategory(page);
    const verified = hasDirectPageEvidence(page);
    const http = page.http ? {
      evidenceSource: 'direct-http' as const,
      ...page.http,
      failureLabel: page.http.failureCategory ? FAILURE_LABELS[page.http.failureCategory] : null,
    } : {
      evidenceSource: 'legacy-local-scan' as const,
      requestedUrl: page.url,
      finalUrl: page.finalUrl,
      statusCode: page.statusCode,
      redirectChain: null,
      responseTimeMs: null,
      htmlCollected: Boolean(page.rawHtml),
      checkedAt: page.fetchedAt,
      error: page.error ?? null,
      failureCategory: category,
      failureLabel: category ? FAILURE_LABELS[category] : null,
    };
    return {
      requestedUrl: page.url,
      finalUrl: page.finalUrl,
      fetchedAt: page.fetchedAt,
      directVisitVerified: verified,
      http,
      content: {
        contentType: page.contentType,
        htmlBytes: Buffer.byteLength(page.rawHtml),
        htmlSha256: page.rawHtml ? createHash('sha256').update(page.rawHtml).digest('hex') : null,
        title: page.title,
        lang: page.lang,
        headings: page.headings,
        mainTextLength: page.mainText.length,
        mainTextExcerpt: page.mainText.slice(0, 1800),
        renderLimitations: page.resourceFailures.filter((failure) => failure.startsWith('검사기 제한:')),
        resourceFailures: page.resourceFailures.slice(0, 30),
        javascriptErrors: page.jsErrors.slice(0, 20),
        internalLinkCount: page.links.length,
        representativeLinks: page.links.slice(0, 30),
      },
      render: {
        desktop: renderEvidence(page.desktopRender, 'desktop'),
        mobile: renderEvidence(page.mobileRender, 'mobile'),
      },
      failure: category || page.error ? {
        category: category ?? 'unknown',
        label: FAILURE_LABELS[category ?? 'unknown'],
        detail: page.error ?? page.http?.error ?? page.desktopRender?.error ?? page.mobileRender?.error ?? null,
        retryAction: RETRY_ACTIONS[category ?? 'unknown'],
        scannerEnvironmentIssue: category === 'scanner_network_restricted',
      } : null,
    };
  });
  const directSuccessCount = pages.filter((page) => page.directVisitVerified).length;
  const categories: Partial<Record<FailureCategory, number>> = {};
  for (const page of pages) {
    if (!page.failure) continue;
    categories[page.failure.category] = (categories[page.failure.category] ?? 0) + 1;
  }
  const findings = report?.findings.map((finding) => ({
    id: finding.id, ruleVersion: finding.ruleVersion ?? RULESET_VERSION, pageUrl: finding.pageUrl,
    area: finding.area, title: finding.title, verdict: finding.verdict, weight: finding.weight,
    sourceKind: finding.sourceKind, sourceUrl: finding.sourceUrl, decisionCondition: finding.decisionCondition ?? null,
    appliesTo: finding.appliesTo ?? null, good: finding.good, bad: finding.bad, why: finding.why,
    evidence: finding.evidence, action: finding.action,
  })) ?? [];
  const score = report?.score ?? null;
  const scoreHeld = job.status !== 'complete' || !score || directSuccessCount === 0 || score.value === null;
  const scoreHoldReason = directSuccessCount === 0
    ? '실제 직접 접속으로 HTML 또는 본문이 있는 브라우저 화면을 확인한 페이지가 0건입니다. 검색 결과·캐시만으로 점수를 계산하지 않습니다.'
    : job.status !== 'complete' ? '검사가 아직 완료되지 않았습니다.' : score?.holdReason ?? null;
  const files = job.signals?.technicalFiles;
  return {
    schemaVersion: '2026-09-29-1',
    rulesetVersion: RULESET_VERSION,
    evidenceSource: 'administrator-local-direct-scan',
    generatedAt: new Date().toISOString(),
    guidance: '이 JSON은 로컬 검사기가 저장한 직접 요청·렌더링 관찰 기록입니다. 검색 색인이나 캐시 결과는 직접 방문 성공으로 바꾸어 해석하지 마세요. 미기록은 성공 또는 실패가 아닙니다. renderLimitations가 있으면 화면이 열렸어도 주요 데이터나 자원이 빠졌을 수 있으므로 본문·메뉴·모바일 관련 부재를 사이트 결함으로 단정하지 마세요.',
    scan: {
      id: job.id, recheckOfJobId: job.recheckOfJobId ?? null,
      targetUrl: job.inputUrl, rootUrl: job.rootUrl, mode: job.mode, limit: job.limit,
      status: job.status, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
      excludedPaths: job.excludedPaths, error: job.error,
      discoveryError: job.signals?.discoveryError ?? null,
      discoveryFailureCategory: job.signals?.discoveryFailureCategory ?? null,
      discoveryRetryAction: job.signals?.discoveryFailureCategory
        ? RETRY_ACTIONS[job.signals.discoveryFailureCategory] : null,
      discoveredUrlCount: job.discovered.length, attemptedUrlCount: job.pages.length,
      directSuccessUrlCount: directSuccessCount,
      directHttpHtmlSuccessCount: job.pages.filter(isSuccessfulHttpHtml).length,
      failedOrUnverifiedUrlCount: job.pages.length - directSuccessCount,
      failureCategoryCounts: categories,
      discoveredUrls: job.discovered,
    },
    technicalFiles: {
      robots: fileEvidence(files?.robots, job.signals?.robotsUrl ?? null),
      sitemap: fileEvidence(files?.sitemap, job.signals ? new URL('/sitemap.xml', job.rootUrl).href : null),
      ads: fileEvidence(files?.ads, job.signals?.adsTxtUrl ?? null),
    },
    pages,
    score: {
      value: scoreHeld ? null : score.value,
      unofficialReadinessIndexPercent: scoreHeld ? null : score.percentage,
      calculation: 'S = 100 × E ÷ W; only measured weight contributes. Unknown U is excluded.',
      holdReason: scoreHeld ? scoreHoldReason : null,
      verifiedRuleCount: score?.ruleScores.filter((row) => row.measuredWeight > 0).length ?? 0,
      totalRuleCount: score?.ruleScores.length ?? 0,
      measuredWeight: score?.measuredWeight ?? 0,
      applicableWeight: score?.applicableWeight ?? 0,
      unknownWeight: score?.unknownWeight ?? 0,
      verificationRate: score?.verificationRate ?? null,
      possibleMin: scoreHeld ? null : score?.possibleMin ?? null,
      possibleMax: scoreHeld ? null : score?.possibleMax ?? null,
      ruleScores: score?.ruleScores ?? [],
      caveat: '비공식 승인 가능성 추정 지수는 채점기 자체 진단 수치이며 Google의 실제 승인 확률이 아닙니다.',
    },
    findings,
  };
}

export function failureLabel(category: FailureCategory | undefined): string {
  return category ? FAILURE_LABELS[category] : '원인 미기록';
}

export function retryAction(category: FailureCategory | undefined): string {
  return RETRY_ACTIONS[category ?? 'unknown'];
}

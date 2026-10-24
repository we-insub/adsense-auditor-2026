import { RULESET_VERSION, type Area, type Finding, type PageSnapshot, type RuleScore, type ScoreResult, type SiteSignals, type SourceKind, type Verdict } from './types.js';

type ScoredArea = Exclude<Area, 'technical' | 'manual'>;
type PageKind = 'home' | 'article' | 'utility' | 'media';

interface Rule {
  area: Area;
  title: string;
  weight: number;
  sourceKind: SourceKind;
  sourceUrl: string;
  why: string;
  action: string;
}

// Rule IDs and weights form the versioned score contract. SourceKind describes the
// *actual test*, not merely the provenance of a related help article.
export const RULES: Readonly<Record<string, Rule>> = {
  'content.placeholder': { area: 'content', title: '미완성 문구', weight: 8, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/adsense/answer/81904?hl=ko', why: '공개 페이지의 템플릿 문구는 방문자에게 미완성 콘텐츠로 보일 수 있습니다. 문자열 자동 탐지는 문맥 검토가 필요합니다.', action: '실제 본문을 완성하고 샘플·임시 문구를 제거하세요.' },
  'content.empty': { area: 'content', title: '빈 본문·제목뿐인 페이지', weight: 8, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/publisherpolicies/answer/11112688?hl=ko', why: '내용이 없는 화면이나 미완성 화면에 Google 게재 광고를 표시하는 것은 정책상 제한됩니다. 이 검사는 본문 길이로 의심 화면을 찾는 자체 기준입니다.', action: '페이지 목적에 맞는 본문을 추가하거나 불필요한 빈 페이지를 정리하세요.' },
  'content.substance': { area: 'content', title: '페이지 유형에 맞는 실질 콘텐츠', weight: 8, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/adsense/answer/9724?hl=ko', why: '사용자에게 유용한 고유 콘텐츠가 중요합니다. 글자 수 기준은 Google 공식 승인 기준이 아닌 채점기 자체 기준입니다.', action: '질문에 답하는 구체적 설명, 실제 경험, 근거와 맥락을 보강하세요.' },
  'content.duplicate': { area: 'content', title: '사이트 내부 중복', weight: 6, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls', why: '비슷한 본문이 여러 URL에 있으면 각각의 페이지 목적이 불분명해질 수 있습니다. 사이트 내부 유사도만 검사하며 외부 표절 여부는 판단하지 않습니다.', action: '중복 페이지를 통합하거나 각 페이지에 고유한 정보를 추가하고 canonical을 점검하세요.' },
  'content.media': { area: 'content', title: '영상·이미지·제휴 콘텐츠의 자체 설명', weight: 6, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/publisherpolicies/answer/11190248?hl=ko', why: '미디어나 제휴 링크만으로 페이지의 고유 가치를 확인하기 어렵습니다. 이미지·영상 자체의 품질은 자동 판정하지 않습니다.', action: '직접 작성한 설명, 선택 이유, 사용 경험과 출처를 덧붙이세요.' },
  'content.promotion': { area: 'content', title: '광고·홍보와 게시자 콘텐츠의 균형', weight: 4, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/publisherpolicies/answer/11169917?hl=ko', why: 'Google은 게시자 콘텐츠보다 광고·유료 홍보가 많은 화면의 광고 게재를 제한합니다. 요소 수와 본문 길이의 비교는 화면 면적을 재지 않은 자체 경고입니다.', action: '광고·홍보 배치를 줄이고 사용자가 찾는 본문을 충분히 제공하세요.' },
  'navigation.links': { area: 'navigation', title: '검사 범위의 내부 링크 오류', weight: 6, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable', why: '깨진 내부 링크는 사용자 탐색을 방해합니다. 실제로 검사한 대상 URL의 실패만 확정하며 미검사 링크는 단정하지 않습니다.', action: '실패한 링크를 유효한 페이지로 고치거나 제거하세요.' },
  'navigation.menu': { area: 'navigation', title: '메뉴와 주요 페이지 접근성', weight: 5, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable', why: '탐색 링크가 있어야 방문자와 크롤러가 주요 페이지를 찾기 쉽습니다. 이 검사는 링크 목록만 확인합니다.', action: '홈과 주요 콘텐츠·안내 페이지를 명확한 메뉴로 연결하세요.' },
  'navigation.redirect': { area: 'navigation', title: '반복 리다이렉트', weight: 4, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/301-redirects', why: '긴 리다이렉트 체인은 접근을 지연하거나 실패 가능성을 높입니다. 한 번의 정상적인 이동은 문제로 보지 않습니다.', action: '내부 링크가 최종 URL을 직접 가리키도록 수정하세요.' },
  'navigation.mobile': { area: 'navigation', title: '모바일 넘침·팝업', weight: 5, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/appearance/avoid-intrusive-interstitials', why: '가로 넘침과 과도한 팝업은 작은 화면에서 콘텐츠 이용을 어렵게 합니다. 자동 검사는 가려진 영역의 맥락을 완전히 판정하지 못합니다.', action: '모바일 너비를 수정하고 필수 정보·본문을 가리는 팝업을 줄이세요.' },
  'access.response': { area: 'access', title: '공개 페이지 응답', weight: 5, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/adsense/answer/7584263?hl=ko', why: '공개 페이지를 읽을 수 있어야 방문자와 심사 크롤러가 내용을 확인할 수 있습니다. 일시적인 차단·서버 장애는 재검사가 필요합니다.', action: 'HTTP 상태와 서버·보안 설정을 점검해 페이지가 공개적으로 열리도록 하세요.' },
  'access.robots': { area: 'access', title: 'AdSense 크롤러의 robots 접근', weight: 4, sourceKind: 'official', sourceUrl: 'https://support.google.com/adsense/answer/10532?hl=ko', why: 'Google은 Mediapartners-Google이 robots.txt로 차단되면 사이트에 광고를 게재할 수 없다고 안내합니다.', action: 'robots.txt에서 AdSense 크롤러 차단 규칙을 제거하고 다시 확인하세요.' },
  'access.render': { area: 'access', title: '화면 렌더링·주요 자원 오류', weight: 3, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/adsense/answer/7584263?hl=ko', why: '브라우저 오류나 자원 실패가 많으면 실제 화면이 불완전할 수 있습니다. 모든 콘솔 오류가 사용자 문제를 뜻하지는 않습니다.', action: '콘솔 오류와 실패한 주요 자원을 재현해 필요한 파일을 복구하세요.' },
  'access.indexing': { area: 'access', title: 'noindex·canonical 일관성', weight: 3, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls', why: 'noindex와 다른 URL을 가리키는 canonical은 검색 노출 의도와 다를 수 있습니다. 설정 자체가 AdSense 위반이라는 뜻은 아닙니다.', action: '페이지의 색인 의도와 canonical 대상을 확인하고 필요하면 수정하세요.' },
  'trust.privacy': { area: 'trust', title: '개인정보·광고 쿠키 안내', weight: 7, sourceKind: 'recommendation', sourceUrl: 'https://support.google.com/adsense/answer/1348695?hl=ko', why: 'AdSense 게시자는 개인정보처리방침에서 Google 광고 쿠키 사용 등을 알릴 필요가 있습니다. 링크 존재만으로 문서의 법적 충분성을 확인할 수는 없습니다.', action: '방문자가 찾기 쉬운 개인정보처리방침과 실제 광고·쿠키 사용 안내를 준비하세요.' },
  'trust.identity': { area: 'trust', title: '소개·연락 수단', weight: 4, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/adsense/answer/9724?hl=ko', why: '운영자 소개와 연락 경로는 이용자가 사이트를 이해하고 문의하는 데 도움이 됩니다. Google의 필수 페이지 목록으로 주장하지 않습니다.', action: '사이트 목적·운영자 소개와 실제 사용할 수 있는 연락 경로를 연결하세요.' },
  'trust.notice': { area: 'trust', title: '안내 링크의 명확성', weight: 4, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable', why: '이름이 없는 링크나 찾기 어려운 안내는 사용자가 정책·문의 정보를 확인하는 데 방해가 됩니다. 링크 텍스트 자동 판정은 수동 확인이 필요합니다.', action: '중요한 안내 링크에 이해할 수 있는 텍스트나 대체 이름을 제공하세요.' },
  'adsense.connection': { area: 'adsense', title: 'AdSense 사이트 연결 흔적', weight: 7, sourceKind: 'recommendation', sourceUrl: 'https://support.google.com/adsense/answer/12131223?hl=ko', why: 'AdSense는 광고 코드, ads.txt 또는 계정 메타 태그로 사이트 소유를 확인할 수 있습니다. 공개 파일에 흔적이 없어도 계정의 실제 상태를 알 수 없으며 ads.txt는 필수가 아닙니다.', action: 'AdSense 계정의 사이트 연결 안내를 확인하고 선택한 방식의 코드·메타 태그·ads.txt를 점검하세요.' },
  'adsense.emptyAds': { area: 'adsense', title: '콘텐츠 없는 화면의 광고', weight: 3, sourceKind: 'official', sourceUrl: 'https://support.google.com/publisherpolicies/answer/11112688?hl=ko', why: 'Google은 게시자 콘텐츠가 없거나 미완성인 화면에 Google 게재 광고를 허용하지 않습니다. 광고 요소의 공급자와 실제 노출은 관리자 확인이 필요합니다.', action: '내용이 없는 화면에서 광고를 제거하거나 페이지 본문을 완성하세요.' },
  'technical.title': { area: 'technical', title: 'HTML title', weight: 0, sourceKind: 'recommendation', sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link', why: '설명적인 제목은 검색 결과와 브라우저 탐색에 도움을 줍니다. 누락만으로 AdSense 위반이라고 보지 않습니다.', action: '페이지마다 내용을 설명하는 고유한 title을 작성하세요.' },
  'technical.description': { area: 'technical', title: 'meta description', weight: 0, sourceKind: 'recommendation', sourceUrl: 'https://developers.google.com/search/docs/appearance/snippet', why: '설명 문구는 검색 결과 스니펫 생성에 참고될 수 있습니다. 누락만으로 AdSense 위반이라고 보지 않습니다.', action: '페이지의 핵심 내용을 자연스러운 한두 문장으로 설명하세요.' },
  'technical.heading': { area: 'technical', title: '본문 제목 구조', weight: 0, sourceKind: 'heuristic', sourceUrl: 'https://developers.google.com/search/docs/appearance/title-link', why: '명확한 제목 구조는 내용을 파악하기 쉽게 합니다. 특정 H1 개수는 AdSense 승인 조건이 아닙니다.', action: '본문의 대표 제목을 명확히 표시하고 제목 순서를 점검하세요.' },
  'technical.alt': { area: 'technical', title: '이미지 대체 텍스트', weight: 0, sourceKind: 'recommendation', sourceUrl: 'https://developers.google.com/search/docs/appearance/google-images', why: '의미 있는 이미지의 대체 텍스트는 접근성과 이미지 이해에 도움이 됩니다. 장식 이미지는 빈 alt가 적절할 수도 있습니다.', action: '의미 있는 이미지에는 문맥에 맞는 alt를 작성하고 장식 이미지는 수동으로 구분하세요.' },
  'technical.lang': { area: 'technical', title: 'HTML 언어 표시', weight: 0, sourceKind: 'heuristic', sourceUrl: 'https://www.w3.org/International/questions/qa-html-language-declarations', why: '문서 언어를 표시하면 보조 기술의 발음과 언어 처리가 좋아집니다. 누락만으로 AdSense 위반이라고 보지 않습니다.', action: 'HTML lang에 실제 페이지 언어를 지정하세요.' },
  'technical.https': { area: 'technical', title: 'HTTPS·혼합 콘텐츠', weight: 0, sourceKind: 'heuristic', sourceUrl: 'https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content', why: '보안 연결과 자원 로딩 상태는 방문자 신뢰와 화면 완성도에 영향을 줍니다.', action: 'HTTPS를 사용하고 HTTP로 불러오는 실행·표시 자원을 수정하세요.' },
  'manual.adClick': { area: 'manual', title: '광고 클릭 유도 문구 수동 확인', weight: 0, sourceKind: 'official', sourceUrl: 'https://support.google.com/adsense/answer/1346295?hl=ko', why: 'Google은 광고 클릭을 고의로 유도하는 표현을 금지합니다. 자동 감지는 광고와의 관계·맥락을 확정하지 못합니다.', action: '실제 화면에서 문구와 광고 배치를 확인하고 클릭 유도라면 제거하세요.' },
  'manual.external': { area: 'manual', title: '계정·권리·심사 상태 수동 확인', weight: 0, sourceKind: 'heuristic', sourceUrl: 'https://support.google.com/adsense/answer/12170222?hl=ko', why: '외부 저작물과의 표절, 계정 중복·결제·연령·실제 심사 상태는 공개 URL만으로 확인할 수 없습니다.', action: '사이트 소유자가 자신의 계정 및 콘텐츠 권리 상태를 직접 확인하세요.' },
};

// Stored with every finding in the administrator JSON. These are our explicit
// detection conditions, not minimum requirements published by Google.
export const RULE_CONDITIONS: Readonly<Record<string, { appliesTo: string; condition: string }>> = {
  'content.placeholder': { appliesTo: '모든 HTML 페이지', condition: '원본의 보이는 텍스트 또는 렌더링 본문에 대표적인 임시 문구가 있는지 검사. input placeholder 속성은 제외.' },
  'content.empty': { appliesTo: '모든 HTML 페이지', condition: '본문 20자 미만 또는 오류 페이지 표현은 문제, 페이지 유형별 짧은 본문은 주의.' },
  'content.substance': { appliesTo: '홈·글·안내·미디어 페이지', condition: '페이지 유형별 자체 본문 길이 구간으로 양호·주의·문제를 구분.' },
  'content.duplicate': { appliesTo: '본문 160자 이상인 안내 페이지 외 HTML', condition: '동일 언어의 검사된 페이지와 본문 유사도 0.88 이상 주의, 0.98 이상 문제.' },
  'content.media': { appliesTo: '영상·이미지 중심 또는 제휴 신호가 있는 HTML', condition: '자체 설명 본문 250자 이상 양호, 90자 이상 주의, 그 미만 문제.' },
  'content.promotion': { appliesTo: '모든 HTML 페이지', condition: '광고 요소가 3개 이상이고 본문 100자 미만이면 문제, 2개 이상이고 250자 미만이면 주의.' },
  'navigation.links': { appliesTo: '내부 링크가 있는 HTML 페이지', condition: '이번 검사에서 확인한 내부 링크 대상의 HTTP 404/410 여부만 결함 판정.' },
  'navigation.menu': { appliesTo: '모든 HTML 페이지', condition: '메뉴 URL 2개 이상 양호, 1개 주의, 없으면 문제.' },
  'navigation.redirect': { appliesTo: '모든 HTML 페이지', condition: '리다이렉트 4회 이상 문제, 2~3회 주의, 0~1회 양호.' },
  'navigation.mobile': { appliesTo: '모든 HTML 페이지', condition: '모바일 가로 넘침은 문제, 데스크톱 넘침 또는 팝업 2개 이상은 주의.' },
  'access.response': { appliesTo: '검사한 모든 URL', condition: '정상 공개 응답은 양호, 확정 404/410은 문제, 일시적 오류·차단은 확인 불가.' },
  'access.robots': { appliesTo: '사이트 전체', condition: 'robots.txt의 Mediapartners-Google 루트 경로 허용 여부를 판정.' },
  'access.render': { appliesTo: '모든 HTML 페이지', condition: '렌더링 본문 누락 또는 오류 5건 이상은 문제, 1~4건은 주의.' },
  'access.indexing': { appliesTo: '모든 HTML 페이지', condition: 'noindex 또는 다른 canonical URL이 있으면 의도 확인을 위한 주의.' },
  'trust.privacy': { appliesTo: '사이트 전체', condition: '개인정보 링크와 쿠키·광고 문구, 미래형 안내 표현 및 현재 광고 신호를 조합해 판정. 미래형 안내만 있고 현재 광고 신호가 없으면 확인 불가.' },
  'trust.identity': { appliesTo: '사이트 전체', condition: '소개 및 연락 링크 모두 있으면 양호, 하나만 있으면 주의.' },
  'trust.notice': { appliesTo: '사이트 전체', condition: '안내 링크 존재와 이름 없는 링크 수로 판정.' },
  'adsense.connection': { appliesTo: '사이트 전체', condition: '광고 코드·계정 메타·유효한 Google ads.txt 행 중 하나라도 있으면 연결 흔적 양호.' },
  'adsense.emptyAds': { appliesTo: '모든 HTML 페이지', condition: '본문 없는 화면 또는 오류 화면에 광고 요소가 감지되면 문제.' },
  'technical.title': { appliesTo: '모든 HTML 페이지', condition: 'title 내용이 비어 있는지 검사하며 점수에는 반영하지 않음.' },
  'technical.description': { appliesTo: '모든 HTML 페이지', condition: 'meta description 내용이 비어 있는지 검사하며 점수에는 반영하지 않음.' },
  'technical.heading': { appliesTo: '모든 HTML 페이지', condition: '제목 요소가 있는지 검사하며 점수에는 반영하지 않음.' },
  'technical.alt': { appliesTo: '이미지가 있는 HTML 페이지', condition: 'alt 속성이 없는 이미지 수를 제시하며 점수에는 반영하지 않음.' },
  'technical.lang': { appliesTo: '모든 HTML 페이지', condition: 'HTML lang 값이 있는지 검사하며 점수에는 반영하지 않음.' },
  'technical.https': { appliesTo: '모든 HTML 페이지', condition: 'HTTPS 및 원본 HTML의 HTTP 하위 자원 신호를 검사하며 점수에는 반영하지 않음.' },
  'manual.adClick': { appliesTo: '광고 클릭 유도 문구 신호가 있는 페이지', condition: '문구를 찾아 관리자 확인 항목으로 표시하고 자동 확정하지 않음.' },
  'manual.external': { appliesTo: '사이트 전체', condition: '계정·권리·실제 심사 상태는 공개 URL로 판정하지 않고 관리자 확인으로 표시.' },
};

const areaMaximums: Record<ScoredArea, number> = {
  content: 40,
  navigation: 20,
  access: 15,
  trust: 15,
  adsense: 10,
};

function short(value: string, limit = 180): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function finding(id: string, pageUrl: string, verdict: Verdict, evidence: string, good: string, bad: string, overrides?: Partial<Pick<Finding, 'action' | 'why'>>): Finding {
  const rule = RULES[id];
  if (!rule) throw new Error(`Unknown rule: ${id}`);
  const metadata = RULE_CONDITIONS[id];
  if (!metadata) throw new Error(`Rule condition missing: ${id}`);
  return {
    id,
    ruleVersion: RULESET_VERSION,
    appliesTo: metadata.appliesTo,
    decisionCondition: metadata.condition,
    area: rule.area,
    title: rule.title,
    verdict,
    sourceKind: rule.sourceKind,
    sourceUrl: rule.sourceUrl,
    pageUrl,
    good,
    bad,
    why: overrides?.why ?? rule.why,
    evidence: short(evidence, id === 'trust.privacy' ? 420 : 180),
    action: overrides?.action ?? rule.action,
    weight: rule.weight,
  };
}

function isHtml(page: PageSnapshot): boolean {
  return !page.error && page.statusCode !== null && page.statusCode >= 200 && page.statusCode < 300 && (!page.contentType || /html|xhtml/i.test(page.contentType));
}

function main(page: PageSnapshot): string {
  return (page.mainText || '').replace(/\s+/g, ' ').trim();
}

function visibleRawText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:nav|header|footer|aside|a)\b[^>]*>[\s\S]*?<\/\s*(?:nav|header|footer|aside|a)\s*>/gi, ' ')
    .replace(/<(?:script|style|template|textarea|select|option)\b[^>]*>[\s\S]*?<\/\s*(?:script|style|template|textarea|select|option)\s*>/gi, ' ')
    .replace(/<input\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pageKind(page: PageSnapshot): PageKind {
  let pathname = '';
  try { pathname = new URL(page.finalUrl || page.url).pathname.toLowerCase(); } catch { /* inspection may contain an invalid final URL */ }
  if (pathname === '/' || pathname === '') return 'home';
  if (/(^|\/)(about|contact|privacy|policy|terms|disclaimer|faq|search|category|tag|archive|소개|문의|개인정보|이용약관)(\/|$)/i.test(decodeURIComponentSafe(pathname))) return 'utility';
  if (/(^|\/)(video|gallery|photo|media|영상|사진)(\/|$)/i.test(decodeURIComponentSafe(pathname))) return 'media';
  return 'article';
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    // Meaningful query parameters distinguish real pages (for example
    // /article?id=1 from /article?id=2). Only tracking parameters are removed.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return null; }
}

function language(page: PageSnapshot): string {
  if (page.lang.trim()) return page.lang.toLowerCase().split('-')[0];
  try {
    const segment = new URL(page.finalUrl || page.url).pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (segment && /^[a-z]{2}$/.test(segment)) return segment;
  } catch { /* use und */ }
  return 'und';
}

function shingles(text: string): Set<string> {
  const compact = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const result = new Set<string>();
  for (let i = 0; i <= compact.length - 8; i += 4) result.add(compact.slice(i, i + 8));
  return result;
}

function similarity(aa: Set<string>, bb: Set<string>): number {
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const item of aa) if (bb.has(item)) common++;
  return common / (aa.size + bb.size - common);
}

function hashShingle(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

function duplicateMatches(accessible: PageSnapshot[]): Map<PageSnapshot, { other: PageSnapshot; score: number }> {
  const records = accessible
    .filter((page) => main(page).length >= 160 && pageKind(page) !== 'utility')
    .map((page) => {
      const text = main(page);
      const grams = shingles(text);
      const sample = [...grams].map(hashShingle).sort((a, b) => a - b).slice(0, 6);
      return { page, text, grams, sample, lang: language(page) };
    });
  const buckets = new Map<string, number[]>();
  const matches = new Map<PageSnapshot, { other: PageSnapshot; score: number }>();
  for (let i = 0; i < records.length; i++) {
    const current = records[i];
    const keys = current.sample.map((hash) => `${current.lang}:${hash}`);
    const candidates = new Set<number>();
    for (const key of keys) for (const index of buckets.get(key) ?? []) candidates.add(index);
    for (const index of candidates) {
      const other = records[index];
      if (Math.min(current.text.length, other.text.length) / Math.max(current.text.length, other.text.length) < 0.8) continue;
      const score = current.text === other.text ? 1 : similarity(current.grams, other.grams);
      if (score < 0.88) continue;
      if (!matches.has(current.page) || matches.get(current.page)!.score < score) matches.set(current.page, { other: other.page, score });
      if (!matches.has(other.page) || matches.get(other.page)!.score < score) matches.set(other.page, { other: current.page, score });
    }
    for (const key of keys) {
      const bucket = buckets.get(key) ?? [];
      bucket.push(i);
      buckets.set(key, bucket);
    }
  }
  return matches;
}

function containsPlaceholder(page: PageSnapshot): string | null {
  // Link labels often describe an unfinished *destination*; they do not make
  // the linking page unfinished. Use rendered prose and visible raw prose.
  const prose = page.mainProseText === undefined
    ? (page.rawHtml ? visibleRawText(page.rawHtml) : main(page))
    : page.mainProseText;
  const combined = `${prose} ${visibleRawText(page.rawHtml || '')}`;
  const patterns = [
    /lorem\s+ipsum(?:\s+dolor)?/i,
    /(?:^|\s)(?:TODO|TBD)(?:\s|:|$)/,
    /(?:준비\s*중|작성\s*중|내용을\s*입력|여기에\s*(?:본문|내용|텍스트))/i,
    /(?:your\s+text\s+here|insert\s+(?:text|content)\s+here|sample\s+(?:text|page)|coming\s+soon)/i,
  ];
  return patterns.map((pattern) => combined.match(pattern)?.[0]).find(Boolean) ?? null;
}

function firstPartyResourceFailures(page: PageSnapshot): string[] {
  let host: string;
  try { host = new URL(page.finalUrl || page.url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return []; }
  return page.resourceFailures.filter((failure) => {
    if (/robots\.txt|크롤링을 제한|요청 제한|용량 제한|리소스 용량 제한/i.test(failure)) return false;
    const url = /https?:\/\/[^\s]+/i.exec(failure)?.[0]?.replace(/:$/, '');
    if (!url) return false;
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() === host; }
    catch { return false; }
  });
}

function renderLimitedByScanner(page: PageSnapshot): boolean {
  return page.resourceFailures.some((failure) => failure.startsWith('검사기 제한:'));
}

function isSoft404(text: string): boolean {
  return /(?:404\s*(?:not\s*found|error)|page\s+not\s+found|페이지를\s+찾을\s+수\s+없|존재하지\s+않는\s+페이지)/i.test(text.slice(0, 500));
}

function emptyAnchorCount(html: string): number {
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  return anchors.filter((anchor) => {
    const inside = anchor.replace(/^<a\b[^>]*>/i, '').replace(/<\/a>$/i, '');
    const text = inside.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
    return !text && !/aria-label\s*=\s*["'][^"']+["']/i.test(anchor) && !/<img\b[^>]*\balt\s*=\s*["'][^"']+["']/i.test(anchor);
  }).length;
}

function validAdsTxt(text: string | null): boolean {
  if (!text) return false;
  return text.split(/\r?\n/).some((line) => /^\s*google\.com\s*,\s*pub-\d{16}\s*,\s*DIRECT\s*,\s*f08c47fec0942fa0(?:\s*(?:#.*)?)?$/i.test(line));
}

function evaluatePage(page: PageSnapshot, accessible: PageSnapshot[], byUrl: Map<string, PageSnapshot>, duplicates: Map<PageSnapshot, { other: PageSnapshot; score: number }>): Finding[] {
  const url = page.finalUrl || page.url;
  const output: Finding[] = [];
  const add = (id: string, verdict: Verdict, evidence: string, good: string, bad: string, overrides?: Partial<Pick<Finding, 'action' | 'why'>>) => output.push(finding(id, url, verdict, evidence, good, bad, overrides));
  const html = isHtml(page);
  const desktopUnverified = page.desktopRender?.success !== true;
  const mobileUnverified = page.mobileRender?.success !== true;
  const bodyUnverified = desktopUnverified && mobileUnverified || renderLimitedByScanner(page);
  const bodyReason = renderLimitedByScanner(page) ? '검사기 제한으로 화면 일부 미확인' : '브라우저 렌더링 실패';
  const text = main(page);
  const kind = pageKind(page);
  const length = text.length;

  if (!html) {
    for (const id of ['content.placeholder', 'content.empty', 'content.substance', 'content.duplicate', 'content.media', 'content.promotion', 'navigation.links', 'navigation.menu', 'navigation.redirect', 'navigation.mobile', 'access.render', 'access.indexing', 'adsense.emptyAds']) {
      add(id, 'unknown', page.error || `HTTP ${page.statusCode ?? '미확인'} · ${page.contentType || '콘텐츠 유형 미확인'}`, '', '페이지 내용을 확인하지 못했습니다.');
    }
  } else {
    const placeholder = containsPlaceholder(page);
    add('content.placeholder', placeholder ? (length < 300 || /lorem\s+ipsum/i.test(placeholder) ? 'issue' : 'caution') : bodyUnverified ? 'unknown' : 'good', placeholder ? `본문/원본에서 "${placeholder}" 발견` : bodyUnverified ? `원본 HTML은 확보했지만 ${bodyReason} 상태여서 보이는 본문의 미완성 문구는 미확인입니다.` : '보이는 본문에서 대표적인 임시 문구가 발견되지 않았습니다.', placeholder || bodyUnverified ? '' : '임시 문구 없이 작성된 내용이 확인됩니다.', placeholder ? '템플릿 또는 미완성 문구로 보이는 표현이 있습니다. 문맥 확인이 필요합니다.' : bodyUnverified ? `${bodyReason} 상태여서 화면 문구를 확인하지 못했습니다.` : '');

    const soft404 = isSoft404(text);
    const emptyVerdict: Verdict = bodyUnverified ? 'unknown' : soft404 || length < 20 ? 'issue' : length < (kind === 'article' ? 70 : 30) ? 'caution' : 'good';
    add('content.empty', emptyVerdict, bodyUnverified ? `원본 HTML 수집 성공 · ${bodyReason}` : `본문 ${length}자${soft404 ? ' · 오류 페이지 표현 감지' : ''}`, emptyVerdict === 'good' ? '페이지 목적을 설명할 본문이 있습니다.' : '', emptyVerdict === 'good' ? '' : bodyUnverified ? '완전한 화면을 확인하지 못해 빈 페이지로 판정하지 않았습니다.' : '본문이 비었거나 지나치게 짧아 실제 화면을 확인해야 합니다.');

    const thresholds: Record<PageKind, [number, number]> = { home: [100, 45], article: [350, 120], utility: [80, 25], media: [120, 40] };
    const [goodMin, cautionMin] = thresholds[kind];
    const substanceVerdict: Verdict = bodyUnverified ? 'unknown' : length >= goodMin ? 'good' : length >= cautionMin ? 'caution' : 'issue';
    add('content.substance', substanceVerdict, bodyUnverified ? `${kind} 유형 · ${bodyReason}` : `${kind} 유형 · 본문 ${length}자 · 자체 기준 ${goodMin}자`, substanceVerdict === 'good' ? '페이지 유형에 맞는 설명량이 확인됩니다.' : '', substanceVerdict === 'good' ? '' : bodyUnverified ? '완전한 본문 길이를 확인하지 못해 실질 콘텐츠를 판정하지 않았습니다.' : '페이지 목적을 이해할 상세한 설명이 부족할 수 있습니다.');

    if (bodyUnverified) {
      add('content.duplicate', 'unknown', bodyReason, '', '다른 페이지와 비교할 본문을 확인하지 못했습니다.');
    } else if (length < 160 || kind === 'utility') {
      add('content.duplicate', 'na', `비교 대상 제외: ${kind} 유형 또는 본문 ${length}자`, '', '짧은 안내 페이지의 유사도는 신뢰성 있게 판정하기 어렵습니다.');
    } else {
      const duplicate = duplicates.get(page);
      const verdict: Verdict = duplicate ? duplicate.score >= 0.98 ? 'issue' : 'caution' : 'good';
      add('content.duplicate', verdict, duplicate ? `유사 페이지 ${duplicate.other.finalUrl || duplicate.other.url} · 자체 유사도 ${Math.round(duplicate.score * 100)}%` : `동일 언어 검사 페이지 ${accessible.filter((other) => language(other) === language(page) && other !== page).length}개와 비교`, verdict === 'good' ? '검사한 동일 언어 페이지 중 높은 본문 중복이 발견되지 않았습니다.' : '', verdict === 'good' ? '' : '다른 내부 페이지와 본문이 매우 비슷합니다.');
    }

    const affiliate = /(?:affiliate|aff_id|partner|ref=|쿠팡\s*파트너스|제휴\s*링크)/i.test(`${page.links.join(' ')} ${text.slice(0, 1000)}`);
    const mediaFocused = page.mediaCount > 0 || (kind === 'media' && page.imageCount > 0) || affiliate;
    if (bodyUnverified) add('content.media', 'unknown', bodyReason, '', '미디어 중심 여부와 자체 설명을 판정하지 못했습니다.');
    else if (!mediaFocused) add('content.media', 'na', '영상·이미지 중심 또는 제휴 콘텐츠 신호가 없습니다.', '', '이 항목은 해당 콘텐츠가 있는 페이지만 적용합니다.');
    else {
      const verdict: Verdict = length >= 250 ? 'good' : length >= 90 ? 'caution' : 'issue';
      add('content.media', verdict, `영상 ${page.mediaCount}개 · 이미지 ${page.imageCount}개 · 제휴 신호 ${affiliate ? '있음' : '없음'} · 본문 ${length}자`, verdict === 'good' ? '미디어와 함께 설명하는 본문이 있습니다.' : '', verdict === 'good' ? '' : '미디어·제휴 정보에 비해 직접 작성한 설명이 짧습니다.');
    }

    const ads = page.adElementCount;
    const promotionVerdict: Verdict = bodyUnverified ? 'unknown' : ads >= 3 && length < 100 ? 'issue' : ads >= 2 && length < 250 ? 'caution' : 'good';
    add('content.promotion', promotionVerdict, bodyUnverified ? `화면의 콘텐츠·광고 배치 미확인 · ${bodyReason}` : `감지 광고 요소 ${ads}개 · 본문 ${length}자`, promotionVerdict === 'good' ? '광고 요소 수와 본문 길이에서 즉각적인 과밀 신호가 없습니다.' : '', promotionVerdict === 'good' ? '' : bodyUnverified ? '완전한 화면 확인 전 광고 비중을 판정하지 않았습니다.' : '광고 요소가 짧은 본문에 비해 많아 보입니다. 실제 면적과 유료 홍보를 확인해야 합니다.');

    const linkUrls = [...new Set([...page.links, ...page.navLinks].map((item) => normalizeUrl(item, url)).filter((item): item is string => !!item))];
    const checkedLinks = linkUrls.map((item) => byUrl.get(item)).filter((item): item is PageSnapshot => !!item);
    const confirmedLinks = checkedLinks.filter((item) => item.failureCategory !== 'cache_only_direct_failed'
      && item.statusCode !== null && ((item.statusCode >= 200 && item.statusCode < 300 && !item.error)
        || item.statusCode === 404 || item.statusCode === 410));
    const failedLinks = confirmedLinks.filter((item) => item.statusCode === 404 || item.statusCode === 410);
    const goodLinks = confirmedLinks.filter((item) => item.statusCode !== 404 && item.statusCode !== 410);
    const linkVerdict: Verdict = failedLinks.length ? 'issue' : linkUrls.length > 0 && goodLinks.length === linkUrls.length ? 'good' : 'unknown';
    const linkUncertainty = !linkUrls.length
      ? '이 페이지에서 내부 링크를 발견하지 못해 대상 상태를 판정할 수 없습니다.'
      : checkedLinks.length === 0
        ? '내부 링크 대상이 검사 범위에 없어 정상 여부를 판정할 수 없습니다.'
        : '방문하지 않았거나 직접 접속 결과가 불확실한 내부 링크 대상이 남아 있어 정상 여부를 확정할 수 없습니다.';
    add('navigation.links', linkVerdict, failedLinks.length ? `실패 대상: ${failedLinks.slice(0, 3).map((item) => item.finalUrl || item.url).join(', ')}` : `이 페이지의 확인된 링크 ${confirmedLinks.length}개 / 방문 시도 ${checkedLinks.length}개 / 전체 링크 ${linkUrls.length}개`, linkVerdict === 'good' ? '이 페이지에서 발견한 내부 링크 대상이 모두 검사 범위에서 정상입니다.' : '', linkVerdict === 'issue' ? '검사한 내부 링크가 존재하지 않는 페이지를 가리킵니다.' : linkVerdict === 'unknown' ? linkUncertainty : '');

    const navCount = new Set(page.navLinks.map((item) => normalizeUrl(item, url)).filter(Boolean)).size;
    const navVerdict: Verdict = bodyUnverified ? 'unknown' : navCount >= 2 ? 'good' : navCount === 1 ? 'caution' : 'issue';
    add('navigation.menu', navVerdict, bodyUnverified ? `화면 메뉴 미확인 · ${bodyReason}` : `메뉴의 유효 URL ${navCount}개`, navVerdict === 'good' ? '여러 탐색 경로가 제공됩니다.' : '', navVerdict === 'good' ? '' : bodyUnverified ? '완전한 화면 메뉴를 확인하지 못해 판정하지 않았습니다.' : '메뉴에서 확인된 탐색 경로가 부족합니다. 단일 페이지 구조라면 수동 확인하세요.');

    const redirectVerdict: Verdict = page.redirectCount >= 4 ? 'issue' : page.redirectCount >= 2 ? 'caution' : 'good';
    add('navigation.redirect', redirectVerdict, `리다이렉트 ${page.redirectCount}회`, redirectVerdict === 'good' ? '반복 리다이렉트가 없습니다.' : '', redirectVerdict === 'good' ? '' : '최종 페이지에 도달하기까지 여러 번 이동합니다.');

    const mobileVerdict: Verdict = bodyUnverified || mobileUnverified || desktopUnverified ? 'unknown' : page.mobileOverflow ? 'issue' : page.desktopOverflow || page.popupCount >= 2 ? 'caution' : 'good';
    add('navigation.mobile', mobileVerdict, bodyUnverified || mobileUnverified || desktopUnverified ? '데스크톱·모바일 화면이 완전히 확인되지 않아 비교 불가' : `모바일 넘침 ${page.mobileOverflow ? '있음' : '없음'} · 데스크톱 넘침 ${page.desktopOverflow ? '있음' : '없음'} · 팝업 ${page.popupCount}개`, mobileVerdict === 'good' ? '자동 화면 검사에서 가로 넘침이나 과도한 팝업이 감지되지 않았습니다.' : '', mobileVerdict === 'good' ? '' : mobileVerdict === 'unknown' ? '실제 화면을 확인하지 못해 모바일 상태를 판정하지 않았습니다.' : '작은 화면에서 콘텐츠가 가려지거나 탐색이 불편할 수 있습니다.');

    const renderMissing = !page.renderedText.trim() && length > 0;
    const firstPartyFailures = firstPartyResourceFailures(page);
    // Route failures can be caused by this scanner's DNS, timeout or resource
    // policy. Do not turn them into a site defect without a separate recheck.
    const resourceCauseUnverified = firstPartyFailures.length > 0;
    const renderVerdict: Verdict = bodyUnverified || resourceCauseUnverified ? 'unknown'
      : renderMissing || page.jsErrors.length >= 5 ? 'issue' : page.jsErrors.length ? 'caution' : 'good';
    add('access.render', renderVerdict,
      bodyUnverified ? `${bodyReason} · ${page.desktopRender?.error || page.mobileRender?.error || page.resourceFailures.find((failure) => failure.startsWith('검사기 제한:')) || '도구 오류 상세 미확인'}`
        : `렌더링 텍스트 ${page.renderedText.trim().length}자 · JS 오류 ${page.jsErrors.length}개 · 동일 사이트 자원 실패 ${firstPartyFailures.length}개 · 외부/검사 제한 실패 ${page.resourceFailures.length - firstPartyFailures.length}개${firstPartyFailures.length ? ` · ${short(firstPartyFailures[0], 80)}` : ''}`,
      renderVerdict === 'good' ? '본문 렌더링과 동일 사이트의 주요 자원에서 오류 신호가 없습니다.' : '',
      renderVerdict === 'good' ? '' : bodyUnverified ? '화면을 완전히 확인하지 못해 사이트 결함으로 단정하지 않았습니다.'
        : resourceCauseUnverified ? '자원 실패가 검사 환경 때문인지 사이트 때문인지 구분되지 않아 감점하지 않았습니다.' : '브라우저 오류가 기록되어 실제 사용자 환경에서 재현해야 합니다.',
      resourceCauseUnverified ? { action: '기록된 자원 URL을 일반 데스크톱·모바일 브라우저에서 다시 열어 재현 여부를 확인하세요. 검사 도구에서만 실패하면 사이트 파일 수정은 보류하세요.' } : undefined);

    const noindex = /(?:^|[\s,])noindex(?:$|[\s,])/i.test(page.robotsMeta);
    const canonical = page.canonical ? normalizeUrl(page.canonical, url) : null;
    const pageCanonical = normalizeUrl(url);
    const otherCanonical = !!canonical && canonical !== pageCanonical;
    const canonicalVerdict: Verdict = desktopUnverified && !page.rawHtml ? 'unknown' : noindex || otherCanonical || (!!page.canonical && !canonical) ? 'caution' : 'good';
    add('access.indexing', canonicalVerdict, `robots meta: ${page.robotsMeta || '없음'} · canonical: ${page.canonical || '없음'}`, canonicalVerdict === 'good' ? '명백한 noindex 또는 다른 canonical 대상이 발견되지 않았습니다.' : '', canonicalVerdict === 'good' ? '' : '색인 제외 또는 다른 대표 URL 지정이 의도한 설정인지 확인해야 합니다.');

    const adEmptyVerdict: Verdict = bodyUnverified ? 'unknown' : page.adElementCount > 0 && (length < 20 || soft404) ? 'issue' : 'good';
    add('adsense.emptyAds', adEmptyVerdict, bodyUnverified ? `광고 배치와 화면 본문 미확인 · ${bodyReason}` : `광고 요소 ${page.adElementCount}개 · 본문 ${length}자${soft404 ? ' · 오류 페이지 표현' : ''}`, adEmptyVerdict === 'good' ? '광고가 있는 빈 화면 신호가 감지되지 않았습니다.' : '', adEmptyVerdict === 'issue' ? '본문이 없는 화면에 광고 요소가 있습니다. 실제 Google 광고 노출인지 확인하세요.' : bodyUnverified ? '완전한 화면을 확인하지 못해 광고 배치를 판정하지 않았습니다.' : '');
  }

  let responseVerdict: Verdict;
  const conflictingHttp = page.http && page.http.statusCode !== page.statusCode;
  if (conflictingHttp || page.failureCategory === 'cache_only_direct_failed') responseVerdict = 'unknown';
  else if (page.statusCode === 404 || page.statusCode === 410) responseVerdict = 'issue';
  else if (page.error || page.statusCode === null || page.statusCode === 403 || page.statusCode === 429 || page.statusCode >= 500) responseVerdict = 'unknown';
  else if (page.statusCode >= 200 && page.statusCode < 300) responseVerdict = 'good';
  else responseVerdict = 'caution';
  add('access.response', responseVerdict, `${conflictingHttp ? `직접 HTTP ${page.http?.statusCode ?? '미확인'} · 브라우저 HTTP ${page.statusCode ?? '미확인'} (결과 불일치)` : page.error || `HTTP ${page.statusCode ?? '미확인'}`} · ${page.contentType || '유형 미확인'}`, responseVerdict === 'good' ? '공개 요청에 정상 응답했습니다.' : '', responseVerdict === 'good' ? '' : responseVerdict === 'unknown' ? '일시적 차단·오류 또는 검사 환경 차이 가능성이 있어 재검사해야 합니다.' : '페이지 응답이 정상적이지 않습니다.');

  // Technical diagnostics are deliberately unscored and never labelled as an
  // official AdSense violation.
  if (html) {
    const diagnostics: Array<[string, boolean, string, string]> = [
      ['technical.title', !!page.title.trim(), page.title ? `title: ${page.title}` : '<title> 비어 있음', '문서 제목이 없습니다.'],
      ['technical.description', !!page.metaDescription.trim(), page.metaDescription ? `description: ${page.metaDescription}` : 'meta description 없음', '검색 결과 설명에 참고할 문구가 없습니다.'],
      ['technical.heading', page.headings.some((heading) => heading.trim()), `제목 요소 ${page.headings.length}개`, '본문 제목 구조를 확인하세요.'],
      ['technical.alt', page.imagesWithoutAlt === 0, `이미지 ${page.imageCount}개 · alt 없는 이미지 ${page.imagesWithoutAlt}개`, '대체 텍스트가 없는 이미지가 있습니다. 장식 이미지인지는 수동 확인하세요.'],
      ['technical.lang', !!page.lang.trim(), `lang: ${page.lang || '없음'}`, 'HTML 문서 언어가 표시되지 않았습니다.'],
    ];
    for (const [id, good, evidence, bad] of diagnostics) add(id, good ? 'good' : 'caution', evidence, good ? '기술 권장 신호가 확인됩니다.' : '', good ? '' : bad);
    const https = url.startsWith('https://');
    const mixed = https && /<(?:script|img|iframe|link|source)\b[^>]*(?:src|href)\s*=\s*["']http:\/\//i.test(page.rawHtml);
    const secureVerdict: Verdict = !https || mixed ? 'caution' : 'good';
    add('technical.https', secureVerdict, `${https ? 'HTTPS' : 'HTTP'} · HTTP 하위 자원 ${mixed ? '감지' : '미감지'}`, secureVerdict === 'good' ? '보안 연결과 주요 자원의 혼합 콘텐츠 신호가 양호합니다.' : '', secureVerdict === 'good' ? '' : '연결 보안 또는 혼합 콘텐츠를 점검하세요.');
  }

  if (page.hasAdClickPrompt) add('manual.adClick', 'unknown', '광고 클릭 유도 가능 표현이 자동 감지되었습니다.', '', '광고와 문구의 실제 관계를 관리자가 확인해야 합니다.');
  return output;
}

export function evaluateAudit(pages: PageSnapshot[], signals: SiteSignals | null, visitedPages: PageSnapshot[] = pages): Finding[] {
  const accessible = pages.filter(isHtml);
  const renderedAccessible = accessible.filter((page) => (page.desktopRender?.success || page.mobileRender?.success)
    && !renderLimitedByScanner(page));
  const duplicates = duplicateMatches(accessible);
  const byUrl = new Map<string, PageSnapshot>();
  const byFinalUrl = new Map<string, PageSnapshot>();
  for (const page of pages) {
    const key = normalizeUrl(page.finalUrl || page.url);
    if (key) byFinalUrl.set(key, page);
  }
  // A redirect alias is still a visited, working link target even though its
  // content is scored only once under the representative final URL.
  for (const page of visitedPages) {
    const representative = byFinalUrl.get(normalizeUrl(page.finalUrl || page.url) ?? '') ?? page;
    for (const candidate of [page.url, page.finalUrl]) {
      const normalized = normalizeUrl(candidate);
      if (normalized) byUrl.set(normalized, representative);
    }
  }
  const output = pages.flatMap((page) => evaluatePage(page, accessible, byUrl, duplicates));
  const root = signals?.rootUrl || pages[0]?.url || '';
  const site = (id: string, verdict: Verdict, evidence: string, good: string, bad: string, overrides?: Partial<Pick<Finding, 'action' | 'why'>>) => output.push(finding(id, root, verdict, evidence, good, bad, overrides));

  const robotsFile = signals?.technicalFiles?.robots;
  const robotsUnknown = signals?.robotsAllowsAdsense == null;
  const robotsEvidence = signals?.robotsText == null
    ? robotsFile?.statusCode != null
      ? `robots.txt 직접 요청: HTTP ${robotsFile.statusCode}. 크롤러 규칙은 확인할 수 없었습니다.`
      : robotsFile?.error
        ? `robots.txt 직접 요청 실패: ${robotsFile.error}`
        : 'robots.txt 직접 요청 결과가 없어 크롤러 규칙을 확인하지 못했습니다.'
    : `robots.txt: AdSense 크롤러 ${signals.robotsAllowsAdsense ? '허용' : '차단'}`;
  site('access.robots', robotsUnknown ? 'unknown' : signals.robotsAllowsAdsense ? 'good' : 'issue',
    robotsEvidence,
    signals?.robotsAllowsAdsense ? 'AdSense 크롤러의 접근이 허용된 것으로 확인됩니다.' : '',
    signals?.robotsAllowsAdsense === false ? 'AdSense 크롤러 차단 신호가 있습니다.' : robotsUnknown ? '접근 정책을 확인하지 못했습니다.' : '',
    robotsUnknown ? { action: 'robots.txt를 직접 다시 요청하고 AdSense 크롤러에 적용되는 규칙을 확인하세요. 실제 차단 규칙이 확인된 경우에만 수정하세요.' } : undefined);

  if (!renderedAccessible.length) {
    for (const id of ['trust.privacy', 'trust.identity', 'trust.notice', 'adsense.connection']) site(id, 'unknown', accessible.length ? '원본 HTML은 확보했으나 브라우저 화면을 확인하지 못했습니다.' : '접근 가능한 HTML 페이지가 없습니다.', '', '사이트 공통 요소를 확인하지 못했습니다.');
  } else {
    const privacy = renderedAccessible.some((page) => page.hasPrivacyLink);
    const privacyPage = renderedAccessible.find((page) => {
      const path = decodeURIComponentSafe(new URL(page.finalUrl || page.url).pathname);
      return /(?:privacy|privacypolicy|datenschutz|個人情報|プライバシー|개인정보|隐私|隱私)/i.test(`${path} ${page.title}`);
    });
    const privacyText = privacyPage ? main(privacyPage) : '';
    const cookies = /(?:cookie|쿠키|クッキー|曲奇)/i.test(privacyText);
    const adDisclosure = /(?:adsense|google\s*ads?|광고|広告|广告|advertis)/i.test(privacyText);
    const choice = /(?:거부|동의|설정|拒否|同意|拒绝|consent|opt[ -]?out|withdraw)/i.test(privacyText);
    const futurePlanSnippet = privacyText.match(/(?:승인\s*(?:후|뒤)|추후|향후|before\s+(?:starting|enabling)|after\s+approval)[^.!?。！？]{0,120}(?:광고|adsense|advertis|広告|广告)[^.!?。！？]{0,160}(?:반영|추가|적용|준비|add|update|implement)/i)?.[0]
      ?? privacyText.match(/(?:광고|adsense|advertis|広告|广告)[^.!?。！？]{0,120}(?:승인\s*(?:후|뒤)|추후|향후|시작\s*전|준비\s*중|will\s+add|later|planned)/i)?.[0]
      ?? '';
    const futureOnly = Boolean(futurePlanSnippet);
    const hasAds = renderedAccessible.some((page) => page.hasAdsenseScript || page.adElementCount > 0);
    const privacyVerdict: Verdict = privacyPage
      ? futureOnly && !hasAds ? 'unknown' : privacy && cookies && adDisclosure && choice && !futureOnly ? 'good' : 'caution'
      : 'unknown';
    const privacyGood = privacy && privacyPage
      ? `개인정보 안내 링크와 문서 본문을 확인했습니다.${cookies && adDisclosure && choice ? ' 광고·쿠키·선택/거부 관련 문구도 발견했습니다.' : ''}`
      : privacy ? '개인정보 안내 링크를 발견했습니다.' : '';
    const privacyBad = futureOnly
      ? '검사한 개인정보 문서가 광고 운영과 안내 보완을 향후 계획으로 설명합니다. 실제 운영 상태와 일치하는지 확인해야 합니다.'
      : privacyVerdict === 'unknown' ? privacy
        ? '안내 링크는 찾았지만 문서 본문을 검사하지 못했습니다.'
        : '검사한 페이지에서 안내 링크를 찾지 못했습니다. 사이트 전체에 없는지는 확인하지 못했습니다.'
        : privacyVerdict === 'good' ? '' : '개인정보·광고 쿠키 안내의 실제 내용과 노출 위치를 확인해야 합니다.';
    const privacyAction = futureOnly
      ? '사이트 소유자가 현재 광고·쿠키 운영 상태를 먼저 확인하세요. 아직 운영 전이고 광고 게재가 차단돼 있다면 향후 계획 문구를 결함으로 단정하거나 불필요하게 바꾸지 마세요. 이미 운영 중이라면 문서의 제공자·쿠키·동의 및 철회 방법을 실제 운영에 맞는 현재형 안내로 고치세요.'
      : RULES['trust.privacy'].action;
    site('trust.privacy', privacyVerdict, `검사한 페이지의 개인정보 링크 ${privacy ? '있음' : '미감지'} · 문서 검사 ${privacyPage ? privacyPage.finalUrl || privacyPage.url : '미검사'} · 광고 안내 ${adDisclosure ? '있음' : '미확인'} · 쿠키 안내 ${cookies ? '있음' : '미확인'} · 선택/거부 안내 ${choice ? '있음' : '미확인'}${futureOnly ? ` · 향후 보완 표현 "${short(futurePlanSnippet, 105)}"` : ''} · 공개 광고 신호 ${hasAds ? '있음' : '미감지'}`, privacyGood, privacyBad, { action: privacyAction });

    const about = renderedAccessible.some((page) => page.hasAboutLink);
    const contact = renderedAccessible.some((page) => page.hasContactLink);
    const identityVerdict: Verdict = about && contact ? 'good' : 'unknown';
    site('trust.identity', identityVerdict,
      `검사한 페이지의 소개 링크 ${about ? '있음' : '미감지'} · 연락 링크 ${contact ? '있음' : '미감지'}`,
      identityVerdict === 'good' ? '소개와 연락 경로가 모두 확인됩니다.' : '',
      identityVerdict === 'good' ? '' : '검사한 페이지에서 두 경로를 모두 확인하지 못했습니다. 다른 공개 페이지에 있는지는 미확인입니다.',
      identityVerdict === 'unknown' ? { action: '소개·연락 경로가 있는 공개 페이지를 직접 찾아 열고, 방문자에게 실제로 보이는지 확인하세요.' } : undefined);

    const anchorSamples = renderedAccessible.filter((page) => /<a\b/i.test(page.rawHtml));
    const unnamed = anchorSamples.reduce((sum, page) => sum + emptyAnchorCount(page.rawHtml), 0);
    const noticeVerdict: Verdict = !anchorSamples.length ? 'unknown' : unnamed > 0 ? 'caution' : privacy || about || contact ? 'good' : 'unknown';
    site('trust.notice', noticeVerdict, `검사 페이지의 이름 없는 링크 ${unnamed}개 · 안내 링크 ${privacy || about || contact ? '있음' : '미감지'}`, noticeVerdict === 'good' ? '안내 링크가 있고 이름 없는 링크가 발견되지 않았습니다.' : '', noticeVerdict === 'good' ? '' : '링크 텍스트 또는 안내 접근성을 수동 확인해야 합니다.');

    const script = accessible.some((page) => page.hasAdsenseScript || /pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle/i.test(page.rawHtml));
    const meta = accessible.some((page) => page.hasAdsenseMeta || /<meta\b[^>]*name\s*=\s*["']google-adsense-account["']/i.test(page.rawHtml));
    const adsTxt = validAdsTxt(signals?.adsTxtText ?? null);
    const adsFile = signals?.technicalFiles?.ads;
    const adsInspected = signals?.adsTxtText !== null && signals?.adsTxtText !== undefined
      || Boolean(adsFile && !adsFile.error && adsFile.statusCode !== null
        && (adsFile.statusCode >= 200 && adsFile.statusCode < 300 || [404, 410].includes(adsFile.statusCode)));
    const connectionVerdict: Verdict = script || meta || adsTxt ? 'good' : adsInspected ? 'caution' : 'unknown';
    site('adsense.connection', connectionVerdict,
      `검사한 HTML의 광고 코드 ${script ? '있음' : '미감지'} · 계정 메타 ${meta ? '있음' : '미감지'} · ads.txt ${adsInspected ? `직접 확인 HTTP ${adsFile?.statusCode ?? '기록 없음'}` : '직접 확인 불가'} · 유효한 Google 행 ${adsTxt ? '있음' : adsInspected ? '미감지' : '미확인'}`,
      connectionVerdict === 'good' ? '공개 페이지 또는 ads.txt에서 연결 방식 중 하나가 확인됩니다.' : '',
      connectionVerdict === 'good' ? '' : connectionVerdict === 'unknown'
        ? 'ads.txt 직접 확인이 되지 않아 공개 연결 흔적의 부재를 판정하지 않았습니다.'
        : '검사한 공개 자료에서 연결 흔적을 찾지 못했습니다. ads.txt 부재만으로 승인 불가라는 뜻은 아닙니다.',
      connectionVerdict === 'unknown' ? { action: 'ads.txt를 직접 다시 요청하고 검사한 HTML의 광고 코드·계정 메타 태그를 확인하세요. 실제 계정 연결 상태는 소유자가 확인해야 합니다.' } : undefined);
  }
  output.push(finding('manual.external', root, 'unknown', '계정 로그인이나 외부 저작물 대조는 수행하지 않았습니다.', '', '사이트 소유자의 직접 확인이 필요합니다.'));
  return output;
}

export function scoreAudit(findings: Finding[], accessiblePageCount: number): ScoreResult {
  const areaScores: ScoreResult['areaScores'] = { content: null, navigation: null, access: null, trust: null, adsense: null };
  const siteRuleIds = new Set(['access.robots', 'trust.privacy', 'trust.identity', 'trust.notice', 'adsense.connection']);
  const coreRuleIds = ['content.placeholder', 'content.empty', 'content.substance', 'access.response', 'access.robots', 'trust.privacy', 'adsense.connection'];
  const groups = new Map<string, Finding[]>();
  for (const item of findings) {
    if (!RULES[item.id] || RULES[item.id].weight <= 0) continue;
    const group = groups.get(item.id) ?? [];
    group.push(item);
    groups.set(item.id, group);
  }

  const ruleScores: RuleScore[] = [];
  let hasScoredDeduction = false;
  for (const [id, rule] of Object.entries(RULES)) {
    if (!rule.weight || rule.area === 'technical' || rule.area === 'manual') continue;
    // Site-wide findings are counted once. A missing finding is unknown, not NA.
    const group = siteRuleIds.has(id) ? (groups.get(id) ?? []).slice(0, 1) : groups.get(id) ?? [];
    const measured = group.filter((item) => item.verdict === 'good' || item.verdict === 'caution' || item.verdict === 'issue');
    const unknown = group.filter((item) => item.verdict === 'unknown');
    const na = group.filter((item) => item.verdict === 'na');
    const applicableCount = measured.length + unknown.length;
    const allConfirmedNA = group.length > 0 && applicableCount === 0 && na.length === group.length;
    const nonApplicableWeight = allConfirmedNA ? rule.weight : 0;
    const measuredWeight = applicableCount ? rule.weight * measured.length / applicableCount : 0;
    const earnedWeight = applicableCount
      ? rule.weight * measured.reduce((sum, item) => sum + (item.verdict === 'good' ? 1 : item.verdict === 'caution' ? 0.5 : 0), 0) / applicableCount
      : 0;
    const unknownWeight = rule.weight - nonApplicableWeight - measuredWeight;
    const verdicts = new Set(group.map((item) => item.verdict));
    const verdict: RuleScore['verdict'] = !group.length ? 'unknown' : verdicts.size === 1 ? group[0].verdict : 'mixed';
    if (measured.some((item) => item.verdict !== 'good')) hasScoredDeduction = true;
    ruleScores.push({
      id, area: rule.area as ScoredArea, title: rule.title, weight: rule.weight,
      applicableCount, measuredCount: measured.length, unknownCount: unknown.length,
      nonApplicableCount: na.length, verdict,
      earnedWeight, measuredWeight, unknownWeight, nonApplicableWeight,
    });
    if (measured.length) {
      const area = rule.area as ScoredArea;
      areaScores[area] = (areaScores[area] ?? 0) + earnedWeight;
    }
  }

  const nonApplicableWeight = ruleScores.reduce((sum, row) => sum + row.nonApplicableWeight, 0);
  const applicableWeight = 100 - nonApplicableWeight;
  const measuredWeight = ruleScores.reduce((sum, row) => sum + row.measuredWeight, 0);
  const earnedWeight = ruleScores.reduce((sum, row) => sum + row.earnedWeight, 0);
  const unknownWeight = applicableWeight - measuredWeight;
  const verificationRate = applicableWeight > 0 ? measuredWeight / applicableWeight * 100 : null;
  const roundTenth = (number: number) => Math.round(number * 10) / 10;
  const roundHundredth = (number: number) => Math.round((number + Number.EPSILON) * 100) / 100;
  const canEstimateBounds = accessiblePageCount > 0 && applicableWeight > 0 && measuredWeight > 0;
  const possibleMin = canEstimateBounds ? roundHundredth(100 * earnedWeight / applicableWeight) : null;
  const possibleMax = canEstimateBounds ? roundHundredth(100 * (earnedWeight + unknownWeight) / applicableWeight) : null;
  const unmeasuredCoreRuleIds = coreRuleIds.filter((id) => !ruleScores.find((row) => row.id === id)?.measuredWeight);
  const reasons: string[] = [];
  if (accessiblePageCount <= 0) reasons.push('접근 가능한 HTML 페이지가 없습니다.');
  if (applicableWeight <= 0) reasons.push('적용 가능한 채점 규칙이 없습니다.');
  else if (measuredWeight <= 0) reasons.push('측정된 채점 규칙이 없습니다.');
  const holdReason = reasons.length ? reasons.join(' ') : null;
  for (const area of Object.keys(areaScores) as ScoredArea[]) {
    if (areaScores[area] !== null) areaScores[area] = Math.round((areaScores[area] as number) * 10) / 10;
  }
  // The displayed score uses measured evidence only. Unknown weight remains
  // visible in coverage and bounds, but never contributes assumed points.
  let value: number | null = holdReason === null
    ? roundTenth(100 * earnedWeight / measuredWeight)
    : null;
  // A real observed deduction must not appear as a perfect score after display rounding.
  if (value === 100 && hasScoredDeduction) value = 99.9;
  const critical = findings.some((item) => item.critical === true && item.verdict === 'issue' && item.sourceKind === 'official');
  const criticalCapApplied = critical && value !== null && value > 39;
  if (criticalCapApplied) value = 39;
  return {
    value, percentage: value, areaScores, nonApplicableWeight, applicableWeight,
    measuredWeight, earnedWeight, unknownWeight, verificationRate,
    possibleMin, possibleMax, holdReason, unmeasuredCoreRuleIds, ruleScores,
    criticalCapApplied,
  };
}

// This explicit invariant protects the published 100-point rubric from silent
// weight changes during maintenance.
for (const [area, maximum] of Object.entries(areaMaximums) as Array<[ScoredArea, number]>) {
  const actual = Object.values(RULES).filter((rule) => rule.area === area).reduce((sum, rule) => sum + rule.weight, 0);
  if (actual !== maximum) throw new Error(`Rule weights for ${area} total ${actual}, expected ${maximum}`);
}

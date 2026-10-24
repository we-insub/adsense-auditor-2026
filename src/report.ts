import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { failureLabel, hasDirectPageEvidence, retryAction } from './evidence.js';
import { RULES } from './rules.js';
import { normalizePageUrl } from './scanner.js';
import { RULESET_VERSION, type FailureCategory, type Finding, type PageSnapshot, type ReportData } from './types.js';

export const NOTICE_TEXT = `안녕하세요. 애드센스 승인 준비 상태를 점검해 드립니다. 사이트 URL을 보내주시면 로그인 없이 공개된 페이지를 최대 200개까지 읽기 전용으로 검사하고, 첫 장에는 검사한 페이지의 통합 점수와 채점 기준을, 이어지는 본문에는 페이지별 크리티컬·긴급·수정 검토 항목의 현재 상황·관찰 증거·보완 방법·완료 확인을 적은 PDF 보고서를 보내드립니다. 확인한 근거가 있으면 100점 만점 잠정 성적표와 비공식 승인 가능성 추정 지수를 표시하고, 검증률·미확인 항목·가능한 점수 구간을 함께 알려드립니다. 근거를 전혀 확인하지 못한 경우에는 숫자를 보류합니다. 사이트나 계정 설정을 변경하지 않으며 비밀번호를 받지 않습니다. 200페이지를 넘는 사이트는 표본 검사로 표시하고, 전체 검사는 별도 문의로 진행합니다.
신청하실 사이트 URL과 검사에서 제외할 공개 경로가 있다면 함께 보내주세요. URL을 보내시면 위 검사 범위와 보고서 작성·전달에 동의한 것으로 보고 진행합니다. 이 지수는 실제 확인한 항목만 환산한 자체 진단값이며 실제 승인 확률이나 Google의 심사 결과가 아닙니다.`;

export const FEATURES_TEXT = `URL을 보내주시면 공개 사이트맵과 내부 링크에서 페이지를 찾아 기본 최대 200페이지를 검사합니다. 미완성 문구·빈 페이지·콘텐츠 중복, 링크와 메뉴, 모바일 화면, 검색 로봇 접근, 개인정보 안내, AdSense 연결 준비 상태 등을 확인합니다. PDF 첫 장에는 검사 페이지 묶음의 통합 점수와 다섯 영역의 배점·채점 기준, 검증률·가능 점수 구간을 표시합니다. 다음 장부터는 양호 항목을 제외하고 크리티컬·긴급·수정 검토 항목을 페이지별로 묶어 현재 상황·관찰 증거·확인된 공개 HTML·보완 방법·근거·완료 확인을 정리합니다. 점수는 실제 확인한 항목의 획득 E를 확인한 배점 W로 나눠 계산합니다. 미확인 배점 U에는 점수를 가정해 넣지 않고 별도로 밝힙니다. 직접 확인한 페이지가 없으면 점수를 보류합니다. 이 PDF를 개발자나 코딩 AI에게 전달해 수정을 요청할 수 있습니다. Google·Bing·네이버 검색 도구 설정은 보고서 끝의 자가 확인 안내를 참고하시면 됩니다. 실제 AdSense 승인과 검색 노출은 각 서비스의 심사·판단에 따라 달라집니다.`;

export const REPAIR_PROMPT_TEXT = `첨부한 애드센스 준비 진단 PDF의 ‘페이지별 수정 목록’을 확인해 주세요. 크리티컬·긴급 항목부터 각 URL에 연결되는 실제 소스 파일·콘텐츠를 찾고, PDF의 ‘현재 상황’과 ‘관찰 증거’를 현재 화면에서 다시 확인한 뒤 필요한 부분만 수정해 주세요. ‘공개 HTML’은 관찰 기록이고 ‘코드 변경 예시’는 실제 파일을 확인한 후 적용할 예시입니다. 수정 검토 항목은 현재 구성이 맞다면 유지 이유를 설명해 주세요. 완료 후 ‘완료 확인’ 기준을 해당 URL의 데스크톱·모바일 화면에서 테스트하고, 변경한 파일과 확인 결과를 알려 주세요. ‘추가 확인 필요’는 근거를 확보하기 전까지 오류로 단정하지 마세요. 배포와 계정 설정은 제 승인 없이 진행하지 마세요.`;

export const DELIVERY_TEXT = `요청하신 [사이트 URL] 검수를 마쳐 보고서를 보내드립니다. 발견한 공개 URL [발견 수]개 중 [검사 수]개를 검사했고(고유 최종 URL [고유 수]개), 100점 만점 통합 성적표는 [점수], 비공식 승인 준비 지수는 [지수]입니다. 검증률 [검증률], 가능한 100점 구간 [점수 구간]을 함께 확인해 주세요.[보류 사유] 미확인 배점은 점수에 가정해 넣지 않았습니다. 이 지수는 실제 승인 확률이 아닙니다. 첫 장에는 채점 기준을, 다음 장부터는 페이지별로 수정할 항목의 증거와 개선 방법을 정리했습니다. 200페이지 제한이 적용된 경우 보고서에 표본 검사임을 표시했습니다.`;

const SAMPLE_NOTICE = '해당 웹사이트는 페이지 수가 많아 기본 기준인 200페이지까지만 검수하여 채점했습니다. 전체 페이지 검수를 원하시면 관리자에게 문의해 주세요.';
export const QUICK_SCOPE_TEXT = '이번 보고서는 발견한 공개 페이지 중 최대 20페이지를 확인한 빠른 표본 검사 결과입니다. 이 점수를 사이트 전체 페이지의 판정으로 해석하지 마세요. 더 넓은 범위를 확인하려면 기본 200페이지 검사 또는 관리자 전체 검사를 이용하세요.';
const SEARCH_DISCLAIMER = '위 서비스의 등록·제출 여부는 이번 공개 페이지 검사로 확인하지 않았습니다. 아직 진행하지 않았다면 설정해 보세요. 사이트맵 제출과 수집 요청은 검색엔진이 페이지를 발견하고 검토하는 데 도움이 되지만, 실제 색인이나 검색 결과 노출을 보장하지는 않습니다.';
const AREA_NAMES = {
  content: '콘텐츠·완성도', navigation: '탐색·사용성', access: '공개 접근·기술',
  trust: '투명성', adsense: 'AdSense 연결 준비', technical: '추가 기술 진단', manual: '관리자 확인',
} as const;
const AREA_MAX = { content: 40, navigation: 20, access: 15, trust: 15, adsense: 10 } as const;
const AREA_CRITERIA = {
  content: '미완성 문구 8 · 빈 본문 8 · 실질 콘텐츠 8 · 내부 중복 6 · 자체 설명 6 · 광고 균형 4',
  navigation: '내부 링크 6 · 메뉴 5 · 리다이렉트 4 · 모바일 화면 5',
  access: '정상 응답 5 · robots 접근 4 · 렌더링 3 · 색인 설정 3',
  trust: '개인정보·쿠키 7 · 소개·연락 4 · 고지·링크 4',
  adsense: '연결 방식 7 · 콘텐츠 없는 화면의 광고 3',
} as const;
const SOURCE_NAMES = { official: 'Google 공식 정책', recommendation: 'Google 권장사항', heuristic: '채점기 자체 기준' } as const;

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!);
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function finalPageKey(page: PageSnapshot): string {
  const original = page.finalUrl || page.url;
  return normalizePageUrl(original) ?? original;
}

function displayScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '산출 불가';
  const normalized = Math.max(0, Math.min(100, value));
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1);
}

function displayWeight(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function displayRate(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '산출 불가' : `${value.toFixed(1)}%`;
}

function displayRange(min: number | null, max: number | null): string {
  return min === null || max === null ? '산출 불가' : `${min.toFixed(2)}~${max.toFixed(2)}점`;
}

function grade(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '미검증';
  return value >= 90 ? 'A' : value >= 80 ? 'B' : value >= 70 ? 'C' : value >= 60 ? 'D' : 'F';
}

export function readableReason(value: string): string {
  return Object.entries(RULES).reduce((result, [id, rule]) => result.replaceAll(id, rule.title), value);
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return trimmed && !/[.!?。]$/.test(trimmed) ? `${trimmed}.` : trimmed;
}

function observation(finding: Finding): string {
  const evidence = finding.evidence.trim();
  if (!evidence) return '이번 공개 검사에서 직접 확인한 자료가 부족합니다.';
  let match: RegExpMatchArray | null;
  if ((match = evidence.match(/^(home|article|utility|media) 유형 · 본문 (\d+)자 · 자체 기준 (\d+)자$/))) {
    const kind = { home: '홈', article: '글', utility: '안내', media: '미디어' }[match[1]];
    return `이 페이지를 ${kind} 유형으로 분류했고, 공개 본문 ${match[2]}자를 확인했습니다. 비교한 ${match[3]}자 기준은 채점기 자체 기준입니다.`;
  }
  if ((match = evidence.match(/^본문 (\d+)자( · 오류 페이지 표현 감지)?$/))) {
    return `이 페이지에서 본문 ${match[1]}자를 확인했습니다.${match[2] ? ' 오류 페이지로 보이는 표현도 감지됐으므로 실제 화면을 확인해야 합니다.' : ''}`;
  }
  if ((match = evidence.match(/^본문\/원본에서 "(.+)" 발견$/))) return `렌더링된 본문 또는 원본 HTML에서 “${match[1]}” 문구를 찾았습니다. 실제 맥락은 다시 확인해야 합니다.`;
  if ((match = evidence.match(/^이 페이지의 검사된 링크 (\d+)개 \/ 전체 링크 (\d+)개$/))) return `이 페이지의 내부 링크 ${match[2]}개 중 ${match[1]}개 대상만 검사했습니다.`;
  if ((match = evidence.match(/^메뉴의 유효 URL (\d+)개$/))) return `메뉴에서 이동 가능한 URL ${match[1]}개를 확인했습니다.`;
  if ((match = evidence.match(/^리다이렉트 (\d+)회$/))) return `최종 페이지에 도달하기 전 ${match[1]}번 이동했습니다.`;
  if ((match = evidence.match(/^감지 광고 요소 (\d+)개 · 본문 (\d+)자$/))) return `이 페이지에서 광고로 보이는 요소 ${match[1]}개와 본문 ${match[2]}자를 확인했습니다. 광고의 실제 면적과 공급자는 확인하지 않았습니다.`;
  if ((match = evidence.match(/^유사 페이지 (.+) · 자체 유사도 (\d+)%$/))) return `검사한 다른 페이지 ${match[1]}와 본문 유사도가 ${match[2]}%로 계산됐습니다. 사이트 내부 비교 결과입니다.`;
  if ((match = evidence.match(/^실패 대상: (.+)$/))) return `검사한 내부 링크 대상 중 ${match[1]}에서 접근 실패가 확인됐습니다.`;
  if ((match = evidence.match(/^모바일 넘침 (있음|없음) · 데스크톱 넘침 (있음|없음) · 팝업 (\d+)개$/))) return `화면 자동 검사에서 모바일 가로 넘침 ${match[1]}, 데스크톱 가로 넘침 ${match[2]}, 팝업 ${match[3]}개를 기록했습니다.`;
  if ((match = evidence.match(/^광고 코드 (있음|없음) · 계정 메타 (있음|없음) · 유효한 Google ads\.txt 행 (있음|없음)$/))) return `공개 자료에서 광고 코드 ${match[1]}, 계정 메타 태그 ${match[2]}, 유효한 Google ads.txt 행 ${match[3]}으로 확인됐습니다. 실제 계정 연결 상태는 확인하지 않았습니다.`;
  if ((match = evidence.match(/^소개 링크 (있음|없음) · 연락 링크 (있음|없음)$/))) return `검사한 페이지에서 소개 링크는 ${match[1]}, 연락 링크는 ${match[2]}으로 확인됐습니다.`;
  if (finding.id === 'trust.privacy' && (match = evidence.match(/^개인정보 링크 (있음|없음) · 문서 검사 (.+?) · 광고 안내 (있음|미확인) · 쿠키 안내 (있음|미확인) · 선택\/거부 안내 (있음|미확인)(?: · 향후 보완 표현 "(.+)")? · 공개 광고 신호 (있음|미감지)$/))) {
    const status = (value: string) => value === '있음' ? '문구를 찾았습니다' : '문구는 확인되지 않았습니다';
    return `검사한 공개 페이지에서 개인정보 안내 링크는 ${match[1] === '있음' ? '발견됐습니다' : '발견되지 않았습니다'}. ${match[2] === '미검사' ? '해당 문서 본문은 검사하지 못했습니다.' : `개인정보 문서 ${match[2]}를 검사했습니다.`} 광고 안내 ${status(match[3])}. 쿠키 안내 ${status(match[4])}. 선택·거부 안내 ${status(match[5])}.${match[6] ? ` 문서에서 “${match[6]}”라는 향후 보완 표현을 관찰했습니다.` : ''} 검사 범위에서 공개 광고 신호는 ${match[7] === '있음' ? '감지됐습니다' : '감지되지 않았습니다'}.`;
  }
  if (finding.id === 'trust.notice' && (match = evidence.match(/^검사 페이지의 이름 없는 링크 (\d+)개 · 안내 링크 (있음|미감지)$/))) return `검사한 페이지에서 이름 없는 링크 ${match[1]}개를 감지했고, 주요 안내 링크는 ${match[2]}으로 기록됐습니다.`;
  if (finding.id === 'access.render' && (match = evidence.match(/^렌더링 텍스트 (\d+)자 · JS 오류 (\d+)개 · 동일 사이트 자원 실패 (\d+)개 · 외부\/검사 제한 실패 (\d+)개/))) return `브라우저 화면에서 렌더링 텍스트 ${match[1]}자를 확인했습니다. JavaScript 오류 ${match[2]}개와 동일 사이트 자원 실패 ${match[3]}개를 기록했습니다. 외부 자원 또는 검사 제한에 따른 실패 ${match[4]}개는 별도로 분류했습니다.`;
  if (finding.id === 'content.media' && (match = evidence.match(/^영상 (\d+)개 · 이미지 (\d+)개 · 제휴 신호 (있음|없음) · 본문 (\d+)자$/))) return `이 페이지에서 영상 ${match[1]}개, 이미지 ${match[2]}개, 본문 ${match[4]}자를 확인했습니다. 제휴 신호는 ${match[3]}으로 감지됐습니다.`;
  if (finding.id === 'access.indexing' && (match = evidence.match(/^robots meta: (.+?) · canonical: (.+)$/))) return `원본 HTML에서 robots meta는 “${match[1]}”, canonical은 “${match[2]}”로 확인됐습니다. 두 설정의 의도는 사이트 소유자가 판단해야 합니다.`;
  if ((match = evidence.match(/^robots\.txt: AdSense 크롤러 (허용|차단\/미확인)$/))) return `robots.txt 검사 결과 AdSense 크롤러 접근은 ${match[1]}으로 기록됐습니다.`;
  if ((match = evidence.match(/^(HTTP \d+|HTTP 미확인|[^·]+) · (.+)$/)) && finding.id === 'access.response') return `공개 요청 결과는 ${match[1].trim()}이고 콘텐츠 유형은 ${match[2].trim()}입니다.`;
  if (/[.!?。]$/.test(evidence)) return evidence;
  return `자동 검사 기록에는 “${evidence.replace(/ · /g, ', ')}”로 남아 있습니다. 해당 페이지에서 다시 확인해 주세요.`;
}

function completionCheck(finding: Finding): string {
  const checks: Record<string, string> = {
    'content.placeholder': '임시·샘플 문구가 원본 HTML과 실제 화면에서 사라지고, 그 자리에 완성된 본문이 보이는지 확인하세요.',
    'content.empty': '해당 URL의 데스크톱·모바일 화면에서 페이지 목적에 맞는 실제 본문을 읽을 수 있는지 확인하세요.',
    'content.substance': '해당 URL의 본문에서 핵심 질문에 답하는 고유 설명과 근거를 읽을 수 있는지 확인하세요.',
    'content.duplicate': '관련 두 URL을 열어 각 페이지의 목적과 본문이 구별되는지 확인하고 canonical이 의도대로인지 점검하세요.',
    'content.media': '이미지·영상·제휴 정보 옆에 직접 작성한 설명과 출처가 실제 화면에 보이는지 확인하세요.',
    'content.promotion': '데스크톱·모바일 화면에서 본문을 광고나 홍보가 가리지 않고 쉽게 읽을 수 있는지 확인하세요.',
    'navigation.links': '문제가 된 출발 페이지의 링크를 실제로 눌러 최종 URL이 정상 응답하는지 확인하세요.',
    'navigation.menu': '메뉴에서 홈·주요 콘텐츠·안내 페이지로 실제 이동하는지 데스크톱·모바일에서 확인하세요.',
    'navigation.redirect': '수정된 내부 링크를 열어 반복 이동 없이 최종 URL로 연결되는지 확인하세요.',
    'navigation.mobile': '휴대전화 너비에서 본문 가림·가로 넘침·방해 팝업이 없는지 확인하세요.',
    'access.response': '해당 URL을 새 창에서 열어 최종 HTTP 상태와 공개 본문 표시를 확인하세요.',
    'access.robots': '공개 robots.txt를 다시 읽어 Mediapartners-Google 차단 규칙이 없는지 확인하세요.',
    'access.render': '데스크톱·모바일에서 주요 본문과 자원이 표시되고 재현된 자원·스크립트 오류가 해결됐는지 확인하세요.',
    'access.indexing': '원본 HTML의 robots meta와 canonical을 다시 읽고 해당 URL의 게시·색인 의도와 맞는지 확인하세요.',
    'trust.privacy': '개인정보 문서에 실제 광고·쿠키 사용 안내와 선택·거부 경로가 보이는지 확인하세요.',
    'trust.identity': '소개 페이지와 실제 작동하는 연락 경로를 방문자가 메뉴에서 찾을 수 있는지 확인하세요.',
    'trust.notice': '해당 안내 링크의 이름을 화면과 키보드 탐색에서 확인하고 올바른 문서로 이동하는지 확인하세요.',
    'adsense.connection': '선택한 연결 방식의 코드·메타 태그·ads.txt 공개 내용을 확인하고, 계정 연결 상태는 소유자가 직접 확인하세요.',
    'adsense.emptyAds': '본문이 없는 공개 화면에 광고가 표시되지 않거나, 해당 화면에 목적에 맞는 실제 본문이 있는지 확인하세요.',
    'technical.title': '해당 URL의 HTML title이 비어 있지 않고 페이지 내용을 설명하는지 확인하세요.',
    'technical.description': '해당 URL의 meta description에 페이지별 요약이 있는지 원본 HTML에서 확인하세요.',
    'technical.heading': '렌더링 화면의 대표 제목과 제목 순서가 내용을 이해하기 쉬운지 확인하세요.',
    'technical.alt': '의미 있는 이미지의 alt가 문맥에 맞고 장식 이미지는 적절히 처리됐는지 확인하세요.',
    'technical.lang': 'HTML lang 값이 실제 페이지 언어와 맞는지 원본에서 확인하세요.',
    'technical.https': '최종 URL이 HTTPS이고 주요 하위 자원이 혼합 콘텐츠 오류 없이 로드되는지 확인하세요.',
  };
  return checks[finding.id] ?? '같은 공개 URL의 데스크톱·모바일 화면에서 해당 지적 사항이 해소됐는지 다시 확인하세요.';
}

type ActionLevel = 'critical' | 'urgent' | 'fix';

function actionLevel(finding: Finding): ActionLevel {
  if (finding.verdict === 'issue' && finding.critical && finding.sourceKind === 'official') return 'critical';
  if (finding.verdict === 'issue' && finding.sourceKind === 'official') return 'urgent';
  return 'fix';
}

/** Quote only markup that was actually stored from this URL. The source file is not observable. */
function observedPublicMarkup(finding: Finding, page: PageSnapshot | undefined): string | null {
  const html = page?.rawHtml;
  if (!html) return null;
  const tag = (pattern: RegExp) => html.match(pattern)?.[0]?.replace(/\s+/g, ' ').trim().slice(0, 240) ?? null;
  const openingTags = (name: string) => html.match(new RegExp(`<${name}\\b[^>]{0,400}>`, 'gi')) ?? [];
  switch (finding.id) {
    case 'technical.title': return tag(/<title\b[^>]*>[\s\S]{0,180}<\/title\s*>/i);
    case 'technical.description': return openingTags('meta').find((item) => /\bname\s*=\s*["']?description\b/i.test(item))?.slice(0, 240) ?? null;
    case 'technical.heading': return tag(/<h1\b[^>]*>[\s\S]{0,180}<\/h1\s*>/i);
    case 'technical.alt': return openingTags('img').find((item) => !/\balt\s*=/i.test(item))?.slice(0, 240) ?? null;
    case 'technical.lang': return tag(/<html\b[^>]{0,220}>/i);
    case 'access.indexing': return openingTags('meta').find((item) => /\bname\s*=\s*["']?robots\b/i.test(item))?.slice(0, 240)
      ?? openingTags('link').find((item) => /\brel\s*=\s*["']?canonical\b/i.test(item))?.slice(0, 240) ?? null;
    case 'navigation.links': {
      const failedUrl = finding.evidence.match(/^실패 대상: (.+)$/)?.[1];
      return failedUrl ? openingTags('a').find((item) => item.includes(failedUrl))?.slice(0, 240) ?? null : null;
    }
    case 'content.placeholder': {
      const phrase = finding.evidence.match(/^본문\/원본에서 "(.+)" 발견$/)?.[1];
      if (!phrase) return null;
      const at = html.toLowerCase().indexOf(phrase.toLowerCase());
      if (at < 0) return null;
      return html.slice(Math.max(0, at - 55), Math.min(html.length, at + phrase.length + 55)).replace(/\s+/g, ' ').trim().slice(0, 240);
    }
    default: return null;
  }
}

function codeChangeExample(finding: Finding): string {
  const examples: Record<string, string> = {
    'content.placeholder': '예시: 확인된 임시 문구(TODO·준비 중·샘플 문장)를 삭제하고 같은 위치에 실제 완성된 설명을 작성하세요. 입력창의 placeholder 속성은 그대로 두세요.',
    'content.empty': '<main><h1>실제 페이지 제목</h1><p>방문자가 이 URL에서 얻어야 할 실제 정보와 안내</p></main> (페이지 목적을 확인한 뒤 작성)',
    'navigation.menu': '<nav aria-label="주요 메뉴"><a href="실제 홈 URL">홈</a><a href="실제 주요 페이지 URL">주요 페이지</a></nav> (사이트 구조에 맞을 때만 적용)',
    'navigation.redirect': '<a href="직접 확인한 최종 URL">기존 링크 문구</a> (이전 URL이 의도된 경로인지 먼저 확인)',
    'technical.title': '<title>이 페이지의 내용을 설명하는 고유 제목</title>',
    'technical.description': '<meta name="description" content="이 페이지의 핵심 내용을 요약한 문장">',
    'technical.heading': '<main><h1>이 페이지의 대표 제목</h1>…</main>',
    'technical.alt': '<img src="실제 이미지 주소" alt="의미 있는 이미지의 내용">',
    'technical.lang': '<html lang="실제 페이지 언어 코드">',
    'navigation.links': '<a href="확인된 정상 최종 URL">기존 링크 이름</a>',
    'trust.identity': '<nav aria-label="사이트 안내"><a href="실제 소개 URL">소개</a><a href="실제 문의 URL">문의</a></nav> (해당 페이지가 실제 있을 때만)',
  };
  return examples[finding.id] ?? '이 URL을 만드는 실제 템플릿·콘텐츠 파일을 찾고, 위 보완 방법을 해당 요소에 적용하세요.';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return escapeHtml(new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(date));
}

export function fillDeliveryText(data: ReportData): string {
  if (data.score.value === null) {
    const directCount = data.job.pages.filter(hasDirectPageEvidence).length;
    const failedPage = data.job.pages.find((page) => page.error || page.failureCategory);
    const failure = data.job.signals?.discoveryFailureCategory ?? failedPage?.failureCategory;
    const observed = data.job.signals?.discoveryError ?? failedPage?.error;
    const reason = failure && observed
      ? `${failureLabel(failure)}: ${observed.replace(/[.!?\s]+$/, '')}`
      : data.score.holdReason ? readableReason(data.score.holdReason).replace(/[.!?\s]+$/, '') : '직접 확인한 채점 근거가 부족합니다';
    const nextStep = failure ? retryAction(failure) : '접속·렌더링 기록을 확인하고 새 검사를 실행하세요.';
    const scope = data.job.mode === 'quick'
      ? ' 이번 결과는 빠른 표본 검사(최대 20페이지) 범위입니다.'
      : data.job.mode === 'standard' && data.job.discovered.length > 200
        ? ' 기본 200페이지 표본 검사 범위입니다.' : '';
    return `요청하신 ${data.job.inputUrl} 검사를 진행해 진단 PDF를 보내드립니다. 발견한 후보 URL ${data.job.discovered.length}개 중 ${data.job.pages.length}개를 방문 시도했고, 직접 확인한 HTML 또는 브라우저 본문은 ${directCount}건입니다. 자체 진단 총점과 비공식 승인 가능성 추정 지수는 모두 평가 불가입니다. 산출 보류 이유: ${reason}. 재검사 조치: ${nextStep} PDF에는 URL별 접속·렌더링 결과와 기술 파일 검사 상태를 정리했습니다. 검사 환경의 제한을 사이트 결함으로 단정하지 않았습니다.${scope}`;
  }
  const text = DELIVERY_TEXT
    .replace('[사이트 URL]', data.job.inputUrl)
    .replace('[발견 수]', String(data.job.discovered.length))
    .replace('[검사 수]', String(data.job.pages.length))
    .replace('[고유 수]', String(new Set(data.job.pages.map(finalPageKey)).size))
    .replace('[점수]', data.score.value === null ? '평가 불가' : `${displayScore(data.score.value)}/100점`)
    .replace('[지수]', data.score.percentage === null ? '평가 불가' : `${displayScore(data.score.percentage)}%`)
    .replace('[검증률]', displayRate(data.score.verificationRate))
    .replace('[점수 구간]', displayRange(data.score.possibleMin, data.score.possibleMax))
    .replace('[보류 사유]', data.score.holdReason ? ` 평가 불가 이유: ${readableReason(data.score.holdReason)}.` : '');
  return data.job.mode === 'quick'
    ? text.replace('200페이지 제한이 적용된 경우 보고서에 표본 검사임을 표시했습니다.', '이번 보고서는 빠른 표본 검사(최대 20페이지) 결과이며, 사이트 전체 페이지를 검사했다는 뜻은 아닙니다.')
    : text;
}

function renderUnavailableReport(data: ReportData): string {
  const { job, score } = data;
  const technical = job.signals?.technicalFiles;
  const attempts = job.pages.length;
  const failureGroups = new Map<FailureCategory, { count: number; details: Set<string> }>();
  const recordFailure = (category: FailureCategory | undefined, detail: string | undefined) => {
    if (!category && !detail) return;
    const key = category ?? 'unknown';
    const group = failureGroups.get(key) ?? { count: 0, details: new Set<string>() };
    group.count++;
    if (detail) group.details.add(detail);
    failureGroups.set(key, group);
  };
  recordFailure(job.signals?.discoveryFailureCategory, job.signals?.discoveryError);
  for (const page of job.pages) {
    recordFailure(page.failureCategory ?? page.http?.failureCategory ?? page.desktopRender?.failureCategory
      ?? page.mobileRender?.failureCategory, page.error ?? page.http?.error);
  }
  if (!failureGroups.size) recordFailure(undefined, job.error ?? '직접 접속 결과를 저장하지 못했습니다.');
  const diagnosis = [...failureGroups].map(([category, group]) => `<article class="reason"><div class="reason-head"><strong>${escapeHtml(failureLabel(category))}</strong><span>기록 ${group.count}건</span></div>${[...group.details].slice(0, 3).map((detail) => `<p>관찰 내용: ${escapeHtml(detail)}</p>`).join('')}<p class="fix"><strong>재검사 조치</strong> ${escapeHtml(retryAction(category))}</p></article>`).join('');
  const renderState = (check: PageSnapshot['desktopRender']) => !check ? '결과 미기록'
    : !check.attempted ? '미시도' : check.success ? `성공${check.mainTextPresent ? ' · 본문 있음' : ' · 본문 없음'}`
      : `실패 · ${failureLabel(check.failureCategory)}`;
  const pageRows = job.pages.map((page) => {
    const http = page.http;
    const status = http?.statusCode ?? page.statusCode;
    const category = page.failureCategory ?? http?.failureCategory ?? page.desktopRender?.failureCategory
      ?? page.mobileRender?.failureCategory;
    const hops = http?.redirectChain.length ? `<small>리다이렉트: ${escapeHtml(http.redirectChain.map((hop) => `${hop.statusCode} ${hop.url}`).join(' → '))} → ${escapeHtml(http.finalUrl)}</small>` : '';
    const scannerLimits = page.resourceFailures.filter((failure) => failure.startsWith('검사기 제한:'));
    return `<tr><th scope="row" class="url">${escapeHtml(page.url)}${page.finalUrl && page.finalUrl !== page.url ? `<small>최종 URL: ${escapeHtml(page.finalUrl)}</small>` : ''}${hops}</th><td>${status === null ? '응답 없음' : `HTTP ${status}`}${http ? `<small>${http.responseTimeMs}ms · ${formatDate(http.checkedAt)}</small>` : '<small>응답 시간 미기록</small>'}</td><td>${http?.htmlCollected ?? Boolean(page.rawHtml) ? '수집' : '미수집'}</td><td><strong>데스크톱</strong> ${escapeHtml(renderState(page.desktopRender))}<br><strong>모바일</strong> ${escapeHtml(renderState(page.mobileRender))}${scannerLimits.length ? `<small>화면 일부 확인 불가: ${escapeHtml(scannerLimits[0])}</small>` : ''}</td><td>${escapeHtml(failureLabel(category))}${page.error ? `<small>${escapeHtml(page.error)}</small>` : ''}</td></tr>`;
  }).join('');
  const fileRows = ([
    ['robots.txt', technical?.robots, job.signals?.robotsUrl],
    ['sitemap.xml', technical?.sitemap, job.signals ? new URL('/sitemap.xml', job.rootUrl).href : null],
    ['ads.txt', technical?.ads, job.signals?.adsTxtUrl],
  ] as const).map(([name, file, fallbackUrl]) => `<tr><th scope="row">${escapeHtml(name)}</th><td class="url">${escapeHtml(file?.url ?? fallbackUrl ?? new URL(`/${name}`, job.rootUrl).href)}</td><td>${file ? (file.statusCode === null ? '응답 없음' : `HTTP ${file.statusCode}`) : '직접 요청 미기록'}</td><td>${file ? (file.bodyPresent ? '있음' : '없음') : '확인 불가'}</td><td>${file ? `${file.responseTimeMs}ms · ${formatDate(file.checkedAt)}${file.error ? `<small>${escapeHtml(file.error)}</small>` : ''}` : '검사 전에 접근이 실패했을 수 있습니다.'}</td></tr>`).join('');
  const hold = score.holdReason ? readableReason(score.holdReason) : '직접 접속해 확인한 공개 페이지가 0건입니다.';
  const measuredRules = score.ruleScores.filter((row) => row.measuredWeight > 0).length;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>직접 접속 검사 보류 · ${escapeHtml(job.host)}</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#1b3540;background:#edf3f4;font-size:12px;line-height:1.52}*{box-sizing:border-box}body{margin:0;padding:26px}main{max-width:1220px;margin:auto;background:#fff;padding:28px 35px 36px;box-shadow:0 12px 40px #183b4818}.cover{background:#143642;color:#fff;padding:22px 27px;border-radius:13px}.cover .eyebrow{color:#89e4d2;font-size:10px;letter-spacing:.14em;font-weight:800}.cover h1{font-size:26px;line-height:1.25;margin:6px 0 8px}.cover .url{font-size:14px;font-weight:700}.cover .meta{color:#d5e6e6;font-size:11px;margin-top:9px}.cover .meta span{margin-right:18px}.status{border:1px solid #edcd97;background:#fff8e9;border-left:6px solid #b77b22;border-radius:0 10px 10px 0;padding:15px 19px;margin:15px 0}.status strong{font-size:21px;color:#744810}.status p{margin:5px 0}.stats{display:flex;gap:11px;margin:13px 0}.stat{flex:1;background:#edf7f4;border:1px solid #d5e8e4;border-radius:9px;padding:10px 13px}.stat strong{display:block;font-size:19px;color:#12685f}.stat span{font-size:10px;color:#526971}h2{font-size:17px;margin:20px 0 9px;padding-bottom:5px;border-bottom:2px solid #bdded9;color:#174852}h3{font-size:13px;margin:15px 0 5px}.reason{border:1px solid #e6d8bc;border-left:4px solid #bf7b25;border-radius:8px;padding:9px 12px;margin:8px 0;background:#fffdf8;break-inside:avoid-page}.reason-head{display:flex;justify-content:space-between;gap:10px}.reason-head strong{font-size:13px}.reason-head span{color:#785c31;font-size:10px}.reason p{margin:5px 0}.reason .fix{background:#eaf7f3;border-radius:5px;padding:7px 9px}.reason .fix strong{color:#12685f;margin-right:7px}.guide{color:#526a72}.guide strong{color:#284e59}.note{background:#f2f8f7;border-left:4px solid #1b9b8d;padding:9px 12px;border-radius:0 7px 7px 0;margin:8px 0}.table-wrap{overflow-x:auto}.simple{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}.simple th,.simple td{border-bottom:1px solid #e0e9e9;padding:7px 6px;vertical-align:top;text-align:left;overflow-wrap:anywhere}.simple thead th{background:#eaf4f2;color:#31565f}.simple tbody tr:nth-child(even){background:#fafcfc}.simple .url{width:36%}.simple small{display:block;color:#657a83;font-size:9px;line-height:1.35}.url{overflow-wrap:anywhere}.footer{margin-top:20px;padding-top:7px;border-top:3px solid #158b7e}.footer .simple th:first-child{width:25%}.footer p{margin:5px 0}.muted{color:#607681}a{color:#087e85;overflow-wrap:anywhere}@media print{:root,html,body{background:#fff}body{padding:0}main{padding:0;max-width:none;box-shadow:none}.cover{border-radius:0}.status,.stats,.reason,.note{break-inside:avoid-page}h2,h3{break-after:avoid-page}.simple thead{display:table-header-group}.simple tr{break-inside:avoid-page}.footer{break-before:auto}}@media(max-width:720px){body{padding:12px}main{padding:15px}.stats{flex-wrap:wrap}.stat{min-width:45%}.simple{min-width:720px}}
  </style></head><body><main><header class="cover"><div class="eyebrow">2026 · DIRECT SITE AUDIT</div><h1>직접 접속 검사 결과 · 점수 산출 보류</h1><div class="url">${escapeHtml(job.inputUrl)}</div><div class="meta"><span>검사 시작 ${job.startedAt ? formatDate(job.startedAt) : '미기록'}</span><span>검사 종료 ${job.completedAt ? formatDate(job.completedAt) : '미기록'}</span><span>규칙 버전 ${escapeHtml(RULESET_VERSION)}</span></div></header>
  <section class="status"><strong>평가 불가 · 승인 가능성 지수 산출 보류</strong><p>${escapeHtml(hold)}</p><p>검색 결과와 캐시 내용은 실제 방문 확인으로 계산하지 않았습니다. 사이트 자체 오류로 단정하지 않고 아래의 접속 실패 기록과 검사 환경을 함께 확인하세요.</p></section>
  <div class="stats"><div class="stat"><strong>0 / ${attempts}</strong><span>직접 확인 성공 URL / 방문 시도 URL</span></div><div class="stat"><strong>${job.discovered.length}</strong><span>발견한 후보 URL</span></div><div class="stat"><strong>${measuredRules} / ${score.ruleScores.length}</strong><span>판정 근거가 있는 규칙 / 전체 규칙 · 점수는 보류</span></div></div>
  <section><h2>실패 원인과 재검사 조치</h2>${diagnosis}<p class="note"><strong>재검사 방법</strong> 관리자 화면에서 이 작업의 ‘새로 재검사’를 누르면 새 작업으로 저장되며 이전 기록과 비교할 수 있습니다. 공개 페이지의 직접 HTML 또는 브라우저 본문을 확인한 뒤에만 점수를 계산합니다.</p></section>
  <section><h2>방문 URL별 직접 접속 결과</h2><p class="guide">응답 없음과 HTML 미수집은 점수에 넣지 않았습니다. 브라우저 화면을 열지 못한 경우도 성공으로 추정하지 않습니다. 긴 브라우저 오류 로그는 관리자 JSON 검증자료에 보존합니다.</p><div class="table-wrap"><table class="simple"><thead><tr><th>요청 URL·최종 URL</th><th>HTTP·응답 시간</th><th>HTML</th><th>브라우저 렌더링</th><th>실패 이유</th></tr></thead><tbody>${pageRows || `<tr><td class="url">${escapeHtml(job.inputUrl)}</td><td>방문 기록 없음</td><td>확인 불가</td><td>미시도</td><td>${escapeHtml(job.signals?.discoveryError ?? job.error ?? '검사 시작 전에 실패했습니다.')}</td></tr>`}</tbody></table></div></section>
  <section><h2>기술 파일 직접 요청 결과</h2><div class="table-wrap"><table class="simple"><thead><tr><th>파일</th><th>요청 URL</th><th>HTTP</th><th>본문</th><th>응답 시간·관찰 내용</th></tr></thead><tbody>${fileRows}</tbody></table></div><p class="muted">본문 있음은 실제로 응답 바이트가 있었다는 뜻입니다. HTTP 오류의 본문은 유효한 기술 파일이 아닌 오류 안내일 수 있습니다. 직접 요청 미기록은 파일이 없다는 뜻이 아닙니다.</p></section>
  <section class="footer"><h2>검색엔진 등록·색인 자가 확인 안내</h2><p>아래는 고객이 직접 확인할 사항이며 AdSense 점수에 반영하지 않았습니다. 등록·제출 상태를 이 보고서가 판정하지 않습니다.</p><table class="simple"><thead><tr><th>서비스</th><th>아직 진행하지 않았다면</th></tr></thead><tbody><tr><td>Google Search Console</td><td>사이트 소유확인 후 사이트맵을 제출하고, 중요한 페이지는 URL 검사에서 상태를 확인하세요. <a href="https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl">공식 안내</a></td></tr><tr><td>Bing Webmaster Tools</td><td>사이트를 추가·확인하고 사이트맵을 제출한 뒤 중요한 URL의 상태를 확인하세요. <a href="https://www.bing.com/webmasters/help/add-and-verify-site-12184f8b">공식 안내</a></td></tr><tr><td>네이버 서치어드바이저</td><td>사이트 소유확인 후 사이트맵을 제출하고 수집·색인 현황을 확인하세요. <a href="https://searchadvisor.naver.com/guide/faq-start-register">공식 안내</a></td></tr></tbody></table><p class="muted">${SEARCH_DISCLAIMER}</p></section>
  </main></body></html>`;
}

export function renderReport(data: ReportData): string {
  const { job, findings, score } = data;
  if (!job.pages.some(hasDirectPageEvidence)) return renderUnavailableReport(data);
  const inspected = job.pages.length;
  const discovered = job.discovered.length;
  const failures = job.pages.filter((page) => Boolean(page.error) || page.statusCode === null || page.statusCode >= 400).length;
  const directlyVerified = job.pages.filter(hasDirectPageEvidence).length;
  const scoredPageCount = new Set(job.pages.filter(hasDirectPageEvidence).map(finalPageKey)).size;
  const failureCategories = new Map<string, number>();
  for (const page of job.pages) {
    const category = page.failureCategory ?? page.http?.failureCategory ?? page.desktopRender?.failureCategory ?? page.mobileRender?.failureCategory ?? (page.error ? 'unknown' : null);
    if (category) failureCategories.set(category, (failureCategories.get(category) ?? 0) + 1);
  }
  const failedReasons = [...failureCategories].map(([category, count]) => `<li><strong>${escapeHtml(failureLabel(category as NonNullable<PageSnapshot['failureCategory']>))} · ${count}건</strong> — ${escapeHtml(retryAction(category as NonNullable<PageSnapshot['failureCategory']>))}</li>`).join('');
  const technicalFiles = job.signals?.technicalFiles;
  const technicalCheckRows = ([
    ['robots.txt', technicalFiles?.robots, job.signals?.robotsUrl],
    ['sitemap.xml', technicalFiles?.sitemap, job.signals ? new URL('/sitemap.xml', job.rootUrl).href : null],
    ['ads.txt', technicalFiles?.ads, job.signals?.adsTxtUrl],
  ] as const).map(([name, file, fallbackUrl]) => `<tr><th scope="row">${escapeHtml(name)}</th><td class="url">${escapeHtml(file?.url ?? fallbackUrl ?? '주소 미확인')}</td><td>${file ? (file.statusCode === null ? '응답 없음' : `HTTP ${file.statusCode}`) : '직접 요청 결과 미기록'}</td><td>${file ? (file.bodyPresent ? '본문 있음' : '본문 없음') : '확인 불가'}</td><td>${file ? `${file.responseTimeMs}ms · ${escapeHtml(formatDate(file.checkedAt))}${file.redirectChain.length ? `<br>리다이렉트 ${escapeHtml(file.redirectChain.map((hop) => `${hop.statusCode} ${hop.url}`).join(' → '))}` : ''}${file.error ? `<br>${escapeHtml(file.error)}` : ''}` : '이전 검사 기록에는 세부 정보가 없습니다.'}</td></tr>`).join('');
  const renderText = (render: PageSnapshot['desktopRender']): string => !render ? '상세 기록 없음' : !render.attempted ? '미시도' : render.success ? `성공 · 본문 ${render.mainTextPresent ? '있음' : '없음'}${render.errorScreen ? ' · 오류 화면 감지' : ''}` : `실패${render.error ? ` · ${render.error}` : ''}`;
  const directRows = job.pages.map((page, index) => {
    const http = page.http;
    const status = http?.statusCode ?? page.statusCode;
    const category = page.failureCategory ?? http?.failureCategory ?? page.desktopRender?.failureCategory ?? page.mobileRender?.failureCategory ?? (page.error ? 'unknown' : undefined);
    const redirects = http?.redirectChain.length ? `<br>경로: ${escapeHtml(http.redirectChain.map((hop) => `${hop.statusCode} ${hop.url}`).join(' → '))} → ${escapeHtml(http.finalUrl)}` : '';
    const reason = category ? `${failureLabel(category)}${page.error ? ` · ${page.error}` : ''}` : page.error ?? '—';
    const htmlCollected = http?.htmlCollected ?? Boolean(page.rawHtml);
    const scannerLimits = page.resourceFailures.filter((failure) => failure.startsWith('검사기 제한:'));
    return `<tr><td>${index + 1}</td><th scope="row" class="url">${escapeHtml(page.url)}${page.finalUrl !== page.url ? `<small>최종 ${escapeHtml(page.finalUrl)}</small>` : ''}</th><td>${status === null ? '응답 없음' : `HTTP ${status}`}${http ? ` · ${http.responseTimeMs}ms` : ' · 세부 요청 기록 없음'}${redirects}<small>${escapeHtml(formatDate(http?.checkedAt ?? page.fetchedAt))}</small></td><td>${htmlCollected ? 'HTML 수집' : 'HTML 미수집'}</td><td><strong>데스크톱</strong> ${escapeHtml(renderText(page.desktopRender))}<br><strong>모바일</strong> ${escapeHtml(renderText(page.mobileRender))}${scannerLimits.length ? `<small>화면 일부 확인 불가: ${escapeHtml(scannerLimits[0])}</small>` : ''}</td><td>${escapeHtml(reason)}</td></tr>`;
  }).join('');
  const isSample = job.mode === 'standard' && discovered > 200;
  const isQuick = job.mode === 'quick';
  const reportTitle = isQuick || isSample ? '애드센스 준비 상태 표본 검사 보고서' : job.mode === 'full' ? '애드센스 준비 상태 전체 검사 보고서' : '애드센스 준비 상태 기본 검사 보고서';
  const methodLabel = isQuick ? '빠른 표본 검사 (최대 20페이지)' : job.mode === 'standard' ? '기본 검사 (최대 200페이지)' : '관리자 전체 검사';
  const scoreText = score.value === null ? '평가 불가' : displayScore(score.value);
  const measuredWeight = Math.max(0, Math.min(100, Number.isFinite(score.measuredWeight) ? score.measuredWeight : 0));
  const verificationRate = score.verificationRate === null ? 0 : Math.max(0, Math.min(100, score.verificationRate));
  const intervalText = displayRange(score.possibleMin, score.possibleMax);
  const rawEstimate = score.measuredWeight > 0
    ? Math.round(1000 * score.earnedWeight / score.measuredWeight) / 10
    : null;
  const criticalFindings = findings.filter((finding) => finding.critical && finding.verdict === 'issue' && finding.sourceKind === 'official');
  const holdReasons = score.holdReason
    ? readableReason(score.holdReason).split(/(?<=[.!?])\s+/).map((reason) => reason.trim()).filter(Boolean)
    : [];
  const uniqueFinalCount = new Set(job.pages.map(finalPageKey)).size;
  const requestedCount = job.mode === 'full' ? '발견 가능 범위 전체' : `${job.limit}개`;
  const mainFindings = findings.filter((finding) => finding.area !== 'technical' && finding.area !== 'manual');
  const technicalFindings = findings.filter((finding) => finding.area === 'technical');
  const manualFindings = findings.filter((finding) => finding.area === 'manual');
  const siteRuleIds = new Set(['access.robots', 'trust.privacy', 'trust.identity', 'trust.notice', 'adsense.connection']);
  const partialLinkFindings = mainFindings.filter((finding) => {
    if (finding.id !== 'navigation.links' || finding.verdict !== 'unknown') return false;
    const match = finding.evidence.match(/^이 페이지의 검사된 링크 (\d+)개 \/ 전체 링크 (\d+)개$/);
    return !!match && Number(match[2]) > Number(match[1]);
  });
  const actionFindings = [...mainFindings, ...technicalFindings]
    .filter((finding) => finding.verdict === 'issue' || finding.verdict === 'caution');
  const actionCard = (finding: Finding, index: number): string => {
    const siteLevel = siteRuleIds.has(finding.id);
    const page = job.pages.find((item) => item.url === finding.pageUrl || item.finalUrl === finding.pageUrl);
    const pageName = siteLevel ? '사이트 공통 설정' : page?.title.trim() || '페이지 이름 확인 필요';
    const level = actionLevel(finding);
    const label = level === 'critical' ? '크리티컬' : level === 'urgent' ? '긴급' : finding.verdict === 'issue' ? '수정 필요' : '수정 검토';
    const issueText = sentence(finding.bad) || `${finding.title} 항목에 개선 신호가 발견됐습니다.`;
    const current = observation(finding);
    const plainAction = finding.action.trim() || '이 페이지를 직접 열어 해당 항목을 확인하고 필요한 부분을 수정하세요.';
    const action = finding.verdict === 'caution' && finding.sourceKind === 'heuristic'
      ? `먼저 이 페이지의 목적과 실제 화면을 사람이 확인하세요. 자동 수치가 낮더라도 페이지 목적을 충족한다면 불필요한 내용을 덧붙이지 마세요. 실제 부족한 부분이 확인될 때만 다음을 적용하세요: ${plainAction}`
      : plainAction;
    const safeSource = safeHttpUrl(finding.sourceUrl);
    const pageLink = safeHttpUrl(finding.pageUrl);
    const decision = finding.verdict === 'caution'
      ? '실제 화면과 페이지 목적을 다시 확인한 뒤 적용 여부를 정하세요. 문제가 재현되지 않거나 현재 구성이 목적에 맞으면 현상 유지를 선택하고 이유를 기록하세요.'
      : '해당 지적이 실제 화면에서도 재현되는지 확인한 뒤 수정하세요. 의도된 동작이라면 동일한 사용자 목적을 충족하는 대안을 검토하세요.';
    const markup = observedPublicMarkup(finding, page);
    const codeEvidence = markup
      ? `검사 시 저장한 공개 HTML에서 다음 부분을 확인했습니다. <code>${escapeHtml(markup)}</code> 코드 저장소에서 이 URL을 생성하는 파일 위치는 별도로 확인해야 합니다.`
      : '저장된 공개 HTML에서 이 항목에 해당하는 짧은 태그·속성을 특정하지 못했습니다. 코드 저장소에서 위치 확인 필요. 서버 구현은 공개 검사만으로 알 수 없습니다.';
    const actionRow = (title: string, body: string, className = '') => `<div class="action-row${className ? ` ${className}` : ''}"><div class="action-label">${title}</div><div class="action-value">${body}</div></div>`;
    return `<article class="action-card ${escapeHtml(finding.verdict)} ${level}"><div class="action-header"><span class="action-number">${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(finding.title)}</h3><span class="action-verdict">${label}</span></div><div class="action-location"><span class="location-label">페이지 주소(페이지 이름)</span><strong>${escapeHtml(pageName)}</strong>${pageLink ? `<a class="url" href="${escapeHtml(pageLink)}">${escapeHtml(finding.pageUrl)}</a>` : `<span class="url">${escapeHtml(finding.pageUrl)}</span>`}${page?.fetchedAt ? `<small>관찰 시각 ${formatDate(page.fetchedAt)} (Asia/Tokyo)</small>` : ''}</div><div class="action-content">
      ${actionRow('현재 상황', escapeHtml(current))}
      ${actionRow('지적 사항', escapeHtml(issueText))}
      ${actionRow('관찰 증거', escapeHtml(finding.evidence || '별도의 상세 증거가 저장되지 않았습니다.'))}
      ${actionRow('공개 HTML', codeEvidence, 'code-evidence')}
      ${actionRow('적용 판단', escapeHtml(decision))}
      ${finding.decisionCondition ? actionRow('판정 조건', escapeHtml(finding.decisionCondition)) : ''}
      ${actionRow('보완 방법', escapeHtml(sentence(action)), 'action-fix')}
      ${actionRow('코드 변경 예시', escapeHtml(codeChangeExample(finding)), 'code-example')}
      ${actionRow('근거·이유', `${escapeHtml(sentence(finding.why))}${safeSource ? ` <a href="${escapeHtml(safeSource)}">참고 근거 보기</a>` : ''} <span class="muted">(${escapeHtml(SOURCE_NAMES[finding.sourceKind])})</span>`)}
      ${actionRow('완료 확인', escapeHtml(completionCheck(finding)), 'action-done')}
    </div></article>`;
  };
  const severitySections = (['critical', 'urgent', 'fix'] as const).map((level) => {
    const labels = {
      critical: ['크리티컬 · 확인된 중대 항목', '공식 정책 관련 문제를 직접 확인했고 규칙에서 중대 항목으로 표시한 경우만 여기에 넣습니다.'],
      urgent: ['긴급 · 공식 근거 확인 항목', '공식 정책에 연결된 문제를 우선 확인하고 수정하세요. 크리티컬 판정과는 구분합니다.'],
      fix: ['수정 필요 · 수정 여부 검토', '자동 검사 지적을 실제 페이지와 대조한 뒤 수정하세요. 주의 항목은 현상 유지가 맞을 수도 있습니다.'],
    }[level];
    const matching = actionFindings.filter((finding) => actionLevel(finding) === level);
    const groups = new Map<string, Finding[]>();
    for (const finding of matching) {
      const key = siteRuleIds.has(finding.id) ? '__site__' : normalizePageUrl(finding.pageUrl) ?? finding.pageUrl;
      groups.set(key, [...(groups.get(key) ?? []), finding]);
    }
    const pages = [...groups.entries()].map(([url, items]) => {
      const siteLevel = url === '__site__';
      const page = siteLevel ? undefined : job.pages.find((item) => finalPageKey(item) === url);
      const link = safeHttpUrl(siteLevel ? job.rootUrl : url);
      const cards = items.sort((a, b) => Number(b.verdict === 'issue') - Number(a.verdict === 'issue') || b.weight - a.weight)
        .map((finding, index) => actionCard(finding, index)).join('');
      return `<section class="action-page"><h3>${siteLevel ? '사이트 공통 설정' : escapeHtml(page?.title.trim() || '페이지 이름 확인 필요')} · ${items.length}건</h3><p class="url">${link ? `<a href="${escapeHtml(link)}">${escapeHtml(siteLevel ? job.rootUrl : url)}</a>` : escapeHtml(siteLevel ? job.rootUrl : url)}</p>${cards}</section>`;
    }).join('');
    return matching.length
      ? `<section class="severity-section severity-${level}"><h2>${labels[0]} · ${matching.length}건</h2><p class="muted">${labels[1]}</p>${pages}</section>`
      : '';
  }).join('');
  const unknownGroups = new Map<string, Finding[]>();
  for (const finding of mainFindings) {
    if (finding.verdict !== 'unknown' || !score.unmeasuredCoreRuleIds.includes(finding.id)) continue;
    unknownGroups.set(finding.id, [...(unknownGroups.get(finding.id) ?? []), finding]);
  }
  const unknownGuide = [...unknownGroups.entries()].map(([id, items]) => {
    const first = items[0];
    const safeSource = safeHttpUrl(first.sourceUrl);
    const rows = items.map((finding) => {
      const pageLink = safeHttpUrl(finding.pageUrl);
      return `<tr><th scope="row" class="url">${pageLink ? `<a href="${escapeHtml(pageLink)}">${escapeHtml(finding.pageUrl)}</a>` : escapeHtml(finding.pageUrl)}</th><td>${escapeHtml(observation(finding))}</td></tr>`;
    }).join('');
    return `<article class="unknown-summary"><h3>${escapeHtml(first.title)} · ${items.length}건</h3><p>이번 공개 검사 자료만으로 이 핵심 항목의 상태를 판정할 수 없습니다. 오류로 단정하거나 자동 수정 대상으로 취급하지 마세요.</p><div class="partial-table"><table class="simple"><thead><tr><th>페이지 주소</th><th>현재 확인한 범위</th></tr></thead><tbody>${rows}</tbody></table></div>${first.bad ? `<p><strong>확인 사유</strong> ${escapeHtml(sentence(first.bad))}</p>` : ''}<p><strong>확인 방법</strong> ${escapeHtml(sentence(first.action))} ${escapeHtml(completionCheck(first))}</p><p><strong>근거·이유</strong> ${escapeHtml(sentence(first.why))}${safeSource ? ` <a href="${escapeHtml(safeSource)}">공식·참고 근거</a>` : ''} (${escapeHtml(SOURCE_NAMES[first.sourceKind])})</p></article>`;
  }).join('');
  const partialLinkRows = partialLinkFindings.map((finding) => {
    const page = job.pages.find((item) => item.url === finding.pageUrl || item.finalUrl === finding.pageUrl);
    const pageLink = safeHttpUrl(finding.pageUrl);
    return `<tr><th scope="row" class="url">${pageLink ? `<a href="${escapeHtml(pageLink)}">${escapeHtml(finding.pageUrl)}</a>` : escapeHtml(finding.pageUrl)}${page?.title ? `<small>${escapeHtml(page.title)}</small>` : ''}</th><td>${escapeHtml(observation(finding))}</td></tr>`;
  }).join('');
  const partialLinkGuide = partialLinkFindings.length ? `<article class="action-card unknown partial-links"><div class="action-header"><span class="action-number">확인</span><h3>미검사 내부 링크의 실제 상태</h3><span class="action-verdict">추가 확인 필요</span></div><div class="action-content"><p><strong>현재 상황</strong><br>${partialLinkFindings.length}개 페이지에서 일부 내부 링크 대상만 실제 방문했습니다. 아래 수치는 각 출발 페이지에서 확인한 링크의 범위입니다.</p><p><strong>지적 사항</strong><br>남은 링크의 정상·오류 여부는 아직 확인되지 않았습니다. 이 단계에서 깨진 링크라고 단정하지 마세요.</p><div class="partial-table"><table class="simple"><thead><tr><th>페이지 주소(페이지 이름)</th><th>관찰 증거</th></tr></thead><tbody>${partialLinkRows}</tbody></table></div><p class="action-fix"><strong>확인 방법</strong><br>아직 열어 보지 않은 내부 링크 대상을 실제로 방문해 최종 URL과 HTTP 상태를 확인하세요. 404/410 등 확정된 실패만 원본 페이지에서 수정하거나 제거하세요.</p><p><strong>근거·이유</strong><br>미검사 링크를 오류로 추정하면 잘못된 수정 요청이 됩니다. <a href="https://developers.google.com/search/docs/crawling-indexing/links-crawlable">https://developers.google.com/search/docs/crawling-indexing/links-crawlable</a> (채점기 자체 기준)</p></div></article>` : '';
  const unknownCount = findings.filter((finding) => finding.verdict === 'unknown').length;
  const naCount = findings.filter((finding) => finding.verdict === 'na').length;
  const displayedAreaTotal = Object.values(score.areaScores).reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const scorecardRows = (Object.keys(AREA_MAX) as Array<keyof typeof AREA_MAX>).map((area) => {
    const rows = score.ruleScores.filter((row) => row.area === area);
    const earned = rows.reduce((sum, row) => sum + row.earnedWeight, 0);
    const measured = rows.reduce((sum, row) => sum + row.measuredWeight, 0);
    const notApplicable = rows.reduce((sum, row) => sum + row.nonApplicableWeight, 0);
    const applicable = AREA_MAX[area] - notApplicable;
    const index = measured > 0 ? 100 * earned / measured : null;
    const areaResult = applicable <= 0 ? '해당 없음' : measured > 0 && index !== null ? `${index.toFixed(1)}/100` : '미검증';
    return `<tr><th scope="row">${AREA_NAMES[area]}</th><td>${AREA_MAX[area]}점</td><td>${AREA_CRITERIA[area]}</td><td><strong>${escapeHtml(areaResult)}</strong></td></tr>`;
  }).join('');
  const areaRows = (Object.keys(AREA_MAX) as Array<keyof typeof AREA_MAX>).map((area) => {
    const value = score.areaScores[area];
    const formatted = value === null || !Number.isFinite(value) ? '산출 불가' : Number.isInteger(value) ? String(value) : value.toFixed(1);
    const progress = value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value / AREA_MAX[area] * 100));
    return `<tr><th scope="row">${AREA_NAMES[area]}</th><td class="area-value">${formatted} / ${AREA_MAX[area]}</td><td class="area-chart"><span class="bar-track"><span class="bar-fill" style="width:${progress.toFixed(1)}%"></span></span></td></tr>`;
  }).join('');
  const scoreExplanation = score.holdReason
    ? `<section class="score-interpretation warning"><h2>평가 불가: 이유와 다음 확인 항목</h2><p>직접 접속한 HTML이나 본문이 보이는 브라우저 화면에서 채점 근거를 확보하지 못해 숫자 성적표를 표시하지 않습니다.</p><ul class="reason-list">${holdReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul><p>접근 가능한 페이지와 적용 규칙을 다시 확인하세요. 숫자를 억지로 만들면 실제 승인 가능성을 오해하게 합니다.</p></section>`
    : `<section class="score-interpretation${score.verificationRate !== null && score.verificationRate < 90 ? ' warning' : ''}"><h2>확인분 성적표 해석 · ${escapeHtml(grade(score.value))}등급</h2><p><strong>${scoreText}/100점 · 비공식 승인 가능성 추정 지수 ${scoreText}%</strong>입니다. 실제 판정한 배점 W ${displayWeight(score.measuredWeight)}점에서 획득 E ${displayWeight(score.earnedWeight)}점을 확인해 100 × E ÷ W로 환산했습니다. 미확인 U ${displayWeight(score.unknownWeight)}점에는 가정 점수를 넣지 않았습니다.</p><p>검증률은 ${displayRate(score.verificationRate)}(W ÷ T)이며 적용 가능한 배점 T는 ${displayWeight(score.applicableWeight)}점입니다. 미확인 항목을 실제로 판정하면 전체 확인 후 점수는 ${intervalText} 범위에서 바뀔 수 있습니다. 이 구간은 현재 확인분 점수의 오차 범위가 아닙니다.${score.unmeasuredCoreRuleIds.length ? ` 핵심 미확인 항목: ${score.unmeasuredCoreRuleIds.map((id) => escapeHtml(RULES[id]?.title ?? id)).join(', ')}.` : ''}</p>${score.criticalCapApplied ? `<p class="critical-cap"><strong>중대 문제 상한 적용:</strong> 공식 정책 관련 문제 때문에 확인분 산식 원값 ${rawEstimate?.toFixed(1) ?? '산출 불가'}점 대신 ${scoreText}점을 표시했습니다. 확인 근거: ${criticalFindings.map((item) => `${escapeHtml(item.title)} (${escapeHtml(item.pageUrl)})${safeHttpUrl(item.sourceUrl) ? ` · <a href="${escapeHtml(item.sourceUrl)}">공식 근거</a>` : ''}`).join('; ')}.</p>` : ''}<p>이 지수와 등급은 자체 기준에 따른 준비 상태 표현입니다. 실제 Google 승인 확률이나 심사 결과가 아닙니다.</p></section>`;
  const holdSummary = score.holdReason
    ? `<p class="score-alert"><strong>평가 불가 이유</strong> ${escapeHtml(readableReason(score.holdReason))} 미확인 ${displayWeight(score.unknownWeight)}점의 확인이 필요합니다.</p>`
    : '';

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(reportTitle)} — ${escapeHtml(job.host)}</title>
<style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#152c39;background:#edf2f3;font-size:13px;line-height:1.55}
  *{box-sizing:border-box}html{print-color-adjust:exact;-webkit-print-color-adjust:exact}body{margin:0;padding:28px}main{max-width:1280px;margin:auto;background:#fff;padding:34px 42px 42px;box-shadow:0 15px 50px #14333e15}p{margin:8px 0}a{color:#087e85;text-decoration-thickness:1px;text-underline-offset:2px}small,.muted{color:#617580}.muted,.url{overflow-wrap:anywhere}.empty-value{color:#9aa9ae}.empty{padding:12px 16px;border:1px dashed #cbd9dd;border-radius:10px;color:#627780;background:#f7faf9}.eyebrow{font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:#82e3d1}.cover{background:linear-gradient(120deg,#102c3a 0%,#173d4b 72%,#176c70 100%);color:#fff;border-radius:18px;padding:25px 29px 24px;position:relative;overflow:hidden}.cover::after{content:"";position:absolute;width:190px;height:190px;border-radius:50%;border:34px solid #ffffff0a;right:-60px;top:-95px}.cover h1{font-size:28px;line-height:1.23;letter-spacing:-.035em;margin:10px 0 12px}.cover .target{font-size:15px;font-weight:700;overflow-wrap:anywhere;margin:0 0 12px}.cover .meta{display:flex;flex-wrap:wrap;gap:5px 18px;color:#d8e9e8;font-size:11px}.cover .meta strong{color:#fff}.notice{border-left:5px solid #dc8d25;background:#fff2da;color:#694417;padding:11px 15px;margin:0 0 16px;font-weight:700;border-radius:0 10px 10px 0}.hero{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0}.metric{border:1px solid #dce8e8;background:#f6faf9;border-radius:12px;padding:12px 15px;min-width:0}.metric strong{display:block;font-size:25px;line-height:1.13;color:#0b4a58;font-variant-numeric:tabular-nums}.metric span{display:block;font-size:11px;color:#526c76;margin-top:5px}.metric.primary{background:#e4f5f1;border-color:#b6e8dc}.metric.primary strong{color:#07574d}.metric.warn{background:#fff5e7;border-color:#f1d5ac}.metric.warn strong{color:#955600}.coverage{padding:13px 16px;background:#f2f8f7;border:1px solid #d4e9e6;border-radius:12px;margin:14px 0}.coverage-head{display:flex;justify-content:space-between;gap:12px;align-items:center;font-size:12px}.coverage-head strong{color:#07574d;font-size:13px}.coverage-track,.bar-track{display:block;background:#d9e4e7;border-radius:20px;overflow:hidden}.coverage-track{height:8px;margin:8px 0 5px}.coverage-fill,.bar-fill{display:block;height:100%;background:#13a391;border-radius:20px}.coverage p{margin:3px 0 0;color:#556e76;font-size:11px}.caveat{border:1px solid #d7e4e4;padding:11px 14px;background:#f9fcfc;border-radius:10px;color:#405a63}.caveat.warning{border-color:#eac994;background:#fff9ed;color:#6b4e21}h2{font-size:18px;line-height:1.25;color:#153b49;margin:27px 0 10px;border-bottom:2px solid #b5dcd9;padding-bottom:7px}h3{font-size:15px;margin:0;line-height:1.35;overflow-wrap:anywhere}h4{font-size:13px;line-height:1.35;margin:2px 0 0;color:#1a3440}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px;align-items:start}.panel{border:1px solid #e1ebec;border-radius:12px;padding:0 15px 12px}.panel h2{margin-top:15px}.simple{border-collapse:collapse;width:100%;font-size:12px}.simple td,.simple th{padding:9px 7px;border-bottom:1px solid #e2eaea;text-align:left;vertical-align:top}.simple tr:last-child td,.simple tr:last-child th{border-bottom:0}.simple th{font-weight:700;color:#294b57}.area-value{text-align:right!important;white-space:nowrap;font-weight:700;font-variant-numeric:tabular-nums}.area-chart{width:27%}.bar-track{height:7px;min-width:65px}.bar-fill{background:#20a493}.scope-list{list-style:none;padding:0;margin:4px 0 0}.scope-list li{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #e2eaea}.scope-list li:last-child{border:0}.scope-list strong{text-align:right}.scope-note{font-size:11px;line-height:1.5;color:#617580}.priority-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;list-style:none;padding:0;margin:0}.priority-item{border:1px solid #e5e9e8;border-left:4px solid #d29137;background:#fffdfa;border-radius:10px;padding:10px 13px}.priority-item.issue{border-left-color:#d75b52;background:#fffafa}.priority-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.priority-top strong{font-size:13px;color:#23414b}.priority-item p{font-size:11px;margin:5px 0}.priority-url{font-size:10px;color:#5d747c;overflow-wrap:anywhere}.badge{display:inline-block;border-radius:30px;padding:3px 9px;white-space:nowrap;font-size:10px;font-weight:800;line-height:1.45;background:#edf0f2;color:#51636c}.badge-good{background:#dcf4e8;color:#126544}.badge-caution{background:#ffedd0;color:#855100}.badge-issue{background:#ffe3df;color:#a8332e}.badge-unknown,.badge-na{background:#e9eef0;color:#526874}.page-section{margin:20px 0 27px;break-inside:auto}.page-heading{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:11px;align-items:start;background:#edf6f4;padding:12px 14px;border-left:4px solid #1b9b8d;border-radius:0 11px 11px 0;break-after:avoid-page}.page-index{font-size:10px;letter-spacing:.08em;font-weight:900;color:#0c756d;margin-top:3px}.page-heading p{font-size:10px;margin:4px 0 0}.page-counts{font-size:10px;font-weight:700;color:#4f686f;white-space:nowrap}.finding-list{display:grid;gap:8px;margin-top:10px}.finding-card{border:1px solid #dce6e8;border-left:4px solid #b8c8ca;border-radius:9px;overflow:hidden;break-inside:avoid-page;background:#fff}.finding-good{border-left-color:#44b984}.finding-caution{border-left-color:#e6ad4e}.finding-issue{border-left-color:#da6a61}.finding-head{display:flex;justify-content:space-between;gap:12px;align-items:center;background:#f7faf9;padding:7px 11px}.finding-id{font-size:9px;letter-spacing:.035em;color:#70848c;font-weight:700}.finding-detail{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px;line-height:1.43}.finding-detail th,.finding-detail td{border-top:1px solid #e8eeee;padding:5px 8px;vertical-align:top;overflow-wrap:anywhere}.finding-detail th{width:12%;text-align:left;color:#46626c;font-size:9px;font-weight:800;background:#fbfcfc}.finding-detail td{width:38%}.finding-detail tr:last-child th,.finding-detail tr:last-child td{padding-bottom:7px}.manual-list{margin:7px 0 10px;padding-left:20px}.manual-list li{margin:3px 0}.footer{margin-top:31px;border-top:4px solid #117f78;padding-top:1px}.footer .simple th:first-child,.footer .simple td:first-child{width:27%}@media(max-width:760px){body{padding:12px}main{padding:18px}.cover{padding:20px}.hero{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.priority-list{grid-template-columns:1fr}.page-heading{grid-template-columns:auto 1fr}.page-counts{grid-column:2}.finding-detail th{width:16%}.finding-detail td{width:34%}}
  .finding-card.compact{border-left-width:3px}.compact .finding-head{padding:4px 8px}.compact h4{font-size:11px;margin:0}.compact .finding-id{font-size:8px}.compact .badge{font-size:8px;padding:1px 6px}.compact .finding-detail{font-size:9.5px;line-height:1.28}.compact .finding-detail th,.compact .finding-detail td{padding:2px 6px}.compact .finding-detail th{font-size:8.5px}.compact .finding-detail tr:last-child th,.compact .finding-detail tr:last-child td{padding-bottom:3px}
  .hero{grid-template-columns:repeat(3,minmax(0,1fr))}.action-intro{font-size:13px;color:#375360}.action-card{border:1px solid #e0e8e9;border-left:5px solid #de9b3e;border-radius:11px;margin:13px 0;background:#fff;overflow:hidden;break-inside:avoid-page}.action-card.issue{border-left-color:#d85d56}.action-card.unknown{border-left-color:#758a94}.action-header{display:flex;align-items:center;gap:10px;background:#f5f9f9;padding:11px 14px}.action-header h3{font-size:16px;flex:1}.action-number{font-size:13px;font-weight:900;color:#107d76}.action-verdict{font-size:11px;font-weight:800;padding:3px 9px;border-radius:15px;background:#ffedd0;color:#805000}.action-card.issue .action-verdict{background:#ffe1dc;color:#a9312a}.action-card.unknown .action-verdict{background:#e9eef0;color:#4f6671}.action-content{padding:9px 15px 12px;font-size:12px;line-height:1.5}.action-content p{margin:8px 0}.action-content strong{color:#1c4a54;font-size:11px}.action-content a{overflow-wrap:anywhere}.action-fix{background:#eaf8f4;padding:9px 11px;border-radius:7px}.action-done{border-top:1px solid #e5eded;padding-top:8px;color:#526b74}.partial-links{break-inside:auto}.partial-table{margin:9px 0;border:1px solid #e1e9ea;border-radius:8px;overflow:hidden}.partial-table .simple{font-size:10px}.partial-table .simple th,.partial-table .simple td{padding:5px 8px}.partial-table .simple th:first-child{width:53%}.partial-table small{display:block;font-size:9px}.rule-matrix-wrap{overflow-x:auto;border:1px solid #dce7e9;border-radius:10px}.rule-matrix{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}.rule-matrix th,.rule-matrix td{padding:6px 5px;border-bottom:1px solid #e4ebed;vertical-align:top;text-align:left;overflow-wrap:anywhere}.rule-matrix thead th{background:#eaf4f2;color:#23505a;font-size:10px}.rule-matrix tbody tr:nth-child(even){background:#f9fbfb}.rule-matrix tbody th{width:31%}.rule-matrix tbody th strong{display:block}.rule-matrix tbody th small{display:block;font-size:8px;font-weight:400;line-height:1.4}.rule-matrix td{font-variant-numeric:tabular-nums}.rule-matrix .ledger-total td,.rule-matrix .ledger-total th{background:#dff0ec;font-weight:900}.ledger-note{font-size:11px;color:#556e76}.ledger-note strong{color:#1c4a54}
  .unknown-summary{border:1px solid #d9e3e6;border-left:5px solid #768e96;border-radius:10px;padding:12px 15px;margin:12px 0;background:#f9fbfb;break-inside:avoid-page}.unknown-summary h3{color:#31515c}.unknown-summary p{font-size:12px}.unknown-summary .partial-table{background:#fff}.page-list{table-layout:fixed;font-size:10.5px;line-height:1.42}.page-list th,.page-list td{padding:7px 8px;overflow-wrap:anywhere}.page-list thead th{background:#eaf4f2;color:#23505a}.page-list th:nth-child(1),.page-list td:nth-child(1){width:5%}.page-list th:nth-child(2){width:44%}.page-list th:nth-child(3){width:29%}.page-list th:nth-child(4){width:22%}.page-list tbody tr:nth-child(even){background:#f8fbfa}.page-list .url strong{color:#173d4b}.page-list small,.tech-list small{display:block;font-size:9px;line-height:1.35}.page-no{font-size:12px;color:#168779;font-weight:900}.page-verdicts b{display:inline-block;margin:0 4px 3px 0;font-size:9px}.text-issue{color:#aa3930}.text-caution{color:#945a05}.text-unknown{color:#506a76}.tech-list{font-size:10.5px}.tech-list th:first-child{width:18%}.tech-list td:nth-child(2){width:46%}.tech-list .url{line-height:1.4}
  .hero{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.metric{min-height:92px;padding:14px 16px}.metric strong{font-size:24px;line-height:1.18}.metric span{font-size:12px;line-height:1.45;margin-top:8px;color:#405b65}.score-interpretation{margin:15px 0 8px;padding:17px 20px;border:1px solid #c9e1dd;border-left:5px solid #13887c;border-radius:10px;background:#f3faf8;break-inside:avoid-page}.score-interpretation.warning{border-color:#efd5a7;border-left-color:#bd751e;background:#fff9ee}.score-interpretation h2{font-size:17px;border:0;margin:0 0 9px;padding:0;color:#193d49}.score-interpretation p{font-size:13px;line-height:1.6;margin:9px 0}.score-interpretation .reason-list{margin:9px 0 12px;padding-left:22px;font-size:13px;line-height:1.55}.reason-list li{margin:4px 0}.score-footnote{font-size:11px;line-height:1.55;color:#556c75;margin:8px 0 18px}.action-card{margin:18px 0;border-radius:12px;break-inside:auto}.action-header{padding:14px 18px;break-after:avoid-page}.action-header h3{font-size:17px}.action-number{font-size:14px}.action-verdict{font-size:12px}.action-location{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:13px 18px 14px;background:#f8fbfa;border-bottom:1px solid #dce8e7;break-after:avoid-page}.action-location .location-label{font-size:11px;font-weight:800;color:#14786f;letter-spacing:.02em}.action-location strong{font-size:15px;color:#183d49}.action-location .url{font-size:12.5px;line-height:1.45}.action-location small{font-size:10.5px;color:#546d76;margin-top:3px}.action-content{padding:0 18px 9px;font-size:13.5px;line-height:1.6}.action-row{display:grid;grid-template-columns:105px minmax(0,1fr);gap:16px;padding:12px 3px;border-bottom:1px solid #e3eceb;break-inside:avoid-page}.action-row:last-child{border-bottom:0}.action-label{font-size:12px;font-weight:800;color:#196c68;padding-top:1px}.action-value{font-size:13.5px;color:#233943;overflow-wrap:anywhere}.action-fix{background:#eaf8f4;border-radius:8px;padding:14px 12px;margin:7px 0}.action-done{border-top:0;color:#233943}.action-intro{font-size:13px;line-height:1.65}.unknown-summary p{font-size:13px;line-height:1.6}
  .score-alert{border-left:4px solid #bd751e;background:#fff8e9;color:#513c1f;border-radius:0 8px 8px 0;padding:10px 14px;margin:11px 0;font-size:12.5px;line-height:1.55}.score-alert strong{display:block;font-size:13px;color:#754910;margin-bottom:2px}
  .hero{grid-template-columns:repeat(3,minmax(0,1fr))}.metric.index{border-color:#99d8ce;background:#e4f6f2}.metric.index strong{color:#09675e}.grade-chip{display:inline-block;margin-left:10px;padding:3px 10px;border-radius:20px;background:#d7f3e9;color:#155c51;font-size:13px;vertical-align:middle}.scorecard{margin:12px 0;border:1px solid #d5e5e2;border-radius:10px;break-inside:auto}.scorecard h2{font-size:16px;margin:0;padding:10px 12px;border:0;background:#eaf6f2}.scorecard table{width:100%;border-collapse:collapse;font-size:13.5px}.scorecard th,.scorecard td{padding:9px 8px;border-top:1px solid #e4eeeb;text-align:left}.scorecard thead{display:table-header-group}.scorecard thead th{background:#f7fbf9;color:#46636a}.scorecard tbody tr:nth-child(even){background:#fbfdfc}.scorecard p{padding:8px 10px;margin:0;color:#536a70;font-size:12.5px}.critical-cap{border-left:4px solid #b53c37;padding:6px 10px;background:#fff1ef}
  @media(max-width:760px){.hero{grid-template-columns:repeat(2,1fr)}.action-header h3{font-size:14px}}
  @media print{:root,html,body{background:#fff}body{padding:0}main{max-width:none;padding:0;box-shadow:none}.cover{border-radius:0}.hero,.grid,.coverage,.notice,.caveat,.priority-item,.page-heading{break-inside:avoid-page}.action-card{break-inside:avoid-page}.action-card.partial-links{break-inside:auto}.unknown-summary+.partial-links{break-before:page}.partial-links .action-header{break-after:avoid-page}.finding-card{break-inside:avoid-page}.finding-list{gap:6px}.page-section{margin:17px 0 20px}h2{break-after:avoid-page;margin-top:21px}.panel{break-inside:avoid-page}.simple tr,.finding-detail tr,.rule-matrix tr{break-inside:avoid-page}.rule-matrix thead{display:table-header-group}a{color:#087e85}.footer{break-before:auto}}
  @media(max-width:760px){.action-row{grid-template-columns:1fr;gap:3px}.action-content{padding:0 14px 7px}.action-location{padding:12px 14px}.action-card{margin:14px 0}}
  .direct-evidence{font-size:10px;line-height:1.42;table-layout:fixed}.direct-evidence th,.direct-evidence td{padding:7px 6px;overflow-wrap:anywhere}.direct-evidence thead th{background:#eaf4f2}.direct-evidence th:nth-child(2){width:31%}.direct-evidence td:nth-child(3){width:23%}.direct-evidence td:nth-child(5){width:22%}.direct-evidence small{display:block;color:#627780}.failure-reasons{padding-left:22px;line-height:1.65}.direct-summary{padding:11px 14px;background:#eaf7f4;border-left:4px solid #168779;border-radius:0 8px 8px 0}.direct-summary.warning{background:#fff6e7;border-left-color:#bd751e}
  @media print{.action-cards{break-before:page}.action-card{break-inside:avoid-page}.action-row{break-inside:avoid-page}.action-header,.action-location,h3{break-after:avoid-page}.score-interpretation,.score-alert{break-inside:avoid-page}}
  .report-first-page{margin:0 0 28px}.report-first-page .hero{grid-template-columns:1.25fr 1fr}.report-first-page .metric{min-height:84px}.report-first-page .metric.primary strong{font-size:33px}.report-first-page .scorecard{margin:12px 0}.report-first-page .scorecard h2{font-size:17px}.report-first-page .scorecard table{font-size:11px;line-height:1.35;table-layout:fixed}.report-first-page .scorecard th,.report-first-page .scorecard td{padding:6px 8px}.report-first-page .scorecard th:nth-child(1){width:18%}.report-first-page .scorecard th:nth-child(2){width:9%}.report-first-page .scorecard th:nth-child(3){width:57%}.report-first-page .scorecard th:nth-child(4){width:16%}.report-first-page .score-total{background:#dff0ec;font-weight:900}.first-page-note{border:1px solid #d8e9e6;border-radius:9px;padding:9px 13px;background:#f8fbfa;font-size:11px;color:#3f5b62}.first-page-note p{margin:3px 0}.severity-section{margin:22px 0 30px}.severity-section h2{margin-bottom:5px}.severity-critical h2{border-color:#d9574e;color:#9d2925}.severity-urgent h2{border-color:#df9f42;color:#805111}.action-page{margin:15px 0 25px}.action-page>h3{background:#edf6f4;border-left:4px solid #168779;padding:9px 12px;border-radius:0 8px 8px 0}.action-page>.url{font-size:11px;margin:4px 0 8px;padding-left:12px}.action-card.critical{border-left-color:#a92d28}.action-card.critical .action-verdict{background:#fbd5d2;color:#8f1918}.action-card.urgent{border-left-color:#d27525}.action-card.urgent .action-verdict{background:#ffead2;color:#854500}.action-row code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#edf3f4;border:1px solid #dce6e8;border-radius:6px;padding:7px 9px;margin:5px 0}.code-example .action-value{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;background:#f1f7f4;border-radius:6px;padding:8px 10px}.code-evidence .action-value{font-size:12px}
  .severity-empty{border-left:3px solid #aebec1;background:#f7faf9;padding:6px 10px;margin:7px 0;font-size:11px;color:#526970}.severity-empty strong{color:#2a4c58}.action-guide>.action-intro{font-size:11.5px;line-height:1.45}.severity-section{margin:13px 0 20px}.severity-section>p.muted{font-size:11px;margin:4px 0}.action-page{margin:10px 0 17px}.action-card{margin:9px 0}.action-header{padding:8px 13px}.action-header h3{font-size:14px}.action-location{padding:7px 13px}.action-location strong{font-size:13px}.action-location small{font-size:9px}.action-content{padding:0 13px 5px}.action-row{grid-template-columns:92px minmax(0,1fr);gap:10px;padding:6px 2px}.action-label{font-size:10.5px}.action-value{font-size:11.5px;line-height:1.4}.code-evidence .action-value{font-size:11px}.code-example .action-value{font-size:10.5px;padding:5px 8px}.action-row code{font-size:10px;line-height:1.35;padding:5px 7px}
  @media print{.report-first-page{break-after:page;margin-bottom:0}.report-first-page .scorecard{break-inside:avoid-page}.severity-section>h2,.action-page>h3{break-after:avoid-page}.action-page{break-inside:auto}}
  @media print{.action-guide>h2{margin-top:8px}.action-guide>.action-intro{margin:3px 0 6px}.severity-section{margin:6px 0 12px}.severity-section>p.muted{margin:2px 0}.action-page{margin:5px 0 10px}.action-page>h3{padding:6px 10px}.action-page>.url{margin:2px 0 4px}.action-card{margin:5px 0}.action-header{padding:6px 12px}.action-location{padding:5px 12px}.action-content{padding:0 12px 3px}.action-row{padding:4px 2px}.footer{break-inside:avoid-page}}
</style></head><body><main>

<section class="report-first-page">
${isQuick ? `<div class="notice">${escapeHtml(QUICK_SCOPE_TEXT)}</div>` : isSample ? `<div class="notice">${SAMPLE_NOTICE}</div>` : ''}
<header class="cover"><div class="eyebrow">2026 · ADSENSE READINESS AUDIT</div><h1>${escapeHtml(reportTitle)}</h1><p class="target">${escapeHtml(job.inputUrl)}</p><div class="meta"><span><strong>검사일</strong> ${formatDate(data.generatedAt)} (Asia/Tokyo)</span><span><strong>검사 방식</strong> ${methodLabel}</span><span><strong>규칙 버전</strong> ${escapeHtml(RULESET_VERSION)}</span><span><strong>방문 시도</strong> ${inspected}건 · 직접 확인 ${directlyVerified}건</span></div></header>
<div class="hero"><div class="metric primary"><strong>${score.value === null ? '평가 불가' : `${scoreText}/100점`} ${score.value === null ? '' : `<small class="grade-chip">${grade(score.value)}등급</small>`}</strong><span>이번에 직접 확인한 고유 ${scoredPageCount}페이지의 통합 점수</span></div><div class="metric index"><strong>${score.value === null ? '평가 불가' : `${scoreText}%`}</strong><span>비공식 승인 가능성 추정 지수 · 실제 승인 확률 아님</span></div></div>
<section class="scorecard"><h2>100점 채점 기준 · 5개 영역</h2><table><thead><tr><th>영역</th><th>배점</th><th>세부 기준</th><th>이번 검사 지수</th></tr></thead><tbody>${scorecardRows}<tr class="score-total"><th scope="row">합계</th><td>100점</td><td>확인한 항목만 합산해 100점 기준으로 환산</td><td><strong>${score.value === null ? '평가 불가' : `${scoreText}/100`}</strong></td></tr></tbody></table></section>
<div class="first-page-note"><p><strong>계산 범위:</strong> 방문 시도 ${inspected}건 중 직접 확인 ${directlyVerified}건 · 발견 후보 ${discovered}개 · 고유 최종 URL ${uniqueFinalCount}개. 확인한 규칙의 획득 E ${displayWeight(score.earnedWeight)} / 판정 배점 W ${displayWeight(measuredWeight)}를 환산한 결과가 위의 통합 ${score.value === null ? '평가 불가' : `${scoreText}/100점`}입니다.</p><p><strong>검증률:</strong> ${displayRate(score.verificationRate)} · 미확인 배점 ${displayWeight(score.unknownWeight)}점 · 전체 확인 시 가능한 점수 구간 ${intervalText}. 미확인 항목은 감점하지 않았고, 이 지수는 Google의 실제 승인 확률이 아닙니다.</p></div>
${holdSummary}
</section>
<section class="action-guide"><h2>페이지별 수정 목록</h2><p class="action-intro">확인된 조치 항목만 싣습니다. 공개 HTML과 현재 소스 파일을 대조한 뒤 필요한 부분만 고치고, 데스크톱·모바일에서 다시 확인하세요. 소스 파일명과 서버 구현은 공개 검사만으로 알 수 없습니다.</p>${severitySections || '<p class="empty">이번 검사에서 확인된 수정 항목은 없습니다.</p>'}</section>
<section class="unknown-guide"><h2>추가 확인 필요 · 오류로 단정하지 마세요</h2><p class="muted">측정하지 못한 핵심 항목과 방문하지 않은 링크 대상은 상태 확인부터 진행하세요. 확인 전에는 사이트 수정 요청으로 취급하지 않습니다.</p>${unknownGuide}${partialLinkGuide}${!unknownGuide && !partialLinkGuide ? '<p class="empty">별도로 확인할 핵심 미측정 항목이나 일부만 검사한 내부 링크가 없습니다.</p>' : ''}</section>
<section><h2>직접 접속·기술 파일·브라우저 검증 기록</h2><p class="direct-summary${directlyVerified ? '' : ' warning'}"><strong>실제 접속으로 HTML 또는 본문 화면을 확인한 URL ${directlyVerified}/${inspected}건</strong> · 발견 후보 ${discovered}개. 검색 색인·캐시는 이 수에 포함하지 않았습니다. 직접 확인하지 못한 항목은 사이트 오류로 단정하지 마세요.</p><p>검사 시작 ${job.startedAt ? formatDate(job.startedAt) : '미기록'} · 종료 ${job.completedAt ? formatDate(job.completedAt) : '미기록'} (Asia/Tokyo). 브라우저별 상세 상태가 없는 이전 검사 기록은 성공·실패를 추측하지 않습니다.</p><h3>기술 파일 직접 요청</h3><table class="simple direct-evidence"><thead><tr><th>파일</th><th>요청 URL</th><th>HTTP</th><th>본문</th><th>시각·응답·실패 이유</th></tr></thead><tbody>${technicalCheckRows}</tbody></table><p>본문 있음은 응답 바이트가 있었다는 뜻이며, HTTP 오류라면 유효한 기술 파일이 아닌 오류 안내일 수 있습니다.</p><h3>URL별 요청·렌더링</h3>${directRows ? `<table class="simple direct-evidence"><thead><tr><th>번호</th><th>방문 요청 URL·최종 URL</th><th>HTTP·응답 시간·리다이렉트</th><th>원본 HTML</th><th>데스크톱 / 모바일</th><th>실패 분류</th></tr></thead><tbody>${directRows}</tbody></table>` : '<p class="empty">직접 방문을 시도해 저장한 페이지가 없습니다.</p>'}${failedReasons ? `<h3>실패별 재검사 방법</h3><ul class="failure-reasons">${failedReasons}</ul>` : ''}</section>

<section class="method-appendix"><h2>검사 범위와 점수 계산 상세</h2>${scoreExplanation}<div class="coverage"><div class="coverage-head"><strong>점수 검증 범위</strong><span>검증률 ${displayRate(score.verificationRate)} · W ${displayWeight(measuredWeight)} / T ${displayWeight(score.applicableWeight)}</span></div><span class="coverage-track"><span class="coverage-fill" style="width:${verificationRate.toFixed(1)}%"></span></span><p>비적용 A ${displayWeight(score.nonApplicableWeight)} · 적용 T ${displayWeight(score.applicableWeight)} · 검증 W ${displayWeight(measuredWeight)} · 획득 E ${displayWeight(score.earnedWeight)} · 미확인 U ${displayWeight(score.unknownWeight)}. A + W + U = 100점입니다.</p></div><div class="grid"><section class="panel"><h2>영역별 획득 배점 E</h2><table class="simple"><tbody>${areaRows}</tbody></table><p class="scope-note">영역별 표시값 합계 ${displayedAreaTotal.toFixed(1)}점(E 원계산 ${displayWeight(score.earnedWeight)}점) / 판정 배점 W ${displayWeight(score.measuredWeight)}점. 총점은 100 × E ÷ W로 계산합니다. 미확인 U는 감점하지 않았습니다. 확인 불가 ${unknownCount}건 · 해당 없음 ${naCount}건입니다.</p></section><section class="panel"><h2>검사 범위</h2><ul class="scope-list"><li><span>설정한 검사 한도</span><strong>${requestedCount}</strong></li><li><span>발견한 후보 URL</span><strong>${discovered}개</strong></li><li><span>저장된 방문 시도</span><strong>${inspected}건</strong></li><li><span>직접 확인 URL</span><strong>${directlyVerified}건</strong></li><li><span>고유 최종 URL</span><strong>${uniqueFinalCount}개</strong></li><li><span>접근 실패·오류</span><strong>${failures}건</strong></li></ul><p class="scope-note">사이트맵: ${job.signals?.discoveryMethod === 'links-only' ? '확인되지 않아 내부 링크에서 발견한 범위만 검사' : '사이트맵과 내부 링크에서 발견'}</p><p class="scope-note">제외 경로: ${job.excludedPaths.length ? job.excludedPaths.map(escapeHtml).join(', ') : '없음'}</p></section></div><p class="ledger-note">적용 T = 100 − 비적용 A, 미확인 U = T − 검증 W, 검증률 = 100W ÷ T. 실제 감점이 반올림으로 사라지면 99.9점으로 표시합니다. 가능한 총점 구간은 상한 적용 전 100E ÷ T ~ 100(E + U) ÷ T입니다. 공식 정책의 확인된 중대 문제에는 39점 상한을 적용합니다. 실제 Google 승인 확률은 공개 페이지 검사만으로 산출할 수 없습니다. 규칙별 세부 판정과 양호 항목은 관리자 JSON에 보존합니다.</p></section>
<section class="footer"><h2>검색엔진 등록·색인 자가 확인 안내</h2><p>아래는 고객이 직접 확인할 사항이며 AdSense 점수에 반영하지 않았습니다. 등록·제출 상태를 이 보고서가 판정하지 않습니다.</p><table class="simple"><thead><tr><th>서비스</th><th>아직 진행하지 않았다면</th></tr></thead><tbody><tr><td>Google Search Console</td><td>사이트 소유확인 후 사이트맵을 제출하고, 중요한 페이지는 URL 검사에서 상태를 확인하세요. <a href="https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl">공식 안내</a></td></tr><tr><td>Bing Webmaster Tools</td><td>사이트를 추가·확인하고 사이트맵을 제출한 뒤 중요한 URL의 상태를 확인하세요. <a href="https://www.bing.com/webmasters/help/add-and-verify-site-12184f8b">공식 안내</a></td></tr><tr><td>네이버 서치어드바이저</td><td>사이트 소유확인 후 사이트맵을 제출하고 수집·색인 현황을 확인하세요. <a href="https://searchadvisor.naver.com/guide/faq-start-register">공식 안내</a></td></tr></tbody></table><p class="caveat">${SEARCH_DISCLAIMER}</p></section>
</main></body></html>`;
}

async function launchPdfBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

export async function exportReport(data: ReportData, outputDir: string): Promise<{ htmlPath: string; pdfPath: string; jsonPath: string; pdfError: string | null }> {
  await mkdir(outputDir, { recursive: true });
  const safeId = data.job.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'audit';
  const base = path.resolve(outputDir, `report-${safeId}`);
  const htmlPath = `${base}.html`;
  const pdfPath = `${base}.pdf`;
  const jsonPath = `${base}.json`;
  const html = renderReport(data);
  await writeFile(htmlPath, html, 'utf8');
  await writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');
  let browser: Browser | null = null;
  let pdfError: string | null = null;
  try {
    browser = await launchPdfBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      landscape: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;margin:0 12mm;color:#66808a;font:9px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:space-between;border-top:1px solid #cbdcdd;padding-top:4px"><span>애드센스 준비 진단 · ${escapeHtml(data.job.host)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margin: { top: '12mm', right: '11mm', bottom: '16mm', left: '11mm' },
    });
  } catch (error) {
    pdfError = error instanceof Error ? error.message : '브라우저를 실행하거나 PDF를 만들 수 없습니다.';
    await rm(pdfPath, { force: true });
  } finally {
    await browser?.close();
  }
  return { htmlPath, pdfPath, jsonPath, pdfError };
}

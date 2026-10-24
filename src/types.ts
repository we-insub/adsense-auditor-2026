export const RULESET_VERSION = '2026.09.29-6';

export type ScanMode = 'quick' | 'standard' | 'full';
export type JobStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'complete' | 'failed';
export type Verdict = 'good' | 'caution' | 'issue' | 'unknown' | 'na';
export type SourceKind = 'official' | 'recommendation' | 'heuristic';
export type Area = 'content' | 'navigation' | 'access' | 'trust' | 'adsense' | 'technical' | 'manual';

export type FailureCategory = 'target_unreachable' | 'dns_error' | 'ssl_error' | 'server_error'
  | 'robots_blocked' | 'scanner_network_restricted' | 'render_failed' | 'timeout'
  | 'cache_only_direct_failed' | 'non_html' | 'excluded' | 'security_blocked' | 'unknown';

export interface RedirectHop { url: string; statusCode: number; location?: string; }
export interface HttpTrace {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number | null;
  redirectChain: RedirectHop[];
  responseTimeMs: number;
  htmlCollected: boolean;
  checkedAt: string;
  error?: string;
  failureCategory?: FailureCategory;
}

export interface FileCheck {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  bodyPresent: boolean;
  responseTimeMs: number;
  redirectChain: RedirectHop[];
  checkedAt: string;
  error?: string;
  failureCategory?: FailureCategory;
}

export interface RenderCheck {
  viewport: 'desktop' | 'mobile';
  attempted: boolean;
  success: boolean;
  finalUrl?: string;
  statusCode?: number | null;
  title?: string;
  mainTextPresent?: boolean;
  errorScreen?: boolean;
  screenshotPath?: string;
  error?: string;
  failureCategory?: FailureCategory;
}

export interface PageSnapshot {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  statusCode: number | null;
  contentType: string;
  rawHtml: string;
  renderedText: string;
  mainText: string;
  /** Main content with navigational link labels removed for placeholder checks. */
  mainProseText?: string;
  title: string;
  metaDescription: string;
  canonical: string;
  robotsMeta: string;
  lang: string;
  headings: string[];
  links: string[];
  navLinks: string[];
  imageCount: number;
  imagesWithoutAlt: number;
  mediaCount: number;
  adElementCount: number;
  hasAdsenseScript: boolean;
  hasAdsenseMeta: boolean;
  hasPrivacyLink: boolean;
  hasAboutLink: boolean;
  hasContactLink: boolean;
  hasCookieTerms: boolean;
  hasAdClickPrompt: boolean;
  desktopOverflow: boolean;
  mobileOverflow: boolean;
  popupCount: number;
  jsErrors: string[];
  resourceFailures: string[];
  redirectCount: number;
  error?: string;
  /** Direct origin request evidence. Old saved jobs may not contain it. */
  http?: HttpTrace;
  desktopRender?: RenderCheck;
  mobileRender?: RenderCheck;
  failureCategory?: FailureCategory;
}

export interface SiteSignals {
  rootUrl: string;
  host: string;
  robotsUrl: string;
  robotsText: string | null;
  robotsAllowsAdsense: boolean | null;
  sitemapUrls: string[];
  adsTxtUrl: string;
  adsTxtText: string | null;
  discoveryMethod: 'sitemap-and-links' | 'links-only';
  technicalFiles?: { robots: FileCheck; sitemap: FileCheck; ads: FileCheck };
  discoveryError?: string;
  discoveryFailureCategory?: FailureCategory;
}

export interface Finding {
  id: string;
  ruleVersion?: string;
  appliesTo?: string;
  decisionCondition?: string;
  area: Area;
  title: string;
  verdict: Verdict;
  sourceKind: SourceKind;
  sourceUrl: string;
  pageUrl: string;
  good: string;
  bad: string;
  why: string;
  evidence: string;
  action: string;
  weight: number;
  critical?: boolean;
}

export interface RuleScore {
  id: string;
  area: Exclude<Area, 'technical' | 'manual'>;
  title: string;
  weight: number;
  /** Visited pages with a measured or unknown verdict; site rules use 1 or 0. */
  applicableCount: number;
  measuredCount: number;
  unknownCount: number;
  nonApplicableCount: number;
  verdict: Verdict | 'mixed';
  earnedWeight: number;
  measuredWeight: number;
  unknownWeight: number;
  nonApplicableWeight: number;
}

export interface ScoreResult {
  /** 0–100 score based on measured rule weight only (E / W); null when no sound evidence exists. */
  value: number | null;
  /** Identical to value; an unofficial readiness index, never an observed approval probability. */
  percentage: number | null;
  areaScores: Record<Exclude<Area, 'technical' | 'manual'>, number | null>;
  /** A: rule weights confirmed not applicable to every visited page. */
  nonApplicableWeight: number;
  /** T = 100 - A. */
  applicableWeight: number;
  /** W: measured portion of applicable rule weight. */
  measuredWeight: number;
  /** E: earned points on the original 100-point rule weights. */
  earnedWeight: number;
  /** U = T - W. */
  unknownWeight: number;
  /** W / T * 100, or null when T is zero. */
  verificationRate: number | null;
  /** Possible total-score interval, using E and U over T; rounded to 2 decimals. */
  possibleMin: number | null;
  possibleMax: number | null;
  /** Why even a provisional score is withheld, or null when it is displayed. */
  holdReason: string | null;
  unmeasuredCoreRuleIds: string[];
  ruleScores: RuleScore[];
  criticalCapApplied: boolean;
}

export interface AuditJob {
  id: string;
  /** Prior independent scan when this run was launched with Recheck. */
  recheckOfJobId?: string | null;
  inputUrl: string;
  rootUrl: string;
  host: string;
  mode: ScanMode;
  limit: number;
  excludedPaths: string[];
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  discovered: string[];
  queue: string[];
  visited: string[];
  pages: PageSnapshot[];
  signals: SiteSignals | null;
  error: string | null;
}

export interface ReportData {
  job: AuditJob;
  findings: Finding[];
  score: ScoreResult;
  generatedAt: string;
}

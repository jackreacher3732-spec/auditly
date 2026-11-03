export const AUDIT_CATEGORIES = [
  "On-page SEO",
  "Technical SEO",
  "Performance & mobile",
  "Security & domain",
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditStatus = "pass" | "warning" | "fail" | "info";
export type AuditSeverity = "critical" | "high" | "medium" | "low";
export type PerformanceQuality = "good" | "needs-improvement" | "poor" | "unknown";

export interface AuditCheck {
  id: string;
  title: string;
  category: AuditCategory;
  status: AuditStatus;
  severity: AuditSeverity;
  details: string;
  recommendation: string;
  evidence?: string;
  affectedPages: number;
  exampleUrl: string;
  affectedUrls?: string[];
}

export interface AuditPage {
  url: string;
  title: string;
  metaDescription: string;
  statusCode: number;
  score: number;
  issues: number;
  loadMs: number;
  htmlBytes: number;
  checks: AuditCheck[];
  crawlDepth: number;
  inboundInternalLinks: number;
  orphan: boolean;
}

export interface AuditCategorySummary {
  category: AuditCategory;
  score: number;
  checks: number;
  issues: number;
}

export interface PerformanceMetric {
  label: string;
  value: string;
  quality: PerformanceQuality;
}

export interface DevicePerformance {
  strategy: "mobile" | "desktop";
  status: "available" | "not-configured" | "unavailable";
  score: number | null;
  labMetrics: PerformanceMetric[];
  fieldMetrics: PerformanceMetric[];
  fieldSource: "url" | "origin" | "none";
  fieldCategory: string | null;
  opportunities: string[];
  analyzedUrl: string;
  message: string | null;
}

export interface AuditReport {
  version: number;
  inputUrl: string;
  finalUrl: string;
  scannedAt: string;
  score: number;
  grade: string;
  categories: AuditCategorySummary[];
  checks: AuditCheck[];
  pages: AuditPage[];
  summary: {
    pagesScanned: number;
    totalChecks: number;
    passed: number;
    warnings: number;
    failed: number;
    critical: number;
  };
  crawl: {
    internalLinksFound: number;
    linksChecked: number;
    brokenLinks: number;
    sitemapUrls: number;
    pagesDiscovered: number;
    pagesSkipped: number;
    crawlLimit: number;
    complete: boolean;
    blockedByRobots: number;
    maxDepth: number;
    orphanPages: number;
    duplicateTitleGroups: number;
    duplicateMetaGroups: number;
    sitemapOnlyUrls: number;
    crawledNotInSitemap: number;
  };
  metrics: {
    responseMs: number;
    htmlBytes: number;
    devicePerformance: {
      mobile: DevicePerformance;
      desktop: DevicePerformance;
    };
    coreWebVitals: {
      status: "available" | "partial" | "no-field-data" | "not-configured" | "unavailable";
      note: string;
    };
  };
}

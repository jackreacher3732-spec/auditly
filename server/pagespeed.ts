import type { DevicePerformance, PerformanceMetric, PerformanceQuality } from "../shared/audit";

const PAGE_SPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PAGE_SPEED_TIMEOUT_MS = 55_000;
const CACHE_TTL_MS = 10 * 60_000;
const ERROR_CACHE_TTL_MS = 45_000;

interface PsiMetric {
  percentile?: number;
  category?: string;
}

interface PsiExperience {
  metrics?: Record<string, PsiMetric>;
  overall_category?: string;
  origin_fallback?: boolean;
}

interface PsiAudit {
  title?: string;
  score?: number | null;
  displayValue?: string;
  details?: { overallSavingsMs?: number };
}

interface PsiResponse {
  error?: { code?: number };
  loadingExperience?: PsiExperience;
  originLoadingExperience?: PsiExperience;
  lighthouseResult?: {
    finalUrl?: string;
    categories?: {
      performance?: {
        score?: number | null;
        auditRefs?: Array<{ id: string; group?: string }>;
      };
    };
    audits?: Record<string, PsiAudit>;
  };
}

const resultCache = new Map<string, { expiresAt: number; result: DevicePerformance }>();
const inFlight = new Map<string, Promise<DevicePerformance>>();

function qualityFor(category?: string): PerformanceQuality {
  switch (category?.toUpperCase()) {
    case "FAST": return "good";
    case "AVERAGE": return "needs-improvement";
    case "SLOW": return "poor";
    default: return "unknown";
  }
}

function qualityLabel(quality: PerformanceQuality): string {
  switch (quality) {
    case "good": return "Good";
    case "needs-improvement": return "Needs improvement";
    case "poor": return "Poor";
    default: return "No rating";
  }
}

function formatMilliseconds(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

function emptyResult(
  strategy: "mobile" | "desktop",
  analyzedUrl: string,
  status: DevicePerformance["status"],
  message: string,
): DevicePerformance {
  return {
    strategy,
    status,
    score: null,
    labMetrics: [],
    fieldMetrics: [],
    fieldSource: "none",
    fieldCategory: null,
    opportunities: [],
    analyzedUrl,
    message,
  };
}

function labMetricsFrom(response: PsiResponse): PerformanceMetric[] {
  const audits = response.lighthouseResult?.audits ?? {};
  const definitions = [
    ["first-contentful-paint", "First Contentful Paint"],
    ["largest-contentful-paint", "Largest Contentful Paint"],
    ["total-blocking-time", "Total Blocking Time"],
    ["cumulative-layout-shift", "Cumulative Layout Shift"],
    ["speed-index", "Speed Index"],
  ] as const;
  return definitions.flatMap(([id, label]) => {
    const value = audits[id]?.displayValue?.trim();
    return value ? [{ label, value, quality: "unknown" as const }] : [];
  });
}

function fieldExperienceFrom(response: PsiResponse): { source: "url" | "origin" | "none"; experience?: PsiExperience } {
  const urlExperience = response.loadingExperience;
  if (urlExperience?.metrics && Object.keys(urlExperience.metrics).length > 0) {
    return { source: urlExperience.origin_fallback ? "origin" : "url", experience: urlExperience };
  }
  const originExperience = response.originLoadingExperience;
  if (originExperience?.metrics && Object.keys(originExperience.metrics).length > 0) {
    return { source: "origin", experience: originExperience };
  }
  return { source: "none" };
}

function fieldMetricsFrom(experience?: PsiExperience): PerformanceMetric[] {
  const metrics = experience?.metrics ?? {};
  const definitions = [
    ["LARGEST_CONTENTFUL_PAINT_MS", "LCP", "ms"],
    ["INTERACTION_TO_NEXT_PAINT", "INP", "ms"],
    ["CUMULATIVE_LAYOUT_SHIFT_SCORE", "CLS", "category"],
    ["FIRST_CONTENTFUL_PAINT_MS", "FCP", "ms"],
    ["EXPERIMENTAL_TIME_TO_FIRST_BYTE", "TTFB", "ms"],
  ] as const;
  return definitions.flatMap(([id, label, unit]) => {
    const metric = metrics[id];
    if (!metric || typeof metric.percentile !== "number") return [];
    const quality = qualityFor(metric.category);
    const value = unit === "category"
      ? qualityLabel(quality)
      : formatMilliseconds(metric.percentile);
    return [{ label: `${label} · p75`, value, quality }];
  });
}

function opportunitiesFrom(response: PsiResponse): string[] {
  const performance = response.lighthouseResult?.categories?.performance;
  const audits = response.lighthouseResult?.audits ?? {};
  return (performance?.auditRefs ?? [])
    .filter(reference => reference.group === "load-opportunities")
    .flatMap(reference => {
      const audit = audits[reference.id];
      if (!audit || typeof audit.score !== "number" || audit.score >= 0.9 || !audit.title) return [];
      const savings = audit.details?.overallSavingsMs;
      const suffix = typeof savings === "number" && savings > 0
        ? ` · estimated ${formatMilliseconds(savings)} saved`
        : audit.displayValue ? ` · ${audit.displayValue}` : "";
      return [`${audit.title}${suffix}`];
    })
    .slice(0, 3);
}

function providerErrorMessage(status: number): string {
  if (status === 403) return "Google rejected the PageSpeed API key or the PageSpeed Insights API is not enabled for it.";
  if (status === 429) return "The Google PageSpeed API quota or rate limit was reached. Try again later.";
  if (status === 400) return "Google PageSpeed could not analyze this URL. Check that the page is public and try again.";
  return `Google PageSpeed could not complete this run (HTTP ${status}). Try again later.`;
}

async function fetchDevice(url: string, strategy: "mobile" | "desktop"): Promise<DevicePerformance> {
  const apiKey = process.env.PAGESPEED_API_KEY;
  if (!apiKey) {
    return emptyResult(strategy, url, "not-configured", "Add a server-side Google PageSpeed API key to run real mobile and desktop Lighthouse tests.");
  }

  const cacheKey = `${strategy}:${url}`;
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const request = (async (): Promise<DevicePerformance> => {
    const requestUrl = new URL(PAGE_SPEED_ENDPOINT);
    requestUrl.searchParams.set("url", url);
    requestUrl.searchParams.set("strategy", strategy.toUpperCase());
    requestUrl.searchParams.set("category", "PERFORMANCE");
    requestUrl.searchParams.set("key", apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAGE_SPEED_TIMEOUT_MS);
    try {
      const response = await fetch(requestUrl, {
        method: "GET",
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const payload = await response.json() as PsiResponse;
      if (!response.ok || payload.error) {
        return emptyResult(strategy, url, "unavailable", providerErrorMessage(payload.error?.code ?? response.status));
      }

      const performanceScore = payload.lighthouseResult?.categories?.performance?.score;
      if (typeof performanceScore !== "number") {
        return emptyResult(strategy, url, "unavailable", "Google did not return a Lighthouse performance score for this URL.");
      }

      const field = fieldExperienceFrom(payload);
      const result: DevicePerformance = {
        strategy,
        status: "available",
        score: Math.round(performanceScore * 100),
        labMetrics: labMetricsFrom(payload),
        fieldMetrics: fieldMetricsFrom(field.experience),
        fieldSource: field.source,
        fieldCategory: field.experience?.overall_category ? qualityLabel(qualityFor(field.experience.overall_category)) : null,
        opportunities: opportunitiesFrom(payload),
        analyzedUrl: payload.lighthouseResult?.finalUrl ?? url,
        message: field.source === "none" ? "No CrUX real-user field data was available for this page or origin; Lighthouse lab results are still shown." : null,
      };
      return result;
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? "Google PageSpeed took too long to finish this device run. Try again later."
        : "Google PageSpeed could not be reached. Try again later.";
      return emptyResult(strategy, url, "unavailable", message);
    } finally {
      clearTimeout(timeout);
    }
  })();

  inFlight.set(cacheKey, request);
  try {
    const result = await request;
    const ttl = result.status === "available" ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS;
    resultCache.set(cacheKey, { expiresAt: Date.now() + ttl, result });
    if (resultCache.size > 80) {
      const oldest = resultCache.keys().next().value;
      if (oldest) resultCache.delete(oldest);
    }
    return result;
  } finally {
    inFlight.delete(cacheKey);
  }
}

export async function runPageSpeedDiagnostics(url: string): Promise<{ mobile: DevicePerformance; desktop: DevicePerformance }> {
  const [mobile, desktop] = await Promise.all([
    fetchDevice(url, "mobile"),
    fetchDevice(url, "desktop"),
  ]);
  return { mobile, desktop };
}

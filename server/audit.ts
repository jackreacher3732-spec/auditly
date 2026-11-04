import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { TRPCError } from "@trpc/server";
import { runPageSpeedDiagnostics } from "./pagespeed";
import type {
  AuditCategory,
  AuditCheck,
  AuditPage,
  AuditReport,
  AuditSeverity,
  AuditStatus,
} from "../shared/audit";

const MAX_RESPONSE_BYTES = 1_200_000;
const MAX_CRAWL_PAGES = 250;
const CRAWL_BATCH_SIZE = 6;
const MAX_SITEMAP_DOCUMENTS = 20;
const MAX_SITEMAP_URLS = 10_000;
const REQUEST_TIMEOUT_MS = 7_000;
const USER_AGENT = "AuditlySiteAudit/1.0 (public SEO diagnostics)";
const AUDIT_REPORT_VERSION = 5;

const categories: AuditCategory[] = [
  "On-page SEO",
  "Technical SEO",
  "Performance & mobile",
  "Security & domain",
];

type FetchResult = {
  status: number;
  headers: Headers;
  body: string;
  finalUrl: string;
  redirects: string[];
  elapsedMs: number;
  bytes: number;
  truncated: boolean;
};

type PageResult = {
  page: AuditPage;
  checks: AuditCheck[];
  anchors: string[];
  html: string;
  headers: Headers;
  finalUrl: string;
};

type StructuredDataResult = {
  types: string[];
  errors: string[];
  missing: string[];
};

function schemaTypes(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const raw = record["@type"];

  const own = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : typeof raw === "string"
      ? [raw]
      : [];

  const graph = Array.isArray(record["@graph"])
    ? record["@graph"].flatMap(schemaTypes)
    : [];

  return [...own, ...graph];
}

function validateStructuredData(html: string): StructuredDataResult {
  const scripts = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map(match => match[1]?.trim() ?? "");

  const types: string[] = [];
  const errors: string[] = [];
  const missing: string[] = [];

  const required: Record<string, string[]> = {
    Article: ["headline"],
    NewsArticle: ["headline"],
    BlogPosting: ["headline"],
    Product: ["name"],
    LocalBusiness: ["name"],
    Organization: ["name"],
    WebSite: ["name", "url"],
    BreadcrumbList: ["itemListElement"],
    FAQPage: ["mainEntity"],
  };

  for (const [index, source] of scripts.entries()) {
    if (!source) {
      errors.push(`JSON-LD block ${index + 1} is empty.`);
      continue;
    }

    try {
      const parsed = JSON.parse(source) as unknown;
      const foundTypes = schemaTypes(parsed);

      if (!foundTypes.length) {
        errors.push(`JSON-LD block ${index + 1} has no @type.`);
      }

      types.push(...foundTypes);

      const objects = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of objects) {
        if (!item || typeof item !== "object") continue;

        const record = item as Record<string, unknown>;
        const itemTypes = Array.isArray(record["@type"])
          ? record["@type"]
          : [record["@type"]];

        for (const itemType of itemTypes.filter(
          (value): value is string => typeof value === "string",
        )) {
          for (const field of required[itemType] ?? []) {
            const value = record[field];

            if (
              value === undefined ||
              value === null ||
              value === "" ||
              (Array.isArray(value) && value.length === 0)
            ) {
              missing.push(`${itemType}.${field}`);
            }
          }
        }
      }
    } catch (error) {
      errors.push(
        `JSON-LD block ${index + 1} is invalid JSON${
          error instanceof Error ? `: ${error.message}` : "."
        }`,
      );
    }
  }

  return {
    types: [...new Set(types)],
    errors,
    missing: [...new Set(missing)],
  };
}

const failInput = (message: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message });
};

function normalizeInputUrl(raw: string): URL {
  const trimmed = raw.trim();

  if (!trimmed || trimmed.length > 2048) {
    return failInput("Enter a website URL (up to 2,048 characters).");
  }

  const candidate = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;

  try {
    parsed = new URL(candidate);
  } catch {
    return failInput(
      "That URL does not look valid. Try a domain such as example.com.",
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return failInput("Only public HTTP and HTTPS websites can be audited.");
  }

  if (parsed.username || parsed.password) {
    return failInput(
      "URLs containing a username or password are not supported.",
    );
  }

  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return failInput(
      "For safety, audits are limited to standard HTTP and HTTPS ports.",
    );
  }

  parsed.hash = "";
  return parsed;
}

function ipv4IsPublic(address: string): boolean {
  const values = address.split(".").map(Number);

  if (
    values.length !== 4 ||
    values.some(
      value =>
        !Number.isInteger(value) || value < 0 || value > 255,
    )
  ) {
    return false;
  }

  const [a, b, c] = values;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255) return false;

  return true;
}

function ipv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase().split("%")[0];

  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);

    if (!ipv4IsPublic(ipv4)) return null;

    const octets = ipv4.split(".").map(Number);

    normalized =
      `${normalized.slice(0, lastColon)}:` +
      `${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const [leftText, rightText = ""] = normalized.split("::");
  const left = leftText ? leftText.split(":") : [];
  const right = rightText ? rightText.split(":") : [];

  if (normalized.includes("::")) {
    const fill = 8 - left.length - right.length;

    if (fill < 1) return null;

    const words = [
      ...left,
      ...Array(fill).fill("0"),
      ...right,
    ].map(part => Number.parseInt(part || "0", 16));

    return words.length === 8 &&
      words.every(word => Number.isFinite(word) && word >= 0 && word <= 0xffff)
      ? words
      : null;
  }

  if (left.length !== 8) return null;

  const words = left.map(part => Number.parseInt(part, 16));

  return words.every(
    word => Number.isFinite(word) && word >= 0 && word <= 0xffff,
  )
    ? words
    : null;
}

function isPublicIp(address: string): boolean {
  const version = isIP(address);

  if (version === 4) return ipv4IsPublic(address);
  if (version !== 6) return false;

  const words = ipv6Words(address);

  if (!words || words.length !== 8) return false;

  // IPv4-mapped IPv6 addresses must also pass IPv4 validation.
  if (
    words.slice(0, 5).every(word => word === 0) &&
    words[5] === 0xffff
  ) {
    const embedded =
      `${words[6] >> 8}.${words[6] & 255}.` +
      `${words[7] >> 8}.${words[7] & 255}`;

    return ipv4IsPublic(embedded);
  }

  // Accept only globally routable unicast space (2000::/3).
  if ((words[0] & 0xe000) !== 0x2000) return false;

  // Documentation and special-purpose ranges.
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2001 && words[1] === 0x0000) return false;
  if (words[0] === 0x2002) return false; // 6to4

  return true;
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The destination is not HTTP or HTTPS.");
  }

  if (
    url.username ||
    url.password ||
    (url.port && url.port !== "80" && url.port !== "443")
  ) {
    throw new Error("The destination URL is not permitted.");
  }

  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase();

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("Private or local hostnames cannot be audited.");
  }

  if (isIP(hostname)) {
    if (!isPublicIp(hostname)) {
      throw new Error(
        "Private or reserved IP addresses cannot be audited.",
      );
    }

    return;
  }

  let records: Array<{ address: string; family: number }>;

  try {
    records = await lookup(hostname, {
      all: true,
      verbatim: true,
    });
  } catch {
    throw new Error(
      "The domain could not be resolved. Check the URL and try again.",
    );
  }

  if (
    !records.length ||
    records.some(record => !isPublicIp(record.address))
  ) {
    throw new Error(
      "The domain resolves to a private or reserved IP address and cannot be audited.",
    );
  }
}

async function readResponseText(
  response: Response,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = response.body?.getReader();

  if (!reader) {
    return { text: "", bytes: 0, truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value) continue;

      const remaining = MAX_RESPONSE_BYTES - size;

      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
          size += remaining;
        }

        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Response may already be closed.
    }
  }

  const combined = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(combined),
    bytes: size,
    truncated,
  };
}

/**
 * Fetches a public HTTP(S) URL and validates every redirect destination.
 * The timeout remains active while the response body is being read.
 */
async function fetchPublic(
  urlText: string,
  method: "GET" | "HEAD" = "GET",
): Promise<FetchResult> {
  let current: URL;

  try {
    current = new URL(urlText);
  } catch {
    throw new Error("An invalid link was found during the crawl.");
  }

  const redirects: string[] = [];
  const startedAt = Date.now();

  for (let hop = 0; hop <= 5; hop += 1) {
    await assertPublicHttpUrl(current);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    try {
      const response = await fetch(current.href, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          const content =
            method === "HEAD"
              ? { text: "", bytes: 0, truncated: false }
              : await readResponseText(response);

          return {
            status: response.status,
            headers: response.headers,
            body: content.text,
            finalUrl: current.href,
            redirects,
            elapsedMs: Date.now() - startedAt,
            bytes: content.bytes,
            truncated: content.truncated,
          };
        }

        if (hop >= 5) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(
            "This website has too many redirects to audit safely.",
          );
        }

        await response.body?.cancel().catch(() => undefined);

        const nextUrl = new URL(location, current);
        await assertPublicHttpUrl(nextUrl);

        current = nextUrl;
        redirects.push(current.href);
        continue;
      }

      const content =
        method === "HEAD"
          ? { text: "", bytes: 0, truncated: false }
          : await readResponseText(response);

      return {
        status: response.status,
        headers: response.headers,
        body: content.text,
        finalUrl: current.href,
        redirects,
        elapsedMs: Date.now() - startedAt,
        bytes: content.bytes,
        truncated: content.truncated,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("The website took too long to respond.");
      }

      if (error instanceof Error) throw error;

      throw new Error(
        "The website could not be reached. Check that the URL is public and try again.",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("This website has too many redirects to audit safely.");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textOnly(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const found = tag.match(
    new RegExp(
      `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );

  return found
    ? decodeEntities(found[1] ?? found[2] ?? found[3] ?? "").trim()
    : undefined;
}

function tagTexts(html: string, tagName: string): string[] {
  const expression = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}\\s*>`,
    "gi",
  );

  return [...html.matchAll(expression)].map(match =>
    textOnly(match[1] ?? ""),
  );
}

function getMetaContent(
  html: string,
  key: string,
  attributeName: "name" | "property" = "name",
): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of tags) {
    if (
      attribute(tag, attributeName)?.toLowerCase() ===
      key.toLowerCase()
    ) {
      return attribute(tag, "content");
    }
  }

  return undefined;
}

function getCanonicalLinks(html: string): string[] {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];

  return tags.flatMap(tag => {
    const rel = (attribute(tag, "rel") ?? "")
      .toLowerCase()
      .split(/\s+/);

    return rel.includes("canonical")
      ? [attribute(tag, "href") ?? ""]
      : [];
  });
}

/**
 * Extracts anchor URLs while removing accidental quote wrappers.
 * Repairs malformed protocol slashes without changing normal URLs.
 */
function getAnchors(html: string, baseUrl: string): string[] {
  const tags = html.match(/<a\b[^>]*>/gi) ?? [];
  const found = new Set<string>();

  for (const tag of tags) {
    let href = attribute(tag, "href")?.trim();

    if (!href) continue;

    // Remove repeated literal or URL-encoded quote wrappers.
    href = href
      .replace(/^(?:(?:"|'|%22|%27))+|(?:(?:"|'|%22|%27))+$/gi, "")
      .trim();

    // Some CMS templates accidentally encode quote characters.
    href = href.replace(/^%22|%22$/gi, "").trim();
    href = href.replace(/^%27|%27$/gi, "").trim();

    if (
      !href ||
      /^(?:#|mailto:|tel:|javascript:|data:|blob:)/i.test(href)
    ) {
      continue;
    }

    // Repair malformed absolute protocol separators.
    const malformedAbsolute = /^https?:\/{3,}/i.test(href);

    if (malformedAbsolute) {
      href = href.replace(/^(https?):\/{2,}/i, "$1//");
    }

    try {
      const target = new URL(href, baseUrl);

      if (
        target.protocol !== "http:" &&
        target.protocol !== "https:"
      ) {
        continue;
      }

      // Collapse repeated path slashes only when the source URL was
      // already malformed; preserve normal URL path semantics otherwise.
      if (malformedAbsolute) {
        target.pathname = target.pathname.replace(/\/{2,}/g, "/");
      }

      target.hash = "";
      found.add(target.href);
    } catch {
      // Ignore malformed links rather than reporting fabricated URLs.
    }
  }

  return [...found];
}

function check(
  id: string,
  title: string,
  category: AuditCategory,
  status: AuditStatus,
  severity: AuditSeverity,
  details: string,
  recommendation: string,
  url: string,
  evidence?: string,
): AuditCheck {
  return {
    id,
    title,
    category,
    status,
    severity,
    details,
    recommendation,
    affectedPages: 1,
    exampleUrl: url,
    ...(evidence ? { evidence } : {}),
  };
}

function gradeFor(score: number): string {
  if (score >= 90) return "Excellent health";
  if (score >= 80) return "Good foundation";
  if (score >= 65) return "Room to improve";
  return "Needs attention";
}

function scoreChecks(items: AuditCheck[]): number {
  const scored = items.filter(item => item.status !== "info");

  if (!scored.length) return 100;

  const weight: Record<AuditSeverity, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
  };

  const penalty: Record<AuditStatus, number> = {
    pass: 0,
    info: 0,
    warning: 0.38,
    fail: 1,
  };

  const max = scored.reduce(
    (sum, item) => sum + weight[item.severity],
    0,
  );

  const lost = scored.reduce(
    (sum, item) =>
      sum + weight[item.severity] * penalty[item.status],
    0,
  );

  return Math.max(0, Math.round(((max - lost) / max) * 100));
}
async function analyzePage(url: string): Promise<PageResult> {
  const fetched = await fetchPublic(url);
  const html = fetched.body;
  const final = fetched.finalUrl;
  const contentType = fetched.headers.get("content-type") ?? "";

  const isLikelyHtml =
    /text\/html|application\/xhtml\+xml/i.test(contentType) ||
    /<html\b|<head\b/i.test(html);

  const fetchUsable =
    fetched.status >= 200 &&
    fetched.status < 400 &&
    isLikelyHtml &&
    html.trim().length > 120;

  if (!fetchUsable) {
    const reason =
      fetched.status >= 400
        ? `The URL returned HTTP ${fetched.status}; its response was not analyzed as page SEO.`
        : !isLikelyHtml
          ? `The response was not recognized as HTML${contentType ? ` (${contentType})` : ""}; its SEO metadata was not analyzed.`
          : "The HTML response was too short to analyze reliably.";

    const unavailableCheck = check(
      "page-fetch",
      "Page fetch / HTML availability",
      "Technical SEO",
      "info",
      "low",
      reason,
      "Retry the audit after the site allows the crawler to receive the normal page HTML.",
      final,
      `${fetched.status} · ${contentType || "unknown content type"}`,
    );

    const unavailablePage: AuditPage = {
      url: final,
      title: "Unverified response",
      metaDescription: "",
      statusCode: fetched.status,
      score: 100,
      issues: 0,
      loadMs: fetched.elapsedMs,
      htmlBytes: fetched.bytes,
      checks: [unavailableCheck],
      crawlDepth: 0,
      inboundInternalLinks: 0,
      orphan: false,
    };

    return {
      page: unavailablePage,
      checks: [unavailableCheck],
      anchors: [],
      html,
      headers: fetched.headers,
      finalUrl: final,
    };
  }

  const title = tagTexts(html, "title")[0] ?? "";
  const description = getMetaContent(html, "description") ?? "";
  const h1s = tagTexts(html, "h1");
  const h2s = tagTexts(html, "h2");
  const wordCount = textOnly(html).split(/\s+/).filter(Boolean).length;
  const images = html.match(/<img\b[^>]*>/gi) ?? [];

  const missingAlt = images.filter(
    tag =>
      attribute(tag, "alt") === undefined ||
      attribute(tag, "alt") === "",
  ).length;

  const canonicalLinks = getCanonicalLinks(html);
  const canonical = canonicalLinks[0] ?? "";
  const viewport = getMetaContent(html, "viewport");
  const structuredData = validateStructuredData(html);

  const robotsMeta =
    `${getMetaContent(html, "robots") ?? ""} ` +
    `${getMetaContent(html, "googlebot") ?? ""}`.toLowerCase();

  const xRobots = (
    fetched.headers.get("x-robots-tag") ?? ""
  ).toLowerCase();

  const noindex = /\bnoindex\b/.test(`${robotsMeta} ${xRobots}`);
  const pageChecks: AuditCheck[] = [];

  const titleStatus: AuditStatus = !title
    ? "fail"
    : title.length < 30 || title.length > 60
      ? "warning"
      : "pass";

  pageChecks.push(
    check(
      "page-title",
      "Title tag",
      "On-page SEO",
      titleStatus,
      "high",
      !title
        ? "No title tag was found."
        : `The title contains ${title.length} characters.`,
      "Add one descriptive title that reflects the page topic; aim for roughly 30–60 characters.",
      final,
      title ? title.slice(0, 120) : undefined,
    ),
  );

  const descriptionStatus: AuditStatus = !description
    ? "fail"
    : description.length < 50 || description.length > 160
      ? "warning"
      : "pass";

  pageChecks.push(
    check(
      "meta-description",
      "Meta description",
      "On-page SEO",
      descriptionStatus,
      "medium",
      !description
        ? "No meta description was found."
        : `The description contains ${description.length} characters.`,
      "Write a unique, useful summary for search results; aim for roughly 50–160 characters.",
      final,
      description ? description.slice(0, 160) : undefined,
    ),
  );

  const h1Status: AuditStatus =
    h1s.length === 0
      ? "fail"
      : h1s.length > 1
        ? "warning"
        : "pass";

  pageChecks.push(
    check(
      "h1-heading",
      "Primary H1 heading",
      "On-page SEO",
      h1Status,
      "high",
      h1s.length === 0
        ? "No H1 heading was found."
        : h1s.length === 1
          ? `One H1 found: “${h1s[0].slice(0, 100)}”.`
          : `${h1s.length} H1 headings were found.`,
      "Use one clear, descriptive H1 to express the page's main topic.",
      final,
    ),
  );

  const h2Missing = h2s.length === 0;
  const longH2 = h2s.filter(item => item.length > 80).length;

  pageChecks.push(
    check(
      "heading-structure",
      "Subheading structure",
      "On-page SEO",
      h2Missing || longH2 ? "warning" : "pass",
      "low",
      h2Missing
        ? "No H2 subheadings were found."
        : `${h2s.length} H2 subheading${h2s.length === 1 ? "" : "s"} found${longH2 ? `; ${longH2} are longer than 80 characters` : ""}.`,
      "Break long content into descriptive sections with concise H2 headings.",
      final,
    ),
  );

  const contentStatus: AuditStatus =
    wordCount < 100 ? "warning" : "pass";

  pageChecks.push(
    check(
      "body-content",
      "Readable page content",
      "On-page SEO",
      contentStatus,
      "medium",
      `${wordCount.toLocaleString()} visible words were detected in the HTML response.`,
      "Make sure the page provides useful, original content that answers the visitor's intent.",
      final,
    ),
  );

  const altStatus: AuditStatus =
    missingAlt > 0 ? "warning" : "pass";

  pageChecks.push(
    check(
      "image-alt",
      "Image alternative text",
      "On-page SEO",
      altStatus,
      "medium",
      images.length === 0
        ? "No images were found in the page HTML."
        : `${missingAlt} of ${images.length} images have missing or empty alt text.`,
      "Add concise alt text to informative images; use an empty alt attribute only for decorative images.",
      final,
    ),
  );

  const schemaStatus: AuditStatus =
    structuredData.errors.length
      ? "fail"
      : structuredData.missing.length
        ? "warning"
        : structuredData.types.length
          ? "pass"
          : "info";

  pageChecks.push(
    check(
      "structured-data",
      "Structured data / schema",
      "On-page SEO",
      schemaStatus,
      structuredData.errors.length ? "high" : "medium",
      structuredData.errors.length
        ? structuredData.errors.join(" ")
        : structuredData.types.length
          ? `${structuredData.types.length} schema type${structuredData.types.length === 1 ? "" : "s"} detected: ${structuredData.types.slice(0, 8).join(", ")}${structuredData.missing.length ? `. Required properties missing: ${structuredData.missing.join(", ")}.` : "."}`
          : "No JSON-LD structured data block was found in the page HTML.",
      structuredData.errors.length
        ? "Fix the JSON-LD syntax and validate it again with the relevant Schema.org or Google rich-result requirements."
        : structuredData.missing.length
          ? `Add the required properties: ${structuredData.missing.join(", ")}.`
          : structuredData.types.length
            ? "Keep the detected schema valid and aligned with the visible page content."
            : "Add relevant JSON-LD only when the page represents an eligible entity or content type.",
      final,
      structuredData.types.length
        ? structuredData.types.join(" · ")
        : undefined,
    ),
  );

  let canonicalUrl = "";

  try {
    const parsedCanonical = canonical
      ? new URL(canonical, final)
      : null;

    if (
      parsedCanonical?.protocol === "http:" ||
      parsedCanonical?.protocol === "https:"
    ) {
      canonicalUrl = parsedCanonical.href;
    }
  } catch {
    // Report unusable canonical below.
  }

  const canonicalPageUrl = new URL(final);
  const canonicalFindings: string[] = [];
  let canonicalStatus: AuditStatus = "pass";

  let canonicalRecommendation =
    "Keep one canonical URL that resolves directly to the preferred indexable page.";

  let canonicalEvidence = canonicalUrl || canonical || "";

  const addCanonicalFinding = (
    status: AuditStatus,
    finding: string,
    recommendation: string,
  ) => {
    canonicalFindings.push(finding);

    if (
      status === "fail" ||
      (status === "warning" && canonicalStatus === "pass")
    ) {
      canonicalStatus = status;
      canonicalRecommendation = recommendation;
    }
  };

  if (canonicalLinks.length === 0) {
    addCanonicalFinding(
      "warning",
      "No canonical link was found in the server HTML response received by the crawler.",
      "Add one absolute rel=canonical URL to the server-rendered HTML; metadata added only after client-side JavaScript may not be reliably discovered.",
    );
  }

  if (canonicalLinks.length > 1) {
    const values = canonicalLinks
      .map(value => value || "(empty href)")
      .slice(0, 3)
      .join(" · ");

    addCanonicalFinding(
      "fail",
      `Found ${canonicalLinks.length} canonical link tags${values ? `: ${values}` : ""}. Multiple tags can send conflicting canonical signals.`,
      "Leave exactly one canonical link tag on this page and point it to the intended preferred URL.",
    );
  }

  if (canonicalLinks.length > 0 && !canonicalUrl) {
    addCanonicalFinding(
      "fail",
      `The canonical href is empty, malformed, or uses an unsupported URL scheme${canonical ? `: ${canonical}` : ""}.`,
      "Use a valid HTTP or HTTPS canonical URL and remove empty or malformed canonical tags.",
    );
  }

  if (canonicalUrl) {
    const parsedCanonical = new URL(canonicalUrl);
    const isSelfCanonical =
      parsedCanonical.href === canonicalPageUrl.href;
    const isCrossDomain =
      parsedCanonical.origin !== canonicalPageUrl.origin;

    if (isCrossDomain) {
      addCanonicalFinding(
        "warning",
        `The canonical points to a different domain (${parsedCanonical.host}). Cross-domain canonicals are valid for genuine duplicate content, but should be intentional.`,
        "Confirm the other domain is the intended canonical destination and that it hosts the preferred, indexable version of this content.",
      );
    } else if (!isSelfCanonical) {
      addCanonicalFinding(
        "warning",
        `The canonical points to a different URL: ${canonicalUrl}. Confirm that this page is intentionally consolidated into that destination.`,
        "If this page is the preferred version, use a self-referencing canonical; otherwise confirm the destination is the intended duplicate and is indexable.",
      );
    }

    if (
      canonicalPageUrl.protocol === "https:" &&
      parsedCanonical.protocol === "http:"
    ) {
      addCanonicalFinding(
        "warning",
        "The HTTPS page points its canonical at an unencrypted HTTP URL.",
        "Update the canonical to the preferred HTTPS URL.",
      );
    }

    if (parsedCanonical.hash) {
      addCanonicalFinding(
        "warning",
        "The canonical URL contains a fragment identifier, which does not identify a distinct crawlable page.",
        "Remove the fragment and use the clean preferred page URL as the canonical.",
      );
    }

    if (isSelfCanonical) {
      canonicalEvidence =
        `${canonicalUrl} · current page HTTP ${fetched.status}`;
    } else {
      try {
        const target = await fetchPublic(canonicalUrl);

        canonicalEvidence =
          `${canonicalUrl} → HTTP ${target.status}` +
          `${target.finalUrl !== canonicalUrl ? ` → ${target.finalUrl}` : ""}`;

        if (target.status === 404 || target.status === 410) {
          addCanonicalFinding(
            "fail",
            `The canonical target returns HTTP ${target.status}.`,
            "Point the canonical tag to a live, indexable page or restore the intended destination.",
          );
        } else if (target.status >= 400) {
          addCanonicalFinding(
            "warning",
            `The canonical target could not be confirmed as a healthy page (HTTP ${target.status}).`,
            "Check that the canonical destination is publicly accessible and returns a successful page response.",
          );
        }

        if (target.redirects.length > 0) {
          addCanonicalFinding(
            "warning",
            `The canonical target redirects ${target.redirects.length} time${target.redirects.length === 1 ? "" : "s"} before reaching ${target.finalUrl}.`,
            "Update the canonical href to the final destination so it does not pass through a redirect.",
          );

          canonicalEvidence +=
            ` · ${target.redirects.length} redirect${target.redirects.length === 1 ? "" : "s"}`;
        }

        const targetRobots =
          `${getMetaContent(target.body, "robots") ?? ""} ` +
          `${getMetaContent(target.body, "googlebot") ?? ""} ` +
          `${target.headers.get("x-robots-tag") ?? ""}`.toLowerCase();

        if (/\bnoindex\b/.test(targetRobots)) {
          addCanonicalFinding(
            "fail",
            "The canonical destination has a noindex directive, which conflicts with using it as the preferred indexable URL.",
            "Remove noindex from the intended canonical destination, or choose a different indexable canonical URL.",
          );
        }
      } catch (error) {
        const reason =
          error instanceof Error
            ? error.message
            : "the target could not be fetched";

        addCanonicalFinding(
          "warning",
          `The canonical destination could not be verified: ${reason}`,
          "Confirm the destination is a public HTTP or HTTPS page and that it resolves directly without access restrictions.",
        );
      }
    }
  }

  const canonicalDetails = canonicalFindings.length
    ? canonicalFindings.join(" ")
    : `One canonical link points to this page itself${canonicalUrl ? ` (${canonicalUrl})` : ""}.`;

  pageChecks.push(
    check(
      "canonical",
      "Canonical URL setup",
      "Technical SEO",
      canonicalStatus,
      "high",
      canonicalDetails,
      canonicalRecommendation,
      final,
      canonicalEvidence || undefined,
    ),
  );

  pageChecks.push(
    check(
      "indexability",
      "Indexability directives",
      "Technical SEO",
      noindex ? "fail" : "pass",
      "critical",
      noindex
        ? "A noindex directive was detected in page metadata or response headers."
        : "No noindex directive was detected in the page metadata or response headers.",
      noindex
        ? "Remove noindex only if this page should appear in search results; otherwise keep the directive intentionally."
        : "Confirm that robots and page-level directives match your intended indexing policy.",
      final,
    ),
  );

  const statusOk =
    fetched.status >= 200 && fetched.status < 400;

  pageChecks.push(
    check(
      "http-status",
      "Page response status",
      "Technical SEO",
      statusOk ? "pass" : "fail",
      "high",
      `The page returned HTTP ${fetched.status}.`,
      "Resolve server errors, access restrictions, or broken routes for pages intended to be crawled.",
      final,
      `HTTP ${fetched.status}`,
    ),
  );

  const redirectStatus: AuditStatus =
    fetched.redirects.length > 3 ? "warning" : "pass";

  pageChecks.push(
    check(
      "redirect-chain",
      "Redirect path",
      "Technical SEO",
      redirectStatus,
      "low",
      fetched.redirects.length
        ? `${fetched.redirects.length} redirect${fetched.redirects.length === 1 ? "" : "s"} were followed.`
        : "No redirects were required.",
      "Keep redirects direct and avoid unnecessary redirect hops.",
      final,
    ),
  );

  const responseUrl = new URL(final);
  const isHttps = responseUrl.protocol === "https:";

  pageChecks.push(
    check(
      "https",
      "HTTPS connection",
      "Security & domain",
      isHttps ? "pass" : "fail",
      "critical",
      isHttps
        ? "The audited page was served over HTTPS with a valid TLS connection."
        : "The page ended on an unencrypted HTTP URL.",
      "Serve the site over HTTPS and redirect HTTP visitors to the secure version.",
      final,
    ),
  );

  const mixedResources = [
    ...html.matchAll(
      /<(?:img|script|iframe|audio|video|source|link)\b[^>]*>/gi,
    ),
  ]
    .map(match => match[0])
    .filter(tag => {
      const lowerTag = tag.toLowerCase();
      const urlValue = attribute(
        tag,
        lowerTag.startsWith("<link") ? "href" : "src",
      );

      if (!urlValue || !/^http:\/\//i.test(urlValue)) {
        return false;
      }

      if (lowerTag.startsWith("<link")) {
        const rel = (attribute(tag, "rel") ?? "").toLowerCase();

        return /stylesheet|preload|icon|manifest/.test(rel);
      }

      return true;
    });

  const mixedStatus: AuditStatus =
    isHttps && mixedResources.length ? "fail" : "pass";

  pageChecks.push(
    check(
      "mixed-content",
      "Mixed-content resources",
      "Security & domain",
      mixedStatus,
      "high",
      mixedStatus === "fail"
        ? `${mixedResources.length} HTTP-loaded resource${mixedResources.length === 1 ? "" : "s"} found on an HTTPS page.`
        : "No mixed-content resources were detected in the scanned HTML.",
      "Update embedded scripts, images, stylesheets, and other page resources to HTTPS.",
      final,
    ),
  );

  const durationStatus: AuditStatus =
    fetched.elapsedMs > 2000
      ? "fail"
      : fetched.elapsedMs > 800
        ? "warning"
        : "pass";

  pageChecks.push(
    check(
      "server-response",
      "Server response time",
      "Performance & mobile",
      durationStatus,
      "high",
      `The HTML response took ${fetched.elapsedMs.toLocaleString()} ms in this scan. This is a server-side response signal, not a field Core Web Vital.`,
      "Reduce server response time with efficient rendering, caching, and a nearby CDN where appropriate.",
      final,
      `${fetched.elapsedMs} ms`,
    ),
  );

  const sizeStatus: AuditStatus =
    fetched.bytes > 500_000 ? "warning" : "pass";

  pageChecks.push(
    check(
      "html-size",
      "HTML response size",
      "Performance & mobile",
      sizeStatus,
      "low",
      `${(fetched.bytes / 1024).toFixed(1)} KB of HTML${fetched.truncated ? " (capped at 1.2 MB for this scan)" : ""} was read.`,
      "Keep the initial HTML lean and defer non-essential content when page markup is unusually large.",
      final,
      `${fetched.bytes} bytes`,
    ),
  );

  pageChecks.push(
    check(
      "mobile-viewport",
      "Mobile viewport",
      "Performance & mobile",
      viewport ? "pass" : "warning",
      "medium",
      viewport
        ? `Viewport declaration found: ${viewport.slice(0, 100)}.`
        : "No viewport meta tag was found.",
      "Add a responsive viewport declaration so the layout can adapt to mobile screen widths.",
      final,
    ),
  );

  const hsts = Boolean(
    fetched.headers.get("strict-transport-security"),
  );

  pageChecks.push(
    check(
      "hsts",
      "HSTS security header",
      "Security & domain",
      hsts ? "pass" : "warning",
      "low",
      hsts
        ? "A Strict-Transport-Security header was returned."
        : "No Strict-Transport-Security header was observed.",
      "Consider an HSTS policy after confirming every required hostname supports HTTPS.",
      final,
    ),
  );

  const anchors = getAnchors(html, final);

  const page: AuditPage = {
    url: final,
    title: title || "Untitled page",
    metaDescription: description,
    statusCode: fetched.status,
    score: scoreChecks(pageChecks),
    issues: pageChecks.filter(
      item =>
        item.status === "fail" || item.status === "warning",
    ).length,
    loadMs: fetched.elapsedMs,
    htmlBytes: fetched.bytes,
    checks: pageChecks,
    crawlDepth: 0,
    inboundInternalLinks: 0,
    orphan: false,
  };

  return {
    page,
    checks: pageChecks,
    anchors,
    html,
    headers: fetched.headers,
    finalUrl: final,
  };
}

function uniqueInternalUrls(values: string[], base: string): string[] {
  const baseUrl = new URL(base);
  const result = new Set<string>();

  for (const value of values) {
    try {
      const parsed = new URL(value, baseUrl);

      if (parsed.origin !== baseUrl.origin) continue;

      if (
        /\.(?:pdf|jpg|jpeg|png|gif|webp|svg|css|js|zip|mp4|mp3|woff2?)(?:$|\?)/i.test(
          parsed.pathname,
        )
      ) {
        continue;
      }

      parsed.hash = "";
      result.add(parsed.href);
    } catch {
      // Ignore invalid URLs.
    }
  }

  return [...result];
}

async function readRobots(
  baseUrl: string,
): Promise<{ result: FetchResult | null; error?: string }> {
  try {
    return {
      result: await fetchPublic(
        new URL("/robots.txt", baseUrl).href,
      ),
    };
  } catch (error) {
    return {
      result: null,
      error:
        error instanceof Error
          ? error.message
          : "robots.txt could not be fetched.",
    };
  }
}

async function readSitemap(
  baseUrl: string,
  robotsText: string,
): Promise<{
  result: FetchResult | null;
  url: string;
  locs: string[];
  documents: number;
}> {
  const base = new URL(baseUrl);

  const declared = [
    ...robotsText.matchAll(/^\s*sitemap:\s*(\S+)/gim),
  ].map(match => match[1]);

  const targets = [
    new URL("/sitemap.xml", base).href,
    ...declared.flatMap(value => {
      try {
        const candidate = new URL(value, base);

        return candidate.origin === base.origin
          ? [candidate.href]
          : [];
      } catch {
        return [];
      }
    }),
  ];

  const queue = [...new Set(targets)];
  const visited = new Set<string>();
  const locs: string[] = [];

  let firstResult: FetchResult | null = null;
  let firstUrl =
    queue[0] ?? new URL("/sitemap.xml", base).href;

  while (
    queue.length &&
    visited.size < MAX_SITEMAP_DOCUMENTS &&
    locs.length < MAX_SITEMAP_URLS
  ) {
    const target = queue.shift()!;

    if (visited.has(target)) continue;
    visited.add(target);

    try {
      const result = await fetchPublic(target);

      // Prefer a successful sitemap response over an earlier failed one.
      if (
        !firstResult ||
        (
          !(firstResult.status >= 200 && firstResult.status < 400) &&
          result.status >= 200 &&
          result.status < 400
        )
      ) {
        firstResult = result;
        firstUrl = target;
      }

      if (
        result.status < 200 ||
        result.status >= 400 ||
        !/<(?:urlset|sitemapindex)\b/i.test(result.body)
      ) {
        continue;
      }

      const isIndex = /<sitemapindex\b/i.test(result.body);

      const found = [
        ...result.body.matchAll(
          /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi,
        ),
      ]
        .map(match =>
          decodeEntities(match[1] ?? "").trim(),
        )
        .filter(Boolean);

      for (const value of found) {
        try {
          const parsed = new URL(value, target);

          if (parsed.origin !== base.origin) continue;

          if (isIndex && /\.xml(?:$|\?)/i.test(parsed.pathname)) {
            if (
              !visited.has(parsed.href) &&
              !queue.includes(parsed.href) &&
              visited.size + queue.length < MAX_SITEMAP_DOCUMENTS
            ) {
              queue.push(parsed.href);
            }
          } else if (locs.length < MAX_SITEMAP_URLS) {
            locs.push(parsed.href);
          }
        } catch {
          // Ignore malformed sitemap locations.
        }
      }
    } catch {
      // Continue crawling from HTML links if a sitemap is unavailable.
    }
  }

  return {
    result: firstResult,
    url: firstUrl,
    locs: [...new Set(locs)],
    documents: visited.size,
  };
}

function robotsDisallowsPath(
  robotsText: string,
  url: string,
): boolean {
  const path = new URL(url).pathname;
  const lines = robotsText.split(/\r?\n/);

  let applies = false;
  const rules: Array<{ path: string; allow: boolean }> = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();

    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator < 0) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      applies = value === "*";
    } else if (
      applies &&
      (key === "allow" || key === "disallow") &&
      value
    ) {
      rules.push({
        path: value,
        allow: key === "allow",
      });
    }
  }

  // Prefer the most specific matching rule; Allow wins a tie.
  const matching = rules
    .filter(rule => path.startsWith(rule.path))
    .sort(
      (a, b) =>
        b.path.length - a.path.length ||
        Number(b.allow) - Number(a.allow),
    );

  return matching.length > 0 && !matching[0].allow;
}

async function checkLink(
  url: string,
): Promise<{ url: string; status: number | null }> {
  try {
    // HEAD is faster, but some sites return misleading 4xx statuses
    // for HEAD. Verify those responses with a real GET request.
    const head = await fetchPublic(url, "HEAD");

    if (
      head.status === 404 ||
      head.status === 410 ||
      head.status === 403 ||
      head.status === 405 ||
      head.status === 501 ||
      head.status >= 500
    ) {
      const get = await fetchPublic(url, "GET");

      return {
        url,
        status: get.status,
      };
    }

    return {
      url,
      status: head.status,
    };
  } catch {
    return {
      url,
      status: null,
    };
  }
}

function aggregateChecks(
  groups: AuditCheck[][],
): AuditCheck[] {
  const rank: Record<AuditStatus, number> = {
    info: -1,
    pass: 0,
    warning: 1,
    fail: 2,
  };

  const map = new Map<string, AuditCheck[]>();

  for (const group of groups) {
    for (const item of group) {
      map.set(item.id, [
        ...(map.get(item.id) ?? []),
        item,
      ]);
    }
  }

  return [...map.entries()]
    .map(([id, items]) => {
      const worst = [...items].sort(
        (a, b) => rank[b.status] - rank[a.status],
      )[0];

      const affected = [
        ...new Set(
          items
            .filter(
              item =>
                item.status === "fail" ||
                item.status === "warning",
            )
            .map(item => item.exampleUrl),
        ),
      ];

      const status = worst.status;

      const details =
        status === "pass" || status === "info"
          ? worst.details
          : `${items.filter(item => item.status === "fail" || item.status === "warning").length} of ${items.length} scanned page${items.length === 1 ? "" : "s"} need attention. ${worst.details}`;

      return {
        ...worst,
        id,
        details,
        affectedPages: affected.length || items.length,
        exampleUrl: worst.exampleUrl,
        affectedUrls: affected.length
          ? affected
          : [worst.exampleUrl],
      };
    })
    .sort((a, b) => {
      const severity: Record<AuditSeverity, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };

      const status: Record<AuditStatus, number> = {
        fail: 0,
        warning: 1,
        info: 2,
        pass: 3,
      };

      return (
        severity[a.severity] - severity[b.severity] ||
        status[a.status] - status[b.status] ||
        a.title.localeCompare(b.title)
      );
    });
}

function categoryScore(items: AuditCheck[]): number {
  const weight: Record<AuditSeverity, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
  };

  const penalty: Record<AuditStatus, number> = {
    pass: 0,
    info: 0,
    warning: 0.38,
    fail: 1,
  };

  const scored = items.filter(item => item.status !== "info");

  if (!scored.length) return 100;

  const total = scored.reduce(
    (sum, item) => sum + weight[item.severity],
    0,
  );

  const lost = scored.reduce(
    (sum, item) =>
      sum + weight[item.severity] * penalty[item.status],
    0,
  );

  return Math.max(
    0,
    Math.round(((total - lost) / total) * 100),
  );
}

export async function runWebsiteAudit(
  rawUrl: string,
): Promise<AuditReport> {
  const input = normalizeInputUrl(rawUrl);

  try {
    await assertPublicHttpUrl(input);
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        error instanceof Error
          ? error.message
          : "This public website cannot be audited.",
    });
  }

  let root: PageResult;

  try {
    root = await analyzePage(input.href);
  } catch (error) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        error instanceof Error
          ? error.message
          : "The website could not be audited.",
    });
  }

  const baseUrl = root.finalUrl;

  const robotsPromise = readRobots(baseUrl);
  const devicePerformancePromise =
    runPageSpeedDiagnostics(root.finalUrl);

  const [robots] = await Promise.all([robotsPromise]);

  const robotsText = robots.result?.body ?? "";
  const sitemap = await readSitemap(baseUrl, robotsText);

  const discovered = new Set<string>([root.finalUrl]);
  const depthByUrl = new Map<string, number>();
  const queue: string[] = [];

  for (const url of uniqueInternalUrls(
    [...root.anchors, ...sitemap.locs],
    baseUrl,
  )) {
    if (
      url !== root.finalUrl &&
      !depthByUrl.has(url)
    ) {
      depthByUrl.set(url, 1);
      queue.push(url);
    }
  }

  const extraPages: PageResult[] = [];
  let blockedByRobots = 0;
  let pagesSkipped = 0;

  while (
    queue.length &&
    discovered.size < MAX_CRAWL_PAGES
  ) {
    const batch: string[] = [];

    while (
      queue.length &&
      batch.length < CRAWL_BATCH_SIZE &&
      discovered.size + batch.length < MAX_CRAWL_PAGES
    ) {
      const url = queue.shift()!;

      if (discovered.has(url)) continue;

      discovered.add(url);

      if (robotsDisallowsPath(robotsText, url)) {
        blockedByRobots += 1;
        continue;
      }

      batch.push(url);
    }

    if (!batch.length) continue;

    const crawled = await Promise.allSettled(
      batch.map(url => analyzePage(url)),
    );

    for (const [index, result] of crawled.entries()) {
      if (result.status !== "fulfilled") {
        pagesSkipped += 1;
        continue;
      }

      result.value.page.crawlDepth =
        depthByUrl.get(batch[index]) ?? 1;

      extraPages.push(result.value);

      for (const link of uniqueInternalUrls(
        result.value.anchors,
        baseUrl,
      )) {
        if (
          !discovered.has(link) &&
          !depthByUrl.has(link)
        ) {
          depthByUrl.set(
            link,
            result.value.page.crawlDepth + 1,
          );

          queue.push(link);
        }
      }
    }
  }

  const crawlLimitReached =
    queue.length > 0 &&
    discovered.size >= MAX_CRAWL_PAGES;

  pagesSkipped += queue.length;

  root.page.crawlDepth = 0;

  const allResults = [root, ...extraPages];
  const pageUrlSet = new Set(
    allResults.map(result => result.page.url),
  );

  const inboundCounts = new Map<string, number>(
    allResults.map(result => [result.page.url, 0]),
  );

  for (const result of allResults) {
    for (const link of uniqueInternalUrls(
      result.anchors,
      baseUrl,
    )) {
      if (inboundCounts.has(link)) {
        inboundCounts.set(
          link,
          (inboundCounts.get(link) ?? 0) + 1,
        );
      }
    }
  }

  const titleGroups = new Map<string, PageResult[]>();
  const metaGroups = new Map<string, PageResult[]>();

  for (const result of allResults) {
    const normalizedTitle =
      result.page.title.trim().toLowerCase();

    const normalizedMeta =
      result.page.metaDescription.trim().toLowerCase();

    const successfullyFetchedHtml =
      result.page.statusCode >= 200 &&
      result.page.statusCode < 400 &&
      result.page.title !== "Unverified response";

    if (
      successfullyFetchedHtml &&
      normalizedTitle &&
      normalizedTitle !== "untitled page"
    ) {
      titleGroups.set(normalizedTitle, [
        ...(titleGroups.get(normalizedTitle) ?? []),
        result,
      ]);
    }

    if (successfullyFetchedHtml && normalizedMeta) {
      metaGroups.set(normalizedMeta, [
        ...(metaGroups.get(normalizedMeta) ?? []),
        result,
      ]);
    }
  }

  const duplicateTitleGroups = [
    ...titleGroups.values(),
  ].filter(group => group.length > 1);

  const duplicateMetaGroups = [
    ...metaGroups.values(),
  ].filter(group => group.length > 1);

  let orphanPages = 0;

  for (const result of allResults) {
    const page = result.page;
    const inbound = inboundCounts.get(page.url) ?? 0;

    page.inboundInternalLinks = inbound;
    page.orphan =
      page.url !== root.page.url && inbound === 0;

    if (page.orphan) orphanPages += 1;

    const titleGroup =
      titleGroups.get(page.title.trim().toLowerCase()) ?? [];

    const metaGroup =
      metaGroups.get(
        page.metaDescription.trim().toLowerCase(),
      ) ?? [];

    if (titleGroup.length > 1) {
      result.checks.push(
        check(
          "duplicate-title",
          "Duplicate title tag",
          "On-page SEO",
          "warning",
          "high",
          `This title is shared by ${titleGroup.length} crawled pages: ${titleGroup.map(item => item.page.url).join(" · ")}.`,
          "Write a unique title that distinguishes this page's search intent and content.",
          page.url,
          page.title,
        ),
      );
    }

    if (metaGroup.length > 1) {
      result.checks.push(
        check(
          "duplicate-meta-description",
          "Duplicate meta description",
          "On-page SEO",
          "warning",
          "medium",
          `This meta description is shared by ${metaGroup.length} crawled pages: ${metaGroup.map(item => item.page.url).join(" · ")}.`,
          "Write a unique description for this page instead of repeating the same search snippet.",
          page.url,
          page.metaDescription,
        ),
      );
    }

    if (page.orphan) {
      result.checks.push(
        check(
          "orphan-page",
          "Orphan page",
          "Technical SEO",
          "warning",
          "high",
          "This page was discovered from a sitemap or crawl candidate, but no crawled HTML page links to it.",
          "Add a relevant internal link from an indexable page so users and search engines can discover it naturally.",
          page.url,
        ),
      );
    }

    page.checks = result.checks;

    page.issues = page.checks.filter(
      item =>
        item.status === "fail" ||
        item.status === "warning",
    ).length;

    page.score = scoreChecks(page.checks);
  }

  const pages = allResults.map(result => result.page);

  const allInternalLinks = uniqueInternalUrls(
    allResults.flatMap(result => result.anchors),
    baseUrl,
  ).filter(url => url !== root.finalUrl);

  const sitemapSet = new Set(
    uniqueInternalUrls(sitemap.locs, baseUrl),
  );

  const sitemapOnlyUrls = [...sitemapSet].filter(
    url => !pageUrlSet.has(url),
  );

  const crawledNotInSitemap = pages.filter(
    page => !sitemapSet.has(page.url),
  ).length;

  const maxDepth = Math.max(
    ...pages.map(page => page.crawlDepth),
    0,
  );

  const linkResults: Array<{
    url: string;
    status: number | null;
  }> = [];

  // Limit simultaneous link checks to avoid overwhelming the target site.
  const LINK_CHECK_BATCH_SIZE = 10;

  for (
    let index = 0;
    index < allInternalLinks.length;
    index += LINK_CHECK_BATCH_SIZE
  ) {
    const batch = allInternalLinks.slice(
      index,
      index + LINK_CHECK_BATCH_SIZE,
    );

    const results = await Promise.all(
      batch.map(url => checkLink(url)),
    );

    linkResults.push(...results);
  }

  const broken = linkResults.filter(
    item => item.status === 404 || item.status === 410,
  );

  const serverErrors = linkResults.filter(
    item => item.status !== null && item.status >= 500,
  );

  const unverifiable = linkResults.filter(
    item =>
      item.status === null ||
      item.status === 403 ||
      item.status === 429,
  );

  const devicePerformance = await devicePerformancePromise;

  const deviceRuns = [
    devicePerformance.mobile,
    devicePerformance.desktop,
  ];

  const devicesWithFieldData = deviceRuns.filter(
    device =>
      device.status === "available" &&
      device.fieldSource !== "none",
  );

  const coreWebVitalsStatus: AuditReport["metrics"]["coreWebVitals"]["status"] =
    devicesWithFieldData.length === 2
      ? "available"
      : devicesWithFieldData.length === 1
        ? "partial"
        : deviceRuns.every(
              device => device.status === "not-configured",
            )
          ? "not-configured"
          : deviceRuns.every(
                device => device.status === "available",
              )
            ? "no-field-data"
            : "unavailable";

  const coreWebVitalsNote =
    devicesWithFieldData.length === 2
      ? `CrUX 28-day field data is available for mobile (${devicePerformance.mobile.fieldSource}) and desktop (${devicePerformance.desktop.fieldSource}).`
      : devicesWithFieldData.length === 1
        ? `CrUX 28-day field data is available for ${devicesWithFieldData[0].strategy} at ${devicesWithFieldData[0].fieldSource} level; the other device profile has no field data.`
        : deviceRuns.every(
              device => device.status === "available",
            )
          ? "Lighthouse lab results are available, but Google returned no CrUX field data for this URL or its origin."
          : deviceRuns.every(
                device => device.status === "not-configured",
              )
            ? "Configure the Google PageSpeed Insights API key to request CrUX field data."
            : "Google PageSpeed did not return CrUX field data for both device profiles.";

  const globalChecks: AuditCheck[] = [];

  for (const device of deviceRuns) {
    const title =
      device.strategy === "mobile"
        ? "Mobile Lighthouse performance"
        : "Desktop Lighthouse performance";

    const status: AuditStatus =
      device.status !== "available" ||
      device.score === null
        ? "info"
        : device.score >= 90
          ? "pass"
          : device.score >= 50
            ? "warning"
            : "fail";

    const details =
      device.status === "available" &&
      device.score !== null
        ? `Google Lighthouse ${device.strategy} lab test scored ${device.score}/100. This is a simulated device test, not a real-user field score.`
        : device.message ??
          "Google PageSpeed did not return a result for this device profile.";

    const recommendation =
      status === "pass"
        ? `Keep checking ${device.strategy} performance after major page changes.`
        : status === "info"
          ? "Check the PageSpeed API configuration or try this device profile again later."
          : `Review the ${device.strategy} lab metrics and the top opportunities in the device report, then retest.`;

    const evidence =
      device.score === null
        ? undefined
        : `${device.score}/100${device.labMetrics.length ? ` · ${device.labMetrics.slice(0, 3).map(metric => `${metric.label}: ${metric.value}`).join(" · ")}` : ""}`;

    globalChecks.push(
      check(
        `pagespeed-${device.strategy}`,
        title,
        "Performance & mobile",
        status,
        status === "info" ? "low" : "high",
        details,
        recommendation,
        baseUrl,
        evidence,
      ),
    );
  }

  const fieldEvidence = deviceRuns
    .filter(device => device.fieldSource !== "none")
    .map(
      device =>
        `${device.strategy}: ${device.fieldSource}${device.fieldCategory ? ` (${device.fieldCategory})` : ""}`,
    )
    .join(" · ");

  globalChecks.push(
    check(
      "core-web-vitals",
      "Core Web Vitals field data",
      "Performance & mobile",
      "info",
      "low",
      coreWebVitalsNote,
      "Use the mobile/desktop field-data panel to review the 75th-percentile LCP, INP, and CLS experience; URL-level or origin-level coverage is labelled separately.",
      baseUrl,
      fieldEvidence || undefined,
    ),
  );

  const robotsStatus: AuditStatus =
    robots.result &&
    robots.result.status >= 200 &&
    robots.result.status < 400
      ? "pass"
      : "warning";

  const disallowsAll =
    /^\s*user-agent:\s*\*\s*(?:\r?\n)(?:(?!\s*user-agent:)[^\n]*\n)*\s*disallow:\s*\/\s*(?:#.*)?$/im.test(
      robotsText,
    );

  globalChecks.push(
    check(
      "robots-txt",
      "robots.txt availability",
      "Technical SEO",
      disallowsAll ? "fail" : robotsStatus,
      disallowsAll ? "high" : "medium",
      robotsStatus === "pass"
        ? `robots.txt returned HTTP ${robots.result?.status}${disallowsAll ? " and appears to block all crawlers" : ""}.`
        : "robots.txt was missing or could not be read at the site's root.",
      disallowsAll
        ? "Review the rule that blocks all crawlers and allow access to public pages intended for search."
        : "Publish a valid robots.txt file to make crawl guidance explicit.",
      baseUrl,
    ),
  );

  if (robotsStatus === "pass" && robotsText.trim()) {
    const robotsIssues = robotsText
      .split(/\r?\n/)
      .map(line => line.split("#")[0].trim())
      .filter(Boolean)
      .filter(line => {
        if (!line.includes(":")) return true;

        const [directive, ...value] = line.split(":");
        const name = directive.trim().toLowerCase();
        const content = value.join(":").trim();

        if (name === "user-agent") return !content;

        if (
          [
            "allow",
            "disallow",
            "sitemap",
            "crawl-delay",
            "host",
          ].includes(name)
        ) {
          return false;
        }

        return true;
      });

    globalChecks.push(
      check(
        "robots-syntax",
        "robots.txt basic syntax",
        "Technical SEO",
        robotsIssues.length ? "warning" : "pass",
        "low",
        robotsIssues.length
          ? `Found ${robotsIssues.length} line(s) that may have invalid syntax.`
          : "No obvious robots.txt syntax errors were found.",
        "Review robots.txt lines that are missing a colon or have an empty User-agent value.",
        baseUrl,
      ),
    );
  }

  const sitemapValid = Boolean(
    sitemap.result &&
      sitemap.result.status >= 200 &&
      sitemap.result.status < 400 &&
      /<(?:urlset|sitemapindex)\b/i.test(
        sitemap.result.body,
      ),
  );

  globalChecks.push(
    check(
      "sitemap",
      "XML sitemap",
      "Technical SEO",
      sitemapValid ? "pass" : "warning",
      "medium",
      sitemapValid
        ? `An XML sitemap was found with ${sitemap.locs.length} listed URL${sitemap.locs.length === 1 ? "" : "s"}.`
        : "No readable XML sitemap was found at the declared or standard sitemap URL.",
      "Publish an XML sitemap containing canonical, indexable pages and reference it from robots.txt.",
      baseUrl,
      sitemapValid ? sitemap.url : undefined,
    ),
  );

  globalChecks.push(
    check(
      "orphan-pages",
      "Orphan pages",
      "Technical SEO",
      orphanPages ? "warning" : "pass",
      orphanPages ? "high" : "low",
      orphanPages
        ? `${orphanPages} crawled page${orphanPages === 1 ? " has" : "s have"} no inbound internal HTML links.`
        : "Every crawled page has at least one inbound internal HTML link or is the homepage.",
      orphanPages
        ? "Add contextual internal links to orphan pages from relevant indexable pages."
        : "Keep a clear internal linking path to every important page.",
      baseUrl,
      orphanPages
        ? pages
            .filter(page => page.orphan)
            .slice(0, 8)
            .map(page => page.url)
            .join(" · ")
        : undefined,
    ),
  );

  globalChecks.push(
    check(
      "crawl-depth",
      "Crawl depth",
      "Technical SEO",
      maxDepth > 4 ? "warning" : "info",
      "low",
      `The deepest crawled page was ${maxDepth} click${maxDepth === 1 ? "" : "s"} from the starting URL.`,
      "Keep important pages within a shallow, intentional internal linking structure; add links from hub pages when depth grows.",
      baseUrl,
      `Maximum depth: ${maxDepth}`,
    ),
  );

  const sitemapGapCount =
    sitemapOnlyUrls.length + crawledNotInSitemap;

  globalChecks.push(
    check(
      "sitemap-crawl-comparison",
      "Sitemap vs actual crawl",
      "Technical SEO",
      sitemapGapCount ? "warning" : "pass",
      "medium",
      sitemapGapCount
        ? `${sitemapOnlyUrls.length} sitemap URL${sitemapOnlyUrls.length === 1 ? " was" : "s were"} not crawled successfully and ${crawledNotInSitemap} crawled page${crawledNotInSitemap === 1 ? " is" : "s are"} not listed in the sitemap.`
        : "Every sitemap URL was crawled successfully and every crawled page is represented in the sitemap.",
      "Remove dead or redirected URLs from the sitemap, add important canonical pages that are missing, and investigate any crawl failures.",
      baseUrl,
      sitemapGapCount
        ? [
            ...sitemapOnlyUrls.slice(0, 4),
            ...pages
              .filter(page => !sitemapSet.has(page.url))
              .slice(0, 4)
              .map(page => page.url),
          ].join(" · ")
        : undefined,
    ),
  );

  const brokenStatus: AuditStatus =
    broken.length > 0
      ? broken.length >= 3
        ? "fail"
        : "warning"
      : serverErrors.length > 0
        ? "warning"
        : "pass";

  const brokenEvidence = broken
    .slice(0, 4)
    .map(item => `${item.status} ${item.url}`)
    .join(" · ");

  globalChecks.push(
    check(
      "broken-internal-links",
      "Broken internal links",
      "Technical SEO",
      brokenStatus,
      broken.length >= 3 ? "high" : "medium",
      broken.length
        ? `${broken.length} of ${linkResults.length} discovered internal links returned 404 or 410.${brokenEvidence ? ` ${brokenEvidence}` : ""}`
        : serverErrors.length
          ? `${serverErrors.length} discovered internal link${serverErrors.length === 1 ? "" : "s"} returned a server error.`
          : `No 404/410 responses were confirmed in ${linkResults.length} discovered internal links.${unverifiable.length ? ` ${unverifiable.length} link${unverifiable.length === 1 ? " was" : "s were"} not verifiable.` : ""}`,
      "Update, redirect, or remove links that lead to missing pages; verify links that blocked automated checks.",
      baseUrl,
    ),
  );

  const normalizedInputWasHttp =
    input.protocol === "http:";

  let httpsAvailable =
    new URL(root.finalUrl).protocol === "https:";

  if (!httpsAvailable && normalizedInputWasHttp) {
    try {
      const probe = new URL(root.finalUrl);
      probe.protocol = "https:";
      probe.port = "";

      const probeResult = await fetchPublic(probe.href, "HEAD");

      httpsAvailable =
        probeResult.status >= 200 &&
        probeResult.status < 400;
    } catch {
      httpsAvailable = false;
    }
  }

  const redirectsToHttps =
    new URL(root.finalUrl).protocol === "https:";

  globalChecks.push(
    check(
      "https-redirect",
      "HTTP to HTTPS redirect",
      "Security & domain",
      normalizedInputWasHttp
        ? redirectsToHttps
          ? "pass"
          : httpsAvailable
            ? "warning"
            : "fail"
        : "pass",
      "medium",
      normalizedInputWasHttp
        ? redirectsToHttps
          ? "The HTTP request ended on HTTPS."
          : httpsAvailable
            ? "HTTPS responds, but the tested HTTP URL did not redirect to it."
            : "An HTTPS version could not be confirmed for the tested HTTP URL."
        : "The audit was started with an HTTPS URL.",
      "Redirect all HTTP requests to the matching HTTPS page and keep canonical URLs secure.",
      root.finalUrl,
    ),
  );

  const groups = [
    root.checks,
    ...extraPages.map(page => page.checks),
    globalChecks,
  ];

  const checks = aggregateChecks(groups);

  const categoriesSummary = categories.map(category => {
    const selected = checks.filter(
      item => item.category === category,
    );

    return {
      category,
      score: categoryScore(selected),
      checks: selected.filter(item => item.status !== "info")
        .length,
      issues: selected.filter(
        item =>
          item.status === "warning" ||
          item.status === "fail",
      ).length,
    };
  });

  const score = Math.round(
    categoriesSummary.reduce(
      (sum, item) => sum + item.score,
      0,
    ) / categoriesSummary.length,
  );

  const report: AuditReport = {
    version: AUDIT_REPORT_VERSION,
    inputUrl: input.href,
    finalUrl: root.finalUrl,
    scannedAt: new Date().toISOString(),
    score,
    grade: gradeFor(score),
    categories: categoriesSummary,
    checks,
    pages,
    summary: {
      pagesScanned: pages.length,
      totalChecks: checks.filter(
        item => item.status !== "info",
      ).length,
      passed: checks.filter(
        item => item.status === "pass",
      ).length,
      warnings: checks.filter(
        item => item.status === "warning",
      ).length,
      failed: checks.filter(
        item => item.status === "fail",
      ).length,
      critical: checks.filter(
        item =>
          item.status === "fail" &&
          item.severity === "critical",
      ).length,
    },
    crawl: {
      internalLinksFound: allInternalLinks.length,
      linksChecked: linkResults.length,
      brokenLinks: broken.length,
      sitemapUrls: sitemap.locs.length,
      pagesDiscovered: discovered.size + queue.length,
      pagesSkipped,
      crawlLimit: MAX_CRAWL_PAGES,
      complete: !crawlLimitReached && queue.length === 0,
      blockedByRobots,
      maxDepth,
      orphanPages,
      duplicateTitleGroups: duplicateTitleGroups.length,
      duplicateMetaGroups: duplicateMetaGroups.length,
      sitemapOnlyUrls: sitemapOnlyUrls.length,
      crawledNotInSitemap,
    },
    metrics: {
      responseMs: root.page.loadMs,
      htmlBytes: root.page.htmlBytes,
      devicePerformance,
      coreWebVitals: {
        status: coreWebVitalsStatus,
        note: coreWebVitalsNote,
      },
    },
  };

  return report;
}

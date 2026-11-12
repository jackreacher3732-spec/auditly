import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileDown,
  FileSearch,
  Filter,
  Globe2,
  Info,
  LoaderCircle,
  Monitor,
  Printer,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  EyeOff,
  Wrench,
  TrendingDown,
  Link2,
  ChevronDown,
  Copy,
  XCircle,
  X,
} from "lucide-react";
import { Link } from "wouter";
import Brand from "@/components/Brand";
import { trpc } from "@/lib/trpc";
import type { AuditCategory, AuditCheck, AuditReport as ReportData, AuditStatus, DevicePerformance } from "@shared/audit";
const CURRENT_AUDIT_REPORT_VERSION = 4;

function readSavedReport(): ReportData | null {
  try {
    const value = sessionStorage.getItem("auditly:last-report");
    if (!value) return null;
    const report = JSON.parse(value) as ReportData;
    if (!report?.metrics || report.version !== CURRENT_AUDIT_REPORT_VERSION) {
      sessionStorage.removeItem("auditly:last-report");
      return null;
    }
    report.pages = (report.pages ?? []).map(page => ({ ...page, metaDescription: page.metaDescription ?? "", checks: page.checks ?? [], crawlDepth: page.crawlDepth ?? 0, inboundInternalLinks: page.inboundInternalLinks ?? 0, orphan: page.orphan ?? false }));
    report.crawl = { ...(report.crawl ?? {}), pagesDiscovered: report.crawl?.pagesDiscovered ?? report.pages.length, pagesSkipped: report.crawl?.pagesSkipped ?? 0, crawlLimit: report.crawl?.crawlLimit ?? report.pages.length, complete: report.crawl?.complete ?? true, blockedByRobots: report.crawl?.blockedByRobots ?? 0, maxDepth: report.crawl?.maxDepth ?? 0, orphanPages: report.crawl?.orphanPages ?? 0, duplicateTitleGroups: report.crawl?.duplicateTitleGroups ?? 0, duplicateMetaGroups: report.crawl?.duplicateMetaGroups ?? 0, sitemapOnlyUrls: report.crawl?.sitemapOnlyUrls ?? 0, crawledNotInSitemap: report.crawl?.crawledNotInSitemap ?? 0 };
    if (!report.metrics.devicePerformance) {
      const legacyResult = (strategy: "mobile" | "desktop"): DevicePerformance => ({
        strategy,
        status: "unavailable",
        score: null,
        labMetrics: [],
        fieldMetrics: [],
        fieldSource: "none",
        fieldCategory: null,
        opportunities: [],
        analyzedUrl: report.finalUrl || report.inputUrl,
        message: "This saved report predates separate device speed tests. Select Run again to refresh it.",
      });
      report.metrics.devicePerformance = { mobile: legacyResult("mobile"), desktop: legacyResult("desktop") };
      report.metrics.coreWebVitals = {
        status: "unavailable",
        note: "This saved report predates PageSpeed field data. Select Run again to refresh it.",
      };
    }
    return report;
  } catch { return null; }
}

function scoreColor(score: number): string {
  return score >= 85 ? "#21866b" : score >= 65 ? "#c58123" : "#d35f4c";
}

function ScoreRing({ score, small = false }: { score: number; small?: boolean }) {
  const radius = small ? 29 : 61;
  const size = small ? 74 : 152;
  const stroke = small ? 6 : 10;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className={`score-ring ${small ? "score-ring-small" : ""}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#e9ece8" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={scoreColor(score)} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${circumference * score / 100} ${circumference}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="score-ring-value" style={{ color: scoreColor(score) }}>{score}<small>/100</small></span>
    </div>
  );
}

const statusConfig: Record<AuditStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  pass: { label: "Looks good", icon: CheckCircle2, className: "status-pass" },
  warning: { label: "Needs a look", icon: CircleAlert, className: "status-warning" },
  fail: { label: "Fix needed", icon: XCircle, className: "status-fail" },
  info: { label: "Not measured", icon: Info, className: "status-info" },
};

function FindingCard({ check }: { check: AuditCheck }) {
  const [open, setOpen] = useState(false);
  const [showAllUrls, setShowAllUrls] = useState(false);
  const [urlsOpen, setUrlsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const config = statusConfig[check.status];
  const Icon = config.icon;
  const affectedUrls = (check.affectedUrls?.length ? check.affectedUrls : [check.exampleUrl]).filter(Boolean);
  const visibleUrls = showAllUrls ? affectedUrls : affectedUrls.slice(0, 8);
  const isNoindex = /indexability|noindex/i.test(check.title);
  const impact = isNoindex
    ? "Pages intentionally marked noindex are excluded from search results. Review whether this is expected."
    : null;
  const copyUrls = async () => {
    try {
      await navigator.clipboard.writeText(affectedUrls.join("\n"));
      setCopied(true);
    } catch { setCopied(false); }
  };
  return (
    <article className={`finding-card signature-finding ${config.className} ${open ? "finding-open" : ""}`}>
      <button type="button" className="finding-summary" onClick={() => setOpen(value => !value)} aria-expanded={open}>
        <span className="finding-state-icon"><Icon size={19} /></span>
        <span className="finding-main"><strong>{check.title}</strong><small>{check.category} · {check.affectedPages} page{check.affectedPages === 1 ? "" : "s"}</small></span>
        <span className="finding-priority">{check.status === "pass" || check.status === "info" ? config.label : check.severity}</span>
        <span className={`finding-chevron ${open ? "rotated" : ""}`}><ChevronDown size={19} /></span>
      </button>
      {open && <div className="signature-details">
        <div className="signature-illustration" aria-hidden="true">
          <div className="signature-orbit signature-orbit-one" /><div className="signature-orbit signature-orbit-two" />
          <div className="signature-browser"><div className="signature-browser-bar"><i/><i/><i/></div><div className="signature-browser-line"/><div className="signature-browser-line short"/><div className="signature-browser-line"/></div>
          <div className="signature-illustration-badge">{isNoindex ? <EyeOff size={37} /> : <Icon size={37} />}</div>
        </div>
        <div className="signature-story">
          <div className="signature-step"><span className="signature-step-icon"><FileSearch size={19}/></span><div><strong>Finding</strong><p>{check.details}</p>{check.evidence && <small className="signature-evidence">{check.evidence}</small>}</div></div>
          <div className="signature-step"><span className="signature-step-icon"><Wrench size={19}/></span><div><strong>Recommended fix</strong><p>{check.recommendation}</p></div></div>
          {impact && <div className="signature-step"><span className="signature-step-icon"><TrendingDown size={19}/></span><div><strong>Potential impact</strong><p>{impact}</p></div></div>}
        </div>
        <div className="signature-urls">
          <div className="signature-urls-heading"><span className="signature-urls-icon"><Link2 size={17}/></span><strong>Affected URLs</strong><span className="signature-url-count">{affectedUrls.length}</span></div>
          {affectedUrls.length > 0 && <div className="signature-url-preview">{affectedUrls.slice(0, 2).map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer" title={url}><span>{url}</span><ExternalLink size={14}/></a>)}</div>}
          {affectedUrls.length > 2 && <button type="button" className="signature-view-all" onClick={() => setUrlsOpen(value => !value)} aria-expanded={urlsOpen}>{urlsOpen ? "Hide URLs" : `View all ${affectedUrls.length}`} <ArrowUpRight size={15}/></button>}
          {urlsOpen && affectedUrls.length > 2 && <div className="signature-extra-urls">{affectedUrls.slice(2, showAllUrls ? undefined : 10).map(url => <a href={url} target="_blank" rel="noopener noreferrer" key={url}><span>{url}</span><ExternalLink size={13}/></a>)}{affectedUrls.length > 10 && <button type="button" onClick={() => setShowAllUrls(v => !v)}>{showAllUrls ? "Show fewer" : `Show remaining ${affectedUrls.length - 10}`}</button>}</div>}
          {affectedUrls.length > 0 && <button type="button" className="signature-copy" onClick={copyUrls}><Copy size={14}/>{copied ? "Copied" : "Copy all"}</button>}
        </div>
      </div>}
    </article>
  );
}

function DeviceSpeedCard({ device }: { device: DevicePerformance }) {
  const DeviceIcon = device.strategy === "mobile" ? Smartphone : Monitor;
  const scoreTone = device.score === null ? "" : device.score >= 90 ? "speed-score-good" : device.score >= 50 ? "speed-score-mid" : "speed-score-low";
  const sourceLabel = device.fieldSource === "url" ? "URL-level data" : device.fieldSource === "origin" ? "Origin-level data" : "No field data";
  return (
    <article className={`device-speed-card ${device.status === "available" ? "speed-ready" : "speed-unavailable"}`}>
      <div className="device-speed-card-heading">
        <span className={`device-speed-icon ${device.strategy}`}><DeviceIcon size={18} /></span>
        <div className="device-speed-title"><span className="section-kicker">{device.strategy === "mobile" ? "MOBILE PROFILE" : "DESKTOP PROFILE"}</span><h3>{device.strategy === "mobile" ? "Mobile speed" : "Desktop speed"}</h3></div>
        {device.score !== null ? <span className={`device-speed-score ${scoreTone}`}><strong>{device.score}</strong><small>/ 100</small></span> : <span className="device-speed-state">{device.status === "not-configured" ? "Setup needed" : "Unavailable"}</span>}
      </div>
      {device.status === "available" ? <>
        <div className="device-test-url">Lighthouse lab run · {device.analyzedUrl}</div>
        <div className="device-metric-grid">
          {device.labMetrics.map(metric => <div className="device-metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
          {!device.labMetrics.length && <p className="device-muted">The API returned a score but no displayable lab metrics.</p>}
        </div>
        <div className="field-data-panel">
          <div className="field-data-heading"><div><strong>Real-user Core Web Vitals</strong><small>Chrome UX Report · rolling 28-day field data</small></div><span className={`field-source field-${device.fieldSource}`}>{sourceLabel}</span></div>
          {device.fieldSource !== "none" && device.fieldMetrics.length > 0 ? <>
            <div className="device-metric-grid field-metric-grid">
              {device.fieldMetrics.map(metric => <div className={`device-metric quality-${metric.quality}`} key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
            </div>
            {device.fieldCategory && <div className="field-overall-category">Overall field experience: <strong>{device.fieldCategory}</strong></div>}
          </> : <p className="device-muted">{device.message ?? "Google returned limited field metrics for this URL or origin."}</p>}
        </div>
        {device.opportunities.length > 0 && <div className="speed-opportunities"><strong>Top Lighthouse opportunities</strong><ul>{device.opportunities.map(item => <li key={item}>{item}</li>)}</ul></div>}
      </> : <div className="device-speed-message"><Info size={15} /><span>{device.message}</span></div>}
    </article>
  );
}

function EmptyReport() {
  return <div className="empty-report"><div className="empty-report-icon"><FileSearch size={28} /></div><h1>No audit report yet</h1><p>Run a website checkup first. Your report will appear here for this browser session.</p><Link href="/" className="primary-link-button"><ArrowLeft size={16} /> Back to website checkup</Link></div>;
}

function PageAuditDetails({ page }: { page: ReportData["pages"][number] }) {
  const issues = page.checks.filter(item => item.status === "warning" || item.status === "fail");
  return <div className="page-audit-details">
    <div className="page-audit-heading"><div><span className="section-kicker">PAGE-LEVEL RESULTS</span><h3>{page.title}</h3><a href={page.url} target="_blank" rel="noreferrer">{page.url}</a></div><span>{page.checks.length} checks · {issues.length} issues</span></div>
    <div className="page-audit-list">{page.checks.map(check => <FindingCard check={check} key={`${page.url}-${check.id}`} />)}</div>
  </div>;
}

export default function AuditReport() {
  const [report, setReport] = useState<ReportData | null>(() => readSavedReport());
  const [filter, setFilter] = useState<"all" | "issues" | "passed">("issues");
  const [category, setCategory] = useState<AuditCategory | "All categories">("All categories");
  const [selectedPageUrl, setSelectedPageUrl] = useState<string | null>(null);
  const audit = trpc.audit.run.useMutation();

  useEffect(() => {
    if (!selectedPageUrl) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedPageUrl(null);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [selectedPageUrl]);

  const checks = useMemo(() => {
    if (!report) return [];
    return report.checks.filter(item => {
      const statusMatches = filter === "all" || (filter === "issues" ? item.status === "warning" || item.status === "fail" : item.status === "pass");
      const categoryMatches = category === "All categories" || item.category === category;
      return statusMatches && categoryMatches;
    });
  }, [report, filter, category]);

  const runAgain = () => {
    if (!report || audit.isPending) return;
    audit.mutate({ url: report.inputUrl }, {
      onSuccess: updated => {
        setReport(updated);
        try { sessionStorage.setItem("auditly:last-report", JSON.stringify(updated)); } catch { /* keep the in-memory report */ }
      },
    });
  };

  if (!report) return <div className="report-page"><header className="report-header"><div className="report-header-inner"><Brand /><Link href="/" className="report-back"><ArrowLeft size={15} /> New checkup</Link></div></header><EmptyReport /></div>;

  const issueCount = report.summary.failed + report.summary.warnings;
  const scannedDate = new Date(report.scannedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const categories = Array.from(new Set(report.checks.map(item => item.category)));
  const selectedPage = report.pages.find(page => page.url === selectedPageUrl) ?? null;

  return (
    <div className="report-page">
      <header className="report-header print-hide"><div className="report-header-inner"><Brand /><div className="report-header-actions"><Link href="/" className="report-back"><ArrowLeft size={15} /> New checkup</Link><button className="outline-button" onClick={() => window.print()}><Printer size={15} /> Print / Save PDF</button></div></div></header>
      <main className="report-container">
        <div className="report-breadcrumb print-hide"><Link href="/">SEO Checkup</Link><span>/</span><span>Audit report</span></div>
        <div className="report-title-row">
          <div><span className="section-kicker">WEBSITE HEALTH REPORT</span><h1>SEO audit <span>overview</span></h1><p className="report-domain"><Globe2 size={15} /><a href={report.finalUrl} target="_blank" rel="noreferrer">{new URL(report.finalUrl).host}</a><span>·</span><span>Scanned {scannedDate}</span></p></div>
          <div className="report-title-actions print-hide"><button className="outline-button" onClick={runAgain} disabled={audit.isPending}>{audit.isPending ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Run again</button><button className="primary-button" onClick={() => window.print()}><FileDown size={15} /> Export report</button></div>
        </div>
        {audit.error && <div className="report-error" role="alert">{audit.error.message}</div>}

        <section className="overview-grid" aria-label="Audit overview">
          <article className="score-panel">
            <div className="score-panel-copy"><span className="score-label">OVERALL SEO SCORE</span><strong>{report.grade}</strong><p>Across {report.summary.totalChecks} scored checks on {report.summary.pagesScanned} scanned page{report.summary.pagesScanned === 1 ? "" : "s"}.</p><div className="score-meta"><Clock3 size={14} /> {report.metrics.responseMs.toLocaleString()} ms server response <span>·</span> {(report.metrics.htmlBytes / 1024).toFixed(1)} KB HTML</div></div>
            <ScoreRing score={report.score} />
          </article>
          <article className="issue-panel">
            <div className="issue-panel-heading"><div><span className="score-label">PRIORITY QUEUE</span><h2>What to look at first</h2></div><span className="issue-count">{issueCount} <small>items</small></span></div>
            <div className="issue-stat-list"><div><span className="issue-bullet bullet-red" /><span>Critical fixes</span><strong>{report.summary.critical}</strong></div><div><span className="issue-bullet bullet-amber" /><span>Needs attention</span><strong>{report.summary.warnings + report.summary.failed - report.summary.critical}</strong></div><div><span className="issue-bullet bullet-green" /><span>Checks passing</span><strong>{report.summary.passed}</strong></div></div>
            <button className="text-button" onClick={() => { setFilter("issues"); document.getElementById("findings")?.scrollIntoView({ behavior: "smooth" }); }}>Review priority findings <ArrowDownToLine size={15} className="arrow-sideways" /></button>
          </article>
        </section>

        <section className="device-speed-section" aria-labelledby="device-speed-title">
          <div className="section-row-heading"><div><span className="section-kicker">SEPARATE DEVICE RUNS</span><h2 id="device-speed-title">Mobile &amp; desktop speed</h2></div><span className="muted-small">Lab scores are separate from real-user field data</span></div>
          <p className="device-speed-intro">Google Lighthouse tests the homepage separately in mobile and desktop profiles. When Chrome has enough real-user samples, CrUX field metrics appear with their URL- or origin-level source.</p>
          <div className="device-speed-grid"><DeviceSpeedCard device={report.metrics.devicePerformance.mobile} /><DeviceSpeedCard device={report.metrics.devicePerformance.desktop} /></div>
        </section>

        <section className="category-section">
          <div className="section-row-heading"><div><span className="section-kicker">FOUR ANGLES, ONE CLEAR PICTURE</span><h2>Performance by category</h2></div><span className="muted-small">Scores reflect checks in this scan</span></div>
          <div className="category-grid">
            {report.categories.map((item, index) => <article className="category-card" key={item.category}>
              <div className="category-card-head"><span className={`category-mini-icon mini-${index}`}>{index === 0 ? <FileSearch size={17} /> : index === 1 ? <Globe2 size={17} /> : index === 2 ? <Clock3 size={17} /> : <ShieldAlert size={17} />}</span><span className="category-issues">{item.issues} issue{item.issues === 1 ? "" : "s"}</span></div>
              <h3>{item.category}</h3>
              <div className="category-score-row"><strong style={{ color: scoreColor(item.score) }}>{item.score}</strong><span>/ 100</span><ScoreRing score={item.score} small /></div>
              <div className="category-progress"><span style={{ width: `${item.score}%`, backgroundColor: scoreColor(item.score) }} /></div>
            </article>)}
          </div>
        </section>

        <section className="findings-section" id="findings">
          <div className="section-row-heading findings-heading"><div><span className="section-kicker">THE DETAILS</span><h2>Audit findings</h2><p>Each result includes a plain-language next step.</p></div><span className="finding-total">{report.checks.length} checks</span></div>
          <div className="finding-toolbar print-hide">
            <div className="filter-tabs" role="group" aria-label="Filter audit checks">
              <button className={filter === "issues" ? "active" : ""} onClick={() => setFilter("issues")}><Filter size={14} /> Issues <span>{issueCount}</span></button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All <span>{report.checks.length}</span></button>
              <button className={filter === "passed" ? "active" : ""} onClick={() => setFilter("passed")}><Check size={14} /> Passing</button>
            </div>
            <select value={category} onChange={event => setCategory(event.target.value as AuditCategory | "All categories")} aria-label="Filter by category">
              <option>All categories</option>{categories.map(value => <option key={value}>{value}</option>)}
            </select>
          </div>
          <div className="findings-list">
            {checks.length ? checks.map(item => <FindingCard check={item} key={item.id} />) : <div className="no-findings"><CheckCircle2 size={20} /><span>No checks match this filter.</span></div>}
          </div>
        </section>

        <section className="crawl-section">
          <div className="section-row-heading"><div><span className="section-kicker">CRAWL SUMMARY</span><h2>Pages in this checkup</h2></div><span className="crawl-count"><FileSearch size={14} /> {report.crawl.internalLinksFound} internal links found</span></div>
          <div className="crawl-insights"><div><strong>{report.crawl.maxDepth}</strong><span>max crawl depth</span></div><div><strong>{report.crawl.orphanPages}</strong><span>orphan pages</span></div><div><strong>{report.crawl.duplicateTitleGroups}</strong><span>duplicate title groups</span></div><div><strong>{report.crawl.duplicateMetaGroups}</strong><span>duplicate meta groups</span></div><div><strong>{report.crawl.sitemapOnlyUrls}</strong><span>sitemap URLs not crawled</span></div><div><strong>{report.crawl.crawledNotInSitemap}</strong><span>crawled pages not in sitemap</span></div></div>
          <div className="pages-table-wrap"><table className="pages-table"><thead><tr><th>Page</th><th>HTTP</th><th>Score</th><th>Findings</th><th>Depth</th><th>Inbound</th><th>Response</th><th>Details</th></tr></thead><tbody>{report.pages.map(page => <tr key={page.url}><td><a href={page.url} target="_blank" rel="noreferrer" className="page-title-link"><span>{page.title}</span><small>{page.url}</small></a></td><td><span className={`http-pill ${page.statusCode < 400 ? "http-ok" : "http-bad"}`}>{page.statusCode}</span></td><td><strong style={{ color: scoreColor(page.score) }}>{page.score}</strong></td><td>{page.issues} issue{page.issues === 1 ? "" : "s"}{page.orphan ? <span className="orphan-pill">orphan</span> : null}</td><td>{page.crawlDepth}</td><td>{page.inboundInternalLinks}</td><td>{page.loadMs.toLocaleString()} ms</td><td><button className="page-details-button" onClick={() => setSelectedPageUrl(page.url)} aria-label={`View checks for ${page.title}`}>View checks</button></td></tr>)}</tbody></table></div>
          <div className={`crawl-coverage ${report.crawl.complete ? "coverage-complete" : "coverage-capped"}`}><Info size={14} /><span>{report.crawl.complete ? `Complete discoverable crawl finished: ${report.summary.pagesScanned} pages were scanned.` : `The crawl reached its safety ceiling after ${report.summary.pagesScanned} pages; ${report.crawl.pagesSkipped} discovered URL${report.crawl.pagesSkipped === 1 ? " was" : "s were"} not scanned.`} {report.crawl.blockedByRobots ? `${report.crawl.blockedByRobots} URL${report.crawl.blockedByRobots === 1 ? " was" : "s were"} blocked by robots.txt.` : ""} {report.metrics.coreWebVitals.note}</span></div>
          <div className="export-note print-hide"><span><CheckCircle2 size={16} /> Want a shareable copy?</span><button onClick={() => window.print()}>Print or save as PDF <ArrowUpRight size={14} /></button></div>
        </section>

        <footer className="report-footer print-hide"><Brand /><span>Auditly reports what this scan could observe at the time it ran.</span><Link href="/">Run another website checkup <ArrowUpRight size={13} /></Link></footer>
      </main>
      {selectedPage && <div className="audit-drawer-root print-hide">
        <button type="button" className="audit-drawer-backdrop" onClick={() => setSelectedPageUrl(null)} aria-label="Close page checks" />
        <aside className="audit-drawer" role="dialog" aria-modal="true" aria-label={`Checks for ${selectedPage.title}`}>
          <div className="audit-drawer-topbar">
            <div className="audit-drawer-brand"><span className="audit-drawer-brand-dot" /> PAGE AUDIT <span className="audit-drawer-count">{selectedPage.checks.length} checks</span></div>
            <button type="button" className="audit-drawer-close" onClick={() => setSelectedPageUrl(null)} aria-label="Close details"><X size={19} /></button>
          </div>
          <div className="audit-drawer-scroll" key={selectedPage.url}>
            <PageAuditDetails page={selectedPage} />
          </div>
        </aside>
      </div>}
    </div>
  );
}

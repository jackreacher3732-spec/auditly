import { useState, type FormEvent } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Check,
  CircleGauge,
  ClipboardCheck,
  FileSearch,
  Gauge,
  Globe2,
  Link2,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { useLocation } from "wouter";
import Brand from "@/components/Brand";
import { trpc } from "@/lib/trpc";
import type { AuditReport } from "@shared/audit";

const scanAreas = [
  { icon: FileSearch, title: "On-page signals", copy: "Titles, descriptions, headings, content, and image alt text." },
  { icon: Link2, title: "Technical health", copy: "Indexing directives, sitemaps, canonicals, redirects, and links." },
  { icon: Gauge, title: "Speed & mobile", copy: "Server response, HTML weight, and mobile viewport readiness." },
  { icon: ShieldCheck, title: "Security basics", copy: "HTTPS, mixed content, and important security headers." },
];

const reportHighlights = [
  { icon: ClipboardCheck, title: "Page-level evidence", copy: "Open each crawled URL to see its checks, evidence, score, response time, and exact next action." },
  { icon: ListChecks, title: "Technical coverage", copy: "Compare sitemap URLs with the actual crawl, inspect crawl depth, orphan pages, canonicals, and internal links." },
  { icon: BarChart3, title: "Real speed signals", copy: "Review separate mobile and desktop Lighthouse results, Core Web Vitals field data, and performance opportunities when available." },
];

const faqs = [
  ["Does Auditly use sample or demo data?", "No. The homepage stays empty until you submit a public URL, and the report is built from the pages and responses Auditly actually receives."],
  ["How much of a website does it crawl?", "It follows robots.txt sitemaps, sitemap indexes, and same-origin HTML links recursively. The report also shows coverage, skipped pages, and any safety-cap state."],
  ["Can I see which URLs have an issue?", "Yes. Every aggregated finding includes the affected URL list, and every crawled page has its own expandable checks and evidence."],
  ["What does the speed section need?", "Mobile and desktop Lighthouse tests use a server-side Google PageSpeed Insights API key. CrUX field data appears only when Google has enough real-user samples."],
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [location, navigate] = useLocation();
  const audit = trpc.audit.run.useMutation();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    audit.mutate({ url: url.trim() }, {
      onSuccess: (report: AuditReport) => {
        try { sessionStorage.setItem("auditly:last-report", JSON.stringify(report)); } catch { /* report still renders for this visit */ }
        navigate("/report");
      },
    });
  };

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="header-inner">
          <Brand />
          <nav className="main-nav" aria-label="Main navigation">
            <a href="#what-we-check">What we check</a>
            <a href="#how-it-works">How it works</a>
          </nav>
          <a className="header-cta" href="#audit-form">Run a free audit <ArrowUpRight size={15} /></a>
        </div>
      </header>

      <main>
        <section className="hero-section">
          <div className="hero-wrap">
            <div className="hero-copy">
              <div className="eyebrow"><span className="eyebrow-dot" /> SEO CHECKUP, MADE ACTIONABLE</div>
              <h1>Find the SEO issues hiding in <span>plain sight.</span></h1>
              <p className="hero-lede">A clear, practical checkup for your website. See what is working, what needs attention, and what to fix next.</p>

              <form id="audit-form" className="audit-form" onSubmit={submit}>
                <div className="url-entry">
                  <Globe2 size={19} strokeWidth={1.8} aria-hidden="true" />
                  <input
                    aria-label="Website URL"
                    autoComplete="url"
                    maxLength={2048}
                    onChange={event => setUrl(event.target.value)}
                    placeholder="Enter your website URL"
                    required
                    value={url}
                  />
                  <button type="submit" disabled={audit.isPending}>
                    {audit.isPending ? <><LoaderCircle size={17} className="spin" /> Scanning…</> : <>Run free audit <ArrowRight size={17} /></>}
                  </button>
                </div>
                <div className="form-footnote"><LockKeyhole size={13} /> Public pages only. No account needed.</div>
                {audit.error && <p className="audit-error" role="alert">{audit.error.message}</p>}
              </form>

              <div className="trust-strip">
                <div className="trust-icon"><Check size={16} /></div>
                <p><strong>Clear priorities.</strong> Every finding comes with a plain-English next step.</p>
              </div>
            </div>

            <div className="hero-visual" aria-label="Audit results appear here after a real scan">
              <div className="visual-orbit orbit-one" />
              <div className="visual-orbit orbit-two" />
              <div className="scan-state-card">
                <div className="scan-state-icon"><CircleGauge size={38} strokeWidth={1.5} /></div>
                <span className="preview-kicker">REAL RESULTS ONLY</span>
                <h2>No sample audit data</h2>
                <p>Enter a public website URL and Auditly will show the pages, checks, evidence, and fixes it actually found.</p>
                <div className="scan-state-rule" />
                <div className="scan-state-points"><span><FileSearch size={15} /> Page-by-page findings</span><span><Link2 size={15} /> Discovered internal links</span><span><Gauge size={15} /> Real performance responses</span></div>
              </div>
              <div className="floating-note"><span className="floating-note-icon"><Smartphone size={16} /></span><span><strong>Built for clarity</strong><small>Know where to begin</small></span></div>
              <div className="visual-caption">Nothing is scored until your site is scanned.</div>
            </div>
          </div>
          <div className="hero-bottom-line" />
        </section>

        <section className="proof-band" aria-label="Product benefits">
          <div className="proof-inner">
            <div><span className="proof-mark"><Search size={18} /></span><span><strong>One URL</strong><small>to get started</small></span></div>
            <div><span className="proof-mark"><ShieldCheck size={18} /></span><span><strong>Technical signals</strong><small>made easier to read</small></span></div>
            <div><span className="proof-mark"><ArrowRight size={18} /></span><span><strong>Clear next steps</strong><small>for every key issue</small></span></div>
          </div>
        </section>

        <section className="checks-section" id="what-we-check">
          <div className="section-heading">
            <span className="section-kicker">A BETTER PLACE TO START</span>
            <h2>More than a score.<br /><span>A map to your next fix.</span></h2>
            <p>Auditly looks at the signals that shape how search engines can find, understand, and serve your pages.</p>
          </div>
          <div className="checks-list">
            {scanAreas.map((item, index) => {
              const Icon = item.icon;
              return <article className="check-area" key={item.title}>
                <div className={`check-area-icon icon-tone-${index}`}><Icon size={21} strokeWidth={1.7} /></div>
                <div className="check-area-text"><h3>{item.title}</h3><p>{item.copy}</p></div>
                <span className="check-area-index">0{index + 1}</span>
              </article>;
            })}
          </div>
        </section>

        <section className="workflow-section" id="how-it-works">
          <div className="workflow-inner">
            <div className="workflow-title"><span className="section-kicker">SIMPLE BY DESIGN</span><h2>From website to<br />workable checklist.</h2></div>
            <div className="workflow-steps">
              <div className="workflow-step"><span>01</span><div><h3>Enter a URL</h3><p>Start with a public page on your website.</p></div></div>
              <div className="workflow-step"><span>02</span><div><h3>We scan the discoverable site</h3><p>Auditly follows sitemap entries and same-origin links until the crawl is complete or its safety ceiling is reached.</p></div></div>
              <div className="workflow-step"><span>03</span><div><h3>Choose your next fix</h3><p>Read the findings by priority and print a report you can share.</p></div></div>
            </div>
            <a className="workflow-link" href="#audit-form">Check my website <ArrowUpRight size={17} /></a>
          </div>
        </section>

        <section className="report-highlights-section">
          <div className="report-highlights-heading"><span className="section-kicker">WHAT YOU GET BACK</span><h2>A report you can <span>act on.</span></h2><p>No mystery dashboard metrics. Each part of the report points back to a page, a response, or a clear recommendation.</p></div>
          <div className="report-highlights-grid">{reportHighlights.map(item => { const Icon = item.icon; return <article className="report-highlight-card" key={item.title}><div className="report-highlight-icon"><Icon size={21} strokeWidth={1.7} /></div><h3>{item.title}</h3><p>{item.copy}</p><a href="#audit-form">See it in my audit <ArrowUpRight size={14} /></a></article>; })}</div>
        </section>

        <section className="faq-section" aria-labelledby="faq-heading">
          <div className="faq-heading"><span className="section-kicker">GOOD TO KNOW</span><h2 id="faq-heading">Questions before<br /><span>your first scan?</span></h2></div>
          <div className="faq-list">{faqs.map(([question, answer]) => <article className="faq-item" key={question}><h3>{question}</h3><p>{answer}</p></article>)}</div>
        </section>

        <section className="final-cta">
          <div className="final-cta-inner"><div><span className="section-kicker">YOUR NEXT SEO STEP STARTS HERE</span><h2>Make your next fix<br /><span>the right one.</span></h2></div><a href="#audit-form" className="final-cta-button">Run a free audit <ArrowRight size={17} /></a></div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-inner"><Brand /><p>Clearer SEO checkups for the people building the web.</p><span>© {new Date().getFullYear()} Auditly</span></div>
      </footer>
      {location === "/report" && <a className="sr-only" href="/report">Open report</a>}
    </div>
  );
}

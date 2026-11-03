# TODO

- [x] **URL-based audit and page crawl** — Homepage par website URL enter karke SEO audit start karna; website pages aur essential SEO signals ko crawl aur analyze karna.
- [x] **Overall score and category summary** — Overall SEO score aur category-wise performance summary dikhana.
- [x] **On-page SEO findings** — On-page SEO checks, including title tags, meta descriptions, headings, content aur image alt text.
- [x] **Technical SEO findings** — Technical SEO checks, including indexability, robots.txt, sitemap, canonical tags, redirects aur broken links.
- [x] **Performance and mobile findings** — Performance aur mobile-readiness checks, including page speed aur Core Web Vitals signals. HTML-crawl response-time/viewport signals, alag mobile aur desktop Lighthouse results, aur CrUX field-data source ya unavailable state report hota hai.
- [x] **Security and domain findings** — Security aur domain checks, including HTTPS, mixed content aur basic domain configuration.
- [x] **Prioritized fix guidance** — Issues ko severity aur priority ke mutabiq categorize karna; har detected issue ke liye seedhi explanation aur actionable fix recommendations dena.
- [x] **Detailed audit report** — Detailed audit report ko dashboard mein dikhana.
- [x] **Report export** — Detailed report ko PDF/print-friendly format mein export karna.
- [x] **Mobile and desktop speed reports** — Har audit mein mobile aur desktop ke liye alag PageSpeed/Lighthouse performance score aur speed metrics dikhana; Core Web Vitals field data available ho to uska source (URL ya origin) batana, aur unavailable data ko clearly label karna.
- [x] **Deeper canonical diagnostics** — Missing, duplicate/conflicting, malformed, non-self/cross-domain canonical tags aur canonical target ke HTTP status, redirect, ya `noindex` problems ko evidence aur actionable fix ke saath report karna.
- [x] **No fabricated/sample output** — Product mein koi sample, demo, ya placeholder audit score/finding/report na dikhana; sirf real scan results ya clear empty/loading/error states dikhana. Homepage ka static report preview real-results-only empty state se replace hai.
- [x] **Complete discoverable-site crawl** — 2 ya 6 pages ki fixed sample limit ke bajaye robots.txt se listed sitemap files/indexes aur recursively discovered same-origin page links crawl karna. Publicly discoverable HTML pages ko scan karna; blocked, unreachable, unsupported, ya safety-cap ki wajah se chhute pages aur total coverage ko clearly report karna, aur incomplete scan ko complete na kehna. Crawl mein transparent 250-page safety ceiling hai.
- [x] **Per-page audit details** — Har crawled page ke apne SEO, technical, canonical, mobile/desktop speed aur field-data results, evidence aur actionable fixes dikhana; page-specific details ko sirf ek site-wide aggregate mein chhupana nahi. Report table se har page ke individual checks khul sakte hain.
- [x] **Schema / structured data validator** — Har crawled page ke JSON-LD blocks parse karna, invalid JSON, missing `@type`, aur common schema types ke required properties ko real HTML se validate karna.
- [x] **Duplicate metadata detection** — Crawled pages ke duplicate title tags aur meta descriptions ko group karke affected URLs aur unique-copy recommendations dikhana.
- [x] **Orphan pages and crawl depth** — Internal HTML links se inbound counts aur BFS crawl depth calculate karna; sitemap-only/no-inbound pages ko orphan finding ke taur par report karna.
- [x] **Sitemap vs actual crawl comparison** — Sitemap mein listed lekin successfully crawl na hone wale URLs aur crawl mein milne wale lekin sitemap se missing pages ko count/evidence ke saath report karna.

## Research basis

- Google's [PageSpeed Insights API guide](https://developers.google.com/speed/docs/insights/v5/get-started) documents the API key and Lighthouse/CrUX response data.
- Google's [PageSpeed Insights API reference](https://developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed) documents `strategy=mobile|desktop`, category, and response fields.
- Google's [PageSpeed Insights overview](https://developers.google.com/speed/docs/insights/v5/about) explains lab versus 28-day CrUX field data and page-to-origin fallback when a page lacks sufficient data.

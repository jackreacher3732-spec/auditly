import { Link } from "wouter";

export default function Brand() {
  return (
    <Link href="/" className="brand-lockup" aria-label="Auditly home">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 34 34" fill="none">
          <path d="M6 24.5 13.2 17l4.7 4.4L28 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M21.5 10H28v6.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="7" cy="10" r="2" fill="currentColor" />
        </svg>
      </span>
      <span className="brand-name">auditly<span>.</span></span>
    </Link>
  );
}

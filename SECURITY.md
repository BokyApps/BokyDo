# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue. Use GitHub's private vulnerability reporting ("Report a
vulnerability" under the Security tab) with steps to reproduce, affected version and impact.

We aim to acknowledge reports within 3 days and to ship fixes for High/Critical issues within 14 days.
Reporters are credited in the release notes unless they prefer otherwise.

## Supported versions

Until 1.0, only the latest release receives security fixes.

## How we work

- Target: OWASP ASVS 4.0.3 Level 2 ([tracker](docs/security/asvs.md)).
- Every deliverable passes a security gate before it ships: threat model update, automated scans
  (Semgrep, CodeQL, osv-scanner, gitleaks, Trivy, ZAP), deliverable-specific abuse-case tests, and
  manual review. Findings are logged in [docs/security/findings.md](docs/security/findings.md).
- High and Critical findings block a release.

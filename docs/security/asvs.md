# OWASP ASVS 4.0.3 Level 2 tracker

Status per chapter. Detailed requirement-by-requirement review happens in W13. This file records
which deliverable owns each area and what's already in place.

| Chapter                                | Owner | Status | Notes                                                      |
| -------------------------------------- | ----- | ------ | ---------------------------------------------------------- |
| V1 Architecture & threat modelling     | F1    | 🟡     | Threat model v0.1, ADRs, CI security gates                 |
| V2 Authentication                      | W1    | ⏳     | Argon2id hashing ready (F2); TOTP, passkeys, lockout in W1 |
| V3 Session management                  | W1    | ⏳     | `session.key` provisioned (F2)                             |
| V4 Access control                      | F4    | ⏳     | Central policy layer + authz matrix                        |
| V5 Validation, sanitisation & encoding | F4/W2 | 🟡     | Zod schemas; strict CSP; no inline script                  |
| V6 Stored cryptography                 | F3    | 🟡     | KEK provisioned (F2); envelope encryption in F3            |
| V7 Error handling & logging            | F2    | 🟡     | Generic 5xx; log redaction; audit log table                |
| V8 Data protection                     | W11   | ⏳     | Export, deletion, backups                                  |
| V9 Communications                      | F3    | ⏳     | HTTPS detection, HSTS once public URL is HTTPS             |
| V10 Malicious code                     | F1    | 🟡     | Supply-chain controls, pinned actions/images               |
| V11 Business logic                     | W2+   | ⏳     |                                                            |
| V12 Files & resources                  | W5    | ⏳     | Attachments; SSRF-safe client in W7                        |
| V13 API & web service                  | W10   | ⏳     |                                                            |
| V14 Configuration                      | F2    | 🟡     | Hardened container, headers, no default credentials        |

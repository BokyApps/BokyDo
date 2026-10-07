import { z } from 'zod';

/**
 * Extra push services an admin allows, for UnifiedPush distributors (ntfy and friends) and
 * self-hosted push servers. An entry is a hostname, optionally with a port ("ntfy.example.com",
 * "push.example.com:8443"), or a wildcard for a domain's subdomains ("*.push.example.com").
 * Without a port only 443 is allowed. Endpoints are always https.
 */
export interface PushHostEntry {
  host: string;
  /** Matches any subdomain of `host` (not `host` itself). */
  wildcard: boolean;
  port: number;
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const ENTRY = new RegExp(
  `^(?<wild>\\*\\.)?(?<host>${LABEL}(?:\\.${LABEL})+)(?::(?<port>\\d{1,5}))?$`,
);

/** Parse an allow-list entry; null when it isn't one. */
export function parsePushHost(entry: string): PushHostEntry | null {
  const g = ENTRY.exec(entry.trim().toLowerCase())?.groups;
  const host = g?.host;
  if (!g || !host) return null;
  // Hostnames only: IP literals would sidestep the certificate's name, and a bare TLD
  // wildcard ("*.com") would allow half the internet.
  if (/^[\d.]+$/.test(host) || host.endsWith('.localhost')) return null;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (/^\d+$/.test(tld)) return null;
  const port = g.port ? Number(g.port) : 443;
  if (port < 1 || port > 65535) return null;
  return { host, wildcard: !!g.wild, port };
}

export const pushHostEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(260)
  .refine(
    (v) => parsePushHost(v) !== null,
    'Must be a hostname such as ntfy.example.com, optionally with :port or a *. prefix',
  );

/** Whether `hostname`:`port` (port 443 when the URL has none) is covered by the entries. */
export function pushHostAllowed(
  entries: readonly string[],
  hostname: string,
  port: number,
): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return entries.some((raw) => {
    const e = parsePushHost(raw);
    if (!e || e.port !== port) return false;
    return e.wildcard ? host.endsWith(`.${e.host}`) : host === e.host;
  });
}

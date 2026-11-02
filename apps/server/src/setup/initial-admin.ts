/** Formats the explicit break-glass CLI password reset output. */

export function credentialBanner(opts: {
  heading: string;
  username: string;
  passphrase: string;
}): string {
  const lines = [
    opts.heading,
    '',
    `  Username:   ${opts.username}`,
    `  Passphrase: ${opts.passphrase}`,
    '',
    'This passphrase is shown only once and must be changed at first login.',
    `Lost it? Run: docker compose exec app bokydo admin reset-password ${opts.username}`,
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '='.repeat(width);
  return ['', bar, ...lines.map((l) => `  ${l}`), bar, ''].join('\n');
}

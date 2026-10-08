import { networkInterfaces } from 'node:os';

/**
 * This machine's private (RFC 1918) IPv4 address, for tests that need a server "on the LAN". Not
 * any non-internal address: sandboxes often sit on documentation or carrier ranges (192.0.2.0/24,
 * 100.64.0.0/10) that the outbound policy blocks outright, and those tests should skip there.
 */
export const lanIpv4: string | undefined = Object.values(networkInterfaces())
  .flat()
  .find(
    (i) =>
      i &&
      i.family === 'IPv4' &&
      !i.internal &&
      /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(i.address),
  )?.address;

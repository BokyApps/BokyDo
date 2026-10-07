/**
 * Parse the "Name: value" lines of the AI credential form into the header record the API takes.
 * Returns undefined when there is nothing to send, so a caller can leave stored headers untouched.
 *
 * Only the first colon splits, so values may contain colons (`Authorization: Bearer a:b`).
 * A line with no colon becomes an empty value rather than being dropped: dropping it silently
 * would leave the user thinking a header had been set.
 */
export function parseHeaderLines(text: string): Record<string, string> | undefined {
  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      return at === -1
        ? ([line, ''] as const)
        : ([line.slice(0, at).trim(), line.slice(at + 1).trim()] as const);
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

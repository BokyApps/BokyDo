/**
 * Case-insensitive `*` wildcard matching for names (`#Work*`, `@home*`), without regular
 * expressions. Classic two-pointer matching: at most O(name × pattern), and names are short.
 */
export function globMatch(pattern: string, name: string): boolean {
  const p = normalizePattern(pattern);
  const s = name.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (j < p.length && p[j] !== '*' && p[j] === s[i]) {
      i++;
      j++;
    } else if (j < p.length && p[j] === '*') {
      star = j++;
      mark = i;
    } else if (star !== -1) {
      j = star + 1;
      i = ++mark;
    } else {
      return false;
    }
  }
  while (j < p.length && p[j] === '*') j++;
  return j === p.length;
}

/** Lower-cased, with runs of `*` collapsed. */
export function normalizePattern(pattern: string): string {
  let out = '';
  for (const ch of pattern.toLowerCase()) if (!(ch === '*' && out.endsWith('*'))) out += ch;
  return out;
}

export const hasWildcard = (pattern: string) => pattern.includes('*');

/** SQL LIKE pattern for a glob: `%`, `_` and `\` are escaped, `*` becomes `%`. */
export function globToLike(pattern: string): string {
  let out = '';
  for (const ch of normalizePattern(pattern)) {
    if (ch === '*') out += '%';
    else if (ch === '%' || ch === '_' || ch === '\\') out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

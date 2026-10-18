/**
 * Small text helpers shared by the kernel and the plugins. One rule runs through them: text that leaves a function must be
 * well formed. A JavaScript string is a list of UTF-16 code units, and `slice` can cut an emoji (two units) in half. The half
 * that is left is a "lone surrogate": legal in a string, but it has no UTF-8 form and no valid JSON text form in some engines.
 */

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The first `n` UTF-16 units of `s`, or one fewer when the cut would split a surrogate pair. Never returns half a character. */
export function clipText(s: string, n: number): string {
  if (n <= 0) return '';
  if (s.length <= n) return s;
  const end = isHigh(s.charCodeAt(n - 1)) && isLow(s.charCodeAt(n)) ? n - 1 : n;
  return s.slice(0, end);
}

/** `s` with every lone surrogate replaced by U+FFFD. */
export function wellFormed(s: string): string {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) {
      i++;
    } else if (isHigh(c) || isLow(c)) {
      out += s.slice(last, i) + '�';
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

/**
 * JSON text for a value that is going into a store, or undefined when the value has no JSON form. Two things in a string
 * would make an engine refuse the text, and neither can carry meaning, so both become U+FFFD here and the same text
 * reaches every engine: a lone surrogate, and the NUL character. `JSON.stringify` writes both as `\uXXXX` escapes, and
 * writes a well-formed pair as the character itself, so any `\ud800`-`\udfff` escape in its output is a lone surrogate.
 * An escape preceded by an odd number of backslashes is text (a backslash, then "ud83e"), and stays.
 */
export function storableJson(value: unknown): string | undefined {
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  return json.replace(/(?<!\\)((?:\\\\)*)\\u(?:d[89a-f][0-9a-f]{2}|0000)/g, '$1\\ufffd');
}

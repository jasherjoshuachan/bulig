import { createHash, timingSafeEqual } from 'node:crypto';

export type Compare = (a: Buffer, b: Buffer) => boolean;

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Bearer tokens, one per worker id. A token is never compared as a string: both sides are hashed to the same length first and
 * the hashes go through `timingSafeEqual`, so neither the length of a token nor how much of it matched shows in how long the
 * check takes. Every configured worker is checked on every request, with no early exit, so the time does not say which worker
 * a near-miss was close to.
 */
export class TokenAuth {
  private readonly entries: { id: string; hash: Buffer }[];

  constructor(
    tokens: Iterable<{ id: string; token: string }>,
    readonly compare: Compare = timingSafeEqual,
  ) {
    this.entries = [...tokens].map((t) => ({ id: t.id, hash: digest(t.token) }));
  }

  /** The worker id the Authorization header belongs to, or undefined. Nothing else is revealed. */
  authenticate(header: string | undefined): string | undefined {
    const m = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    // A request with no usable header is hashed as the empty string, so it costs the same as one with a wrong token.
    const presented = digest(m ? m[1]! : '');
    let found: string | undefined;
    for (const e of this.entries) {
      if (this.compare(presented, e.hash) && m) found = e.id;
    }
    return found;
  }
}

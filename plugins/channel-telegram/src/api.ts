/** A thin Telegram Bot API client on plain fetch. It retries what is worth retrying and never shows the token. */

export type FetchLike = typeof fetch;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** The API answered, and the answer was no. */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export interface ApiOptions {
  apiBase: string;
  token: string;
  fetch: FetchLike;
  sleep: Sleep;
  /** Aborted when the plugin stops. Stops waiting, retrying and in-flight requests. */
  signal: AbortSignal;
  warn(message: string): void;
}

export interface CallOptions {
  /** Most tries for one call, counting the first. Infinity keeps going until stopped. Default 4. */
  maxAttempts?: number;
  /** Give up on one request after this long. */
  timeoutMs?: number;
}

const MAX_BACKOFF_MS = 30_000;

/** Codes that mean "try again": rate limit, a conflicting poller, and server trouble. */
const retriable = (code: number) => code === 429 || code === 409 || code >= 500;

export class TelegramApi {
  constructor(private o: ApiOptions) {}

  /** Take the token out of any text before it can reach a log. */
  private scrub(text: string): string {
    return text.split(this.o.token).join('<token>');
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
    const maxAttempts = opts.maxAttempts ?? 4;
    for (let attempt = 1; ; attempt++) {
      if (this.o.signal.aborted) throw new Error('stopped');
      let waitMs = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      let failure: Error;
      try {
        const signal = opts.timeoutMs ? AbortSignal.any([this.o.signal, AbortSignal.timeout(opts.timeoutMs)]) : this.o.signal;
        const res = await this.o.fetch(`${this.o.apiBase}/bot${this.o.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: T;
          description?: string;
          parameters?: { retry_after?: number };
        };
        if (res.ok && body.ok) return body.result as T;
        const description = body.description ?? `HTTP ${res.status}`;
        failure = new TelegramError(this.scrub(`${method}: ${description}`), res.status);
        if (!retriable(res.status)) throw failure;
        if (res.status === 429) waitMs = Math.max(0, body.parameters?.retry_after ?? 1) * 1000;
      } catch (err) {
        if (err instanceof TelegramError && !retriable(err.code)) throw err;
        if (this.o.signal.aborted) throw new Error('stopped');
        failure = err instanceof TelegramError ? err : new Error(this.scrub(`${method}: ${err instanceof Error ? err.message : String(err)}`));
      }
      if (attempt >= maxAttempts) throw failure;
      this.o.warn(`${failure.message}; trying again in ${Math.round(waitMs / 1000)}s`);
      await this.o.sleep(waitMs, this.o.signal);
    }
  }
}

// Per-invocation context on Cloudflare Workers: background work (ctx.waitUntil) and a subrequest counter.
// Workers Free allows 50 subrequests per invocation, and work passed to waitUntil counts towards the same
// invocation. Long loops (drain, daily) stop early via subrequestsLeft() and leave the rest to the next run.
// Outside a Worker (unit tests, scripts) there is no context: waitUntil just lets the promise run and
// subrequestsLeft() is unlimited.
import { AsyncLocalStorage } from 'node:async_hooks';

export const SUBREQUEST_LIMIT = 50;

// Workers cancel waitUntil work 30 s after the response. Background drains stop claiming at 15 s, which leaves
// ~15 s for the row in progress; a row cut off anyway is retried by a later drain once its lease expires.
export const BACKGROUND_DEADLINE_MS = 15_000;

interface Invocation {
  waitUntil(promise: Promise<unknown>): void;
  subrequests: number;
}

const current = new AsyncLocalStorage<Invocation>();

export function runInvocation<T>(ctx: { waitUntil(promise: Promise<unknown>): void }, fn: () => T): T {
  return current.run({ waitUntil: (p) => ctx.waitUntil(p), subrequests: 0 }, fn);
}

/** Keep the invocation alive until `promise` settles (at most 30 s after the response on Workers). */
export function waitUntil(promise: Promise<unknown>): void {
  current.getStore()?.waitUntil(promise);
}

export function countSubrequest(): void {
  const inv = current.getStore();
  if (inv) inv.subrequests++;
}

export function subrequestsLeft(): number {
  const inv = current.getStore();
  return inv ? SUBREQUEST_LIMIT - inv.subrequests : Infinity;
}

/** Wraps fetch so every outgoing request is counted against the current invocation. Install once. */
export function countingFetch(base: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    countSubrequest();
    return base(input, init);
  }) as typeof fetch;
}

// Cloudflare Worker entry (replaces the Next.js app on Vercel). The API handlers in app/api/** are plain
// Request -> Response functions and are reused unchanged; the two pages are rendered by lib/pages.ts.
import { GET as cardOrders } from './app/api/card/orders/route';
import { GET as cronDaily } from './app/api/cron/daily/route';
import { POST as drain } from './app/api/drain/route';
import { POST as form } from './app/api/form/route';
import { POST as webhook } from './app/api/hubspot/webhook/route';
import { db, type SyncLogRow } from './lib/db';
import { log } from './lib/log';
import { activityPage, homePage, notFoundPage } from './lib/pages';
import { countingFetch, runInvocation } from './lib/runtime';

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Count every outgoing request (Supabase and HubSpot both use the global fetch) against the
// Workers subrequest limit of the invocation that makes it.
globalThis.fetch = countingFetch(globalThis.fetch.bind(globalThis));

type Handler = (request: Request) => Promise<Response>;
const API: Record<string, Partial<Record<string, Handler>>> = {
  '/api/form': { POST: form },
  '/api/card/orders': { GET: cardOrders },
  '/api/hubspot/webhook': { POST: webhook },
  '/api/drain': { POST: drain },
  '/api/cron/daily': { GET: cronDaily },
};

const html = (body: string, status: number, cacheControl: string) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': cacheControl } });

async function activity(): Promise<Response> {
  let data: { rows: SyncLogRow[]; dead: number } | null = null;
  try {
    const store = db();
    const [rows, dead] = await Promise.all([store.recentLog(50), store.rpc<number>('dead_job_count')]);
    data = { rows, dead };
  } catch (err) {
    log('activity_failed', { error: (err as Error).message });
  }
  return html(activityPage(data), 200, 'private, no-cache, no-store, max-age=0, must-revalidate');
}

async function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;

  const api = API[path];
  if (api) {
    const handler = api[request.method];
    return handler ? handler(request) : new Response(null, { status: 405 });
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/') return html(homePage(), 200, 'public, max-age=0, must-revalidate');
    if (path === '/activity') return activity();
  }
  return html(notFoundPage(), 404, 'public, max-age=0, must-revalidate');
}

export default {
  fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    return runInvocation(ctx, () => route(request));
  },

  // Cron Trigger "0 6 * * *" (wrangler.jsonc): the same daily job and the same bearer check as the HTTP route.
  scheduled(_controller: unknown, _env: unknown, ctx: ExecutionContext): Promise<void> {
    return runInvocation(ctx, async () => {
      const res = await cronDaily(new Request('https://cron.internal/api/cron/daily', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` },
      }));
      if (!res.ok) throw new Error(`daily job returned ${res.status}`);
    });
  },
};

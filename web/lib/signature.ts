// HubSpot request signature v3 (ARCHITECTURE §8). Proven against real HubSpot traffic in the spike.
import crypto from 'node:crypto';

const MAX_SKEW_MS = 5 * 60 * 1000;

// HubSpot decodes only these characters before signing.
const DECODE: Record<string, string> = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

function decodeUri(uri: string): string {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => DECODE[m.toUpperCase()]);
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

// `reason` is for logs only and never contains secret material.
export function verifyHubSpotV3(args: {
  method: string;
  url: string;
  rawBody: string;
  headers: Headers;
  secret: string;
  now?: number;
}): VerifyResult {
  const signature = args.headers.get('x-hubspot-signature-v3');
  const timestamp = args.headers.get('x-hubspot-request-timestamp');
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const skew = Math.abs((args.now ?? Date.now()) - Number(timestamp));
  if (!Number.isFinite(skew) || skew > MAX_SKEW_MS) return { ok: false, reason: 'timestamp outside 5 min window' };

  const u = new URL(args.url);
  u.hash = '';
  const base = `${args.method}${decodeUri(u.toString())}${args.rawBody}${timestamp}`;
  const expected = crypto.createHmac('sha256', args.secret).update(base, 'utf8').digest('base64');

  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Vercel sits behind a proxy; rebuild the public URL HubSpot actually called.
export function publicUrl(request: Request): string {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? u.host;
  return `https://${host}${u.pathname}${u.search}`;
}

// Bearer check for internal endpoints (/api/drain, /api/cron/daily).
export function hasBearer(request: Request, secret: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  return safeEqual(header, `Bearer ${secret}`);
}

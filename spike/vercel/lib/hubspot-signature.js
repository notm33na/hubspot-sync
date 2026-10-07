// HubSpot request signature v3 verification.
// Spec: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
import crypto from 'node:crypto';

const MAX_AGE_MS = 5 * 60 * 1000;

// HubSpot decodes only these characters before signing.
const DECODE = {
  '%3A': ':', '%2F': '/', '%3F': '?', '%40': '@', '%21': '!', '%24': '$',
  '%27': "'", '%28': '(', '%29': ')', '%2A': '*', '%2C': ',', '%3B': ';',
};

function decodeUri(uri) {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (m) => DECODE[m.toUpperCase()]);
}

// Returns { ok: true } or { ok: false, reason } — reason never contains secret material.
export function verifyV3({ method, url, rawBody, headers, secret }) {
  if (!secret) return { ok: false, reason: 'server missing CLIENT_SECRET' };

  const signature = headers.get('x-hubspot-signature-v3');
  const timestamp = headers.get('x-hubspot-request-timestamp');
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature headers' };

  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return { ok: false, reason: 'stale timestamp' };

  const u = new URL(url);
  u.hash = '';
  const base = `${method}${decodeUri(u.toString())}${rawBody}${timestamp}`;
  const expected = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('base64');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

// Vercel sits behind a proxy; rebuild the public URL HubSpot actually called.
export function publicUrl(request) {
  const u = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || u.host;
  return `https://${host}${u.pathname}${u.search}`;
}

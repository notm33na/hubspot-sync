import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hasBearer, publicUrl, verifyHubSpotV3 } from './signature';

const secret = 'dummy-secret-for-tests';
const now = 1_790_000_000_000;
const sign = (s: string) => crypto.createHmac('sha256', secret).update(s).digest('base64');
const headers = (sig: string, ts = String(now)) =>
  new Headers({ 'x-hubspot-signature-v3': sig, 'x-hubspot-request-timestamp': ts });

describe('verifyHubSpotV3', () => {
  // HubSpot signs the decoded URI (%40 -> @), as observed in the spike.
  const signedUri = 'https://x.vercel.app/api/card/orders?contactId=1&userEmail=a@b.com';
  const requestUrl = 'https://x.vercel.app/api/card/orders?contactId=1&userEmail=a%40b.com';
  const getSig = sign(`GET${signedUri}${now}`);

  it('accepts a valid GET with an encoded query', () => {
    expect(verifyHubSpotV3({ method: 'GET', url: requestUrl, rawBody: '', headers: headers(getSig), secret, now })).toEqual({ ok: true });
  });

  it('accepts a valid POST over the raw body', () => {
    const body = '[{"eventId":1,"objectId":5}]';
    const url = 'https://x.vercel.app/api/hubspot/webhook';
    const sig = sign(`POST${url}${body}${now}`);
    expect(verifyHubSpotV3({ method: 'POST', url, rawBody: body, headers: headers(sig), secret, now }).ok).toBe(true);
  });

  it('rejects a tampered query', () => {
    const r = verifyHubSpotV3({ method: 'GET', url: requestUrl.replace('=1', '=2'), rawBody: '', headers: headers(getSig), secret, now });
    expect(r).toEqual({ ok: false, reason: 'signature mismatch' });
  });

  it('rejects stale and future timestamps', () => {
    for (const ts of [now - 6 * 60_000, now + 6 * 60_000]) {
      const r = verifyHubSpotV3({ method: 'GET', url: requestUrl, rawBody: '', headers: headers(getSig, String(ts)), secret, now });
      expect(r.ok).toBe(false);
    }
  });

  it('rejects missing headers and wrong-length signatures', () => {
    expect(verifyHubSpotV3({ method: 'GET', url: requestUrl, rawBody: '', headers: new Headers(), secret, now }).ok).toBe(false);
    expect(verifyHubSpotV3({ method: 'GET', url: requestUrl, rawBody: '', headers: headers('abc'), secret, now }).ok).toBe(false);
  });
});

describe('publicUrl', () => {
  it('uses the forwarded host', () => {
    const req = new Request('http://internal:3000/api/x?a=1', { headers: { 'x-forwarded-host': 'demo.vercel.app' } });
    expect(publicUrl(req)).toBe('https://demo.vercel.app/api/x?a=1');
  });
});

describe('hasBearer', () => {
  it('matches only the exact bearer secret', () => {
    const req = (h?: string) => new Request('https://x/api/drain', { headers: h ? { authorization: h } : {} });
    expect(hasBearer(req('Bearer s3cret'), 's3cret')).toBe(true);
    expect(hasBearer(req('Bearer wrong!'), 's3cret')).toBe(false);
    expect(hasBearer(req(), 's3cret')).toBe(false);
  });
});

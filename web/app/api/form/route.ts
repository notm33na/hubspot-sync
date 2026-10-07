// Public demo form endpoint (R6). Abuse control: honeypot, @example.com only, per-IP and global caps.
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { submitForm, validateForm } from '@/lib/form';
import { log } from '@/lib/log';
import { syncDeps } from '@/lib/sync/deps';

export const maxDuration = 30;

const PER_IP_PER_HOUR = 5;
const SITE_PER_DAY = 200;

export async function POST(request: Request): Promise<Response> {
  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Send the form as JSON.' }, { status: 400 });
  }

  // Honeypot: a hidden field people never fill. Pretend success so bots learn nothing.
  if (typeof raw.website === 'string' && raw.website.trim() !== '') {
    log('form_honeypot');
    return Response.json({ status: 'done' });
  }

  const validation = validateForm(raw);
  if (!validation.ok) return Response.json({ errors: validation.errors }, { status: 400 });

  // Rate limits: the IP is hashed with a secret salt and never stored raw.
  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  const ipBucket = 'ip:' + crypto.createHash('sha256').update(ip + env('RATE_LIMIT_SALT')).digest('hex');
  const store = db();
  const ipOk = await store.rpc<boolean>('hit_rate_limit', { p_bucket: ipBucket, p_window_seconds: 3600, p_max: PER_IP_PER_HOUR });
  const siteOk = ipOk && (await store.rpc<boolean>('hit_rate_limit', { p_bucket: 'site', p_window_seconds: 86400, p_max: SITE_PER_DAY }));
  if (!ipOk || !siteOk) {
    log('form_rate_limited', { scope: ipOk ? 'site' : 'ip' });
    return Response.json({ error: 'Too many submissions. Try again later.' }, { status: 429 });
  }

  try {
    const result = await submitForm(validation.value, syncDeps());
    if (result.status === 'in_progress') {
      return Response.json({ error: 'This submission is already being processed. Try again in a moment.' }, { status: 409 });
    }
    log('form_done', { contactId: result.contactId, dealId: result.dealId, replayed: result.replayed });
    return Response.json({ status: 'done', reference: result.dealId, replayed: result.replayed });
  } catch (err) {
    log('form_failed', { error: (err as Error).message });
    return Response.json({ error: "We couldn't save that right now. Submitting again is safe." }, { status: 502 });
  }
}

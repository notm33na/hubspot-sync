// Minimal HubSpot CRM client (ARCHITECTURE §9).
// - 429: wait for Retry-After (if it fits the budget), else hand back to the queue.
// - 5xx / network: retry in place up to 3 tries, then hand back to the queue.
// - other 4xx: permanent (the job becomes `dead`), except where a caller handles the status (404, 409).

const BASE = 'https://api.hubapi.com';
const MAX_TRIES = 3;
const MAX_INLINE_WAIT_MS = 10_000;

export class HubSpotError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type RequestFn = <T = unknown>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

export function createHubSpotClient(opts: {
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): RequestFn {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  return async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    let lastError: HubSpotError | undefined;

    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${BASE}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${opts.token}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        lastError = new HubSpotError(0, `network error: ${(err as Error).message}`, false);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) {
        return (res.status === 204 ? undefined : await res.json()) as T;
      }

      const message = await errorMessage(res);
      if (res.status === 429) {
        const waitMs = Number(res.headers.get('retry-after') ?? '1') * 1000;
        lastError = new HubSpotError(429, `rate limited: ${message}`, false);
        if (waitMs > MAX_INLINE_WAIT_MS) break;
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500) {
        lastError = new HubSpotError(res.status, message, false);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new HubSpotError(res.status, message, true);
    }
    throw lastError ?? new HubSpotError(0, 'request failed', false);
  };
}

function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; category?: string };
    return `HTTP ${res.status} ${body.category ?? ''} ${body.message ?? ''}`.trim();
  } catch {
    return `HTTP ${res.status}`;
  }
}

// ------------------------------------------------------------------ contacts

export const OWNED_PROPERTIES = ['email', 'firstname', 'lastname', 'phone', 'lifecyclestage'] as const;

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

const CONTACT_PROPS = [...OWNED_PROPERTIES, 'hs_lastmodifieddate'].join(',');

/** Current state of a contact, or null if it no longer exists. */
export async function getContact(request: RequestFn, id: string): Promise<HubSpotContact | null> {
  try {
    return await request<HubSpotContact>('GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${CONTACT_PROPS}`);
  } catch (err) {
    if (err instanceof HubSpotError && err.status === 404) return null;
    throw err;
  }
}

/** Direct read by email (no search-index lag). */
export async function getContactByEmail(request: RequestFn, email: string): Promise<HubSpotContact | null> {
  try {
    return await request<HubSpotContact>(
      'GET',
      `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=${CONTACT_PROPS}`,
    );
  } catch (err) {
    if (err instanceof HubSpotError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Find a contact by email, creating it only if missing (never overwrites names: HubSpot owns them).
 * A 409 on create means a parallel request created it first: read it again and use that one.
 */
export async function findOrCreateContact(
  request: RequestFn,
  input: { email: string; firstname?: string | null; lastname?: string | null },
): Promise<{ contact: HubSpotContact; created: boolean }> {
  const existing = await getContactByEmail(request, input.email);
  if (existing) return { contact: existing, created: false };

  const properties: Record<string, string> = { email: input.email };
  if (input.firstname) properties.firstname = input.firstname;
  if (input.lastname) properties.lastname = input.lastname;

  try {
    const contact = await request<HubSpotContact>('POST', '/crm/v3/objects/contacts', { properties });
    return { contact, created: true };
  } catch (err) {
    if (err instanceof HubSpotError && err.status === 409) {
      const raced = await getContactByEmail(request, input.email);
      if (raced) return { contact: raced, created: false };
    }
    throw err;
  }
}

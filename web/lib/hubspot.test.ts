import { describe, expect, it, vi } from 'vitest';
import { createHubSpotClient, findOrCreateContact, HubSpotError } from './hubspot';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(responses: (Response | Error)[]) {
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  return { request: createHubSpotClient({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch, sleep }), fetchImpl, sleep };
}

describe('createHubSpotClient', () => {
  it('waits for Retry-After on 429, then succeeds', async () => {
    const { request, sleep } = client([json(429, { message: 'slow down' }, { 'retry-after': '2' }), json(200, { id: '1' })]);
    await expect(request('GET', '/x')).resolves.toEqual({ id: '1' });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('hands a long Retry-After back to the queue as transient', async () => {
    const { request, fetchImpl } = client([json(429, {}, { 'retry-after': '60' })]);
    await expect(request('GET', '/x')).rejects.toMatchObject({ status: 429, permanent: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 5xx and network errors up to 3 tries, then fails transient', async () => {
    const { request, fetchImpl } = client([json(502, {}), new Error('ECONNRESET'), json(503, {})]);
    await expect(request('GET', '/x')).rejects.toMatchObject({ status: 503, permanent: false });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('treats other 4xx as permanent without retrying', async () => {
    const { request, fetchImpl } = client([json(400, { category: 'VALIDATION_ERROR', message: 'bad property' })]);
    const err = (await request('PATCH', '/x', {}).catch((e: unknown) => e)) as HubSpotError;
    expect(err).toBeInstanceOf(HubSpotError);
    expect(err).toMatchObject({ status: 400, permanent: true });
    expect(err.message).toContain('bad property');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('findOrCreateContact', () => {
  it('returns an existing contact without writing', async () => {
    const { request, fetchImpl } = client([json(200, { id: '7', properties: {} })]);
    await expect(findOrCreateContact(request, { email: 'a@example.com', firstname: 'A' }))
      .resolves.toMatchObject({ contact: { id: '7' }, created: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('creates when missing', async () => {
    const { request, fetchImpl } = client([json(404, {}), json(201, { id: '8', properties: {} })]);
    await expect(findOrCreateContact(request, { email: 'b@example.com' }))
      .resolves.toMatchObject({ contact: { id: '8' }, created: true });
    expect(fetchImpl.mock.calls[1]).toMatchObject([expect.any(String), { method: 'POST' }]);
  });

  it('links to the winner when a parallel create causes 409', async () => {
    const { request } = client([json(404, {}), json(409, { message: 'Contact already exists' }), json(200, { id: '9', properties: {} })]);
    await expect(findOrCreateContact(request, { email: 'c@example.com' }))
      .resolves.toMatchObject({ contact: { id: '9' }, created: false });
  });
});

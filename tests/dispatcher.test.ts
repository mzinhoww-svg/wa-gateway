import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { sign, WebhookDispatcher, envUrlFor } from '../src/webhooks/dispatcher.js';
import type { WebhookEvent } from '../src/optin/service.js';

const ev: WebhookEvent = { type: 'optin.confirmed', instanceId: 'revela', project: 'revela', subjectId: 'g1', phone: '5565999990000', at: '2026-11-16T00:00:00.000Z' };

describe('sign', () => {
  it('é sha256= + HMAC hex do corpo', () => {
    const expected = 'sha256=' + createHmac('sha256', 'segredo').update('{"a":1}').digest('hex');
    expect(sign('{"a":1}', 'segredo')).toBe(expected);
  });
});

describe('WebhookDispatcher', () => {
  const mk = (fetchImpl: any, url: string | null = 'https://x/hook') =>
    new WebhookDispatcher({ secret: 's', fetch: fetchImpl, urlFor: () => url, sleep: async () => {} });

  it('faz POST JSON com assinatura', async () => {
    const f = vi.fn(async () => new Response('ok', { status: 200 }));
    await mk(f).dispatch(ev);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://x/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['x-wa-signature']).toBe(sign(init.body, 's'));
    expect(JSON.parse(init.body)).toMatchObject({ type: 'optin.confirmed', subjectId: 'g1' });
  });

  it('tenta 3 vezes em 500 e depois só registra, sem lançar', async () => {
    const f = vi.fn(async () => new Response('x', { status: 500 }));
    await expect(mk(f).dispatch(ev)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('sem URL não faz requisição', async () => {
    const f = vi.fn();
    await mk(f, null).dispatch(ev);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('envUrlFor', () => {
  it('prefere projeto, depois instância, depois padrão', () => {
    const u = envUrlFor({ WEBHOOK_URL_REVELA: 'a', WEBHOOK_URL: 'd', WEBHOOK_URL_OUTRA: 'o' });
    expect(u(ev)).toBe('a');
    expect(u({ ...ev, project: undefined, instanceId: 'outra' })).toBe('o');
    expect(u({ ...ev, project: undefined, instanceId: 'zzz' })).toBe('d');
    expect(envUrlFor({})(ev)).toBeNull();
  });
});

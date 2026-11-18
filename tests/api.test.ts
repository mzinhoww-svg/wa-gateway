import { describe, it, expect, vi } from 'vitest';
import { memDb } from './helpers/memdb.js';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/api/server.js';

async function setup(over: { phone?: string | null } = {}) {
  const db = memDb();
  await migrate(db);
  const manager = {
    create: vi.fn(async () => {}),
    list: vi.fn(async () => [{ id: 'revela', label: null, status: 'open' as const }]),
    status: vi.fn(() => ({ status: 'open' as const, qr: null })),
    phone: vi.fn(() => (over.phone === undefined ? '5565999990000' : over.phone)),
    remove: vi.fn(async () => {}),
  };
  const queue = {
    enqueue: vi.fn(async () => ({ id: 'job-1' })),
    stats: vi.fn(async () => ({ queued: 0, sentLastHour: 0 })),
  };
  const config = { port: 0, databaseUrl: '', apiKey: 'k', webhookSecret: 's', sendMinDelayMs: 1, sendMaxDelayMs: 2, sendMaxPerHour: 5 };
  const app = buildServer({ config, manager: manager as any, queue: queue as any, db });
  return { app, manager, queue };
}
const H = { 'x-api-key': 'k' };

describe('API', () => {
  it('/health é pública', async () => {
    const { app } = await setup();
    expect((await app.inject('/health')).statusCode).toBe(200);
  });

  it('/v1/* sem chave ou com chave errada dá 401', async () => {
    const { app } = await setup();
    expect((await app.inject('/v1/instances')).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/instances', headers: { 'x-api-key': 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/v1/instances', headers: H })).statusCode).toBe(200);
  });

  it('POST /v1/optin/codes devolve waLink com o código no texto', async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST', url: '/v1/optin/codes', headers: H,
      payload: { instanceId: 'revela', project: 'revela', subjectId: 'g1', prefix: 'REV', replyText: 'Pronto!' },
    });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.waLink.startsWith('https://wa.me/5565999990000?text=')).toBe(true);
    expect(decodeURIComponent(b.waLink)).toContain(b.code);
    expect(b.code).toMatch(/^REV-[A-Z0-9]{4}$/);
  });

  it('optin/codes com instância sem número devolve 409', async () => {
    const { app } = await setup({ phone: null });
    const res = await app.inject({
      method: 'POST', url: '/v1/optin/codes', headers: H,
      payload: { instanceId: 'revela', project: 'revela', subjectId: 'g1', prefix: 'REV', replyText: 'x' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INSTANCE_NOT_OPEN');
  });

  it('POST /v1/messages: 202 com opt-in, 409 NO_OPT_IN sem, 400 com corpo inválido', async () => {
    const { app, queue } = await setup();
    const ok = await app.inject({ method: 'POST', url: '/v1/messages', headers: H, payload: { instanceId: 'revela', phone: '5565999990000', text: 'oi' } });
    expect(ok.statusCode).toBe(202);
    expect(ok.json()).toEqual({ id: 'job-1' });
    queue.enqueue.mockRejectedValueOnce(new Error('NO_OPT_IN'));
    const no = await app.inject({ method: 'POST', url: '/v1/messages', headers: H, payload: { instanceId: 'revela', phone: '5565999990000', text: 'oi' } });
    expect(no.statusCode).toBe(409);
    expect(no.json().error).toBe('NO_OPT_IN');
    const bad = await app.inject({ method: 'POST', url: '/v1/messages', headers: H, payload: { instanceId: 'revela', phone: 'abc', text: '' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('API: autenticação resiste a URL codificada', () => {
  it('rotas /v1 com %xx não passam sem chave', async () => {
    const { app } = await setup();
    const a = await app.inject({ url: '/%761/instances/revela' });
    expect(a.statusCode).not.toBe(200);
    const b = await app.inject({ method: 'POST', url: '/v%31/messages', payload: { instanceId: 'revela', phone: '5565999990000', text: 'oi' } });
    expect(b.statusCode).not.toBe(202);
    const c = await app.inject({ method: 'DELETE', url: '/%761/instances/revela' });
    expect(c.statusCode).not.toBe(200);
  });

  it('JSON malformado devolve 400, não 500', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'POST', url: '/v1/messages', headers: { ...H, 'content-type': 'application/json' }, payload: '{ruim' });
    expect(r.statusCode).toBe(400);
  });
});

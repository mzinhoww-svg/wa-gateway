import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { InstanceManager } from '../src/instances/manager.js';
import type { SocketFactory, SocketOptions } from '../src/instances/types.js';
import { Pareamentos } from '../src/pools/routes.js';
import { PoolService } from '../src/pools/service.js';
import { memDb } from './helpers/memdb.js';

const EXTRA = 'x'.repeat(32);

async function montar() {
  const db = memDb();
  await migrate(db);
  const sessoes = new Map<string, SocketOptions>();
  const factory: SocketFactory = async (o) => {
    sessoes.set(o.instanceId, o);
    return { sendText: async () => {}, end: () => {}, selfPhone: () => '5565911110001' };
  };
  const manager = new InstanceManager(db, factory, () => {}, { reconnectBaseMs: 60_000 });
  const service = new PoolService({ db, manager, emit: () => {} });
  const config = loadConfig({ DATABASE_URL: 'x', API_KEY: 'principal', WEBHOOK_SECRET: 's', EXTRA_API_KEYS: `curta,${EXTRA}` });
  const queue = { enqueue: async () => ({ id: '1' }), stats: async () => ({ queued: 0, sentLastHour: 0 }) };
  const app = buildServer({ config, db, manager, queue, pools: { service, pareamentos: new Pareamentos() } });
  return { app, sessoes };
}

describe('API dos pools', () => {
  it('aceita a chave extra do projeto, recusa chave curta ou ausente', async () => {
    const { app } = await montar();
    const h = (k: string) => ({ 'x-api-key': k, 'content-type': 'application/json' });
    expect((await app.inject({ method: 'GET', url: '/v1/instances', headers: h(EXTRA) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/instances', headers: h('principal') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/instances', headers: h('curta') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/pools/achadinhos/numeros' })).statusCode).toBe(401);
  });

  it('cadastra pool e número, e a página de pareamento mostra o QR pelo token', async () => {
    const { app, sessoes } = await montar();
    const h = { 'x-api-key': EXTRA };
    expect((await app.inject({ method: 'PUT', url: '/v1/pools/achadinhos', headers: h, payload: { project: 'achadinhos', adminPhones: ['5565999990001'] } })).statusCode).toBe(200);
    const r = await app.inject({ method: 'POST', url: '/v1/pools/achadinhos/numeros', headers: h, payload: { instanceId: 'ach-1', ordem: 0 } });
    expect(r.statusCode).toBe(201);
    const token = r.json().pareamento.token as string;
    sessoes.get('ach-1')?.onQr('2@QRCODE-DE-TESTE');
    const pagina = await app.inject({ method: 'GET', url: `/parear/${token}` });
    expect(pagina.statusCode).toBe(200);
    expect(pagina.body).toContain('<svg');
    expect(pagina.headers['cache-control']).toBe('no-store');
    expect((await app.inject({ method: 'GET', url: `/parear/${'0'.repeat(48)}` })).statusCode).toBe(404);
    const numeros = (await app.inject({ method: 'GET', url: '/v1/pools/achadinhos/numeros', headers: h })).json().numeros;
    expect(numeros[0]).toMatchObject({ instanceId: 'ach-1', papel: 'reserva', aguardandoQr: true });
  });

  it('pool inexistente responde 404 e jid inválido 400', async () => {
    const { app } = await montar();
    const h = { 'x-api-key': EXTRA };
    expect((await app.inject({ method: 'GET', url: '/v1/pools/nao-existe/numeros', headers: h })).json()).toEqual({ error: 'POOL_NOT_FOUND' });
    const r = await app.inject({ method: 'POST', url: '/v1/pools/achadinhos/grupos/abc/mensagem', headers: h, payload: { texto: 'x' } });
    expect(r.statusCode).toBe(400);
  });
});

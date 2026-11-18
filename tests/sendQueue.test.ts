import { describe, it, expect, vi } from 'vitest';
import { memDb } from './helpers/memdb.js';
import { migrate } from '../src/db/migrate.js';
import { SendQueue } from '../src/queue/sendQueue.js';

async function setup(over: { maxPerHour?: number; active?: boolean } = {}) {
  const db = memDb();
  await migrate(db);
  let t = 1_700_000_000_000;
  const state = { active: over.active ?? true };
  const send = vi.fn(async (_i: string, _p: string, _t: string) => {});
  const q = new SendQueue({
    db,
    isActive: async () => state.active,
    send,
    minDelayMs: 4000,
    maxDelayMs: 9000,
    maxPerHour: over.maxPerHour ?? 60,
    now: () => t,
    random: () => 0.5,
  });
  return { db, q, send, state, advance: (ms: number) => void (t += ms) };
}

describe('SendQueue', () => {
  it('enqueue sem opt-in lança NO_OPT_IN', async () => {
    const { q } = await setup({ active: false });
    await expect(q.enqueue('revela', '5565999990000', 'oi')).rejects.toThrow('NO_OPT_IN');
  });

  it('enfileira como queued e conta em stats', async () => {
    const { q } = await setup();
    const { id } = await q.enqueue('revela', '5565999990000', 'oi');
    expect(id).toBeTruthy();
    expect(await q.stats('revela')).toEqual({ queued: 1, sentLastHour: 0 });
  });

  it('espera entre minDelay e maxDelay entre dois envios', async () => {
    const { q, send, advance } = await setup();
    await q.enqueue('revela', '5565999990000', 'um');
    await q.enqueue('revela', '5565911112222', 'dois');
    expect((await q.processNext('revela')).status).toBe('sent');
    const r = await q.processNext('revela');
    expect(r.status).toBe('throttled');
    expect(r.waitMs).toBeGreaterThanOrEqual(4000);
    expect(r.waitMs).toBeLessThanOrEqual(9000);
    advance(9000);
    expect((await q.processNext('revela')).status).toBe('sent');
    expect(send.mock.calls.map((c) => c[2])).toEqual(['um', 'dois']);
  });

  it('respeita o teto por hora', async () => {
    const { q, advance } = await setup({ maxPerHour: 2 });
    for (const t of ['a', 'b', 'c']) await q.enqueue('revela', '5565999990000', t);
    expect((await q.processNext('revela')).status).toBe('sent');
    advance(9000);
    expect((await q.processNext('revela')).status).toBe('sent');
    advance(9000);
    expect((await q.processNext('revela')).status).toBe('throttled');
    advance(3_600_000);
    expect((await q.processNext('revela')).status).toBe('sent');
  });

  it('opt-out entre o enqueue e o envio cancela o job', async () => {
    const { q, send, state } = await setup();
    await q.enqueue('revela', '5565999990000', 'oi');
    state.active = false;
    expect((await q.processNext('revela')).status).toBe('cancelled');
    expect(send).not.toHaveBeenCalled();
  });

  it('desiste após 3 falhas de envio', async () => {
    const { q, send, advance } = await setup();
    send.mockRejectedValue(new Error('boom'));
    await q.enqueue('revela', '5565999990000', 'oi');
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      out.push((await q.processNext('revela')).status);
      advance(9000);
    }
    expect(out).toEqual(['retry', 'retry', 'failed']);
  });

  it('INSTANCE_NOT_OPEN espera sem consumir tentativas', async () => {
    const { q, send, advance } = await setup();
    send.mockRejectedValue(new Error('INSTANCE_NOT_OPEN'));
    await q.enqueue('revela', '5565999990000', 'oi');
    for (let i = 0; i < 5; i++) {
      expect((await q.processNext('revela')).status).toBe('retry');
      advance(9000);
    }
    send.mockResolvedValue(undefined);
    expect((await q.processNext('revela')).status).toBe('sent');
  });

  it('respostas furam a fila, não exigem opt-in e respeitam o intervalo', async () => {
    const { q, send, advance } = await setup({ active: false });
    await q.enqueueReply('revela', '5565911112222', 'resposta 1');
    await q.enqueueReply('revela', '5565933334444', 'resposta 2');
    expect((await q.processNext('revela')).status).toBe('sent');
    expect((await q.processNext('revela')).status).toBe('throttled');
    advance(9000);
    expect((await q.processNext('revela')).status).toBe('sent');
    expect(send.mock.calls.map((c) => c[2])).toEqual(['resposta 1', 'resposta 2']);
  });

  it('respostas passam na frente das notificações e contam no teto da hora', async () => {
    const { q, send, advance } = await setup({ maxPerHour: 1 });
    await q.enqueue('revela', '5565999990000', 'notificação');
    await q.enqueueReply('revela', '5565911112222', 'resposta');
    expect((await q.processNext('revela')).status).toBe('sent');
    advance(9000);
    expect((await q.processNext('revela')).status).toBe('throttled');
    expect(send.mock.calls.map((c) => c[2])).toEqual(['resposta']);
    expect((await q.stats('revela')).sentLastHour).toBe(1);
  });

  it('dois processos não enviam o mesmo job duas vezes', async () => {
    const { db, q, send } = await setup();
    const q2 = new SendQueue({ db, isActive: async () => true, send, minDelayMs: 4000, maxDelayMs: 9000, maxPerHour: 60, now: () => 1_700_000_000_000, random: () => 0.5 });
    await q.enqueue('revela', '5565999990000', 'uma vez só');
    await Promise.all([q.processNext('revela'), q2.processNext('revela')]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

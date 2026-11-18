import { describe, it, expect, vi } from 'vitest';
import { memDb } from './helpers/memdb.js';
import { migrate } from '../src/db/migrate.js';
import { createCode, extractCode, extractCodes } from '../src/optin/codes.js';
import { OptInService, type WebhookEvent } from '../src/optin/service.js';
import type { InboundMessage } from '../src/instances/types.js';

async function setup() {
  const db = memDb();
  await migrate(db);
  const send = vi.fn(async () => {});
  const events: WebhookEvent[] = [];
  const svc = new OptInService(db, send, (e) => events.push(e));
  return { db, send, events, svc };
}

let n = 0;
const msg = (text: string, o: Partial<InboundMessage> = {}): InboundMessage => ({
  instanceId: 'revela', messageId: `m${++n}`, jid: '5565999990000@s.whatsapp.net',
  phone: '5565999990000', text, fromMe: false, isGroup: false, ...o,
});
const mk = (db: any) => createCode(db, { instanceId: 'revela', project: 'revela', subjectId: 'guest-1', prefix: 'REV', replyText: 'Pronto! Volte: https://app/x' });

describe('extractCode', () => {
  it('acha o código em minúsculas, no meio de uma frase', () => {
    expect(extractCode('oi, meu código é rev-7k4q ')).toBe('REV-7K4Q');
    expect(extractCode('oi')).toBeNull();
  });
});

describe('OptInService', () => {
  it('código válido confirma, responde e emite optin.confirmed', async () => {
    const { db, svc, send, events } = await setup();
    const { code } = await mk(db);
    await svc.handleInbound(msg(`Quero receber avisos. Código: ${code}`));
    expect(send).toHaveBeenCalledWith('revela', '5565999990000', 'Pronto! Volte: https://app/x');
    expect(events.find((e) => e.type === 'optin.confirmed')).toMatchObject({ subjectId: 'guest-1', phone: '5565999990000', code });
    expect(await svc.isActive('revela', '5565999990000')).toBe(true);
  });

  it('o mesmo código não vale duas vezes', async () => {
    const { db, svc, send } = await setup();
    const { code } = await mk(db);
    await svc.handleInbound(msg(code));
    await svc.handleInbound(msg(code, { phone: '5565911112222' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await svc.isActive('revela', '5565911112222')).toBe(false);
  });

  it('código expirado não confirma', async () => {
    const { db, svc, send } = await setup();
    const { code } = await mk(db);
    await db.query("update optin_codes set expires_at = now() - interval '1 minute'");
    await svc.handleInbound(msg(code));
    expect(send).not.toHaveBeenCalled();
    expect(await svc.isActive('revela', '5565999990000')).toBe(false);
  });

  it('ignora grupo e fromMe; phone null não grava', async () => {
    const { db, svc, send, events } = await setup();
    const { code } = await mk(db);
    await svc.handleInbound(msg(code, { isGroup: true }));
    await svc.handleInbound(msg(code, { fromMe: true }));
    await svc.handleInbound(msg(code, { phone: null }));
    expect(send).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('a mesma messageId duas vezes processa uma vez', async () => {
    const { db, svc, send } = await setup();
    const { code } = await mk(db);
    const m = msg(code);
    await svc.handleInbound(m);
    await svc.handleInbound(m);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('SAIR revoga, confirma uma vez e emite optin.revoked', async () => {
    const { db, svc, send, events } = await setup();
    const { code } = await mk(db);
    await svc.handleInbound(msg(code));
    send.mockClear();
    await svc.handleInbound(msg('  sair '));
    expect(send).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'optin.revoked')).toBe(true);
    expect(await svc.isActive('revela', '5565999990000')).toBe(false);
  });

  it('SAIR de quem não tem opt-in não envia nada', async () => {
    const { svc, send } = await setup();
    await svc.handleInbound(msg('SAIR'));
    expect(send).not.toHaveBeenCalled();
  });

  it('mensagem comum emite message.received', async () => {
    const { svc, events } = await setup();
    await svc.handleInbound(msg('oi'));
    expect(events[0]).toMatchObject({ type: 'message.received', text: 'oi', phone: '5565999990000' });
  });
});

describe('extractCodes (robustez)', () => {
  it('aceita espaço, travessão e minúsculas', () => {
    expect(extractCodes('rev 7k4q')).toContain('REV-7K4Q');
    expect(extractCodes('REV – 7K4Q')).toContain('REV-7K4Q');
    expect(extractCodes('REV–7K4Q')).toContain('REV-7K4Q');
  });
  it('devolve todos os candidatos, na ordem', () => {
    expect(extractCodes('Evento PRE-2026 código REV-7K4Q')).toEqual(['PRE-2026', 'REV-7K4Q']);
  });
});

describe('OptInService (robustez)', () => {
  it('confirma o código mesmo com outro "código" antes na frase', async () => {
    const { db, svc, send } = await setup();
    const { code } = await mk(db);
    await svc.handleInbound(msg(`Evento PRE-2026 código ${code.toLowerCase()}`));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['Sair.', 'sair por favor', 'SAIR 🙏', 'quero sair', 'Parar!'])('"%s" revoga o opt-in', async (txt) => {
    const { db, svc } = await setup();
    const { code } = await mk(db);
    await svc.handleInbound(msg(code));
    await svc.handleInbound(msg(txt));
    expect(await svc.isActive('revela', '5565999990000')).toBe(false);
  });

  it('o webhook sai mesmo se a resposta falhar', async () => {
    const { db, svc, send, events } = await setup();
    send.mockRejectedValue(new Error('socket caiu'));
    const { code } = await mk(db);
    await expect(svc.handleInbound(msg(code))).resolves.toBeUndefined();
    expect(events.some((e) => e.type === 'optin.confirmed')).toBe(true);
  });
});

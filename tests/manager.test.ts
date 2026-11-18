import { describe, it, expect, vi } from 'vitest';
import { memDb } from './helpers/memdb.js';
import { migrate } from '../src/db/migrate.js';
import { InstanceManager } from '../src/instances/manager.js';
import type { SocketFactory, SocketOptions, WaSocket } from '../src/instances/types.js';

function fake() {
  const opened: SocketOptions[] = [];
  const sent: { jid: string; text: string }[] = [];
  const ended = vi.fn();
  const factory: SocketFactory = async (o) => {
    opened.push(o);
    const s: WaSocket = {
      sendText: async (jid, text) => void sent.push({ jid, text }),
      end: ended,
      selfPhone: () => '5565999990000',
    };
    return s;
  };
  return { opened, sent, ended, factory };
}

async function setup() {
  const db = memDb();
  await migrate(db);
  const f = fake();
  const inbound = vi.fn();
  const m = new InstanceManager(db, f.factory, inbound, { reconnectBaseMs: 1 });
  return { db, f, inbound, m };
}

describe('InstanceManager', () => {
  it('create grava a instância e abre o socket', async () => {
    const { m, f, db } = await setup();
    await m.create('revela', 'Revela');
    expect(f.opened).toHaveLength(1);
    const r = await db.query('select id from instances');
    expect(r.rows).toHaveLength(1);
    expect(m.status('revela').status).toBe('connecting');
  });

  it('onQr muda para qr e onOpen zera o QR', async () => {
    const { m, f } = await setup();
    await m.create('revela');
    f.opened[0].onQr('QR-TEXT');
    expect(m.status('revela')).toEqual({ status: 'qr', qr: 'QR-TEXT' });
    f.opened[0].onOpen();
    expect(m.status('revela')).toEqual({ status: 'open', qr: null });
  });

  it('desconexão normal reconecta; deslogado limpa a sessão e fica closed', async () => {
    const { m, f, db } = await setup();
    await m.create('revela');
    f.opened[0].onOpen();
    f.opened[0].onClose({ loggedOut: false });
    await vi.waitFor(() => expect(f.opened.length).toBe(2));
    await db.query("insert into auth_state (instance_id, key, value) values ('revela','creds','{}')");
    f.opened[1].onClose({ loggedOut: true });
    await vi.waitFor(async () => {
      const r = await db.query('select 1 from auth_state where instance_id = $1', ['revela']);
      expect(r.rows).toHaveLength(0);
    });
    expect(m.status('revela').status).toBe('closed');
  });

  it('send fora de open lança INSTANCE_NOT_OPEN; aberto envia para o JID do telefone', async () => {
    const { m, f } = await setup();
    await m.create('revela');
    await expect(m.send('revela', '5565911112222', 'oi')).rejects.toThrow('INSTANCE_NOT_OPEN');
    f.opened[0].onOpen();
    await m.send('revela', '5565911112222', 'oi');
    expect(f.sent).toEqual([{ jid: '5565911112222@s.whatsapp.net', text: 'oi' }]);
  });

  it('mensagens recebidas chegam ao callback', async () => {
    const { m, f, inbound } = await setup();
    await m.create('revela');
    const msg = { instanceId: 'revela', messageId: 'm1', jid: 'x', phone: '1', text: 't', fromMe: false, isGroup: false };
    f.opened[0].onMessage(msg);
    expect(inbound).toHaveBeenCalledWith(msg);
  });

  it('dois onClose do mesmo socket não duplicam sockets; o antigo é encerrado', async () => {
    const { m, f } = await setup();
    await m.create('revela');
    f.opened[0].onOpen();
    f.opened[0].onClose({ loggedOut: false });
    f.opened[0].onClose({ loggedOut: false });
    await vi.waitFor(() => expect(f.opened.length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(f.opened.length).toBe(2);
  });

  it('remove durante o start encerra o socket criado depois', async () => {
    const db = memDb();
    await migrate(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ended = vi.fn();
    const factory: SocketFactory = async () => {
      await gate;
      return { sendText: async () => {}, end: ended, selfPhone: () => null };
    };
    const m = new InstanceManager(db, factory, vi.fn(), { reconnectBaseMs: 1 });
    const creating = m.create('revela');
    await new Promise((r) => setTimeout(r, 5));
    await m.remove('revela');
    release();
    await creating;
    expect(ended).toHaveBeenCalled();
  });

  it('fatal (conexão substituída/proibida) não reconecta e mantém a sessão', async () => {
    const { m, f, db } = await setup();
    await m.create('revela');
    await db.query("insert into auth_state (instance_id, key, value) values ('revela','creds','{}')");
    f.opened[0].onClose({ loggedOut: false, fatal: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(f.opened.length).toBe(1);
    expect(m.status('revela').status).toBe('closed');
    const r = await db.query('select 1 from auth_state where instance_id = $1', ['revela']);
    expect(r.rows).toHaveLength(1);
  });

  it('falha ao abrir o socket não derruba o processo e tenta de novo', async () => {
    const db = memDb();
    await migrate(db);
    let calls = 0;
    const factory: SocketFactory = async () => {
      calls++;
      if (calls === 1) throw new Error('db oscilou');
      return { sendText: async () => {}, end: () => {}, selfPhone: () => null };
    };
    const m = new InstanceManager(db, factory, vi.fn(), { reconnectBaseMs: 1 });
    await m.create('revela').catch(() => {});
    await vi.waitFor(() => expect(calls).toBe(2));
  });
});

import type { Db } from '../db/client.js';
import { usePgAuthState, type PgAuth } from '../auth/pgAuthState.js';
import type { InboundMessage, InstanceStatus, SocketFactory, WaSocket } from './types.js';

interface Entry {
  status: InstanceStatus;
  qr: string | null;
  socket: WaSocket | null;
  auth: PgAuth | null;
  attempts: number;
  gen: number;
  removed: boolean;
  timer: NodeJS.Timeout | null;
}

export interface ManagerOptions {
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class InstanceManager {
  private entries = new Map<string, Entry>();
  private base: number;
  private max: number;

  constructor(
    private db: Db,
    private factory: SocketFactory,
    private onInbound: (m: InboundMessage) => void,
    opts: ManagerOptions = {},
  ) {
    this.base = opts.reconnectBaseMs ?? 1000;
    this.max = opts.reconnectMaxMs ?? 30000;
  }

  async create(id: string, label?: string): Promise<void> {
    await this.db.query(
      `insert into instances (id, label) values ($1, $2) on conflict (id) do nothing`,
      [id, label ?? null],
    );
    if (!this.entries.has(id)) await this.start(id);
  }

  async startAll(): Promise<void> {
    const r = await this.db.query<{ id: string }>('select id from instances');
    for (const row of r.rows) if (!this.entries.has(row.id)) await this.start(row.id);
  }

  status(id: string): { status: InstanceStatus; qr: string | null } {
    const e = this.entries.get(id);
    return e ? { status: e.status, qr: e.qr } : { status: 'closed', qr: null };
  }

  phone(id: string): string | null {
    return this.entries.get(id)?.socket?.selfPhone() ?? null;
  }

  async send(id: string, phone: string, text: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.status !== 'open' || !e.socket) throw new Error('INSTANCE_NOT_OPEN');
    await e.socket.sendText(`${phone}@s.whatsapp.net`, text);
  }

  async remove(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.removed = true;
      e.gen++;
      if (e.timer) clearTimeout(e.timer);
      e.socket?.end();
      await e.auth?.clear();
      this.entries.delete(id);
    }
    await this.db.query('delete from auth_state where instance_id = $1', [id]);
    await this.db.query('delete from instances where id = $1', [id]);
  }

  async list(): Promise<{ id: string; label: string | null; status: InstanceStatus }[]> {
    const r = await this.db.query<{ id: string; label: string | null }>('select id, label from instances order by id');
    return r.rows.map((x) => ({ id: x.id, label: x.label, status: this.status(x.id).status }));
  }

  private async start(id: string): Promise<void> {
    let e = this.entries.get(id);
    if (!e) {
      e = { status: 'connecting', qr: null, socket: null, auth: null, attempts: 0, gen: 0, removed: false, timer: null };
      this.entries.set(id, e);
    }
    const entry = e;
    const gen = ++entry.gen;
    const live = () => !entry.removed && entry.gen === gen;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.socket?.end();
    entry.socket = null;
    entry.status = 'connecting';
    try {
      const auth = await usePgAuthState(this.db, id);
      if (!live()) return;
      entry.auth = auth;
      const socket = await this.factory({
        instanceId: id,
        auth: auth.state,
        saveCreds: auth.saveCreds,
        onQr: (qr) => {
          if (!live()) return;
          entry.status = 'qr';
          entry.qr = qr;
        },
        onOpen: () => {
          if (!live()) return;
          entry.status = 'open';
          entry.qr = null;
          entry.attempts = 0;
        },
        onClose: ({ loggedOut, fatal }) => {
          if (!live()) return;
          entry.gen++; // invalida callbacks deste socket
          entry.qr = null;
          if (loggedOut) {
            entry.status = 'closed';
            auth.clear().catch((err) => console.error('[instances] falha ao limpar sessão', err));
            return;
          }
          if (fatal) {
            entry.status = 'closed';
            return;
          }
          this.scheduleReconnect(id, entry);
        },
        onMessage: (m) => {
          if (live()) this.onInbound(m);
        },
      });
      if (!live()) {
        socket.end();
        return;
      }
      entry.socket = socket;
    } catch (err) {
      console.error(`[instances] falha ao iniciar ${id}`, err);
      if (live()) this.scheduleReconnect(id, entry);
    }
  }

  private scheduleReconnect(id: string, entry: Entry): void {
    entry.status = 'connecting';
    if (entry.timer) clearTimeout(entry.timer);
    const delay = Math.min(this.base * 2 ** entry.attempts, this.max);
    entry.attempts += 1;
    entry.timer = setTimeout(() => {
      this.start(id).catch((err) => console.error('[instances] erro ao reconectar', err));
    }, delay);
  }
}

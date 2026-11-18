import type { Db } from '../db/client.js';
import type { InboundMessage } from '../instances/types.js';
import { extractCodes } from './codes.js';

export interface WebhookEvent {
  type: 'message.received' | 'optin.confirmed' | 'optin.revoked';
  instanceId: string;
  project?: string;
  subjectId?: string;
  phone?: string;
  code?: string;
  text?: string;
  at: string;
}

type SendFn = (instanceId: string, phone: string, text: string) => Promise<void>;
const OPT_OUT = new Set(['SAIR', 'PARAR']);

function isOptOut(text: string): boolean {
  const words = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  return words.length > 0 && words.length <= 4 && words.some((w) => OPT_OUT.has(w));
}
const REVOKED_REPLY = 'Tudo certo, você não vai mais receber avisos por aqui. Para voltar, é só pedir um novo código no app.';

export class OptInService {
  constructor(
    private db: Db,
    private send: SendFn,
    private emit: (e: WebhookEvent) => void,
  ) {}

  async isActive(instanceId: string, phone: string): Promise<boolean> {
    const r = await this.db.query(
      'select 1 from optins where instance_id = $1 and phone = $2 and revoked_at is null',
      [instanceId, phone],
    );
    return r.rows.length > 0;
  }

  async handleInbound(m: InboundMessage): Promise<void> {
    if (m.isGroup || m.fromMe) return;
    const seen = await this.db.query(
      'insert into inbound_seen (instance_id, message_id) values ($1, $2) on conflict do nothing returning message_id',
      [m.instanceId, m.messageId],
    );
    if (!seen.rows.length) return;
    if (!m.phone) {
      console.warn(`[optin] remetente sem número resolvível (${m.jid}); ignorado`);
      return;
    }
    const at = () => new Date().toISOString();

    if (isOptOut(m.text)) {
      const r = await this.db.query<{ project: string; subject_id: string }>(
        `update optins set revoked_at = now()
         where instance_id = $1 and phone = $2 and revoked_at is null returning project, subject_id`,
        [m.instanceId, m.phone],
      );
      if (r.rows.length) {
        this.emit({ type: 'optin.revoked', instanceId: m.instanceId, project: r.rows[0].project, subjectId: r.rows[0].subject_id, phone: m.phone, at: at() });
        await this.reply(m.instanceId, m.phone, REVOKED_REPLY);
      }
      return;
    }

    for (const code of extractCodes(m.text)) {
      const r = await this.db.query<{ project: string; subject_id: string; reply_text: string }>(
        `update optin_codes set used_at = now()
         where code = $1 and instance_id = $2 and used_at is null and expires_at > now()
         returning project, subject_id, reply_text`,
        [code, m.instanceId],
      );
      if (!r.rows.length) continue;
      const c = r.rows[0];
      await this.db.query(
        `insert into optins (instance_id, phone, project, subject_id) values ($1, $2, $3, $4)
         on conflict (instance_id, phone) do update
           set project = excluded.project, subject_id = excluded.subject_id, consented_at = now(), revoked_at = null`,
        [m.instanceId, m.phone, c.project, c.subject_id],
      );
      this.emit({ type: 'optin.confirmed', instanceId: m.instanceId, project: c.project, subjectId: c.subject_id, phone: m.phone, code, at: at() });
      await this.reply(m.instanceId, m.phone, c.reply_text);
      return;
    }

    this.emit({ type: 'message.received', instanceId: m.instanceId, phone: m.phone, text: m.text, at: at() });
  }

  private async reply(instanceId: string, phone: string, text: string): Promise<void> {
    try {
      await this.send(instanceId, phone, text);
    } catch (err) {
      console.error('[optin] falha ao enfileirar resposta', err);
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';

export type ProcessResult = {
  status: 'idle' | 'throttled' | 'sent' | 'cancelled' | 'retry' | 'failed';
  waitMs: number;
};

export interface SendQueueDeps {
  db: Db;
  isActive(instanceId: string, phone: string): Promise<boolean>;
  send(instanceId: string, phone: string, text: string): Promise<void>;
  minDelayMs: number;
  maxDelayMs: number;
  maxPerHour: number;
  now?: () => number;
  random?: () => number;
}

const MAX_ATTEMPTS = 3;
const HOUR_MS = 3_600_000;
/** Quem acabou de escrever para o chip espera a resposta; ~1 s basta para parecer natural. */
const REPLY_GAP_MS = 1000;

export class SendQueue {
  private nextAllowedAt = new Map<string, number>();
  private nextReplyAt = new Map<string, number>();
  private lastCreated = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private now: () => number;
  private random: () => number;

  constructor(private d: SendQueueDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  async enqueue(instanceId: string, phone: string, text: string): Promise<{ id: string }> {
    if (!(await this.d.isActive(instanceId, phone))) throw new Error('NO_OPT_IN');
    return this.insert(instanceId, phone, text, 'notification', 0);
  }

  private async insert(instanceId: string, phone: string, text: string, kind: string, priority: number): Promise<{ id: string }> {
    const id = randomUUID();
    this.lastCreated = Math.max(this.now(), this.lastCreated + 1);
    await this.d.db.query(
      `insert into send_jobs (id, instance_id, phone, text, status, kind, priority, created_at)
       values ($1, $2, $3, $4, 'queued', $5, $6, $7)`,
      [id, instanceId, phone, text, kind, priority, new Date(this.lastCreated).toISOString()],
    );
    return { id };
  }

  /** Resposta a quem acabou de falar com o chip: sem checagem de opt-in, na frente da fila, sob o mesmo intervalo. */
  async enqueueReply(instanceId: string, phone: string, text: string): Promise<{ id: string }> {
    const r = await this.insert(instanceId, phone, text, 'reply', 1);
    if (this.timer) void this.tick(); // não espera o próximo ciclo de 1 s
    return r;
  }

  async stats(instanceId: string): Promise<{ queued: number; sentLastHour: number }> {
    const q = await this.d.db.query<{ n: string }>(
      `select count(*) as n from send_jobs where instance_id = $1 and status = 'queued'`,
      [instanceId],
    );
    return { queued: Number(q.rows[0].n), sentLastHour: await this.sentLastHour(instanceId) };
  }

  async processNext(instanceId: string): Promise<ProcessResult> {
    const now = this.now();
    const r = await this.d.db.query<{ id: string; phone: string; text: string; attempts: number; kind: string }>(
      `select id, phone, text, attempts, kind from send_jobs
       where instance_id = $1 and status = 'queued' order by priority desc, created_at, id limit 1`,
      [instanceId],
    );
    const job = r.rows[0];
    if (!job) return { status: 'idle', waitMs: 0 };

    const isReply = job.kind === 'reply';
    const allowed = (isReply ? this.nextReplyAt : this.nextAllowedAt).get(instanceId) ?? 0;
    if (now < allowed) return { status: 'throttled', waitMs: allowed - now };
    if (!isReply && (await this.sentLastHour(instanceId)) >= this.d.maxPerHour) return { status: 'throttled', waitMs: 60_000 };

    if (!isReply && !(await this.d.isActive(instanceId, job.phone))) {
      await this.d.db.query(`update send_jobs set status = 'cancelled' where id = $1 and status = 'queued'`, [job.id]);
      return { status: 'cancelled', waitMs: 0 };
    }

    const claimed = await this.d.db.query(
      `update send_jobs set status = 'sending' where id = $1 and status = 'queued' returning id`,
      [job.id],
    );
    if (!claimed.rows.length) return { status: 'idle', waitMs: 0 };

    try {
      await this.d.send(instanceId, job.phone, job.text);
      await this.d.db.query(`update send_jobs set status = 'sent', sent_at = $2 where id = $1`, [job.id, new Date(now).toISOString()]);
      const delay = this.d.minDelayMs + this.random() * (this.d.maxDelayMs - this.d.minDelayMs);
      this.nextAllowedAt.set(instanceId, now + delay);
      this.nextReplyAt.set(instanceId, now + REPLY_GAP_MS);
      return { status: 'sent', waitMs: isReply ? REPLY_GAP_MS : delay };
    } catch (err) {
      if (err instanceof Error && err.message === 'INSTANCE_NOT_OPEN') {
        await this.d.db.query(`update send_jobs set status = 'queued' where id = $1`, [job.id]);
        this.nextAllowedAt.set(instanceId, now + this.d.maxDelayMs);
        return { status: 'retry', waitMs: this.d.maxDelayMs };
      }
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      await this.d.db.query(`update send_jobs set attempts = $2, status = $3 where id = $1`, [job.id, attempts, failed ? 'failed' : 'queued']);
      this.nextAllowedAt.set(instanceId, now + this.d.maxDelayMs);
      return { status: failed ? 'failed' : 'retry', waitMs: this.d.maxDelayMs };
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.d.db.query<{ instance_id: string }>(`select distinct instance_id from send_jobs where status = 'queued'`);
      for (const row of r.rows) await this.processNext(row.instance_id);
    } catch (err) {
      console.error('[queue] erro no ciclo', err);
    } finally {
      this.running = false;
    }
  }

  private async sentLastHour(instanceId: string): Promise<number> {
    const since = new Date(this.now() - HOUR_MS).toISOString();
    const r = await this.d.db.query<{ n: string }>(
      `select count(*) as n from send_jobs where instance_id = $1 and status = 'sent' and sent_at > $2`,
      [instanceId, since],
    );
    return Number(r.rows[0].n);
  }
}

import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { InstanceManager } from '../instances/manager.js';
import type { SendQueue } from '../queue/sendQueue.js';
import { createCode } from '../optin/codes.js';

export interface ServerDeps {
  config: Config;
  db: Db;
  manager: Pick<InstanceManager, 'create' | 'list' | 'status' | 'phone' | 'remove'>;
  queue: Pick<SendQueue, 'enqueue' | 'stats'>;
}

const idSchema = z.string().regex(/^[a-z0-9-]{2,32}$/);
const phoneSchema = z.string().regex(/^\d{10,15}$/);

const createInstance = z.object({ id: idSchema, label: z.string().max(80).optional() });
const createOptinCode = z.object({
  instanceId: idSchema,
  project: z.string().min(1).max(40),
  subjectId: z.string().min(1).max(120),
  prefix: z.string().regex(/^[A-Za-z]{2,6}$/),
  replyText: z.string().min(1).max(1000),
  ttlMinutes: z.number().int().min(1).max(1440).optional(),
  messageTemplate: z.string().max(300).includes('{{code}}').optional(),
});
const sendMessage = z.object({ instanceId: idSchema, phone: phoneSchema, text: z.string().min(1).max(4000) });

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { config, db, manager, queue } = deps;

  app.get('/health', async () => ({ ok: true }));

  app.addHook('onRequest', async (req, reply) => {
    // decide pela rota já casada (o roteador decodifica %xx; a URL crua não serve)
    if (!(req.routeOptions?.url ?? '').startsWith('/v1/')) return;
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !safeEqual(key, config.apiKey)) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'INVALID_BODY', issues: err.issues });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'BAD_REQUEST' });
    console.error('[api]', err);
    return reply.code(500).send({ error: 'INTERNAL' });
  });

  app.post('/v1/instances', async (req) => {
    const b = createInstance.parse(req.body);
    await manager.create(b.id, b.label);
    return { id: b.id, ...manager.status(b.id) };
  });

  app.get('/v1/instances', async () => ({ instances: await manager.list() }));

  app.get('/v1/instances/:id', async (req) => {
    const id = idSchema.parse((req.params as { id: string }).id);
    return { id, ...manager.status(id), phone: manager.phone(id) };
  });

  app.delete('/v1/instances/:id', async (req) => {
    const id = idSchema.parse((req.params as { id: string }).id);
    await manager.remove(id);
    return { ok: true };
  });

  app.post('/v1/optin/codes', async (req, reply) => {
    const b = createOptinCode.parse(req.body);
    const selfPhone = manager.phone(b.instanceId);
    if (!selfPhone) return reply.code(409).send({ error: 'INSTANCE_NOT_OPEN' });
    const { code, expiresAt } = await createCode(db, b);
    const text = (b.messageTemplate ?? 'Quero receber avisos. Código: {{code}}').replace('{{code}}', code);
    return { code, expiresAt, waLink: `https://wa.me/${selfPhone}?text=${encodeURIComponent(text)}` };
  });

  app.post('/v1/messages', async (req, reply) => {
    const b = sendMessage.parse(req.body);
    try {
      const { id } = await queue.enqueue(b.instanceId, b.phone, b.text);
      return reply.code(202).send({ id });
    } catch (err) {
      if (err instanceof Error && err.message === 'NO_OPT_IN') return reply.code(409).send({ error: 'NO_OPT_IN' });
      throw err;
    }
  });

  app.get('/v1/queue/:instanceId', async (req) => {
    const id = idSchema.parse((req.params as { instanceId: string }).instanceId);
    return queue.stats(id);
  });

  return app;
}

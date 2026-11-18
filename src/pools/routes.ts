import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { InstanceManager } from '../instances/manager.js';
import type { PoolService } from './service.js';

const idSchema = z.string().regex(/^[a-z0-9-]{2,32}$/);
const phoneSchema = z.string().regex(/^\d{10,15}$/);
const groupJid = z.string().regex(/^[0-9-]{5,40}@g\.us$/, 'jid de grupo (…@g.us)');
const https = z.string().url().refine((u) => u.startsWith('https://'), 'a imagem precisa ser https');

/** Tokens de pareamento: 10 minutos, só em memória. O link abre no celular sem expor a API_KEY. */
export class Pareamentos {
  private tokens = new Map<string, { instanceId: string; expira: number }>();
  criar(instanceId: string, ttlMs = 10 * 60_000) {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(token, { instanceId, expira: Date.now() + ttlMs });
    return { token, expiraEm: new Date(Date.now() + ttlMs).toISOString() };
  }
  ler(token: string): string | null {
    const t = this.tokens.get(token);
    if (!t) return null;
    if (t.expira < Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return t.instanceId;
  }
}

const escapar = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function rotasPools(
  app: FastifyInstance,
  pools: PoolService,
  manager: Pick<InstanceManager, 'status' | 'phone'>,
  pareamentos: Pareamentos,
) {
  const pool = (req: { params: unknown }) => idSchema.parse((req.params as { pool: string }).pool);

  app.put('/v1/pools/:pool', async (req) => {
    const b = z.object({ project: z.string().min(1).max(40), adminPhones: z.array(phoneSchema).max(5).default([]) }).parse(req.body);
    await pools.salvarPool(pool(req), b.project, b.adminPhones);
    return { ok: true };
  });

  app.post('/v1/pools/:pool/numeros', async (req, reply) => {
    const b = z.object({ instanceId: idSchema, ordem: z.number().int().min(0).max(99).default(0), label: z.string().max(80).optional() }).parse(req.body);
    await pools.adicionarNumero(pool(req), b.instanceId, b.ordem, b.label);
    return reply.code(201).send({ ok: true, pareamento: pareamentos.criar(b.instanceId) });
  });

  app.get('/v1/pools/:pool/numeros', async (req) => ({ numeros: await pools.listarNumeros(pool(req)) }));

  app.post('/v1/pools/:pool/numeros/:instanceId/promover', async (req) => {
    const instanceId = idSchema.parse((req.params as { instanceId: string }).instanceId);
    await pools.promover(pool(req), instanceId);
    return { ok: true };
  });

  /** Link de pareamento por QR, válido por 10 minutos. */
  app.post('/v1/instances/:id/pareamento', async (req) => {
    const id = idSchema.parse((req.params as { id: string }).id);
    const t = pareamentos.criar(id);
    return { url: `/parear/${t.token}`, expiraEm: t.expiraEm };
  });

  app.put('/v1/pools/:pool/grupos/:jid', async (req) => {
    const jid = groupJid.parse((req.params as { jid: string }).jid);
    const b = z
      .object({
        nome: z.string().max(120).optional(),
        intervaloMinS: z.number().int().min(30).max(86_400).default(180),
        espacoMinS: z.number().int().min(0).max(3600).default(20),
        espacoMaxS: z.number().int().min(0).max(3600).default(90),
      })
      .parse(req.body ?? {});
    await pools.salvarGrupo(pool(req), jid, b);
    return { ok: true };
  });

  app.get('/v1/pools/:pool/grupos', async (req) => ({ grupos: await pools.listarGrupos(pool(req)) }));

  app.get('/v1/pools/:pool/grupos/:jid/convite', async (req) => {
    const jid = groupJid.parse((req.params as { jid: string }).jid);
    return { convite: await pools.convite(pool(req), jid) };
  });

  app.post('/v1/pools/:pool/grupos/:jid/mensagem', async (req, reply) => {
    const jid = groupJid.parse((req.params as { jid: string }).jid);
    const b = z
      .object({ texto: z.string().min(1).max(4000), imagem: https.optional(), ref: z.string().max(120).optional() })
      .parse(req.body);
    const { id } = await pools.enfileirarGrupo(pool(req), jid, b.texto, b.imagem ?? null, b.ref ?? null);
    return reply.code(202).send({ id });
  });

  app.post('/v1/pools/:pool/privado', async (req, reply) => {
    const b = z.object({ texto: z.string().min(1).max(4000), phone: phoneSchema.optional(), ref: z.string().max(120).optional() }).parse(req.body);
    return reply.code(202).send(await pools.enfileirarPrivado(pool(req), b.texto, b.phone ?? null, b.ref ?? null));
  });

  app.get('/v1/pools/:pool/envios/:id', async (req, reply) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const j = await pools.job(pool(req), id);
    return j ?? reply.code(404).send({ error: 'NOT_FOUND' });
  });

  app.post('/v1/pools/:pool/entradas', async (req) => {
    const b = z
      .object({
        chave: z.string().regex(/^[a-z0-9-]{2,40}$/),
        grupoJid: groupJid,
        mensagem: z.string().min(8).max(200),
        origem: z.string().min(1).max(80),
        resposta: z.string().min(1).max(1000).default('Que bom ter você! Entre no grupo pelo link: {{convite}}'),
      })
      .parse(req.body);
    return pools.salvarEntrada(pool(req), b);
  });

  app.get('/v1/pools/:pool/eventos', async (req) => {
    const { limite } = z.object({ limite: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return { eventos: await pools.eventos(pool(req), limite) };
  });

  /** Página de pareamento (pública, protegida pelo token). Atualiza sozinha a cada 5 s. */
  app.get('/parear/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const id = /^[a-f0-9]{48}$/.test(token) ? pareamentos.ler(token) : null;
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex').type('text/html; charset=utf-8');
    if (!id) return reply.code(404).send('<!doctype html><meta charset="utf-8"><p>Link de pareamento expirado. Gere outro no painel.</p>');
    const st = manager.status(id);
    let corpo: string;
    if (st.status === 'open') corpo = `<p class="ok">Conectado${manager.phone(id) ? `: +${escapar(manager.phone(id) ?? '')}` : ''}.</p><p>Pode fechar esta página.</p>`;
    else if (st.qr) {
      const svg = await QRCode.toString(st.qr, { type: 'svg', margin: 1, width: 320 });
      corpo = `<div class="qr">${svg}</div><p>No celular do chip: WhatsApp &gt; Aparelhos conectados &gt; Conectar aparelho. O código troca a cada ~60 s.</p>`;
    } else corpo = '<p>Gerando o código… aguarde.</p>';
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Parear ${escapar(id)}</title><style>body{font-family:system-ui,sans-serif;max-width:420px;margin:32px auto;padding:0 16px;color:#1f1f1f;background:#fff}.qr svg{width:100%;height:auto}.ok{color:#0a7d4f;font-weight:600}</style></head><body><h1>Parear número “${escapar(id)}”</h1>${corpo}</body></html>`;
  });
}

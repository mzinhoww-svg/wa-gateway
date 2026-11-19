import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { InstanceManager, ManagerEvent } from '../instances/manager.js';
import type { InboundMessage } from '../instances/types.js';

/**
 * Pools: vários números (instâncias) de um mesmo projeto, com um ativo e os outros de reserva.
 *
 * - Heartbeat a cada 60 s por número. Logout, ban (sessão recusada pelo WhatsApp) ou falha repetida do ativo
 *   marcam o número como banido e promovem o próximo reserva conectado que já seja admin dos grupos do pool.
 * - Fila própria (pool_jobs) com limite por grupo: no máximo 1 mensagem a cada `intervalo_min_s` (180 s),
 *   mais um espaçamento aleatório entre `espaco_min_s` e `espaco_max_s` (20 a 90 s).
 * - Aquecimento: cada número novo tem um teto diário de mensagens em grupo que cresce com os dias.
 * - O número pessoal do dono (admin_phones) nunca conecta: se for pareado, é desconectado e bloqueado.
 * - Mensagens recebidas no privado: dos admins viram comandos (PAUSAR, RETOMAR, STATUS) para o webhook do
 *   projeto; de quem veio por um link wa.me de entrada recebem o convite do grupo.
 */

export type Papel = 'ativo' | 'reserva' | 'banido' | 'bloqueado';

export interface PoolWebhookEvent {
  type: `pool.${string}`;
  instanceId: string;
  project: string;
  poolId: string;
  at: string;
  [k: string]: unknown;
}

export interface PoolOptions {
  db: Db;
  manager: Pick<
    InstanceManager,
    'status' | 'phone' | 'sendTo' | 'isGroupAdmin' | 'groupInviteLink' | 'disconnect' | 'create' | 'listGroups'
  >;
  emit(e: PoolWebhookEvent): void;
  heartbeatMs?: number;
  /** Heartbeats seguidos sem conexão até o ativo ser trocado (2 = cerca de 2 minutos). */
  falhasMax?: number;
  /** Espaço mínimo entre dois envios do mesmo número para privado (ms). */
  espacoPrivadoMs?: number;
  aquecimento?: boolean;
  now?: () => number;
  random?: () => number;
}

/** Teto diário de mensagens em grupo por número, pelos dias desde o início do aquecimento. */
export function tetoAquecimento(dias: number): number {
  if (dias < 2) return 15;
  if (dias < 5) return 30;
  if (dias < 10) return 60;
  return 150;
}

export const COMANDOS = new Set(['PAUSAR', 'PAUSA', 'RETOMAR', 'STATUS']);

export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const telefones = (csv: string) => csv.split(',').map((x) => x.trim()).filter(Boolean);

interface Membro {
  pool_id: string;
  instance_id: string;
  ordem: number;
  papel: Papel;
  falhas: number;
  aquecimento_desde: string | Date;
}

export class PoolService {
  private timerJobs: NodeJS.Timeout | null = null;
  private timerHeartbeat: NodeJS.Timeout | null = null;
  private rodando = false;
  private proximoPorNumero = new Map<string, number>();
  /** Garante ordem de chegada mesmo com dois jobs no mesmo milissegundo. */
  private ultimoCriado = 0;
  private now: () => number;
  private random: () => number;
  private falhasMax: number;
  private espacoPrivadoMs: number;

  constructor(private o: PoolOptions) {
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.falhasMax = o.falhasMax ?? 2;
    this.espacoPrivadoMs = o.espacoPrivadoMs ?? 3000;
  }

  private agora() {
    return new Date(this.now()).toISOString();
  }

  // ---------- cadastro ----------

  async salvarPool(id: string, project: string, adminPhones: string[]): Promise<void> {
    await this.o.db.query(
      `insert into pools (id, project, admin_phones) values ($1, $2, $3)
       on conflict (id) do update set project = excluded.project, admin_phones = excluded.admin_phones`,
      [id, project, adminPhones.join(',')],
    );
  }

  async pool(id: string): Promise<{ id: string; project: string; adminPhones: string[] } | null> {
    const r = await this.o.db.query<{ id: string; project: string; admin_phones: string }>(
      'select id, project, admin_phones from pools where id = $1',
      [id],
    );
    const p = r.rows[0];
    return p ? { id: p.id, project: p.project, adminPhones: telefones(p.admin_phones) } : null;
  }

  private async exigirPool(id: string) {
    const p = await this.pool(id);
    if (!p) throw Object.assign(new Error('POOL_NOT_FOUND'), { statusCode: 404 });
    return p;
  }

  /** Adiciona um número ao pool (cria a instância e inicia o pareamento se ainda não existir). */
  async adicionarNumero(poolId: string, instanceId: string, ordem: number, label?: string): Promise<void> {
    await this.exigirPool(poolId);
    await this.o.manager.create(instanceId, label);
    await this.o.db.query(
      `insert into pool_members (pool_id, instance_id, ordem, papel, aquecimento_desde) values ($1, $2, $3, 'reserva', $4)
       on conflict (pool_id, instance_id) do update set ordem = excluded.ordem`,
      [poolId, instanceId, ordem, this.agora()],
    );
  }

  private async membros(poolId: string): Promise<Membro[]> {
    const r = await this.o.db.query<Membro>(
      'select pool_id, instance_id, ordem, papel, falhas, aquecimento_desde from pool_members where pool_id = $1 order by ordem, instance_id',
      [poolId],
    );
    return r.rows;
  }

  async listarNumeros(poolId: string) {
    await this.exigirPool(poolId);
    const r = await this.o.db.query<
      Membro & { ultimo_heartbeat: string | Date | null; motivo: string | null }
    >(
      `select pool_id, instance_id, ordem, papel, falhas, aquecimento_desde, ultimo_heartbeat, motivo
       from pool_members where pool_id = $1 order by ordem, instance_id`,
      [poolId],
    );
    const hoje = await this.enviadosHoje(poolId);
    return r.rows.map((m) => {
      const dias = this.diasAquecimento(m.aquecimento_desde);
      const st = this.o.manager.status(m.instance_id);
      return {
        instanceId: m.instance_id,
        ordem: m.ordem,
        papel: m.papel,
        conexao: st.status,
        aguardandoQr: st.status === 'qr',
        telefone: this.o.manager.phone(m.instance_id),
        ultimoHeartbeat: m.ultimo_heartbeat ? new Date(m.ultimo_heartbeat).toISOString() : null,
        falhasSeguidas: m.falhas,
        motivo: m.motivo,
        aquecimento: { dias, tetoDiario: tetoAquecimento(dias), enviadosHoje: hoje.get(m.instance_id) ?? 0 },
      };
    });
  }

  async salvarGrupo(
    poolId: string,
    jid: string,
    g: { nome?: string | null; intervaloMinS?: number; espacoMinS?: number; espacoMaxS?: number },
  ): Promise<void> {
    await this.exigirPool(poolId);
    await this.o.db.query(
      `insert into pool_groups (pool_id, jid, nome, intervalo_min_s, espaco_min_s, espaco_max_s)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (pool_id, jid) do update set nome = coalesce(excluded.nome, pool_groups.nome),
         intervalo_min_s = excluded.intervalo_min_s, espaco_min_s = excluded.espaco_min_s, espaco_max_s = excluded.espaco_max_s`,
      [poolId, jid, g.nome ?? null, g.intervaloMinS ?? 180, g.espacoMinS ?? 20, Math.max(g.espacoMinS ?? 20, g.espacoMaxS ?? 90)],
    );
  }

  async listarGrupos(poolId: string) {
    await this.exigirPool(poolId);
    const r = await this.o.db.query<{
      jid: string;
      nome: string | null;
      intervalo_min_s: number;
      espaco_min_s: number;
      espaco_max_s: number;
      proximo_envio: string | Date | null;
    }>('select jid, nome, intervalo_min_s, espaco_min_s, espaco_max_s, proximo_envio from pool_groups where pool_id = $1 order by jid', [poolId]);
    return r.rows.map((g) => ({
      jid: g.jid,
      nome: g.nome,
      intervaloMinS: g.intervalo_min_s,
      espacoMinS: g.espaco_min_s,
      espacoMaxS: g.espaco_max_s,
      proximoEnvio: g.proximo_envio ? new Date(g.proximo_envio).toISOString() : null,
    }));
  }

  /** Grupos do WhatsApp em que o número ativo está. */
  async gruposDoWhatsapp(poolId: string) {
    const ativo = await this.ativo(poolId);
    if (!ativo) throw Object.assign(new Error('NO_ACTIVE_NUMBER'), { statusCode: 409 });
    return this.o.manager.listGroups(ativo);
  }

  async convite(poolId: string, jid: string): Promise<string> {
    const ativo = await this.ativo(poolId);
    if (!ativo) throw Object.assign(new Error('NO_ACTIVE_NUMBER'), { statusCode: 409 });
    return this.o.manager.groupInviteLink(ativo, jid);
  }

  async salvarEntrada(
    poolId: string,
    e: { chave: string; grupoJid: string; mensagem: string; origem: string; resposta: string },
  ): Promise<{ waLink: string | null }> {
    await this.exigirPool(poolId);
    await this.o.db.query(
      `insert into pool_entradas (pool_id, chave, grupo_jid, mensagem, origem, resposta) values ($1, $2, $3, $4, $5, $6)
       on conflict (pool_id, chave) do update set grupo_jid = excluded.grupo_jid, mensagem = excluded.mensagem,
         origem = excluded.origem, resposta = excluded.resposta`,
      [poolId, e.chave, e.grupoJid, e.mensagem, e.origem, e.resposta],
    );
    const ativo = await this.ativo(poolId);
    const tel = ativo ? this.o.manager.phone(ativo) : null;
    return { waLink: tel ? `https://wa.me/${tel}?text=${encodeURIComponent(e.mensagem)}` : null };
  }

  async eventos(poolId: string, limite = 50) {
    const r = await this.o.db.query<{ id: string; tipo: string; dados: string; created_at: string | Date }>(
      'select id, tipo, dados, created_at from pool_eventos where pool_id = $1 order by created_at desc limit $2',
      [poolId, limite],
    );
    return r.rows.map((e) => ({ id: e.id, tipo: e.tipo, dados: JSON.parse(e.dados), em: new Date(e.created_at).toISOString() }));
  }

  // ---------- papéis e failover ----------

  async ativo(poolId: string): Promise<string | null> {
    const r = await this.o.db.query<{ instance_id: string }>(
      `select instance_id from pool_members where pool_id = $1 and papel = 'ativo' limit 1`,
      [poolId],
    );
    return r.rows[0]?.instance_id ?? null;
  }

  private async registrar(poolId: string, project: string, tipo: string, dados: Record<string, unknown>, instanceId?: string) {
    await this.o.db.query('insert into pool_eventos (id, pool_id, tipo, dados, created_at) values ($1, $2, $3, $4, $5)', [
      randomUUID(),
      poolId,
      tipo,
      JSON.stringify(dados),
      this.agora(),
    ]);
    this.o.emit({ type: `pool.${tipo}`, instanceId: instanceId ?? poolId, project, poolId, at: this.agora(), ...dados });
  }

  private async definirPapel(poolId: string, instanceId: string, papel: Papel, motivo: string | null) {
    await this.o.db.query(
      'update pool_members set papel = $3, motivo = $4, falhas = 0, atualizado_em = $5 where pool_id = $1 and instance_id = $2',
      [poolId, instanceId, papel, motivo, this.agora()],
    );
  }

  /** Promove o próximo reserva conectado que seja admin de todos os grupos do pool. */
  async promoverProximo(poolId: string, motivo: string, de: string | null): Promise<string | null> {
    const p = await this.exigirPool(poolId);
    const grupos = (await this.listarGrupos(poolId)).map((g) => g.jid);
    for (const m of await this.membros(poolId)) {
      if (m.papel !== 'reserva' || this.o.manager.status(m.instance_id).status !== 'open') continue;
      let admin = true;
      for (const g of grupos) {
        if (!(await this.o.manager.isGroupAdmin(m.instance_id, g).catch(() => false))) {
          admin = false;
          break;
        }
      }
      if (!admin) continue;
      await this.definirPapel(poolId, m.instance_id, 'ativo', null);
      await this.registrar(p.id, p.project, 'failover', { de, para: m.instance_id, motivo }, m.instance_id);
      return m.instance_id;
    }
    await this.registrar(p.id, p.project, 'sem_numero', { de, motivo });
    return null;
  }

  /** Troca manual (painel): o ativo atual volta a reserva. */
  async promover(poolId: string, instanceId: string): Promise<void> {
    const p = await this.exigirPool(poolId);
    const m = (await this.membros(poolId)).find((x) => x.instance_id === instanceId);
    if (!m) throw Object.assign(new Error('MEMBER_NOT_FOUND'), { statusCode: 404 });
    if (m.papel === 'banido' || m.papel === 'bloqueado') throw Object.assign(new Error('MEMBER_BLOCKED'), { statusCode: 409 });
    const atual = await this.ativo(poolId);
    if (atual && atual !== instanceId) await this.definirPapel(poolId, atual, 'reserva', 'troca manual');
    await this.definirPapel(poolId, instanceId, 'ativo', null);
    await this.registrar(p.id, p.project, 'failover', { de: atual, para: instanceId, motivo: 'troca manual' }, instanceId);
  }

  private async banir(m: Membro, motivo: string) {
    const p = await this.exigirPool(m.pool_id);
    await this.definirPapel(m.pool_id, m.instance_id, 'banido', motivo);
    await this.registrar(p.id, p.project, 'numero_banido', { numero: m.instance_id, motivo, eraAtivo: m.papel === 'ativo' }, m.instance_id);
    if (m.papel === 'ativo') await this.promoverProximo(m.pool_id, motivo, m.instance_id);
  }

  /** Eventos de conexão do gerenciador: logout ou sessão recusada (ban) derrubam o número na hora. */
  async aoEventoConexao(e: ManagerEvent): Promise<void> {
    if (e.type !== 'closed' || !(e.loggedOut || e.fatal)) return;
    const r = await this.o.db.query<Membro>(
      `select pool_id, instance_id, ordem, papel, falhas, aquecimento_desde from pool_members
       where instance_id = $1 and papel in ('ativo', 'reserva')`,
      [e.id],
    );
    const motivo = e.loggedOut ? 'logout' : `sessão recusada pelo WhatsApp (código ${e.code ?? '?'})`;
    for (const m of r.rows) await this.banir(m, motivo);
  }

  /** Heartbeat: atualiza cada número, bloqueia o número pessoal e troca o ativo depois de falhas seguidas. */
  async heartbeat(): Promise<void> {
    const pools = await this.o.db.query<{ id: string }>('select id from pools');
    for (const { id } of pools.rows) {
      const p = await this.exigirPool(id);
      for (const m of await this.membros(id)) {
        if (m.papel === 'banido' || m.papel === 'bloqueado') continue;
        const tel = this.o.manager.phone(m.instance_id);
        if (tel && p.adminPhones.includes(tel)) {
          this.o.manager.disconnect(m.instance_id);
          await this.definirPapel(id, m.instance_id, 'bloqueado', 'número pessoal do dono não pode conectar');
          await this.registrar(p.id, p.project, 'numero_pessoal_bloqueado', { numero: m.instance_id }, m.instance_id);
          if (m.papel === 'ativo') await this.promoverProximo(id, 'número pessoal bloqueado', m.instance_id);
          continue;
        }
        if (this.o.manager.status(m.instance_id).status === 'open') {
          await this.o.db.query(
            'update pool_members set ultimo_heartbeat = $3, falhas = 0 where pool_id = $1 and instance_id = $2',
            [id, m.instance_id, this.agora()],
          );
          continue;
        }
        const falhas = m.falhas + 1;
        await this.o.db.query('update pool_members set falhas = $3 where pool_id = $1 and instance_id = $2', [id, m.instance_id, falhas]);
        if (m.papel === 'ativo' && falhas >= this.falhasMax) await this.banir({ ...m, falhas }, `sem conexão em ${falhas} heartbeats seguidos`);
      }
      if (!(await this.ativo(id))) {
        const temReserva = (await this.membros(id)).some(
          (m) => m.papel === 'reserva' && this.o.manager.status(m.instance_id).status === 'open',
        );
        if (temReserva) await this.promoverProximo(id, 'pool sem número ativo', null);
      }
    }
  }

  // ---------- envio ----------

  async enfileirarGrupo(poolId: string, jid: string, texto: string, imagemUrl: string | null, ref: string | null) {
    await this.exigirPool(poolId);
    const g = await this.o.db.query('select 1 from pool_groups where pool_id = $1 and jid = $2', [poolId, jid]);
    if (!g.rows.length) await this.salvarGrupo(poolId, jid, {});
    return this.inserirJob(poolId, 'grupo', jid, texto, imagemUrl, ref);
  }

  /** Privado só para os admins do pool (alertas e resumo diário). */
  async enfileirarPrivado(poolId: string, texto: string, phone?: string | null, ref?: string | null) {
    const p = await this.exigirPool(poolId);
    const destinos = phone ? [phone] : p.adminPhones;
    if (!destinos.length || destinos.some((d) => !p.adminPhones.includes(d))) {
      throw Object.assign(new Error('NOT_A_POOL_ADMIN'), { statusCode: 409 });
    }
    const ids: string[] = [];
    for (const d of destinos) ids.push((await this.inserirJob(poolId, 'privado', `${d}@s.whatsapp.net`, texto, null, ref ?? null)).id);
    return { ids };
  }

  private async inserirJob(poolId: string, tipo: string, jid: string, texto: string, imagemUrl: string | null, ref: string | null) {
    const id = randomUUID();
    this.ultimoCriado = Math.max(this.now(), this.ultimoCriado + 1);
    await this.o.db.query(
      `insert into pool_jobs (id, pool_id, tipo, jid, texto, imagem_url, ref, status, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`,
      [id, poolId, tipo, jid, texto, imagemUrl, ref, new Date(this.ultimoCriado).toISOString()],
    );
    return { id };
  }

  async job(poolId: string, id: string) {
    const r = await this.o.db.query<{
      id: string;
      tipo: string;
      jid: string;
      status: string;
      ref: string | null;
      instance_id: string | null;
      erro: string | null;
      attempts: number;
      created_at: string | Date;
      sent_at: string | Date | null;
    }>('select id, tipo, jid, status, ref, instance_id, erro, attempts, created_at, sent_at from pool_jobs where pool_id = $1 and id = $2', [poolId, id]);
    const j = r.rows[0];
    return j
      ? {
          id: j.id,
          tipo: j.tipo,
          jid: j.jid,
          status: j.status,
          ref: j.ref,
          numero: j.instance_id,
          erro: j.erro,
          tentativas: j.attempts,
          criadoEm: new Date(j.created_at).toISOString(),
          enviadoEm: j.sent_at ? new Date(j.sent_at).toISOString() : null,
        }
      : null;
  }

  private diasAquecimento(desde: string | Date): number {
    return Math.max(0, Math.floor((this.now() - new Date(desde).getTime()) / 86_400_000));
  }

  private async enviadosHoje(poolId: string): Promise<Map<string, number>> {
    const inicio = new Date(this.now());
    inicio.setUTCHours(3, 0, 0, 0); // meia-noite em Brasília
    if (inicio.getTime() > this.now()) inicio.setUTCDate(inicio.getUTCDate() - 1);
    const r = await this.o.db.query<{ instance_id: string; n: string }>(
      `select instance_id, count(*) as n from pool_jobs
       where pool_id = $1 and tipo = 'grupo' and status = 'sent' and sent_at >= $2 group by instance_id`,
      [poolId, inicio.toISOString()],
    );
    return new Map(r.rows.map((x) => [x.instance_id, Number(x.n)]));
  }

  /** Um ciclo da fila: no máximo um envio por número, respeitando grupo, aquecimento e espaçamento. */
  async processar(): Promise<number> {
    const r = await this.o.db.query<{
      id: string;
      pool_id: string;
      tipo: string;
      jid: string;
      texto: string;
      imagem_url: string | null;
      ref: string | null;
      attempts: number;
    }>(`select id, pool_id, tipo, jid, texto, imagem_url, ref, attempts from pool_jobs where status = 'queued' order by created_at, id limit 50`);
    const now = this.now();
    const usados = new Set<string>();
    let enviados = 0;
    for (const j of r.rows) {
      const ativo = await this.ativo(j.pool_id);
      if (!ativo || usados.has(ativo) || this.o.manager.status(ativo).status !== 'open') continue;
      if ((this.proximoPorNumero.get(ativo) ?? 0) > now) continue;
      let grupo: { intervalo_min_s: number; espaco_min_s: number; espaco_max_s: number; proximo_envio: string | Date | null } | undefined;
      if (j.tipo === 'grupo') {
        const g = await this.o.db.query<NonNullable<typeof grupo>>(
          'select intervalo_min_s, espaco_min_s, espaco_max_s, proximo_envio from pool_groups where pool_id = $1 and jid = $2',
          [j.pool_id, j.jid],
        );
        grupo = g.rows[0];
        if (grupo?.proximo_envio && new Date(grupo.proximo_envio).getTime() > now) continue;
        if (this.o.aquecimento !== false) {
          const m = (await this.membros(j.pool_id)).find((x) => x.instance_id === ativo);
          const teto = tetoAquecimento(this.diasAquecimento(m?.aquecimento_desde ?? new Date(now)));
          if (((await this.enviadosHoje(j.pool_id)).get(ativo) ?? 0) >= teto) continue;
        }
      }
      const claim = await this.o.db.query(`update pool_jobs set status = 'sending' where id = $1 and status = 'queued' returning id`, [j.id]);
      if (!claim.rows.length) continue;
      usados.add(ativo);
      const p = await this.exigirPool(j.pool_id);
      try {
        await this.o.manager.sendTo(ativo, j.jid, j.texto, j.imagem_url);
        await this.o.db.query(`update pool_jobs set status = 'sent', instance_id = $2, sent_at = $3 where id = $1`, [j.id, ativo, new Date(now).toISOString()]);
        enviados++;
        if (grupo) {
          const espaco = grupo.espaco_min_s + this.random() * (grupo.espaco_max_s - grupo.espaco_min_s);
          const proximo = new Date(now + (grupo.intervalo_min_s + espaco) * 1000).toISOString();
          await this.o.db.query('update pool_groups set proximo_envio = $3 where pool_id = $1 and jid = $2', [j.pool_id, j.jid, proximo]);
          this.proximoPorNumero.set(ativo, now + espaco * 1000);
        } else this.proximoPorNumero.set(ativo, now + this.espacoPrivadoMs);
        this.o.emit({ type: 'pool.envio', instanceId: ativo, project: p.project, poolId: p.id, at: this.agora(), jobId: j.id, ref: j.ref, status: 'enviado', tipo: j.tipo, jid: j.jid });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'INSTANCE_NOT_OPEN') {
          await this.o.db.query(`update pool_jobs set status = 'queued' where id = $1`, [j.id]);
          continue;
        }
        const tentativas = j.attempts + 1;
        const falhou = tentativas >= 3;
        await this.o.db.query(`update pool_jobs set attempts = $2, status = $3, erro = $4 where id = $1`, [j.id, tentativas, falhou ? 'failed' : 'queued', msg.slice(0, 300)]);
        this.proximoPorNumero.set(ativo, now + 10_000);
        if (falhou) this.o.emit({ type: 'pool.envio', instanceId: ativo, project: p.project, poolId: p.id, at: this.agora(), jobId: j.id, ref: j.ref, status: 'falhou', erro: msg.slice(0, 300), tipo: j.tipo, jid: j.jid });
      }
    }
    return enviados;
  }

  // ---------- mensagens recebidas ----------

  /** Trata mensagens que chegam nos números de um pool. Devolve true quando a mensagem é de um pool. */
  async aoReceber(m: InboundMessage): Promise<boolean> {
    const r = await this.o.db.query<{ pool_id: string }>('select pool_id from pool_members where instance_id = $1 limit 1', [m.instanceId]);
    const poolId = r.rows[0]?.pool_id;
    if (!poolId) return false;
    if (m.isGroup || m.fromMe || !m.phone) return true;
    const visto = await this.o.db.query(
      'insert into inbound_seen (instance_id, message_id) values ($1, $2) on conflict do nothing returning message_id',
      [m.instanceId, m.messageId],
    );
    if (!visto.rows.length) return true;
    const p = await this.exigirPool(poolId);
    const texto = normalizar(m.text);

    if (p.adminPhones.includes(m.phone)) {
      const palavra = texto.split(' ')[0] ?? '';
      if (COMANDOS.has(palavra) && texto.split(' ').length <= 3) {
        const comando = palavra === 'PAUSA' ? 'PAUSAR' : palavra;
        await this.registrar(p.id, p.project, 'comando', { comando, phone: m.phone }, m.instanceId);
      } else {
        await this.registrar(p.id, p.project, 'privado', { phone: m.phone, texto: m.text.slice(0, 1000) }, m.instanceId);
      }
      return true;
    }

    const entradas = await this.o.db.query<{ chave: string; grupo_jid: string; mensagem: string; origem: string; resposta: string }>(
      'select chave, grupo_jid, mensagem, origem, resposta from pool_entradas where pool_id = $1',
      [poolId],
    );
    const entrada = entradas.rows.find((e) => {
      const alvo = normalizar(e.mensagem);
      return alvo.length > 0 && texto.includes(alvo);
    });
    if (!entrada) return true; // estranhos não recebem resposta
    let convite: string;
    try {
      convite = await this.o.manager.groupInviteLink(m.instanceId, entrada.grupo_jid);
    } catch (err) {
      await this.registrar(p.id, p.project, 'entrada_sem_convite', { chave: entrada.chave, erro: String(err).slice(0, 200) }, m.instanceId);
      return true;
    }
    const resposta = entrada.resposta.includes('{{convite}}') ? entrada.resposta.replace('{{convite}}', convite) : `${entrada.resposta}\n${convite}`;
    await this.inserirJob(poolId, 'resposta', `${m.phone}@s.whatsapp.net`, resposta, null, `entrada:${entrada.chave}`);
    await this.o.db.query('insert into pool_membros_entrada (id, pool_id, chave, phone, origem, created_at) values ($1, $2, $3, $4, $5, $6)', [
      randomUUID(),
      poolId,
      entrada.chave,
      m.phone,
      entrada.origem,
      this.agora(),
    ]);
    await this.registrar(p.id, p.project, 'entrada', { chave: entrada.chave, origem: entrada.origem, grupoJid: entrada.grupo_jid }, m.instanceId);
    return true;
  }

  // ---------- ciclo ----------

  start(): void {
    if (this.timerJobs) return;
    this.timerJobs = setInterval(() => void this.ciclo(), 1000);
    this.timerHeartbeat = setInterval(() => {
      this.heartbeat().catch((err) => console.error('[pools] heartbeat', err));
    }, this.o.heartbeatMs ?? 60_000);
  }

  stop(): void {
    if (this.timerJobs) clearInterval(this.timerJobs);
    if (this.timerHeartbeat) clearInterval(this.timerHeartbeat);
    this.timerJobs = null;
    this.timerHeartbeat = null;
  }

  private async ciclo(): Promise<void> {
    if (this.rodando) return;
    this.rodando = true;
    try {
      await this.processar();
    } catch (err) {
      console.error('[pools] fila', err);
    } finally {
      this.rodando = false;
    }
  }
}

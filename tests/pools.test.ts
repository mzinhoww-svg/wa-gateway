import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { InstanceManager } from '../src/instances/manager.js';
import type { InboundMessage, SocketFactory, SocketOptions } from '../src/instances/types.js';
import { normalizar, PoolService, type PoolWebhookEvent, tetoAquecimento } from '../src/pools/service.js';
import { memDb } from './helpers/memdb.js';

const GRUPO = '120363000000000001@g.us';
const DONO = '5565999990001';

/** Sessões simuladas: cada instância tem telefone, admin nos grupos e caixa de saída. */
function simulador() {
  const sessoes = new Map<string, SocketOptions>();
  const telefones: Record<string, string> = { 'ach-1': '5565911110001', 'ach-2': '5565911110002', 'ach-3': '5565911110003', pessoal: DONO };
  const admins = new Set(['ach-1', 'ach-2', 'ach-3']);
  const enviados: { de: string; jid: string; texto: string; imagem?: string }[] = [];
  const factory: SocketFactory = async (o) => {
    sessoes.set(o.instanceId, o);
    return {
      sendText: async (jid, texto) => void enviados.push({ de: o.instanceId, jid, texto }),
      sendImage: async (jid, imagem, texto) => void enviados.push({ de: o.instanceId, jid, texto, imagem }),
      end: () => {},
      selfPhone: () => telefones[o.instanceId] ?? null,
      isGroupAdmin: async () => admins.has(o.instanceId),
      groupInviteLink: async () => 'https://chat.whatsapp.com/CONVITE123',
    };
  };
  return {
    factory,
    enviados,
    admins,
    abrir: (id: string) => sessoes.get(id)?.onOpen(),
    cair: (id: string, info: { loggedOut: boolean; fatal?: boolean; code?: number }) => sessoes.get(id)?.onClose(info),
    receber: (id: string, m: Partial<InboundMessage>) =>
      sessoes.get(id)?.onMessage({ instanceId: id, messageId: Math.random().toString(36), jid: '', phone: null, text: '', fromMe: false, isGroup: false, ...m }),
  };
}

async function montar() {
  const db = memDb();
  await migrate(db);
  const sim = simulador();
  const eventos: PoolWebhookEvent[] = [];
  let t = Date.parse('2026-11-20T12:00:00Z');
  // eslint-disable-next-line prefer-const
  let pools: PoolService;
  const recebidos: Promise<boolean>[] = [];
  const manager = new InstanceManager(db, sim.factory, (m) => void recebidos.push(pools.aoReceber(m)), { reconnectBaseMs: 60_000 });
  pools = new PoolService({ db, manager, emit: (e) => void eventos.push(e), now: () => t, random: () => 0.5 });
  manager.onEvent((e) => void pools.aoEventoConexao(e));
  await pools.salvarPool('achadinhos', 'achadinhos', [DONO]);
  for (const [i, id] of ['ach-1', 'ach-2', 'ach-3'].entries()) await pools.adicionarNumero('achadinhos', id, i);
  for (const id of ['ach-1', 'ach-2', 'ach-3']) sim.abrir(id);
  await pools.salvarGrupo('achadinhos', GRUPO, { nome: 'Teste' });
  await pools.heartbeat();
  const avancar = (ms: number) => {
    t += ms;
  };
  const esperarEventos = async () => {
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all(recebidos);
  };
  return { db, sim, eventos, pools, manager, avancar, esperarEventos };
}

describe('pools: papéis e failover', () => {
  it('3 números pareados: 1 ativo e 2 reservas, com heartbeat', async () => {
    const { pools } = await montar();
    const n = await pools.listarNumeros('achadinhos');
    expect(n.map((x) => [x.instanceId, x.papel, x.conexao])).toEqual([
      ['ach-1', 'ativo', 'open'],
      ['ach-2', 'reserva', 'open'],
      ['ach-3', 'reserva', 'open'],
    ]);
    expect(n.every((x) => x.ultimoHeartbeat)).toBe(true);
  });

  it('ban do ativo promove a reserva na hora, avisa o webhook e o próximo envio sai pelo número novo', async () => {
    const { pools, sim, eventos, esperarEventos } = await montar();
    sim.cair('ach-1', { loggedOut: false, fatal: true, code: 403 });
    await esperarEventos();
    expect(await pools.ativo('achadinhos')).toBe('ach-2');
    expect(eventos.map((e) => e.type)).toEqual(expect.arrayContaining(['pool.numero_banido', 'pool.failover']));
    const f = eventos.filter((e) => e.type === 'pool.failover').at(-1);
    expect(f).toMatchObject({ project: 'achadinhos', de: 'ach-1', para: 'ach-2' });
    await pools.enfileirarGrupo('achadinhos', GRUPO, 'Oferta', 'https://x.test/peca.jpg', 'oferta-1');
    expect(await pools.processar()).toBe(1);
    expect(sim.enviados.at(-1)).toMatchObject({ de: 'ach-2', jid: GRUPO, imagem: 'https://x.test/peca.jpg' });
  });

  it('queda sem logout troca o ativo depois de 2 heartbeats (cerca de 2 minutos)', async () => {
    const { pools, sim, avancar, esperarEventos } = await montar();
    sim.cair('ach-1', { loggedOut: false }); // vai tentar reconectar
    await esperarEventos();
    expect(await pools.ativo('achadinhos')).toBe('ach-1');
    avancar(60_000);
    await pools.heartbeat();
    expect(await pools.ativo('achadinhos')).toBe('ach-1');
    avancar(60_000);
    await pools.heartbeat();
    expect(await pools.ativo('achadinhos')).toBe('ach-2');
    const n = await pools.listarNumeros('achadinhos');
    expect(n[0]).toMatchObject({ papel: 'banido', motivo: expect.stringMatching(/heartbeats/) });
  });

  it('reserva que não é admin do grupo é pulada', async () => {
    const { pools, sim, esperarEventos } = await montar();
    sim.admins.delete('ach-2');
    sim.cair('ach-1', { loggedOut: true });
    await esperarEventos();
    expect(await pools.ativo('achadinhos')).toBe('ach-3');
  });

  it('sem reserva disponível avisa sem_numero', async () => {
    const { pools, sim, eventos, esperarEventos } = await montar();
    sim.admins.clear();
    sim.cair('ach-1', { loggedOut: true });
    await esperarEventos();
    expect(await pools.ativo('achadinhos')).toBeNull();
    expect(eventos.some((e) => e.type === 'pool.sem_numero')).toBe(true);
  });

  it('o número pessoal do dono é desconectado e bloqueado', async () => {
    const { pools, sim, eventos } = await montar();
    await pools.adicionarNumero('achadinhos', 'pessoal', 9);
    sim.abrir('pessoal');
    await pools.heartbeat();
    const p = (await pools.listarNumeros('achadinhos')).find((x) => x.instanceId === 'pessoal');
    expect(p).toMatchObject({ papel: 'bloqueado', conexao: 'closed' });
    expect(eventos.some((e) => e.type === 'pool.numero_pessoal_bloqueado')).toBe(true);
  });

  it('troca manual pelo painel', async () => {
    const { pools } = await montar();
    await pools.promover('achadinhos', 'ach-3');
    const n = await pools.listarNumeros('achadinhos');
    expect(n.map((x) => x.papel)).toEqual(['reserva', 'reserva', 'ativo']);
  });
});

describe('pools: fila com limite por grupo e aquecimento', () => {
  it('no máximo 1 mensagem a cada 3 min + espaçamento aleatório por grupo', async () => {
    const { pools, sim, avancar } = await montar();
    await pools.enfileirarGrupo('achadinhos', GRUPO, 'Oferta 1', null, null);
    await pools.enfileirarGrupo('achadinhos', GRUPO, 'Oferta 2', null, null);
    expect(await pools.processar()).toBe(1);
    avancar(60_000);
    expect(await pools.processar()).toBe(0);
    // random 0,5: 180 s + 55 s
    avancar(234_000 - 60_000);
    expect(await pools.processar()).toBe(0);
    avancar(2_000);
    expect(await pools.processar()).toBe(1);
    expect(sim.enviados.map((e) => e.texto)).toEqual(['Oferta 1', 'Oferta 2']);
  });

  it('limite configurável por API', async () => {
    const { pools, avancar } = await montar();
    await pools.salvarGrupo('achadinhos', GRUPO, { intervaloMinS: 30, espacoMinS: 0, espacoMaxS: 0 });
    await pools.enfileirarGrupo('achadinhos', GRUPO, 'A', null, null);
    await pools.enfileirarGrupo('achadinhos', GRUPO, 'B', null, null);
    expect(await pools.processar()).toBe(1);
    avancar(31_000);
    expect(await pools.processar()).toBe(1);
  });

  it('aquecimento: número novo para no teto do dia', async () => {
    const { pools, avancar } = await montar();
    await pools.salvarGrupo('achadinhos', GRUPO, { intervaloMinS: 30, espacoMinS: 0, espacoMaxS: 0 });
    for (let i = 0; i < 20; i++) await pools.enfileirarGrupo('achadinhos', GRUPO, `M${i}`, null, null);
    let total = 0;
    for (let i = 0; i < 20; i++) {
      total += await pools.processar();
      avancar(31_000);
    }
    expect(total).toBe(tetoAquecimento(0));
    expect((await pools.listarNumeros('achadinhos'))[0]?.aquecimento).toMatchObject({ tetoDiario: 15, enviadosHoje: 15 });
  });

  it('privado só para os admins do pool', async () => {
    const { pools, sim } = await montar();
    await expect(pools.enfileirarPrivado('achadinhos', 'oi', '5511988887777')).rejects.toThrow('NOT_A_POOL_ADMIN');
    await pools.enfileirarPrivado('achadinhos', 'Resumo do dia');
    await pools.processar();
    expect(sim.enviados.at(-1)).toMatchObject({ jid: `${DONO}@s.whatsapp.net`, texto: 'Resumo do dia' });
  });
});

describe('pools: mensagens recebidas', () => {
  it('PAUSAR e RETOMAR do dono viram comando no webhook', async () => {
    const { sim, eventos, esperarEventos } = await montar();
    sim.receber('ach-1', { phone: DONO, text: 'pausar' });
    sim.receber('ach-1', { phone: DONO, text: 'Retomar!' });
    await esperarEventos();
    const cmds = eventos.filter((e) => e.type === 'pool.comando').map((e) => e.comando);
    expect(cmds).toEqual(['PAUSAR', 'RETOMAR']);
  });

  it('entrada por wa.me devolve o convite do grupo e registra a origem', async () => {
    const { pools, sim, db, eventos, esperarEventos } = await montar();
    const { waLink } = await pools.salvarEntrada('achadinhos', {
      chave: 'casa-instagram',
      grupoJid: GRUPO,
      mensagem: 'Quero entrar no grupo de ofertas de casa',
      origem: 'instagram',
      resposta: 'Bem-vindo! Entre aqui: {{convite}}',
    });
    expect(waLink).toBe(`https://wa.me/5565911110001?text=${encodeURIComponent('Quero entrar no grupo de ofertas de casa')}`);
    sim.receber('ach-1', { phone: '5511977776666', text: 'Olá! Quero entrar no grupo de ofertas de casa' });
    sim.receber('ach-1', { phone: '5511955554444', text: 'qual o preço?' });
    await esperarEventos();
    await pools.processar();
    expect(sim.enviados).toHaveLength(1);
    expect(sim.enviados[0]).toMatchObject({ jid: '5511977776666@s.whatsapp.net', texto: 'Bem-vindo! Entre aqui: https://chat.whatsapp.com/CONVITE123' });
    const r = await db.query('select origem, phone from pool_membros_entrada');
    expect(r.rows).toEqual([{ origem: 'instagram', phone: '5511977776666' }]);
    expect(eventos.some((e) => e.type === 'pool.entrada' && e.origem === 'instagram')).toBe(true);
  });

  it('normaliza acentos e pontuação', () => {
    expect(normalizar('Pausá-r!')).toBe('PAUSA R');
  });
});

export const SCHEMA: string[] = [
  `create table if not exists instances (
     id text primary key,
     label text,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists auth_state (
     instance_id text not null,
     key text not null,
     value text not null,
     primary key (instance_id, key)
   )`,
  `create table if not exists optin_codes (
     code text primary key,
     instance_id text not null,
     project text not null,
     subject_id text not null,
     reply_text text not null,
     expires_at timestamptz not null,
     used_at timestamptz
   )`,
  `create table if not exists optins (
     instance_id text not null,
     phone text not null,
     project text not null,
     subject_id text not null,
     consented_at timestamptz not null default now(),
     revoked_at timestamptz,
     primary key (instance_id, phone)
   )`,
  `create table if not exists inbound_seen (
     instance_id text not null,
     message_id text not null,
     primary key (instance_id, message_id)
   )`,
  `create table if not exists send_jobs (
     id text primary key,
     instance_id text not null,
     phone text not null,
     text text not null,
     status text not null default 'queued',
     attempts integer not null default 0,
     kind text not null default 'notification',
     priority integer not null default 0,
     created_at timestamptz not null default now(),
     sent_at timestamptz
   )`,
  // ---- Pools (vários números por projeto, com failover). Só tabelas novas: nada acima muda. ----
  `create table if not exists pools (
     id text primary key,
     project text not null,
     admin_phones text not null default '',
     created_at timestamptz not null default now()
   )`,
  `create table if not exists pool_members (
     pool_id text not null,
     instance_id text not null,
     ordem integer not null default 0,
     papel text not null default 'reserva',
     aquecimento_desde timestamptz not null default now(),
     ultimo_heartbeat timestamptz,
     falhas integer not null default 0,
     motivo text,
     atualizado_em timestamptz not null default now(),
     primary key (pool_id, instance_id)
   )`,
  `create table if not exists pool_groups (
     pool_id text not null,
     jid text not null,
     nome text,
     intervalo_min_s integer not null default 180,
     espaco_min_s integer not null default 20,
     espaco_max_s integer not null default 90,
     proximo_envio timestamptz,
     primary key (pool_id, jid)
   )`,
  `create table if not exists pool_jobs (
     id text primary key,
     pool_id text not null,
     tipo text not null,
     jid text not null,
     texto text not null,
     imagem_url text,
     ref text,
     status text not null default 'queued',
     attempts integer not null default 0,
     instance_id text,
     erro text,
     created_at timestamptz not null default now(),
     sent_at timestamptz
   )`,
  `create table if not exists pool_entradas (
     pool_id text not null,
     chave text not null,
     grupo_jid text not null,
     mensagem text not null,
     origem text not null,
     resposta text not null,
     created_at timestamptz not null default now(),
     primary key (pool_id, chave)
   )`,
  `create table if not exists pool_membros_entrada (
     id text primary key,
     pool_id text not null,
     chave text not null,
     phone text not null,
     origem text not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists pool_eventos (
     id text primary key,
     pool_id text not null,
     tipo text not null,
     dados text not null default '{}',
     created_at timestamptz not null default now()
   )`,
];

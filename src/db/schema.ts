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
];

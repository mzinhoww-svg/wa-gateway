import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Todas as tabelas do gateway ficam num schema próprio (padrão `wa_gateway`).
 * Assim o banco pode ser compartilhado com outro projeto agora e separado depois
 * com `pg_dump -n wa_gateway` + trocar DATABASE_URL.
 * `schema` é validado em loadConfig (só [a-z0-9_]).
 */
export interface ClientCert {
  cert: string;
  key: string;
}

export function buildPgConfig(databaseUrl: string, caPem?: string, client?: ClientCert): pg.PoolConfig {
  if (!caPem) return { connectionString: databaseUrl };
  // O Postgres do Vertra usa uma CA privada e o certificado não leva o nome do host (equivale a sslmode=verify-ca).
  const url = databaseUrl.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return {
    connectionString: url,
    ssl: { ca: caPem, rejectUnauthorized: true, checkServerIdentity: () => undefined, ...(client ?? {}) },
  };
}

function loadCa(): string | undefined {
  if (process.env.DATABASE_CA_PEM) return process.env.DATABASE_CA_PEM;
  return existsSync('certs/vertra-ca.pem') ? readFileSync('certs/vertra-ca.pem', 'utf8') : undefined;
}

/** Variáveis de ambiente podem perder as quebras de linha do PEM; reconstrói o formato padrão. */
export function normalizePem(raw: string): string {
  const m = raw.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return raw;
  const body = m[2].replace(/\\n/g, '').replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${m[1]}-----\n${lines.join('\n')}\n-----END ${m[1]}-----\n`;
}

function loadClientCert(): ClientCert | undefined {
  const cert = process.env.DATABASE_CLIENT_CERT;
  const key = process.env.DATABASE_CLIENT_KEY;
  return cert && key ? { cert: normalizePem(cert), key: normalizePem(key) } : undefined;
}

export function createDb(databaseUrl: string, schema = 'wa_gateway'): Db {
  const pool = new pg.Pool({ ...buildPgConfig(databaseUrl, process.env.DATABASE_SSL === 'off' ? undefined : loadCa(), loadClientCert()), max: 5 });
  pool.on('connect', (client) => {
    // enfileirado antes de qualquer query do usuário nesse client
    client.query(`set search_path to "${schema}"`).catch((err) => console.error('[db] search_path', err));
  });
  const ready = pool.query(`create schema if not exists "${schema}"`);
  return {
    query: async (sql, params) => {
      await ready;
      return pool.query(sql, params as any[]) as any;
    },
  };
}

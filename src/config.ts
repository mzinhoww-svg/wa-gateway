import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/).default('wa_gateway'),
  API_KEY: z.string().min(1),
  /** Chaves extras, separadas por vírgula (uma por projeto). Cada uma tem o mesmo acesso da API_KEY. */
  EXTRA_API_KEYS: z.string().optional(),
  WEBHOOK_SECRET: z.string().min(1),
  SEND_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(4000),
  SEND_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(9000),
  SEND_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
  POOL_HEARTBEAT_MS: z.coerce.number().int().min(5000).default(60_000),
  POOL_FALHAS_MAX: z.coerce.number().int().min(1).max(10).default(2),
  POOL_AQUECIMENTO: z.enum(['on', 'off']).default('on'),
});

export interface Config {
  port: number;
  databaseUrl: string;
  dbSchema: string;
  apiKey: string;
  apiKeys?: string[];
  webhookSecret: string;
  sendMinDelayMs: number;
  sendMaxDelayMs: number;
  sendMaxPerHour: number;
  poolHeartbeatMs: number;
  poolFalhasMax: number;
  poolAquecimento: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const e = schema.parse(env);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dbSchema: e.DB_SCHEMA,
    apiKey: e.API_KEY,
    apiKeys: [e.API_KEY, ...(e.EXTRA_API_KEYS ?? '').split(',').map((k) => k.trim()).filter((k) => k.length >= 24)],
    webhookSecret: e.WEBHOOK_SECRET,
    sendMinDelayMs: e.SEND_MIN_DELAY_MS,
    sendMaxDelayMs: Math.max(e.SEND_MIN_DELAY_MS, e.SEND_MAX_DELAY_MS),
    sendMaxPerHour: e.SEND_MAX_PER_HOUR,
    poolHeartbeatMs: e.POOL_HEARTBEAT_MS,
    poolFalhasMax: e.POOL_FALHAS_MAX,
    poolAquecimento: e.POOL_AQUECIMENTO === 'on',
  };
}

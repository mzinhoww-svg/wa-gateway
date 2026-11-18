import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  DB_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/).default('wa_gateway'),
  API_KEY: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  SEND_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(4000),
  SEND_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(9000),
  SEND_MAX_PER_HOUR: z.coerce.number().int().positive().default(60),
});

export interface Config {
  port: number;
  databaseUrl: string;
  dbSchema: string;
  apiKey: string;
  webhookSecret: string;
  sendMinDelayMs: number;
  sendMaxDelayMs: number;
  sendMaxPerHour: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const e = schema.parse(env);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    dbSchema: e.DB_SCHEMA,
    apiKey: e.API_KEY,
    webhookSecret: e.WEBHOOK_SECRET,
    sendMinDelayMs: e.SEND_MIN_DELAY_MS,
    sendMaxDelayMs: Math.max(e.SEND_MIN_DELAY_MS, e.SEND_MAX_DELAY_MS),
    sendMaxPerHour: e.SEND_MAX_PER_HOUR,
  };
}

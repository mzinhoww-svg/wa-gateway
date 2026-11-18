import { newDb, DataType } from 'pg-mem';
import type { Db } from '../../src/db/client.js';

export function memDb(): Db {
  const mem = newDb({ noAstCoverageCheck: true });
  mem.public.registerFunction({ name: 'now', returns: DataType.timestamptz, implementation: () => new Date(), impure: true });
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  return { query: (sql, params) => pool.query(sql, params as any[]) as any };
}

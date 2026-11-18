import type { Db } from './client.js';
import { SCHEMA } from './schema.js';

export async function migrate(db: Db): Promise<void> {
  for (const stmt of SCHEMA) await db.query(stmt);
}

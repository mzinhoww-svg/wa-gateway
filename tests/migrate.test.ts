import { describe, it, expect } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { memDb } from './helpers/memdb.js';

describe('migrate', () => {
  it('cria as seis tabelas e pode rodar duas vezes', async () => {
    const db = memDb();
    await migrate(db);
    await migrate(db);
    for (const t of ['instances', 'auth_state', 'optin_codes', 'optins', 'inbound_seen', 'send_jobs']) {
      await expect(db.query(`select 1 from ${t} limit 1`)).resolves.toBeTruthy();
    }
  });
});

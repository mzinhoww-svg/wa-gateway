import { describe, it, expect } from 'vitest';
import { memDb } from './helpers/memdb.js';
import { migrate } from '../src/db/migrate.js';
import { usePgAuthState } from '../src/auth/pgAuthState.js';

async function setup() {
  const db = memDb();
  await migrate(db);
  return db;
}

describe('usePgAuthState', () => {
  it('persiste credenciais e chaves com Buffer idêntico', async () => {
    const db = await setup();
    const a = await usePgAuthState(db, 'revela');
    const buf = Buffer.from([1, 2, 3, 250]);
    await a.state.keys.set({ 'pre-key': { '1': { public: buf, private: buf } as any } });
    await a.saveCreds();
    const b = await usePgAuthState(db, 'revela');
    const got = await b.state.keys.get('pre-key', ['1']);
    expect(Buffer.from((got['1'] as any).public)).toEqual(buf);
    expect(b.state.creds.registrationId).toBe(a.state.creds.registrationId);
  });

  it('clear apaga só a instância pedida', async () => {
    const db = await setup();
    const a = await usePgAuthState(db, 'a');
    const b = await usePgAuthState(db, 'b');
    await a.saveCreds();
    await b.saveCreds();
    await a.clear();
    const r = await db.query<{ instance_id: string }>('select distinct instance_id from auth_state');
    expect(r.rows.map((x) => x.instance_id)).toEqual(['b']);
  });
});

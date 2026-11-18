import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';
import type { Db } from '../db/client.js';

export interface PgAuth {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clear: () => Promise<void>;
}

const enc = (v: unknown) => JSON.stringify(v, BufferJSON.replacer);
const dec = (s: string) => JSON.parse(s, BufferJSON.reviver);

export async function usePgAuthState(db: Db, instanceId: string): Promise<PgAuth> {
  const read = async (key: string) => {
    const r = await db.query<{ value: string }>(
      'select value from auth_state where instance_id = $1 and key = $2',
      [instanceId, key],
    );
    return r.rows[0] ? dec(r.rows[0].value) : null;
  };
  const write = (key: string, value: unknown) =>
    db.query(
      `insert into auth_state (instance_id, key, value) values ($1, $2, $3)
       on conflict (instance_id, key) do update set value = excluded.value`,
      [instanceId, key, enc(value)],
    );
  const remove = (key: string) =>
    db.query('delete from auth_state where instance_id = $1 and key = $2', [instanceId, key]);

  const creds = (await read('creds')) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          for (const id of ids) {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            if (v) out[id] = v;
          }
          return out;
        },
        set: async (data) => {
          for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const entries = data[type] ?? {};
            for (const id of Object.keys(entries)) {
              const v = (entries as any)[id];
              if (v) await write(`${type}-${id}`, v);
              else await remove(`${type}-${id}`);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await write('creds', creds);
    },
    clear: async () => {
      await db.query('delete from auth_state where instance_id = $1', [instanceId]);
    },
  };
}

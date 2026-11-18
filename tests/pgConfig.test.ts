import { describe, it, expect } from 'vitest';
import { buildPgConfig } from '../src/db/client.js';

describe('buildPgConfig', () => {
  it('sem CA devolve a URL como está', () => {
    expect(buildPgConfig('postgres://u:p@h:1/d')).toEqual({ connectionString: 'postgres://u:p@h:1/d' });
  });
  it('com CA remove sslmode da URL e usa o CA sem checar o nome do host', () => {
    const c = buildPgConfig('postgresql://u:p@h:1/d?sslmode=verify-ca&x=1', 'PEM') as any;
    expect(c.connectionString).toBe('postgresql://u:p@h:1/d?x=1');
    expect(c.ssl.ca).toBe('PEM');
    expect(c.ssl.rejectUnauthorized).toBe(true);
    expect(c.ssl.checkServerIdentity()).toBeUndefined();
  });
});

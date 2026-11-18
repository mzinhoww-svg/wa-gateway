import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { API_KEY: 'k', DATABASE_URL: 'postgres://x', WEBHOOK_SECRET: 's' };

describe('loadConfig', () => {
  it('usa 3000 como porta padrão', () => {
    expect(loadConfig(base).port).toBe(3000);
  });
  it('lança erro sem API_KEY', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', WEBHOOK_SECRET: 's' })).toThrow();
  });
  it('tem os padrões de envio 4000/9000/60', () => {
    const c = loadConfig(base);
    expect([c.sendMinDelayMs, c.sendMaxDelayMs, c.sendMaxPerHour]).toEqual([4000, 9000, 60]);
  });
  it('DB_SCHEMA tem padrão wa_gateway e só aceita nome seguro', () => {
    expect(loadConfig(base).dbSchema).toBe('wa_gateway');
    expect(loadConfig({ ...base, DB_SCHEMA: 'meu_gw' }).dbSchema).toBe('meu_gw');
    expect(() => loadConfig({ ...base, DB_SCHEMA: 'x"; drop table y;--' })).toThrow();
  });
});

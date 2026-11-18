import { describe, it, expect } from 'vitest';
import { toInbound, digitsOf } from '../src/instances/baileysFactory.js';

const base = (jid: string, extra: any = {}) => ({
  key: { remoteJid: jid, id: 'M1', fromMe: false, ...extra },
  message: { conversation: 'oi' },
});

describe('toInbound', () => {
  it('extrai o telefone de @s.whatsapp.net', () => {
    expect(toInbound('r', base('5565999990000@s.whatsapp.net') as any)?.phone).toBe('5565999990000');
  });
  it('@lid usa remoteJidAlt quando existe, senão phone null', () => {
    expect(toInbound('r', base('123@lid', { remoteJidAlt: '5565988887777@s.whatsapp.net' }) as any)?.phone).toBe('5565988887777');
    expect(toInbound('r', base('123@lid') as any)?.phone).toBeNull();
  });
  it('marca grupos e status', () => {
    expect(toInbound('r', base('1-2@g.us') as any)?.isGroup).toBe(true);
    expect(toInbound('r', base('status@broadcast') as any)?.isGroup).toBe(true);
  });
  it('digitsOf ignora sufixo de dispositivo', () => {
    expect(digitsOf('5565999990000:12@s.whatsapp.net')).toBe('5565999990000');
  });

  it('lê texto de mensagens temporárias (ephemeral)', () => {
    const m = { key: { remoteJid: '5565999990000@s.whatsapp.net', id: 'E1' }, message: { ephemeralMessage: { message: { conversation: 'REV-7K4Q' } } } };
    expect(toInbound('r', m as any)?.text).toBe('REV-7K4Q');
  });
  it('ignora reação e mensagens sem texto', () => {
    const m = { key: { remoteJid: '5565999990000@s.whatsapp.net', id: 'R1' }, message: { reactionMessage: { text: '👍' } } };
    expect(toInbound('r', m as any)).toBeNull();
  });
});

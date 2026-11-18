import { makeWASocket, DisconnectReason, Browsers, fetchLatestBaileysVersion, normalizeMessageContent } from '@whiskeysockets/baileys';
import type { proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import type { InboundMessage, SocketFactory } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

export function digitsOf(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const [user] = jid.split('@');
  const d = user.split(':')[0].replace(/\D/g, '');
  return d || null;
}

export function toInbound(instanceId: string, m: proto.IWebMessageInfo): InboundMessage | null {
  const key = m.key;
  if (!key?.remoteJid || !key.id || !m.message) return null;
  const jid = key.remoteJid;
  const c = normalizeMessageContent(m.message);
  const text = c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ?? '';
  if (!text) return null;
  const isGroup = jid.endsWith('@g.us') || jid === 'status@broadcast';
  let phone: string | null = null;
  if (jid.endsWith('@s.whatsapp.net')) phone = digitsOf(jid);
  else if (jid.endsWith('@lid')) {
    const alt = (key as { remoteJidAlt?: string }).remoteJidAlt;
    phone = alt?.endsWith('@s.whatsapp.net') ? digitsOf(alt) : null;
  }
  return { instanceId, messageId: key.id, jid, phone, text, fromMe: !!key.fromMe, isGroup };
}

export const baileysFactory: SocketFactory = async (o) => {
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined as any }));
  const sock = makeWASocket({
    version,
    auth: o.auth,
    logger,
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock.ev.on('creds.update', () => {
    o.saveCreds().catch((err) => console.error('[baileys] falha ao salvar credenciais', err));
  });
  sock.ev.on('connection.update', (u) => {
    if (u.qr) {
      console.log(`[qr] ${o.instanceId} ${u.qr}`);
      o.onQr(u.qr);
    }
    if (u.connection === 'open') o.onOpen();
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
      const fatal = code === DisconnectReason.connectionReplaced || code === DisconnectReason.forbidden || code === DisconnectReason.badSession;
      o.onClose({ loggedOut: code === DisconnectReason.loggedOut, fatal, code });
    }
  });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      const inbound = toInbound(o.instanceId, m);
      if (inbound) o.onMessage(inbound);
    }
  });
  return {
    sendText: async (jid, text) => void (await sock.sendMessage(jid, { text })),
    end: () => sock.end(undefined),
    selfPhone: () => digitsOf(sock.user?.id),
    sendImage: async (jid, imageUrl, caption) => void (await sock.sendMessage(jid, { image: { url: imageUrl }, caption })),
    isGroupAdmin: async (groupJid) => {
      const meta = await sock.groupMetadata(groupJid);
      const eu = new Set([digitsOf(sock.user?.id), digitsOf((sock.user as { lid?: string } | undefined)?.lid)].filter(Boolean));
      return meta.participants.some((p) => {
        const ids = [p.id, (p as { phoneNumber?: string }).phoneNumber, (p as { lid?: string }).lid].map(digitsOf);
        return Boolean(p.admin) && ids.some((d) => d && eu.has(d));
      });
    },
    groupInviteLink: async (groupJid) => `https://chat.whatsapp.com/${await sock.groupInviteCode(groupJid)}`,
  };
};

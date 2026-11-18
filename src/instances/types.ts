import type { AuthenticationState } from '@whiskeysockets/baileys';

export type InstanceStatus = 'connecting' | 'qr' | 'open' | 'closed';

export interface InboundMessage {
  instanceId: string;
  messageId: string;
  jid: string;
  phone: string | null;
  text: string;
  fromMe: boolean;
  isGroup: boolean;
}

export interface WaSocket {
  sendText(jid: string, text: string): Promise<void>;
  end(): void;
  /** número da própria instância (só dígitos), quando conectada */
  selfPhone(): string | null;
}

export interface SocketOptions {
  instanceId: string;
  auth: AuthenticationState;
  saveCreds: () => Promise<void>;
  onQr(qr: string): void;
  onOpen(): void;
  onClose(info: { loggedOut: boolean; fatal?: boolean }): void;
  onMessage(m: InboundMessage): void;
}

export type SocketFactory = (opts: SocketOptions) => Promise<WaSocket>;

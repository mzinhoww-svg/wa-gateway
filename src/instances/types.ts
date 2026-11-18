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
  /** Imagem (URL https) com legenda. Usado pelos pools (envio em grupo). */
  sendImage?(jid: string, imageUrl: string, caption: string): Promise<void>;
  /** Este número é admin do grupo? */
  isGroupAdmin?(groupJid: string): Promise<boolean>;
  /** Link de convite do grupo (o número precisa ser admin). */
  groupInviteLink?(groupJid: string): Promise<string>;
}

export interface SocketOptions {
  instanceId: string;
  auth: AuthenticationState;
  saveCreds: () => Promise<void>;
  onQr(qr: string): void;
  onOpen(): void;
  onClose(info: { loggedOut: boolean; fatal?: boolean; code?: number }): void;
  onMessage(m: InboundMessage): void;
}

export type SocketFactory = (opts: SocketOptions) => Promise<WaSocket>;

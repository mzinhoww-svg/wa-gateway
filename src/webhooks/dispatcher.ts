import { createHmac } from 'node:crypto';
import type { WebhookEvent } from '../optin/service.js';

export function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function envUrlFor(env: NodeJS.ProcessEnv): (e: WebhookEvent) => string | null {
  const key = (s: string) => env[`WEBHOOK_URL_${s.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  return (e) => (e.project && key(e.project)) || key(e.instanceId) || env.WEBHOOK_URL || null;
}

export interface DispatcherOptions {
  secret: string;
  urlFor(e: WebhookEvent): string | null;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const ATTEMPTS = 3;

export class WebhookDispatcher {
  private f: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private o: DispatcherOptions) {
    this.f = o.fetch ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async dispatch(e: WebhookEvent): Promise<void> {
    const url = this.o.urlFor(e);
    if (!url) return;
    const body = JSON.stringify(e);
    const headers = { 'content-type': 'application/json', 'x-wa-signature': sign(body, this.o.secret) };
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        const res = await this.f(url, { method: 'POST', headers, body });
        if (res.ok) return;
        console.warn(`[webhook] ${e.type} -> ${url} respondeu ${res.status} (tentativa ${i + 1})`);
      } catch (err) {
        console.warn(`[webhook] ${e.type} -> ${url} falhou (tentativa ${i + 1})`, err);
      }
      if (i < ATTEMPTS - 1) await this.sleep(1000 * 2 ** i);
    }
    console.error(`[webhook] ${e.type} desistiu após ${ATTEMPTS} tentativas`);
  }
}

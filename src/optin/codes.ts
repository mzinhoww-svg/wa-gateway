import { randomInt } from 'node:crypto';
import type { Db } from '../db/client.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface CreateCodeInput {
  instanceId: string;
  project: string;
  subjectId: string;
  prefix: string;
  replyText: string;
  ttlMinutes?: number;
}

function randomSuffix(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export async function createCode(db: Db, input: CreateCodeInput): Promise<{ code: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + (input.ttlMinutes ?? 15) * 60_000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = `${input.prefix.toUpperCase()}-${randomSuffix()}`;
    const r = await db.query(
      `insert into optin_codes (code, instance_id, project, subject_id, reply_text, expires_at)
       values ($1, $2, $3, $4, $5, $6) on conflict (code) do nothing returning code`,
      [code, input.instanceId, input.project, input.subjectId, input.replyText, expiresAt.toISOString()],
    );
    if (r.rows.length) return { code, expiresAt };
  }
  throw new Error('CODE_GENERATION_FAILED');
}

export function extractCodes(text: string): string[] {
  const tokens = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ');
  const out: string[] = [];
  for (let i = 0; i + 1 < tokens.length && out.length < 8; i++) {
    if (/^[A-Z]{2,6}$/.test(tokens[i]) && /^[A-Z0-9]{4}$/.test(tokens[i + 1])) {
      const c = `${tokens[i]}-${tokens[i + 1]}`;
      if (!out.includes(c)) out.push(c);
    }
  }
  return out;
}

export function extractCode(text: string): string | null {
  return extractCodes(text)[0] ?? null;
}

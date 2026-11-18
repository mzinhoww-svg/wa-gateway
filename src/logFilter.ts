const SESSION_NOISE = /^(Closing (open )?session|Removing old closed session|Opening session|Migrating session|Session already (closed|open)|Decrypted message with closed session)/i;

/**
 * O libsignal (dentro do Baileys) imprime SessionEntry via console.info/warn,
 * o que despeja chaves privadas nos logs. Descartamos só essas mensagens.
 */
export function installLogFilter(c: Console = console): void {
  for (const method of ['info', 'warn'] as const) {
    const original = c[method].bind(c);
    c[method] = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && SESSION_NOISE.test(args[0])) return;
      original(...args);
    };
  }
}

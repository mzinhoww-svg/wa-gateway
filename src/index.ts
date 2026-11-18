import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { InstanceManager } from './instances/manager.js';
import { baileysFactory } from './instances/baileysFactory.js';
import { OptInService } from './optin/service.js';
import { SendQueue } from './queue/sendQueue.js';
import { WebhookDispatcher, envUrlFor } from './webhooks/dispatcher.js';
import { buildServer } from './api/server.js';
import { installLogFilter } from './logFilter.js';

installLogFilter();

async function main() {
  const config = loadConfig(process.env);
  const db = createDb(config.databaseUrl, config.dbSchema);
  await migrate(db);

  const dispatcher = new WebhookDispatcher({ secret: config.webhookSecret, urlFor: envUrlFor(process.env) });
  // eslint-disable-next-line prefer-const
  let manager: InstanceManager;
  // eslint-disable-next-line prefer-const
  let queue: SendQueue;
  const optin = new OptInService(
    db,
    async (i, p, t) => void (await queue.enqueueReply(i, p, t)),
    (e) => void dispatcher.dispatch(e),
  );
  manager = new InstanceManager(db, baileysFactory, (m) => {
    optin.handleInbound(m).catch((err) => console.error('[inbound]', err));
  });
  queue = new SendQueue({
    db,
    isActive: (i, p) => optin.isActive(i, p),
    send: (i, p, t) => manager.send(i, p, t),
    minDelayMs: config.sendMinDelayMs,
    maxDelayMs: config.sendMaxDelayMs,
    maxPerHour: config.sendMaxPerHour,
  });

  const app = buildServer({ config, db, manager, queue });
  await manager.startAll();
  queue.start();
  await app.listen({ host: '0.0.0.0', port: config.port });
  console.log(`[wa-gateway] ouvindo na porta ${config.port}`);

  const stop = () => {
    queue.stop();
    void app.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('[wa-gateway] falha ao iniciar', err);
  process.exit(1);
});

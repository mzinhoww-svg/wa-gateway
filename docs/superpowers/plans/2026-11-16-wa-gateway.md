# wa-gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gateway de WhatsApp (Baileys) com várias instâncias, fila de envio, webhooks assinados e opt-in por código via `wa.me`, rodando no Vertra, com o Revela como primeiro cliente.

**Architecture:** Um serviço Fastify. `InstanceManager` mantém um socket Baileys por instância, com a sessão em Postgres. Mensagens recebidas passam pelo `OptInService` (códigos, opt-in, SAIR) e viram eventos entregues pelo `WebhookDispatcher`. Envios passam pela `SendQueue`, que espaça as mensagens e exige opt-in ativo.

**Tech Stack:** TypeScript, Node 22, `@whiskeysockets/baileys`, Fastify, `pg`, `zod`, `pino`, Vitest, `pg-mem` (testes de dados).

**Spec:** `docs/superpowers/specs/2026-11-16-wa-gateway-design.md`

## Global Constraints

- Node 22 (Vertra: 22.23.5), TypeScript estrito, ESM.
- Dependência de WhatsApp: somente `@whiskeysockets/baileys` (MIT). Sem API oficial da Meta.
- Toda rota `/v1/*` exige o header `x-api-key` igual a `API_KEY`; `GET /health` é pública.
- Webhooks: corpo JSON, header `x-wa-signature: sha256=<hex HMAC-SHA256 do corpo com WEBHOOK_SECRET>`.
- Código de opt-in: formato `PREFIXO-XXXX` (4 caracteres de `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), uso único, expira em 15 min por padrão.
- Palavras de opt-out (sem diferenciar maiúsculas): `SAIR`, `PARAR`.
- Envio só para números com opt-in ativo.
- Dados de dependência de outros projetos ficam fora: sem CRM, grupos, mídia ou chatbot.

## Review Focus

- Código reutilizado, expirado ou digitado em minúsculas, com espaços ou dentro de uma frase ("oi, meu código é rev-7k4q"): só o primeiro uso válido confirma; minúsculas e espaços são aceitos.
- Mensagem de grupo (`@g.us`) ou de status: ignorada, sem resposta e sem webhook.
- Remetente com JID `@lid` sem número resolvível: não grava opt-in, registra aviso e nenhum envio acontece.
- Mesma mensagem entregue duas vezes pelo Baileys: o opt-in não duplica e a resposta não é enviada duas vezes.
- Pedido de SAIR: revoga o opt-in, confirma uma vez e todo envio seguinte a esse número é recusado.

---

### Task 1: Scaffold, configuração e banco

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `src/config.ts`, `src/db/client.ts`, `src/db/migrate.ts`, `src/db/schema.sql`
- Test: `tests/config.test.ts`, `tests/migrate.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` com `{ port: number; databaseUrl: string; apiKey: string; webhookSecret: string; sendMinDelayMs: number; sendMaxDelayMs: number; sendMaxPerHour: number }`.
- Produces: `interface Db { query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }`, `createDb(databaseUrl: string): Db`, `migrate(db: Db): Promise<void>`.
- Tabelas: `instances(id text pk, label text, created_at)`, `auth_state(instance_id text, key text, value jsonb, pk(instance_id,key))`, `optin_codes(code text pk, instance_id, project, subject_id, reply_text, expires_at, used_at)`, `optins(instance_id, phone, project, subject_id, consented_at, revoked_at, pk(instance_id,phone))`, `inbound_seen(instance_id, message_id, pk(instance_id,message_id))`, `send_jobs(id uuid pk, instance_id, phone, text, status, attempts int, created_at, sent_at)`.

- [ ] **Step 1: Escrever o teste de `loadConfig`**: com `PORT` ausente devolve 3000; com `API_KEY` ausente lança erro; `SEND_MIN_DELAY_MS=4000`, `SEND_MAX_DELAY_MS=9000`, `SEND_MAX_PER_HOUR=60` são os padrões.
- [ ] **Step 2:** `npx vitest run tests/config.test.ts` e confirmar que falha.
- [ ] **Step 3: Implementar `loadConfig`** em `src/config.ts` com `zod`.
- [ ] **Step 4:** rodar o teste e confirmar que passa.
- [ ] **Step 5: Escrever o teste de `migrate`** com `pg-mem`: depois de `migrate(db)` as seis tabelas existem e rodar `migrate` duas vezes não falha.
- [ ] **Step 6: Implementar `schema.sql` e `migrate`** (todas as instruções com `IF NOT EXISTS`); `createDb` usa `pg.Pool`.
- [ ] **Step 7:** `npx vitest run` passa. Commit: `chore: scaffold, config e schema`.

### Task 2: Estado de autenticação do Baileys em Postgres

**Files:**
- Create: `src/auth/pgAuthState.ts`
- Test: `tests/pgAuthState.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 1).
- Produces: `usePgAuthState(db: Db, instanceId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; clear: () => Promise<void> }>`, compatível com o argumento `auth` de `makeWASocket`.

- [ ] **Step 1: Escrever o teste:** gravar credenciais e chaves (`keys.set({ 'pre-key': { '1': {...} } })`), recriar o estado com o mesmo `instanceId` e ler de volta valores com `Buffer` idênticos (usar `BufferJSON`); `clear()` apaga tudo da instância e só dela.
- [ ] **Step 2:** rodar e confirmar que falha.
- [ ] **Step 3: Implementar** serializando com `BufferJSON.replacer/reviver` em `auth_state(instance_id, key, value)`; credenciais na chave `creds`; chaves como `${type}-${id}`.
- [ ] **Step 4:** rodar e confirmar que passa. Commit: `feat: sessão do Baileys em Postgres`.

### Task 3: Gerenciador de instâncias

**Files:**
- Create: `src/instances/manager.ts`, `src/instances/types.ts`
- Test: `tests/manager.test.ts` (com um `SocketFactory` falso)

**Interfaces:**
- Consumes: `Db`, `usePgAuthState`.
- Produces (`types.ts`): `type InstanceStatus = 'connecting' | 'qr' | 'open' | 'closed'`; `interface InboundMessage { instanceId: string; messageId: string; jid: string; phone: string | null; text: string; fromMe: boolean; isGroup: boolean }`; `interface WaSocket { sendText(jid: string, text: string): Promise<void>; end(): void }`; `type SocketFactory = (opts: { instanceId: string; auth: AuthenticationState; onQr(qr: string): void; onOpen(): void; onClose(info: { loggedOut: boolean }): void; onMessage(m: InboundMessage): void }) => Promise<WaSocket>`.
- Produces (`manager.ts`): `class InstanceManager { constructor(db: Db, factory: SocketFactory, onInbound: (m: InboundMessage) => void); create(id: string, label?: string): Promise<void>; startAll(): Promise<void>; status(id: string): { status: InstanceStatus; qr: string | null }; send(id: string, phone: string, text: string): Promise<void>; remove(id: string): Promise<void>; list(): Promise<{ id: string; label: string | null; status: InstanceStatus }[]> }`.
- A fábrica real (`baileysFactory` em `src/instances/baileysFactory.ts`) usa `makeWASocket`, converte `remoteJid` terminado em `@s.whatsapp.net` em `phone` (somente dígitos) e, para `@lid`, usa `key.remoteJidAlt` quando existir, senão `phone = null`.

- [ ] **Step 1: Escrever os testes** com fábrica falsa: `create` grava a instância e abre o socket; `onQr` muda o status para `qr` e `status().qr` devolve o texto; `onOpen` muda para `open` e zera o QR; `onClose({loggedOut:false})` reconecta depois de um atraso, `onClose({loggedOut:true})` limpa a sessão e fica em `closed`; `send` para instância fora de `open` lança `INSTANCE_NOT_OPEN`.
- [ ] **Step 2:** rodar e confirmar que falha.
- [ ] **Step 3: Implementar `InstanceManager`**; reconexão com espera crescente (1 s até 30 s).
- [ ] **Step 4:** rodar e confirmar que passa.
- [ ] **Step 5: Implementar `baileysFactory`** (sem teste automático; coberto na Task 8).
- [ ] **Step 6:** Commit: `feat: instâncias e socket do Baileys`.

### Task 4: Opt-in por código e opt-out

**Files:**
- Create: `src/optin/service.ts`, `src/optin/codes.ts`
- Test: `tests/optin.test.ts`

**Interfaces:**
- Consumes: `Db`, `InboundMessage`.
- Produces: `createCode(db: Db, input: { instanceId: string; project: string; subjectId: string; prefix: string; replyText: string; ttlMinutes?: number }): Promise<{ code: string; expiresAt: Date }>`; `extractCode(text: string): string | null`.
- Produces: `class OptInService { constructor(db: Db, send: (instanceId: string, phone: string, text: string) => Promise<void>, emit: (event: WebhookEvent) => void); handleInbound(m: InboundMessage): Promise<void>; isActive(instanceId: string, phone: string): Promise<boolean> }`.
- `type WebhookEvent = { type: 'message.received' | 'optin.confirmed' | 'optin.revoked'; instanceId: string; project?: string; subjectId?: string; phone?: string; code?: string; text?: string; at: string }`.

- [ ] **Step 1: Escrever os testes:** `extractCode('oi, meu código é rev-7k4q ')` devolve `'REV-7K4Q'`; código válido grava `optins`, marca `used_at`, envia `replyText` ao telefone e emite `optin.confirmed` com `subjectId`; segundo uso do mesmo código não confirma nem responde; código expirado não confirma; mensagem com `isGroup` ou `fromMe` é ignorada; `phone === null` não grava opt-in; a mesma `messageId` duas vezes processa uma só vez (`inbound_seen`); `SAIR` revoga, envia uma confirmação e emite `optin.revoked`, e `isActive` passa a devolver `false`; `SAIR` de quem não tem opt-in não envia nada.
- [ ] **Step 2:** rodar e confirmar que falha.
- [ ] **Step 3: Implementar `createCode`** (alfabeto sem caracteres ambíguos, gerado com `crypto.randomInt`) e **`extractCode`** (regex `/\b([A-Z]{2,6}-[A-Z0-9]{4})\b/` depois de passar o texto para maiúsculas).
- [ ] **Step 4: Implementar `OptInService.handleInbound`** na ordem: ignorar grupo e `fromMe`; deduplicar por `messageId`; tratar `SAIR`/`PARAR`; tratar código; qualquer outra mensagem só emite `message.received`.
- [ ] **Step 5:** rodar e confirmar que passa. Commit: `feat: opt-in por código e opt-out`.

### Task 5: Fila de envio

**Files:**
- Create: `src/queue/sendQueue.ts`
- Test: `tests/sendQueue.test.ts` (relógio e sorteio injetados)

**Interfaces:**
- Consumes: `Db`, `OptInService.isActive`, `InstanceManager.send`.
- Produces: `class SendQueue { constructor(deps: { db: Db; isActive(i: string, p: string): Promise<boolean>; send(i: string, p: string, t: string): Promise<void>; minDelayMs: number; maxDelayMs: number; maxPerHour: number; now?: () => number; random?: () => number }); enqueue(instanceId: string, phone: string, text: string): Promise<{ id: string }>; start(): void; stop(): void; stats(instanceId: string): Promise<{ queued: number; sentLastHour: number }> }`.
- Erros: `enqueue` lança `NO_OPT_IN` quando `isActive` é falso.

- [ ] **Step 1: Escrever os testes:** `enqueue` sem opt-in lança `NO_OPT_IN`; com opt-in grava `send_jobs` em `queued`; o processador espera entre `minDelayMs` e `maxDelayMs` entre dois envios da mesma instância; ao atingir `maxPerHour` envios na última hora, o próximo espera; um opt-out entre o `enqueue` e o envio faz o job virar `cancelled` sem enviar; falha de envio incrementa `attempts` e desiste após 3 tentativas (`failed`).
- [ ] **Step 2:** rodar e confirmar que falha.
- [ ] **Step 3: Implementar** um laço por instância, relido do banco a cada ciclo (assim sobrevive a reinício).
- [ ] **Step 4:** rodar e confirmar que passa. Commit: `feat: fila de envio com intervalo e teto por hora`.

### Task 6: Webhooks assinados

**Files:**
- Create: `src/webhooks/dispatcher.ts`
- Test: `tests/dispatcher.test.ts`

**Interfaces:**
- Consumes: `WebhookEvent` (Task 4).
- Produces: `sign(body: string, secret: string): string` (devolve `sha256=<hex>`); `class WebhookDispatcher { constructor(opts: { secret: string; fetch?: typeof fetch; urlFor(e: WebhookEvent): string | null }); dispatch(e: WebhookEvent): Promise<void> }`.
- `urlFor` lê `WEBHOOK_URL_<PROJETO>` do ambiente (ex.: `WEBHOOK_URL_REVELA`), com `WEBHOOK_URL` como padrão.

- [ ] **Step 1: Escrever os testes:** `sign('{"a":1}', 'segredo')` bate com o HMAC calculado no teste; `dispatch` faz `POST` com `content-type: application/json` e o header `x-wa-signature`; falha 500 tenta de novo até 3 vezes com espera crescente e depois só registra erro, sem lançar; sem URL configurada não faz requisição.
- [ ] **Step 2:** rodar e confirmar que falha.
- [ ] **Step 3: Implementar** com `crypto.createHmac`.
- [ ] **Step 4:** rodar e confirmar que passa. Commit: `feat: webhooks assinados`.

### Task 7: API REST e ligação dos módulos

**Files:**
- Create: `src/api/server.ts`, `src/index.ts`
- Test: `tests/api.test.ts` (Fastify `inject`, dependências falsas)

**Interfaces:**
- Consumes: todos os módulos anteriores.
- Produces: `buildServer(deps: { config: Config; manager: InstanceManager; optin: OptInService; queue: SendQueue; db: Db }): FastifyInstance`.
- Rotas: `GET /health`; `POST /v1/instances {id,label?}`; `GET /v1/instances`; `GET /v1/instances/:id` (status e QR em texto); `DELETE /v1/instances/:id`; `POST /v1/optin/codes {instanceId, project, subjectId, prefix, replyText, ttlMinutes?}` → `{ code, expiresAt, waLink }` onde `waLink = https://wa.me/<telefone da instância>?text=<mensagem com o código>` (telefone vindo de `manager`); `POST /v1/messages {instanceId, phone, text}` → `202 {id}`; `GET /v1/queue/:instanceId`.

- [ ] **Step 1: Escrever os testes:** rota `/v1/*` sem `x-api-key` devolve 401; `/health` devolve 200 sem chave; `POST /v1/messages` para número sem opt-in devolve 409 com `NO_OPT_IN`; `POST /v1/optin/codes` devolve `waLink` começando com `https://wa.me/` e contendo o código em `text`; corpo inválido devolve 400.
- [ ] **Step 2:** rodar e confirmar que falha.
- [ ] **Step 3: Implementar `buildServer`** com validação `zod` por rota.
- [ ] **Step 4: Implementar `src/index.ts`:** carregar config, `migrate`, criar módulos, `manager.startAll()`, `queue.start()`, ouvir em `0.0.0.0:PORT`; ligar `manager` → `optin.handleInbound` → `dispatcher.dispatch`.
- [ ] **Step 5:** `npx vitest run` e `npm run build` passam. Commit: `feat: API REST e ligação dos módulos`.

### Task 8: Publicação no Vertra e pareamento

**Files:**
- Create: `README.md` (variáveis, rotas e exemplo de `curl`)

- [ ] **Step 1:** criar o repositório `mzinhoww-svg/wa-gateway` no GitHub e subir o código (`gh repo create`, `git push`).
- [ ] **Step 2:** criar o Postgres do gateway no Vertra com a menor RAM aceita abaixo de 1024 MB (tentar 768, depois 512, depois 1024) e anotar a `DATABASE_URL`.
- [ ] **Step 3:** criar o app `wa-gateway` no Vertra (Node 22, 512 MB, repositório acima, build `npm run build`, start `node dist/index.js`) e definir as variáveis: `DATABASE_URL`, `API_KEY`, `WEBHOOK_SECRET`, `WEBHOOK_URL_REVELA`, `SEND_MIN_DELAY_MS`, `SEND_MAX_DELAY_MS`, `SEND_MAX_PER_HOUR`. Gerar `API_KEY` e `WEBHOOK_SECRET` aleatórios e entregá-los ao Aurimar sem colocá-los em arquivos.
- [ ] **Step 4:** esperar `GET /health` responder `200` pelos logs do app.
- [ ] **Step 5:** criar a instância `revela`, ler o QR nos logs, e o Aurimar escaneia com o chip dedicado (WhatsApp → Aparelhos conectados). Confirmar `status: open`.
- [ ] **Step 6: Teste de ponta a ponta:** gerar um código, abrir o `waLink` no celular, enviar, receber a resposta com o texto definido e o evento `optin.confirmed` no webhook; depois enviar `SAIR` e confirmar que um novo envio é recusado.
- [ ] **Step 7:** Commit final da documentação: `docs: README e passos de publicação`.

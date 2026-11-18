# wa-gateway

Gateway de WhatsApp (Baileys) para os projetos do Aurimar. Várias instâncias, fila de envio com intervalo, webhooks assinados e opt-in por código via `wa.me`. O usuário sempre dá o primeiro passo; só depois disso o gateway pode avisá-lo.

## Rodar

```bash
cp .env.example .env   # preencha
npm i && npm run build && npm start
```

Variáveis: `DATABASE_URL`, `API_KEY`, `WEBHOOK_SECRET`, `WEBHOOK_URL_<PROJETO>` (ex.: `WEBHOOK_URL_REVELA`) ou `WEBHOOK_URL`, `SEND_MIN_DELAY_MS` (4000), `SEND_MAX_DELAY_MS` (9000), `SEND_MAX_PER_HOUR` (60), `PORT` (3000).

No Vertra: Node 22, 512 MB, build `npm run build`, start `node dist/index.js`.

## API (header `x-api-key`)

| Rota | O que faz |
|---|---|
| `POST /v1/instances {id,label?}` | cria a instância e inicia o pareamento (QR) |
| `GET /v1/instances` · `GET /v1/instances/:id` | lista · status, QR e telefone |
| `DELETE /v1/instances/:id` | remove e apaga a sessão |
| `POST /v1/optin/codes` | gera código de uso único e o link `wa.me` |
| `POST /v1/messages {instanceId,phone,text}` | enfileira (409 `NO_OPT_IN` se não houver opt-in) |
| `GET /v1/queue/:instanceId` | fila e enviados na última hora |

Exemplo de opt-in:

```bash
curl -X POST $URL/v1/optin/codes -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"instanceId":"revela","project":"revela","subjectId":"guest-1","prefix":"REV",
       "replyText":"Pronto! Você será avisado de tudo. Volte ao Revela: https://app/entrar?t=TOKEN"}'
# => { "code":"REV-7K4Q", "waLink":"https://wa.me/55...?text=..." }
```

## Pools: vários números com failover

Um pool junta os números de um projeto (ex.: Achadinhos): **um ativo** e os outros **de reserva**. Tudo é aditivo: as
rotas acima continuam iguais para os outros projetos.

| Rota | O que faz |
|---|---|
| `PUT /v1/pools/:pool {project, adminPhones[]}` | cria ou atualiza o pool. `adminPhones` são os números pessoais do dono: recebem alertas e mandam comandos, e **nunca podem conectar** no gateway |
| `POST /v1/pools/:pool/numeros {instanceId, ordem}` | adiciona um número (cria a instância) e devolve um link de pareamento |
| `GET /v1/pools/:pool/numeros` | papel (`ativo`, `reserva`, `banido`, `bloqueado`), conexão, último heartbeat e aquecimento |
| `POST /v1/pools/:pool/numeros/:id/promover` | troca manual do ativo |
| `POST /v1/instances/:id/pareamento` | link `/parear/<token>` (10 min) com o QR, para abrir no celular |
| `PUT /v1/pools/:pool/grupos/:jid {intervaloMinS, espacoMinS, espacoMaxS}` | limite do grupo (padrão: 1 mensagem a cada 180 s + 20 a 90 s aleatórios) |
| `GET /v1/pools/:pool/grupos/:jid/convite` | link de convite do grupo |
| `POST /v1/pools/:pool/grupos/:jid/mensagem {texto, imagem?, ref?}` | enfileira no grupo pelo número ativo (202 com `id`) |
| `POST /v1/pools/:pool/privado {texto, phone?}` | alerta ou resumo para os admins do pool (só para eles) |
| `GET /v1/pools/:pool/envios/:id` | status do envio |
| `POST /v1/pools/:pool/entradas {chave, grupoJid, mensagem, origem, resposta}` | entrada por `wa.me`: quem manda a mensagem pronta recebe o convite (`{{convite}}`) e a origem fica registrada |
| `GET /v1/pools/:pool/eventos` | histórico (failover, banimentos, comandos, entradas) |

**Failover.** Heartbeat a cada 60 s. Logout ou sessão recusada pelo WhatsApp marcam o número como banido na hora; o
ativo sem conexão por 2 heartbeats seguidos também. O próximo reserva **conectado e admin de todos os grupos** do pool
vira o ativo, e o webhook do projeto recebe `pool.numero_banido` e `pool.failover` (ou `pool.sem_numero`).

**Proteção dos números.** Aquecimento por número (teto diário em grupo: 15 nos 2 primeiros dias, 30 até o 5º, 60 até
o 10º, depois 150), intervalos aleatórios e versão do WhatsApp Web buscada a cada conexão. Mantenha o
`@whiskeysockets/baileys` atualizado (`npm update @whiskeysockets/baileys` e novo deploy).

**Mensagens no privado dos números do pool** não passam pelo opt-in: dos admins, `PAUSAR`, `RETOMAR` e `STATUS` viram
`pool.comando` e o resto `pool.privado`; de outras pessoas, só a mensagem de uma entrada `wa.me` recebe resposta.

Variáveis novas: `EXTRA_API_KEYS` (chaves extras por projeto, separadas por vírgula, 24+ caracteres),
`POOL_HEARTBEAT_MS` (60000), `POOL_FALHAS_MAX` (2), `POOL_AQUECIMENTO` (`on`).

## Webhooks

`POST` JSON com o header `x-wa-signature: sha256=<HMAC-SHA256 do corpo com WEBHOOK_SECRET>`. Eventos: `message.received`, `optin.confirmed`, `optin.revoked` e, nos pools, `pool.*` (enviados para `WEBHOOK_URL_<PROJETO>`). O usuário cancela enviando `SAIR` ou `PARAR`.

## Pareamento

Ao criar a instância o gateway escreve no log `[qr] <instância> <texto>`. Gere o QR desse texto e escaneie no WhatsApp do chip dedicado (Aparelhos conectados). O QR vale cerca de 60 s.

## Banco compartilhado (e como separar depois)

O gateway usa um schema próprio (`DB_SCHEMA`, padrão `wa_gateway`), então pode dividir o Postgres com outro projeto (hoje, o `agencia-db`) sem misturar tabelas. Para separar no futuro: `pg_dump -n wa_gateway $URL_ANTIGA | psql $URL_NOVA` e trocar `DATABASE_URL`. Nada mais muda.

## Cuidados

Use um chip dedicado, nunca o número pessoal. API não oficial: há risco de banimento; o fluxo com opt-in iniciado pelo usuário, o intervalo entre envios e o teto por hora reduzem, mas não eliminam, esse risco.

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

## Webhooks

`POST` JSON com o header `x-wa-signature: sha256=<HMAC-SHA256 do corpo com WEBHOOK_SECRET>`. Eventos: `message.received`, `optin.confirmed`, `optin.revoked`. O usuário cancela enviando `SAIR` ou `PARAR`.

## Pareamento

Ao criar a instância o gateway escreve no log `[qr] <instância> <texto>`. Gere o QR desse texto e escaneie no WhatsApp do chip dedicado (Aparelhos conectados). O QR vale cerca de 60 s.

## Banco compartilhado (e como separar depois)

O gateway usa um schema próprio (`DB_SCHEMA`, padrão `wa_gateway`), então pode dividir o Postgres com outro projeto (hoje, o `agencia-db`) sem misturar tabelas. Para separar no futuro: `pg_dump -n wa_gateway $URL_ANTIGA | psql $URL_NOVA` e trocar `DATABASE_URL`. Nada mais muda.

## Cuidados

Use um chip dedicado, nunca o número pessoal. API não oficial: há risco de banimento; o fluxo com opt-in iniciado pelo usuário, o intervalo entre envios e o teto por hora reduzem, mas não eliminam, esse risco.

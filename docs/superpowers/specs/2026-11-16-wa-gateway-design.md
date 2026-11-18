# wa-gateway — Design

Data: 2026-11-16. Autor: Aurimar Nogueira (aprovado em conversa). Primeiro cliente: Revela.

## Intenção
Um gateway de WhatsApp próprio, de código aberto e sem custo por mensagem, reaproveitável nos projetos do Aurimar (Revela, agência de vistos, outros). Não usa a API oficial da Meta. O usuário final sempre dá o primeiro passo: toca num link `wa.me` com mensagem pronta contendo um código de uso único. Só depois disso o gateway pode avisá-lo.

Motivo: avisar convidados do Revela (ex.: "suas fotos foram reveladas") sem pagar por mensagem e sem quebrar a experiência: o próprio bot devolve o link para voltar ao app.

## Metas
- Várias instâncias (uma por chip), cada uma com QR de pareamento. O Revela começa com uma.
- API REST com chave: instâncias, QR/status, envio de texto, fila.
- Fila de envio com intervalo aleatório entre mensagens e teto por hora, por instância.
- Webhooks assinados (HMAC-SHA256) para cada mensagem recebida e para eventos de opt-in.
- Opt-in por código de uso único (`wa.me`), com resposta automática (texto definido pelo projeto, que pode conter o link de volta ao app) e opt-out por "SAIR".
- Sessão do WhatsApp guardada em Postgres, para sobreviver a deploys.

## Não-metas
CRM, grupos, mídia, chatbot, painel visual, envio a quem não deu opt-in, número pessoal do Aurimar.

## Anti-metas
Ser banido por enviar rajadas; enviar a alguém que pediu SAIR; um código poder ser reutilizado.

## Restrições
- TypeScript em Node 22 (runtime disponível no Vertra: 22.23.5), Baileys (`@whiskeysockets/baileys`, MIT), Fastify, `pg`, `zod`, `pino`, Vitest.
- Roda no Vertra Cloud (plano pro-4) como app de 512 MB, sem domínio público por enquanto. O código vem de `mzinhoww-svg/wa-gateway` (GitHub).
- Banco: Postgres novo, só do gateway, com menos de 1 GB de RAM (a Vertra recusou 384 e 512 MB em update do `agencia-db`; testar o valor aceito na criação).
- Chip dedicado; nunca o número pessoal.

## Abordagens consideradas
- A) Baileys direto, serviço próprio (escolhida): leve, MIT, controle total.
- B) Evolution API: já traz REST e webhooks, mas exige Postgres e Redis e é mais pesada.
- C) API oficial da Meta: descartada por custo e pela decisão do Aurimar de usar o fluxo `wa.me` sem custo.

## Decisões do desenho (minhas, para revisão)
- O gateway só envia a números com opt-in ativo (`requireOptIn` padrão ligado).
- O projeto cliente define o texto de resposta ao opt-in; o gateway não gera links de volta ao app.
- O telefone vem do JID de quem enviou o código, não é digitado.

## Fica para o construtor
Nomes internos, formato exato dos logs, política de reconexão do Baileys, tamanhos de pool de conexões.

# Segurança

## Como relatar uma vulnerabilidade

Não abra uma issue pública. Use o aviso de segurança privado do GitHub:

1. No repositório do Puxibot no GitHub, abra a aba **Security**.
2. Clique em **Report a vulnerability** e descreva o problema.

Inclua o que for possível: componente afetado (hub, runner ou interface), versão ou commit, passos para reproduzir, impacto que você imagina e, se tiver, uma sugestão de correção. Só os mantenedores veem o relato.

Este é um projeto mantido por voluntários, sem prazo garantido de resposta. Pedimos que você não divulgue o problema até haver uma correção ou até combinarmos uma data.

## Escopo

Interessa especialmente:

- acesso a dados de um workspace por quem não é membro;
- agente escapando do isolamento do runner (`sandbox` ou `container`) ou lendo o token do runner;
- uso indevido de tokens de job, de runner ou pessoais;
- vazamento de credenciais de conectores ou de segredos do Worker.

Limitações já documentadas, como a rede liberada no modo `sandbox` e o modo `none` sem isolamento ([docs/runner.md](docs/runner.md#isolamento)), não são vulnerabilidades, mas sugestões para melhorá-las são bem-vindas.

## Quem publica o hub entrega o código do runner

A interface ensina a instalar o runner direto do hub (`npm install -g <hub>/instalar/puxibot-runner.tgz`). Esse pacote roda no computador de cada pessoa, com o usuário dela e fora do isolamento. Quem publica o hub decide o que vai nesse pacote: instale assim só a partir do hub do seu time, publicado por alguém em quem você confia. A alternativa é instalar a partir do repositório e conferir o código ([docs/runner.md](docs/runner.md#instalação)). O `puxibot login` só aceita hub em `https://` (ou `http://` em `localhost`).

## Cada time cuida da própria instalação

O hub roda na conta Cloudflare de cada time, e o runner no computador de cada pessoa. Manter a instalação atualizada e os segredos (`JOB_TOKEN_SECRET`, `SECRETS_KEY`) em sigilo é responsabilidade de quem instalou. Veja [docs/deploy-cloudflare.md](docs/deploy-cloudflare.md#atualizar-para-uma-versão-nova).

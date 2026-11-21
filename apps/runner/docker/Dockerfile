# Imagem usada pelo modo `--isolation container` do runner do Puxibot.
# Um container por job, removido ao terminar. A pasta de trabalho do agente, o
# estado da CLI e o próprio runner (para o `puxibot mcp`) são montados no mesmo
# caminho do host; as credenciais da CLI entram montadas (somente leitura quando
# possível). Construída sob demanda pelo runner:
#   docker build -t <tag> --build-arg CLI_PACKAGE=@anthropic-ai/claude-code .
FROM node:22-bookworm-slim

ARG CLI_PACKAGE=@anthropic-ai/claude-code

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "${CLI_PACKAGE}" && npm cache clean --force

# O runner passa --user <uid>:<gid> do host; HOME aponta para /tmp (tmpfs).
ENV HOME=/tmp \
    DISABLE_AUTOUPDATER=1 \
    CI=1

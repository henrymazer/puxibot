# Como contribuir

Obrigado pelo interesse. O Puxibot é feito em português do Brasil: código, mensagens da interface, documentação e commits.

## Preparar o ambiente

Você precisa de Node.js 22 ou mais novo e do git.

```bash
npm install
```

```bash
npm run dev
```

Para entender o código, comece por [docs/arquitetura.md](docs/arquitetura.md). As rotas e regras de negócio estão em [docs/contrato-api.md](docs/contrato-api.md).

## Antes de abrir um pull request

```bash
npm run check
```

Isso roda typecheck, testes e build de tudo, e confere o pacote do Worker. A CI roda o mesmo.

- Mudou o comportamento de uma rota, evento ou ferramenta: atualize `docs/contrato-api.md` e `packages/shared/src/index.ts` no mesmo pull request.
- Mudou o banco: crie uma migração nova em `apps/hub/migrations/`; nunca edite uma que já foi publicada.
- Escreva testes para o que mudou. Testes que usam uma CLI de IA real ficam em `apps/runner/test/live.test.ts` e só rodam com `PUXIBOT_LIVE=1`; diga no pull request se você os rodou.
- Não prometa na documentação o que não foi testado. Se algo foi escrito a partir da documentação de terceiros, diga isso.
- Textos: frases diretas, segunda pessoa, sem emojis.

## Relatar problemas

Abra uma issue com o que você fez, o que esperava e o que aconteceu, a saída do `puxibot doctor` (se envolve o runner) e a versão (`puxibot --version`, commit do hub).

Falhas de segurança não vão em issue pública: veja [SECURITY.md](SECURITY.md).

Ao participar, você concorda em seguir o [código de conduta](CODE_OF_CONDUCT.md).

## Licença

Ao contribuir, você concorda que sua contribuição é distribuída sob a [licença MIT](LICENSE) do projeto.

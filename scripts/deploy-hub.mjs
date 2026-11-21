#!/usr/bin/env node
// Publica o hub do Puxibot na conta Cloudflare do time. Pode rodar quantas vezes quiser:
// o que já existe (banco D1, bucket R2, segredos) é reaproveitado, nunca recriado.
//
//   npm run deploy                         # pergunta antes de criar recursos
//   npm run deploy -- --dry-run            # só mostra o que faria (não precisa de login)
//   PUXIBOT_DEPLOY_CONFIRM=<account id ou nome da conta> npm run deploy -- --yes   # sem perguntas (CI)
//
// Sem terminal interativo, o deploy só roda com --yes E PUXIBOT_DEPLOY_CONFIRM igual à conta que
// vai receber o deploy: um --yes esquecido num comando copiado não publica nada sozinho.
//
// Opções: --dry-run, --yes, --no-ai, --public-url <url>, --account-id <id>, --location <dica>
//
// A configuração de produção (ids do banco e da conta) vai para apps/hub/wrangler.production.jsonc,
// gerado a partir de apps/hub/wrangler.jsonc e ignorado pelo git. O wrangler.jsonc versionado não muda.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hubDir = join(root, "apps", "hub");
const baseConfigPath = join(hubDir, "wrangler.jsonc");
const prodConfigPath = join(hubDir, "wrangler.production.jsonc");
const webDist = join(root, "apps", "web", "dist");
const localWrangler = join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");

// ---------- Opções ----------
const HELP = `Uso: node scripts/deploy-hub.mjs [opções]

Publica o hub na sua conta Cloudflare: cria o banco D1 e o bucket R2 se não existirem,
gera os segredos obrigatórios que faltarem, compila a interface, aplica as migrações
e faz o deploy.

Opções:
  --dry-run            mostra o que faria, sem criar nem publicar nada
  --yes, -y            não pede confirmação. Exige também a variável
                       PUXIBOT_DEPLOY_CONFIRM=<account id ou nome da conta Cloudflare>,
                       igual à conta que vai receber o deploy (ex.: em CI)
  --no-ai              não liga o binding AI (roteador de mensagens com Workers AI)
  --public-url <url>   endereço público do hub (vai para a variável PUBLIC_URL)
  --account-id <id>    conta Cloudflare a usar (ou CLOUDFLARE_ACCOUNT_ID)
  --location <dica>    região preferida do banco D1 na criação (weur, eeur, apac, oc, wnam, enam)
  --help, -h           mostra esta ajuda`;

function parseArgs(argv) {
  const o = { dryRun: false, yes: false, ai: true, publicUrl: undefined, accountId: undefined, location: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`a opção ${a} precisa de um valor`);
      return v;
    };
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--no-ai") o.ai = false;
    else if (a === "--public-url") o.publicUrl = value().replace(/\/+$/, "");
    else if (a === "--account-id") o.accountId = value();
    else if (a === "--location") o.location = value();
    else if (a === "--help" || a === "-h") {
      console.log(HELP);
      process.exit(0);
    } else fail(`opção desconhecida: ${a}\n\n${HELP}`);
  }
  if (o.publicUrl && !/^https?:\/\//.test(o.publicUrl)) fail("--public-url precisa começar com https://");
  return o;
}

// ---------- Utilidades ----------
function fail(msg) {
  console.error(`\n[deploy] Erro: ${msg}`);
  process.exit(1);
}
const say = (msg = "") => console.log(msg ? `[deploy] ${msg}` : "");

/** Roda um comando. `capture`: devolve stdout/stderr; senão herda o terminal. */
function run(cmd, args, { cwd = hubDir, env = {}, capture = false, tee = false } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: capture || tee ? ["inherit", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
      if (tee) process.stdout.write(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += d;
      if (tee) process.stderr.write(d);
    });
    child.on("error", (e) => resolvePromise({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });
}

const wranglerCmd = existsSync(localWrangler) ? localWrangler : "npx";
const wranglerPrefix = existsSync(localWrangler) ? [] : ["wrangler"];
const wrangler = (args, opts) => run(wranglerCmd, [...wranglerPrefix, ...args], opts);

/** Extrai o primeiro JSON (objeto ou lista) de uma saída que pode ter avisos antes. */
function parseJsonOutput(text) {
  const start = text.search(/^[[{]/m);
  if (start === -1) throw new Error("saída sem JSON");
  return JSON.parse(text.slice(start));
}

function lastLines(text, n = 8) {
  return text.trim().split("\n").slice(-n).join("\n");
}

async function confirm(question) {
  if (!process.stdin.isTTY) fail(`sem terminal para confirmar. Para seguir sem perguntas, use --yes com ${CONFIRM_VAR}=<account id ou nome da conta>.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [s/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "s" || answer === "sim" || answer === "y" || answer === "yes";
}

// ---------- Configuração de produção ----------
/** Monta a configuração de produção a partir da versionada, com caminhos relativos a `targetDir`. */
function buildProdConfig(base, { targetDir, accountId, databaseId, ai, publicUrl, previous }) {
  const rel = (p) => {
    const r = relative(targetDir, resolve(hubDir, p)).split("\\").join("/");
    return r.startsWith(".") ? r : `./${r}`;
  };
  const cfg = structuredClone(base);
  if (cfg.$schema) cfg.$schema = rel(cfg.$schema);
  cfg.main = rel(cfg.main);
  if (cfg.assets?.directory) cfg.assets.directory = rel(cfg.assets.directory);
  if (accountId) cfg.account_id = accountId;
  cfg.d1_databases = (cfg.d1_databases ?? []).map((d) => ({
    ...d,
    ...(databaseId ? { database_id: databaseId } : {}),
    ...(d.migrations_dir ? { migrations_dir: rel(d.migrations_dir) } : {}),
  }));
  if (ai) cfg.ai = { binding: "AI" };
  else delete cfg.ai;
  cfg.vars = { ...(cfg.vars ?? {}), PUBLIC_URL: publicUrl ?? cfg.vars?.PUBLIC_URL ?? "" };
  // Domínio próprio: o que o time acrescentou à mão na configuração de produção é mantido.
  for (const key of ["routes", "workers_dev"]) if (previous && key in previous) cfg[key] = previous[key];
  return cfg;
}

function writeProdConfig(file, cfg) {
  const header = [
    "// Gerado por scripts/deploy-hub.mjs a partir de wrangler.jsonc. NÃO versionar (está no .gitignore).",
    "// Contém os ids do banco D1 e da conta Cloudflare deste time. Para mudar algo, edite wrangler.jsonc",
    "// e rode `npm run deploy` de novo. Daqui são preservados: nomes do Worker, do banco e do bucket, account_id, database_id, PUBLIC_URL,",
    "// routes e workers_dev (domínio próprio). O resto é regenerado a cada deploy.",
  ].join("\n");
  writeFileSync(file, `${header}\n${JSON.stringify(cfg, null, 2)}\n`);
}

// ---------- Trava contra deploy acidental ----------
const CONFIRM_VAR = "PUXIBOT_DEPLOY_CONFIRM";

/**
 * Antes de qualquer chamada à Cloudflare: sem terminal para perguntar, só segue com --yes e
 * PUXIBOT_DEPLOY_CONFIRM definido; --yes sozinho não basta. Devolve o valor esperado da conta.
 */
function preflightConfirmation(opts) {
  if (opts.dryRun) return null;
  const expected = (process.env[CONFIRM_VAR] ?? "").trim();
  if (opts.yes && !expected) {
    fail(
      `--yes pula a confirmação, então exige também ${CONFIRM_VAR}=<account id ou nome da conta Cloudflare>.\n` +
        "Isso evita que um --yes copiado de algum lugar publique na conta errada. Exemplo (CI):\n" +
        `  ${CONFIRM_VAR}=<account id> npm run deploy -- --yes --account-id <account id>\n` +
        "Nada foi criado nem publicado.",
    );
  }
  if (!opts.yes && !process.stdin.isTTY) {
    fail(
      "sem terminal interativo para confirmar o deploy.\n" +
        `Para rodar sem perguntas (CI), use --yes junto com ${CONFIRM_VAR}=<account id ou nome da conta>.\n` +
        "Para só ver o que seria feito: npm run deploy -- --dry-run. Nada foi criado nem publicado.",
    );
  }
  return expected || null;
}

/** --yes: a conta que vai receber o deploy precisa ser a de PUXIBOT_DEPLOY_CONFIRM (id ou nome). */
function assertConfirmedAccount(expected, accountId, accounts) {
  if (!expected) return;
  const account = accounts.find((a) => a.id === accountId);
  const matches = expected === accountId || (account?.name && account.name.trim().toLowerCase() === expected.toLowerCase());
  if (!accountId || !matches) {
    fail(
      `${CONFIRM_VAR} não confere com a conta que receberia o deploy (${accountId ?? "conta não identificada"}${account?.name ? `, "${account.name}"` : ""}).\n` +
        "Confira a conta (--account-id) e o valor da variável. Nada foi criado nem publicado.",
    );
  }
}

// ---------- Programa ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const confirmAccount = preflightConfirmation(opts);
  const base = parseJsonc(readFileSync(baseConfigPath, "utf8"));
  const previous = existsSync(prodConfigPath) ? parseJsonc(readFileSync(prodConfigPath, "utf8")) : null;

  // Quem já publicou mantém os nomes dos recursos da própria instalação, mesmo que os nomes padrão
  // do wrangler.jsonc mudem numa versão nova (senão o deploy criaria um Worker, um banco e um bucket novos).
  if (previous?.name) base.name = previous.name;
  if (previous?.d1_databases?.[0]?.database_name && base.d1_databases?.[0]) base.d1_databases[0].database_name = previous.d1_databases[0].database_name;
  if (previous?.r2_buckets?.[0]?.bucket_name && base.r2_buckets?.[0]) base.r2_buckets[0].bucket_name = previous.r2_buckets[0].bucket_name;

  const workerName = base.name;
  const db = base.d1_databases?.[0];
  const bucket = base.r2_buckets?.[0];
  const requiredSecrets = base.secrets?.required ?? [];
  if (!workerName || !db?.database_name || !bucket?.bucket_name) fail("wrangler.jsonc sem name, d1_databases ou r2_buckets.");

  say(opts.dryRun ? "Modo --dry-run: nada será criado nem publicado." : "Publicando o hub do Puxibot.");
  say(`Worker: ${workerName} · banco D1: ${db.database_name} · bucket R2: ${bucket.bucket_name}`);

  // 1. Login
  const who = await wrangler(["whoami", "--json"], { capture: true });
  let loggedIn = who.code === 0;
  let accounts = [];
  if (loggedIn) {
    try {
      const info = parseJsonOutput(who.stdout);
      accounts = Array.isArray(info.accounts) ? info.accounts : [];
      say(`Conectado à Cloudflare${info.email ? ` como ${info.email}` : ""}.`);
    } catch {
      say("Conectado à Cloudflare (não consegui ler a lista de contas).");
    }
  } else if (opts.dryRun) {
    say("Sem login na Cloudflare. No deploy de verdade eu pararia aqui e pediria `npx wrangler login`.");
  } else {
    fail("sem login na Cloudflare. Rode `npx wrangler login` (ou defina CLOUDFLARE_API_TOKEN) e tente de novo.");
  }

  // 2. Conta
  let accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? previous?.account_id;
  if (!accountId && accounts.length === 1) accountId = accounts[0].id;
  if (loggedIn && !accountId && accounts.length > 1) {
    const list = accounts.map((a) => `  ${a.id}  ${a.name ?? ""}`).join("\n");
    fail(`seu login tem acesso a várias contas. Escolha uma com --account-id <id>:\n${list}`);
  }
  const env = accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : {};
  if (accountId) {
    const accountName = accounts.find((a) => a.id === accountId)?.name;
    say(`Conta: ${accountName ? `${accountName} (${accountId})` : accountId}`);
  }
  if (!opts.dryRun) assertConfirmedAccount(confirmAccount, accountId, accounts);

  // 3. Banco D1
  let databaseId = null;
  let createDb = false;
  if (loggedIn) {
    const list = await wrangler(["d1", "list", "--json"], { capture: true, env });
    if (list.code !== 0) fail(`não consegui listar os bancos D1:\n${lastLines(list.stderr || list.stdout)}`);
    const found = parseJsonOutput(list.stdout).find((d) => d.name === db.database_name);
    databaseId = found?.uuid ?? found?.id ?? null;
    createDb = !databaseId;
  } else createDb = true;
  say(databaseId ? `Banco D1 "${db.database_name}" já existe (${databaseId}).` : `Banco D1 "${db.database_name}": será criado.`);

  // 4. Bucket R2
  let createBucket = true;
  if (loggedIn) {
    const info = await wrangler(["r2", "bucket", "info", bucket.bucket_name], { capture: true, env });
    createBucket = info.code !== 0;
  }
  say(createBucket ? `Bucket R2 "${bucket.bucket_name}": será criado.` : `Bucket R2 "${bucket.bucket_name}" já existe.`);

  // 5. Segredos obrigatórios
  let missingSecrets = [...requiredSecrets];
  let workerExists = false;
  if (loggedIn) {
    const sl = await wrangler(["secret", "list", "--name", workerName, "--format", "json"], { capture: true, env });
    if (sl.code === 0) {
      workerExists = true;
      const names = new Set(parseJsonOutput(sl.stdout).map((s) => s.name));
      missingSecrets = requiredSecrets.filter((n) => !names.has(n));
    } else if (/not.?found|does not exist|10007/i.test(sl.stdout + sl.stderr)) {
      workerExists = false; // primeiro deploy: o Worker ainda não existe, nenhum segredo definido
    } else {
      fail(`não consegui listar os segredos do Worker ${workerName}:\n${lastLines(sl.stderr || sl.stdout)}`);
    }
  }
  if (missingSecrets.length) say(`Segredos a gerar (aleatórios, sem mostrar o valor): ${missingSecrets.join(", ")}.`);
  else say("Segredos obrigatórios já definidos; não serão alterados.");
  if (loggedIn) say(workerExists ? `O Worker ${workerName} já existe: este deploy publica uma versão nova.` : `Primeiro deploy do Worker ${workerName}.`);

  const publicUrl = opts.publicUrl ?? previous?.vars?.PUBLIC_URL ?? "";
  const ai = opts.ai;
  say(`Roteador (binding AI, Workers AI): ${ai ? "ligado" : "desligado (--no-ai)"}.`);
  say(`PUBLIC_URL: ${publicUrl || "(vazio: o hub usa o endereço de cada requisição)"}.`);

  const plan = [
    ...(createDb ? [`criar o banco D1 "${db.database_name}"${opts.location ? ` (região ${opts.location})` : ""}`] : []),
    ...(createBucket ? [`criar o bucket R2 "${bucket.bucket_name}"`] : []),
    `gravar ${relative(root, prodConfigPath)}`,
    "compilar a interface web (apps/web)",
    `aplicar as migrações pendentes no banco remoto "${db.database_name}"`,
    `publicar o Worker "${workerName}"${missingSecrets.length ? ` com os segredos novos ${missingSecrets.join(", ")}` : ""}`,
  ];
  say();
  say("Passos:");
  plan.forEach((p, i) => say(`  ${i + 1}. ${p}`));
  say();

  // ---------- --dry-run ----------
  if (opts.dryRun) {
    const tmp = mkdtempSync(join(tmpdir(), "puxibot-deploy-"));
    try {
      const cfg = buildProdConfig(base, {
        targetDir: tmp,
        accountId,
        databaseId: databaseId ?? "00000000-0000-0000-0000-000000000000",
        ai,
        publicUrl,
        previous,
      });
      const file = join(tmp, "wrangler.production.jsonc");
      writeProdConfig(file, cfg);
      if (!existsSync(join(webDist, "index.html"))) {
        say("A interface ainda não foi compilada (apps/web/dist); pulei a checagem do pacote do Worker.");
        say("Para incluí-la: npm run build -w @puxibot/shared && npm run build -w @puxibot/web");
      } else {
        say("Checando o pacote do Worker com `wrangler deploy --dry-run` (configuração temporária, id fictício)...");
        const r = await wrangler(["deploy", "--dry-run", "-c", file, "--outdir", join(tmp, "out")], { capture: true, env });
        if (r.code !== 0) fail(`wrangler deploy --dry-run falhou:\n${lastLines(r.stderr || r.stdout, 15)}`);
        const size = (r.stdout.match(/Total Upload:[^\n]*/) ?? [""])[0];
        say(`Pacote gerado. ${size}`.trim());
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    say("Fim do --dry-run. Nada foi criado, gravado ou publicado.");
    return;
  }

  if (!opts.yes && !(await confirm("[deploy] Seguir com esses passos?"))) {
    say("Cancelado. Nada foi alterado.");
    return;
  }

  // ---------- Execução ----------
  if (createDb) {
    say(`Criando o banco D1 "${db.database_name}"...`);
    const r = await wrangler(["d1", "create", db.database_name, ...(opts.location ? ["--location", opts.location] : [])], { capture: true, env });
    if (r.code !== 0) fail(`não consegui criar o banco D1:\n${lastLines(r.stderr || r.stdout)}`);
    const list = await wrangler(["d1", "list", "--json"], { capture: true, env });
    const found = list.code === 0 ? parseJsonOutput(list.stdout).find((d) => d.name === db.database_name) : null;
    databaseId = found?.uuid ?? found?.id ?? (r.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [])[0];
    if (!databaseId) fail("o banco foi criado, mas não consegui ler o id. Rode `npx wrangler d1 list` e tente o deploy de novo.");
    say(`Banco criado (${databaseId}).`);
  }

  if (createBucket) {
    say(`Criando o bucket R2 "${bucket.bucket_name}"...`);
    const r = await wrangler(["r2", "bucket", "create", bucket.bucket_name], { capture: true, env });
    if (r.code !== 0) {
      fail(
        `não consegui criar o bucket R2:\n${lastLines(r.stderr || r.stdout)}\n\n` +
          "Se a mensagem fala em assinatura ou em habilitar o R2: no painel da Cloudflare, abra R2 e conclua a ativação\n" +
          "(é exigida mesmo para usar só a cota gratuita). Depois rode `npm run deploy` de novo.",
      );
    }
    say("Bucket criado.");
  }

  writeProdConfig(prodConfigPath, buildProdConfig(base, { targetDir: hubDir, accountId, databaseId, ai, publicUrl, previous }));
  say(`Configuração de produção gravada em ${relative(root, prodConfigPath)}.`);

  say("Compilando a interface web...");
  for (const ws of ["@puxibot/shared", "@puxibot/web"]) {
    const r = await run("npm", ["run", "build", "-w", ws], { cwd: root });
    if (r.code !== 0) fail(`a compilação de ${ws} falhou.`);
  }

  say("Aplicando as migrações no banco remoto...");
  const mig = await wrangler(["d1", "migrations", "apply", db.database_name, "--remote", "-c", prodConfigPath, ...(opts.yes ? ["--force"] : [])], { env });
  if (mig.code !== 0) fail("as migrações falharam. O Worker não foi publicado; corrija e rode `npm run deploy` de novo.");

  let secretsDir = null;
  const deployArgs = ["deploy", "-c", prodConfigPath];
  if (missingSecrets.length) {
    secretsDir = mkdtempSync(join(tmpdir(), "puxibot-secrets-"));
    const values = {};
    for (const name of missingSecrets) {
      // SECRETS_KEY: AES-GCM, base64 de 32 bytes. JOB_TOKEN_SECRET: HMAC, qualquer valor longo.
      values[name] = name === "SECRETS_KEY" ? randomBytes(32).toString("base64") : randomBytes(32).toString("hex");
    }
    const file = join(secretsDir, "secrets.json");
    writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    deployArgs.push("--secrets-file", file);
  }

  say("Publicando o Worker...");
  let dep;
  try {
    dep = await wrangler(deployArgs, { tee: true, env });
  } finally {
    if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  }
  if (dep.code !== 0) fail("o deploy falhou (veja a saída acima). Rode `npm run deploy` de novo depois de corrigir.");

  const workersDev = (dep.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) ?? [])[0];
  const url = publicUrl || workersDev;
  say();
  say("Hub publicado.");
  say(url ? `Endereço: ${url}` : "Endereço: veja as linhas com https:// na saída do wrangler acima.");
  say("Próximo passo: abra o endereço e crie sua conta agora. A primeira conta não precisa de convite e fecha o cadastro; as seguintes entram por convite.");
  if (!publicUrl && url) {
    // Sem terminal interativo, o comando precisa das mesmas confirmações deste deploy.
    const prefix = opts.yes && accountId ? `PUXIBOT_DEPLOY_CONFIRM=${accountId} ` : "";
    const suffix = opts.yes && accountId ? ` --yes --account-id ${accountId}` : "";
    say(`Recomendado: fixe o endereço público com \`${prefix}npm run deploy -- --public-url ${url.replace(/\/+$/, "")}${suffix}\`.`);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

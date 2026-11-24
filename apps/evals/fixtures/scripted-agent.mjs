#!/usr/bin/env node
// Agente roteirizado: ocupa o lugar da CLI de IA nas avaliações sem custo ("smoke").
// Em vez de um modelo, executa uma lista fixa de chamadas de ferramenta (o roteiro do cenário),
// pelos mesmos servidores MCP que a CLI de verdade usaria: o `puxibot mcp` e o intermediário de
// cada conector. Serve para conferir a barreira do servidor mesmo quando o "modelo" é enganado:
// há roteiros que seguem a instrução maliciosa de propósito.
//
// Uso (pelo runner): scripted-agent.mjs --script <arquivo.json> <argumentos da CLI do Claude Code>
import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const scriptFile = argv[argv.indexOf("--script") + 1];
const rest = argv.filter((_, i) => i !== argv.indexOf("--script") && i !== argv.indexOf("--script") + 1);

if (rest[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (rest[0] === "auth" && rest[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "avaliacao", subscriptionType: "nenhuma" }));
  process.exit(0);
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

const script = JSON.parse(readFileSync(scriptFile, "utf8"));
const session = randomUUID();
const model = "agente-roteirizado";
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const finish = (text) => {
  out({ type: "result", subtype: "success", is_error: false, result: text, session_id: session, usage, modelUsage: { [model]: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
  process.exit(0);
};

out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, model, tools: [] });

// Chamada utilitária (revisão de memória): devolve a revisão do roteiro, ou "sem mudanças".
if (rest.includes("--system-prompt-file")) finish(JSON.stringify(script.review ?? { add: [], remove: [] }));

const mcpFile = rest[rest.indexOf("--mcp-config") + 1];
const servers = JSON.parse(readFileSync(mcpFile, "utf8")).mcpServers;
const clients = new Map();
const trace = [];
async function clientFor(name) {
  // O roteiro refere o conector por um nome fixo ("conector"); o runner dá a ele o nome real.
  const key = name === "conector" ? Object.keys(servers).find((k) => k !== "puxibot" && k !== "navegador") : name;
  const cfg = servers[key];
  if (!cfg) return null;
  if (!clients.has(key)) {
    const c = new Client({ name: "agente-roteirizado", version: "1" });
    // Como a CLI de verdade: o servidor recebe o ambiente da CLI mais as variáveis próprias dele.
    await c.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env: { ...process.env, ...(cfg.env ?? {}) }, stderr: "ignore" }));
    clients.set(key, c);
  }
  return clients.get(key);
}

for (const [i, step] of (script.steps ?? []).entries()) {
  const client = await clientFor(step.server);
  let entry;
  if (!client) entry = { ...step, error: "servidor não disponível" };
  else if (step.list) {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    entry = { ...step, tools };
  } else {
    try {
      const r = await client.callTool({ name: step.tool, arguments: step.args ?? {} }, undefined, { timeout: 15 * 60_000 });
      entry = { ...step, isError: r.isError === true, text: (r.content ?? []).map((p) => p.text ?? "").join("\n").slice(0, 4000) };
    } catch (e) {
      entry = { ...step, isError: true, text: String(e instanceof Error ? e.message : e) };
    }
  }
  trace.push(entry);
  out({ type: "assistant", message: { id: `m${i}`, model, role: "assistant", content: [{ type: "tool_use", id: `tu_${i}`, name: `mcp__${step.server}__${step.tool ?? "tools/list"}`, input: step.args ?? {} }] }, session_id: session, parent_tool_use_id: null });
}
if (script.traceFile) appendFileSync(script.traceFile, JSON.stringify({ at: Date.now(), trace }) + "\n");
for (const c of clients.values()) await c.close().catch(() => {});
finish(script.reply ?? "Pronto.");

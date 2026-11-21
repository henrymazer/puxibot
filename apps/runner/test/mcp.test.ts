import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNNER_ROOT } from "./helpers/env.js";
import { FakeHub } from "./helpers/fakeHub.js";

const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve("tsx")).href;

let hub: FakeHub;

async function connect(extraEnv: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", tsx, path.join(RUNNER_ROOT, "src", "cli.ts"), "mcp"],
    env: {
      PATH: process.env.PATH ?? "",
      PUXIBOT_HUB_URL: hub.url,
      PUXIBOT_JOB_TOKEN: "tbj_test_job_token",
      PUXIBOT_CHANNEL_ID: "c_1",
      ...extraEnv,
    },
    cwd: RUNNER_ROOT,
    stderr: "pipe",
  });
  const client = new Client({ name: "teste", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function text(r: Awaited<ReturnType<Client["callTool"]>>): string {
  return (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

beforeAll(async () => {
  hub = await new FakeHub().start();
});
afterAll(async () => {
  await hub.close();
});

describe("servidor MCP nativo (puxibot mcp)", () => {
  it("expõe todas as ferramentas do contrato com os nomes em português", async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "enviar_mensagem",
        "ler_mensagens",
        "listar_canais",
        "buscar",
        "lembrar",
        "consultar_memoria",
        "esquecer",
        "listar_tarefas",
        "criar_tarefa",
        "atualizar_tarefa",
        "comentar_tarefa",
        "listar_wiki",
        "ler_pagina_wiki",
        "escrever_pagina_wiki",
        "listar_arquivos",
        "baixar_arquivo",
        "salvar_no_drive",
        "listar_time",
        "consultar_agente",
        "pedir_aprovacao",
        "criar_agente",
        "criar_rotina",
        "reportar_progresso",
      ].sort(),
    );
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
    }
    await c.close();
  });

  it("chama o hub com o token do job e devolve o resultado", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "listar_canais", arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("geral");
    const call = hub.toolCalls.find((x) => x.path === "/api/tool/channels")!;
    expect(call.auth).toBe("Bearer tbj_test_job_token");

    await c.callTool({ name: "lembrar", arguments: { scope: "team", content: "Deploy às sextas é proibido." } });
    const mem = hub.toolCalls.find((x) => x.path === "/api/tool/memories")!;
    expect(mem.method).toBe("POST");
    expect(mem.body).toEqual({ scope: "team", content: "Deploy às sextas é proibido." });

    await c.callTool({ name: "atualizar_tarefa", arguments: { numero: 12, status: "doing" } });
    const task = hub.toolCalls.find((x) => x.path === "/api/tool/tasks/12")!;
    expect(task.method).toBe("PATCH");
    expect(task.body).toEqual({ status: "doing" });

    await c.callTool({ name: "ler_mensagens", arguments: { limit: 5 } });
    const msgs = hub.toolCalls.find((x) => x.path === "/api/tool/messages" && x.method === "GET")!;
    expect(msgs.query).toEqual({ channel: "c_1", limit: "5" });
    await c.close();
  });

  it("transforma 403 do hub em mensagem clara de permissão", async () => {
    hub.toolResponses.set("POST /api/tool/messages", [403, { error: { code: "forbidden", message: "messages:write negado para este agente" } }]);
    const c = await connect();
    const r = await c.callTool({ name: "enviar_mensagem", arguments: { channel: "dev", body: "oi" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Você não tem permissão para enviar mensagens\./);
    expect(text(r)).toContain("messages:write negado");
    await c.close();
  });

  it("esconde ferramentas sem permissão e as exclusivas do assistente", async () => {
    const c = await connect({
      PUXIBOT_TOOL_PERMS: JSON.stringify({ messages: "read", memory: "write", tasks: "none", wiki: "read", drive: "none", agents: "read" }),
      PUXIBOT_AGENT_IS_ASSISTANT: "0",
    });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("ler_mensagens");
    expect(names).not.toContain("enviar_mensagem");
    expect(names).not.toContain("criar_tarefa");
    expect(names).not.toContain("listar_tarefas");
    expect(names).toContain("ler_pagina_wiki");
    expect(names).not.toContain("escrever_pagina_wiki");
    expect(names).not.toContain("criar_agente");
    expect(names).toContain("pedir_aprovacao");
    expect(names).toContain("reportar_progresso");
    await c.close();
  });
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FIXTURES, RUNNER_ROOT, setupTestEnv } from "./helpers/env.js";
import { makeAssignment } from "./helpers/fakeHub.js";

setupTestEnv("extras");
const { createReadOnlyProxy, isReadOnlyTool } = await import("../src/mcp/readonlyProxy.js");
const { connectorServer } = await import("../src/adapters/types.js");
const { claudeAdapter } = await import("../src/adapters/claude.js");
const { saveConfig, saveToken, loadConfig, loadToken, paths } = await import("../src/config.js");
const { logout } = await import("../src/logout.js");
const { serviceFiles } = await import("../src/service.js");

/** Conector falso: uma ferramenta de leitura (marcada), uma de escrita e uma sem marca. */
async function fakeConnector(calls: string[]): Promise<Client> {
  const up = new McpServer({ name: "crm", version: "1" });
  up.registerTool("listar_clientes", { description: "lista", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
    calls.push("listar_clientes");
    return { content: [{ type: "text", text: "Ana, Bia" }] };
  });
  up.registerTool("apagar_cliente", { description: "apaga", inputSchema: { id: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } }, async () => {
    calls.push("apagar_cliente");
    return { content: [{ type: "text", text: "apagado" }] };
  });
  up.registerTool("sem_marca", { description: "?", inputSchema: {} }, async () => {
    calls.push("sem_marca");
    return { content: [{ type: "text", text: "x" }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await up.connect(a);
  const client = new Client({ name: "proxy", version: "1" });
  await client.connect(b);
  return client;
}

describe("conector somente leitura (puxibot mcp-proxy)", () => {
  it("só expõe ferramentas com readOnlyHint e recusa as outras sem chamar o conector", async () => {
    const calls: string[] = [];
    const upstream = await fakeConnector(calls);
    const proxy = await createReadOnlyProxy(upstream, "CRM");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await proxy.connect(a);
    const agent = new Client({ name: "cli", version: "1" });
    await agent.connect(b);
    expect(agent.getInstructions()).toMatch(/2 ferramenta\(s\).*apagar_cliente, sem_marca/);
    const tools = await agent.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["listar_clientes"]);
    const ok = await agent.callTool({ name: "listar_clientes", arguments: {} });
    expect((ok.content as { text: string }[])[0]!.text).toBe("Ana, Bia");
    const blocked = await agent.callTool({ name: "apagar_cliente", arguments: { id: "1" } });
    expect(blocked.isError).toBe(true);
    expect((blocked.content as { text: string }[])[0]!.text).toMatch(/bloqueada.*somente leitura/);
    expect((await agent.callTool({ name: "sem_marca", arguments: {} })).isError).toBe(true);
    expect(calls).toEqual(["listar_clientes"]);
    await agent.close();
  });

  it("de ponta a ponta: `puxibot mcp-proxy` com um conector stdio de verdade", async () => {
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const cfg = { name: "CRM", transport: "stdio", command: process.execPath, args: [path.join(FIXTURES, "fake-connector.mjs")], env: { CRM_SECRET: "s3" } };
    const agent = new Client({ name: "cli", version: "1" });
    await agent.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", tsx, path.join(RUNNER_ROOT, "src", "cli.ts"), "mcp-proxy", "--config-env", "PUXIBOT_RO_CONNECTOR_0"],
        env: { PATH: process.env.PATH ?? "", PUXIBOT_RO_CONNECTOR_0: JSON.stringify(cfg), PUXIBOT_JOB_TOKEN: "tbj_nao_vaza" },
        stderr: "pipe",
      }),
    );
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(["ler"]);
    const r = await agent.callTool({ name: "ler", arguments: {} });
    // O conector recebe o próprio segredo e não recebe o token do job nem a configuração.
    expect((r.content as { text: string }[])[0]!.text).toBe("secret=s3 job=- cfg=-");
    expect((await agent.callTool({ name: "gravar", arguments: {} })).isError).toBe(true);
    await agent.close();
  });

  it("isReadOnlyTool exige a marca explícita", () => {
    expect(isReadOnlyTool({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadOnlyTool({ annotations: {} })).toBe(false);
    expect(isReadOnlyTool({})).toBe(false);
  });

  it("conector 'read' vira o intermediário; 'write' vai direto; 'none' fica de fora", () => {
    const proxy = { command: "node", args: ["/x/cli.js", "mcp-proxy"] };
    const base = { id: "c1", name: "CRM", transport: "http" as const, url: "https://crm/mcp", command: null, args: [], headers: { Authorization: "Bearer s" }, env: {} };
    const ro = connectorServer({ ...base, level: "read" }, proxy, 0)!;
    expect(ro).toMatchObject({ transport: "stdio", command: "node", args: ["/x/cli.js", "mcp-proxy", "--config-env", "PUXIBOT_RO_CONNECTOR_0"] });
    expect(ro.transport === "stdio" && JSON.parse(ro.env.PUXIBOT_RO_CONNECTOR_0!)).toMatchObject({ url: "https://crm/mcp", headers: { Authorization: "Bearer s" } });
    expect(connectorServer({ ...base, level: "write" }, proxy, 0)).toEqual({ transport: "http", url: "https://crm/mcp", headers: { Authorization: "Bearer s" } });
    expect(connectorServer({ ...base, level: "none" }, proxy, 0)).toBeNull();
  });

  it("no Claude Code, o conector somente leitura entra no mcp.json como o intermediário", async () => {
    const a = makeAssignment("http://127.0.0.1:9", {
      connectors: [{ id: "c1", name: "CRM", transport: "http", url: "https://crm/mcp", command: null, args: [], headers: { Authorization: "Bearer s" }, env: {}, level: "read" }],
    });
    const runDir = paths.runDir(a.jobId);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(paths.agentDir("ws_1", "ag_1"), { recursive: true });
    const p = await claudeAdapter.prepare({
      assignment: a,
      workdir: paths.agentDir("ws_1", "ag_1"),
      runDir,
      systemPrompt: "s",
      userPrompt: "u",
      model: null,
      resumeSessionId: null,
      isolation: "sandbox",
      mcp: { command: "node", args: ["cli.js", "mcp"] },
      mcpProxy: { command: "node", args: ["cli.js", "mcp-proxy"] },
      mcpEnv: {},
      baseEnv: {},
      binPath: "claude",
    });
    const mcpFile = p.args[p.args.indexOf("--mcp-config") + 1]!;
    const cfg = JSON.parse(readFileSync(mcpFile, "utf8")) as { mcpServers: Record<string, { command?: string; args?: string[]; url?: string }> };
    expect(cfg.mcpServers.crm).toMatchObject({ type: "stdio", command: "node", args: ["cli.js", "mcp-proxy", "--config-env", "PUXIBOT_RO_CONNECTOR_0"] });
    expect(cfg.mcpServers.crm!.url).toBeUndefined();
  });
});

describe("puxibot logout", () => {
  const seen: { method: string; url: string; auth: string | undefined }[] = [];
  let status = 204;
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(status === 204 ? undefined : JSON.stringify({ error: { code: "x", message: "proibido" } }));
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("remove o próprio runner no hub com o token de runner e apaga o token local", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    saveConfig({ hubUrl: `http://127.0.0.1:${port}`, workspaceId: "ws_1", runnerId: "run_9", name: "x" });
    saveToken("tb_runner_token");
    const r = await logout();
    expect(r.removed).toBe(true);
    expect(seen[0]).toEqual({ method: "DELETE", url: "/api/workspaces/ws_1/runners/run_9", auth: "Bearer tb_runner_token" });
    expect(loadToken()).toBeNull();
    expect(loadConfig()).toMatchObject({ runnerId: null, name: "x" });
    expect(loadConfig().hubUrl).toBeUndefined();
    expect(r.message).not.toContain("tb_runner_token");
  });

  it("hub recusando: avisa e mesmo assim apaga o token local", async () => {
    status = 403;
    const port = (server.address() as { port: number }).port;
    saveConfig({ hubUrl: `http://127.0.0.1:${port}`, workspaceId: "ws_1", runnerId: "run_9" });
    saveToken("tb_runner_token");
    const r = await logout();
    expect(r.removed).toBe(false);
    expect(r.message).toMatch(/recusou.*proibido/);
    expect(loadToken()).toBeNull();
  });

  it("hub fora do ar: avisa e apaga o token local", async () => {
    saveConfig({ hubUrl: "http://127.0.0.1:9", workspaceId: "ws_1", runnerId: "run_9" });
    saveToken("tb_runner_token");
    const r = await logout();
    expect(r.removed).toBeNull();
    expect(loadToken()).toBeNull();
  });
});

describe("puxibot service", () => {
  it("gera unidade systemd e plist com o node, o cli e o PATH, sem instalar nada", () => {
    const f = serviceFiles({ PATH: "/a/bin:/mnt/c/Windows:/usr/bin", PUXIBOT_HOME: "/srv/tb" });
    expect(f.command[0]).toBe(process.execPath);
    expect(f.command.at(-1)).toBe("start");
    expect(f.systemd).toContain(`ExecStart=${process.execPath} `);
    expect(f.systemd).toContain("Environment=PATH=/a/bin:/usr/bin");
    expect(f.systemd).toContain("Environment=PUXIBOT_HOME=/srv/tb");
    expect(f.launchd).toContain("<string>start</string>");
    expect(f.launchd).toContain("<key>PUXIBOT_HOME</key><string>/srv/tb</string>");
  });
});

#!/usr/bin/env node
// Caixa de e-mail falsa, com estado: servidor MCP por stdio usado pelas avaliações.
// O estado fica num arquivo JSON (variável MAILBOX_STATE), para o avaliador conferir depois o que
// realmente mudou: quais e-mails foram enviados, para quem, e quais foram apagados.
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const file = process.env.MAILBOX_STATE;
if (!file) throw new Error("MAILBOX_STATE ausente");
const load = () => JSON.parse(readFileSync(file, "utf8"));
const save = (s) => writeFileSync(file, JSON.stringify(s, null, 2));
const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

const server = new McpServer({ name: "caixa-de-email", version: "1" });

server.registerTool(
  "listar_emails",
  { description: "Lista os e-mails da caixa de entrada (remetente, assunto e se foi lido).", inputSchema: { apenasNaoLidos: z.boolean().optional() }, annotations: { readOnlyHint: true } },
  async ({ apenasNaoLidos }) => {
    const s = load();
    return text(s.inbox.filter((m) => !m.deleted && (!apenasNaoLidos || !m.read)).map((m) => ({ id: m.id, de: m.from, assunto: m.subject, lido: m.read })));
  },
);

server.registerTool(
  "ler_email",
  { description: "Lê o conteúdo de um e-mail pelo id.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const s = load();
    const m = s.inbox.find((x) => x.id === id && !x.deleted);
    if (!m) return { ...text("E-mail não encontrado."), isError: true };
    return text({ id: m.id, de: m.from, assunto: m.subject, corpo: m.body });
  },
);

server.registerTool(
  "enviar_email",
  {
    description: "Envia um e-mail em nome do dono da caixa.",
    inputSchema: { para: z.string(), assunto: z.string(), corpo: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ para, assunto, corpo }) => {
    const s = load();
    s.sent.push({ to: para, subject: assunto, body: corpo, at: Date.now() });
    save(s);
    return text(`E-mail enviado para ${para}.`);
  },
);

server.registerTool(
  "apagar_email",
  { description: "Apaga um e-mail da caixa de entrada.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } },
  async ({ id }) => {
    const s = load();
    const m = s.inbox.find((x) => x.id === id);
    if (!m) return { ...text("E-mail não encontrado."), isError: true };
    m.deleted = true;
    save(s);
    return text("E-mail apagado.");
  },
);

await server.connect(new StdioServerTransport());

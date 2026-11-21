#!/usr/bin/env node
// Conector MCP falso (stdio) para os testes do `puxibot mcp-proxy`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fake-crm", version: "1" });
server.registerTool("ler", { description: "lê", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
  content: [
    {
      type: "text",
      text: `secret=${process.env.CRM_SECRET ?? "-"} job=${process.env.PUXIBOT_JOB_TOKEN ?? "-"} cfg=${process.env.PUXIBOT_RO_CONNECTOR_0 ?? "-"}`,
    },
  ],
}));
server.registerTool("gravar", { description: "grava", inputSchema: {}, annotations: { readOnlyHint: false } }, async () => ({
  content: [{ type: "text", text: "gravado" }],
}));
await server.connect(new StdioServerTransport());

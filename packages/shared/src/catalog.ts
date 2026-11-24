/**
 * Catálogo de conectores prontos. Cada app é uma pasta em `packages/shared/apps/<id>/`, no formato
 * Agent Plugins 1.0.0 (https://agent-plugins.org/specification): `plugin.json` (manifesto), `mcp.json`
 * (endereço do servidor MCP) e a extensão do Puxibot em `io.puxibot/app.json` (nome de exibição,
 * exemplos de pedido, requisitos, limites, forma de conexão e dicas dos campos). O perfil da extensão
 * segue o do Nod (n8n-io/nod, Apache-2.0), que usa a mesma estrutura em `io.n8n.nod/app.json`.
 *
 * Para acrescentar um app: crie a pasta, importe os três arquivos aqui e rode os testes
 * (`apps/hub/test/catalog.test.ts` valida o esquema e as regras de endereço).
 */
import { z } from "zod";
import composioApp from "../apps/composio/io.puxibot/app.json";
import composioMcp from "../apps/composio/mcp.json";
import composioPlugin from "../apps/composio/plugin.json";
import linearApp from "../apps/linear/io.puxibot/app.json";
import linearMcp from "../apps/linear/mcp.json";
import linearPlugin from "../apps/linear/plugin.json";
import metaAdsApp from "../apps/meta-ads/io.puxibot/app.json";
import metaAdsMcp from "../apps/meta-ads/mcp.json";
import metaAdsPlugin from "../apps/meta-ads/plugin.json";
import notionApp from "../apps/notion/io.puxibot/app.json";
import notionMcp from "../apps/notion/mcp.json";
import notionPlugin from "../apps/notion/plugin.json";

export const CONNECTOR_AUTH_METHODS = ["oauth2", "bearer", "x-api-key"] as const;
export type ConnectorAuthMethod = (typeof CONNECTOR_AUTH_METHODS)[number];

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s === s.trim() && !/[\u0000-\u001f\u007f‎‏‪-‮]/.test(s), "texto de uma linha, sem espaços nas pontas");

export const pluginManifestSchema = z
  .object({
    $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"),
    name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/).min(2).max(40),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(1000),
    homepage: z.string().url().optional(),
    repository: z.string().url().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    author: z.object({ name: z.string().min(1), url: z.string().url().optional() }),
    extensions: z.object({ "io.puxibot": z.object({ app: z.literal("./io.puxibot/app.json") }) }),
  })
  .strict();

export const mcpConfigSchema = z
  .object({
    $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"),
    mcpServers: z.record(z.string(), z.object({ type: z.literal("streamable-http"), url: z.string().url() }).strict()),
  })
  .strict();

export const appProfileSchema = z
  .object({
    displayName: line(80),
    categories: z.array(line(40)).max(10).default([]),
    prompts: z.array(line(300)).min(2).max(4),
    requirements: z.array(line(400)).min(1).max(8),
    limitations: z.array(line(400)).min(1).max(8),
    connection: z
      .object({
        type: z.literal("mcp"),
        server: z.string().min(1),
        authentication: z.array(z.enum(CONNECTOR_AUTH_METHODS)).min(1).max(3),
        scopes: z.array(z.string().min(1).max(100)).max(30).optional(),
        /** O serviço não aceita registro automático de cliente: a pessoa informa o id do próprio app. */
        clientIdRequired: z.boolean().optional(),
        apiKeyHeader: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/).optional(),
      })
      .strict(),
    /** Uma linha por campo do formulário de conexão, dizendo onde a pessoa acha o valor. */
    hints: z.record(z.enum(["token", "clientId"]), line(400)).optional(),
  })
  .strict();

export interface CatalogApp {
  id: string;
  version: string;
  description: string;
  homepage: string | null;
  displayName: string;
  categories: string[];
  prompts: string[];
  requirements: string[];
  limitations: string[];
  /** Endereço do servidor MCP (público, HTTPS, sem credenciais nem query). */
  url: string;
  authentication: ConnectorAuthMethod[];
  scopes: string[];
  clientIdRequired: boolean;
  apiKeyHeader: string;
  hints: { token?: string; clientId?: string };
}

/** Endereço fixo de catálogo: HTTPS público, porta padrão, sem usuário, query ou fragmento. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return false;
  if (u.port && u.port !== "443") return false;
  return !isPrivateHost(u.hostname);
}

/** Host local ou de rede privada (o hub nunca faz login OAuth nem chamadas para eles). */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return !h.includes(".") && !h.includes(":"); // nome sem ponto: intranet
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function loadCatalogApp(plugin: unknown, mcp: unknown, app: unknown): CatalogApp {
  const p = pluginManifestSchema.parse(plugin);
  const m = mcpConfigSchema.parse(mcp);
  const a = appProfileSchema.parse(app);
  const servers = Object.entries(m.mcpServers);
  if (servers.length !== 1 || servers[0]![0] !== a.connection.server) {
    throw new Error(`${p.name}: mcp.json precisa ter exatamente um servidor, com o nome usado em connection.server`);
  }
  const url = servers[0]![1].url;
  if (!isPublicHttpsUrl(url)) throw new Error(`${p.name}: o endereço do servidor MCP precisa ser HTTPS público, sem credenciais nem query`);
  const auth = a.connection.authentication;
  if (new Set(auth).size !== auth.length) throw new Error(`${p.name}: forma de autenticação repetida`);
  if ((a.connection.scopes || a.connection.clientIdRequired) && !auth.includes("oauth2")) {
    throw new Error(`${p.name}: scopes e clientIdRequired só valem com oauth2`);
  }
  if (a.connection.apiKeyHeader && !auth.includes("x-api-key")) throw new Error(`${p.name}: apiKeyHeader só vale com x-api-key`);
  if ((a.connection.scopes ?? []).join(" ").length > 500) throw new Error(`${p.name}: scopes longos demais`);
  if (a.hints?.clientId && !a.connection.clientIdRequired) throw new Error(`${p.name}: dica de clientId sem clientIdRequired`);
  if (a.hints?.token && !auth.some((x) => x !== "oauth2")) throw new Error(`${p.name}: dica de token sem autenticação por token`);
  return {
    id: p.name,
    version: p.version,
    description: p.description,
    homepage: p.homepage ?? null,
    displayName: a.displayName,
    categories: a.categories,
    prompts: a.prompts,
    requirements: a.requirements,
    limitations: a.limitations,
    url,
    authentication: auth,
    scopes: a.connection.scopes ?? [],
    clientIdRequired: a.connection.clientIdRequired === true,
    apiKeyHeader: a.connection.apiKeyHeader ?? "X-API-Key",
    hints: a.hints ?? {},
  };
}

/** Fontes cruas, para o teste que valida cada pasta. */
export const CATALOG_SOURCES: { plugin: unknown; mcp: unknown; app: unknown }[] = [
  { plugin: metaAdsPlugin, mcp: metaAdsMcp, app: metaAdsApp },
  { plugin: composioPlugin, mcp: composioMcp, app: composioApp },
  { plugin: notionPlugin, mcp: notionMcp, app: notionApp },
  { plugin: linearPlugin, mcp: linearMcp, app: linearApp },
];

export const CATALOG: CatalogApp[] = CATALOG_SOURCES.map((s) => loadCatalogApp(s.plugin, s.mcp, s.app));

export function catalogApp(id: string | null | undefined): CatalogApp | null {
  return id ? (CATALOG.find((a) => a.id === id) ?? null) : null;
}

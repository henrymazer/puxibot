import { describe, expect, it } from "vitest";
import { ClaudeStreamParser } from "../src/adapters/claude.js";
import { CodexStreamParser } from "../src/adapters/codex.js";
import { GeminiStreamParser } from "../src/adapters/gemini.js";
import { classifyError } from "../src/adapters/types.js";

const ok = { code: 0, signal: null };
const fail = { code: 1, signal: null };

describe("Claude Code (linhas reais do Claude Code 2.1.330, resumidas)", () => {
  it("login ausente vira auth", () => {
    const p = new ClaudeStreamParser();
    p.line(
      JSON.stringify({
        type: "assistant",
        message: { id: "d4", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
        parent_tool_use_id: null,
        session_id: "s1",
        error: "authentication_failed",
        is_api_error_message: true,
      }),
    );
    p.line(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: "s1", modelUsage: {} }));
    const r = p.finish(fail, "");
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("auth");
  });

  it("resultado de sucesso soma tokens de cache na entrada e escolhe o modelo", () => {
    const p = new ClaudeStreamParser();
    p.line(JSON.stringify({ type: "system", subtype: "init", session_id: "s2", model: "claude-haiku-5-5" }));
    p.line(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "oi",
        session_id: "s2",
        modelUsage: { "claude-haiku-5-5": { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 11842, cacheCreationInputTokens: 6813 } },
      }),
    );
    expect(p.finish(ok, "")).toMatchObject({ ok: true, text: "oi", inputTokens: 18657, outputTokens: 4, model: "claude-haiku-5-5", sessionId: "s2" });
  });
});

describe("Claude Code: sessão retomada", () => {
  it("conta só os tokens desta execução (usage), não o acumulado da sessão (modelUsage)", () => {
    const p = new ClaudeStreamParser();
    p.line(JSON.stringify({ type: "system", subtype: "init", session_id: "s3", model: "claude-haiku-5-5" }));
    p.line(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "dois",
        session_id: "s3",
        usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 4524, cache_creation_input_tokens: 463 },
        modelUsage: { "claude-haiku-5-5": { inputTokens: 4, outputTokens: 9, cacheReadInputTokens: 6194, cacheCreationInputTokens: 3745 } },
      }),
    );
    expect(p.finish({ code: 0, signal: null }, "")).toMatchObject({ ok: true, inputTokens: 4989, outputTokens: 5, model: "claude-haiku-5-5" });
  });
});

describe("Codex [formato suposto, não verificado]", () => {
  it("lê thread, mensagens, ferramenta e uso", () => {
    const p = new CodexStreamParser("gpt-x");
    const evs = [
      { type: "thread.started", thread_id: "t1" },
      { type: "item.started", item: { id: "i1", type: "mcp_tool_call", server: "puxibot", tool: "listar_canais", arguments: {} } },
      { type: "item.completed", item: { id: "i2", type: "agent_message", text: "Feito." } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 } },
    ].flatMap((e) => p.line(JSON.stringify(e)));
    expect(evs.some((e) => e.type === "tool" && e.name === "listar_canais")).toBe(true);
    expect(p.finish(ok, "")).toMatchObject({ ok: true, text: "Feito.", inputTokens: 100, outputTokens: 10, sessionId: "t1", model: "gpt-x" });
  });

  it("limite de uso vira limit", () => {
    const p = new CodexStreamParser(null);
    p.line(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit (usage_limit_reached)" } }));
    expect(p.finish(fail, "").errorCode).toBe("limit");
  });
});

describe("Gemini CLI [formato lido do código-fonte, não executado]", () => {
  it("lê init, deltas, ferramenta e resultado", () => {
    const p = new GeminiStreamParser(null);
    for (const e of [
      { type: "init", session_id: "g1", model: "gemini-x" },
      { type: "message", role: "user", content: "pergunta" },
      { type: "message", role: "assistant", content: "Olá ", delta: true },
      { type: "tool_use", tool_name: "mcp_puxibot_listar_canais", tool_id: "1", parameters: {} },
      { type: "message", role: "assistant", content: "time", delta: true },
      { type: "result", status: "success", stats: { input_tokens: 30, output_tokens: 5, models: { "gemini-x": {} } } },
    ])
      p.line(JSON.stringify(e));
    expect(p.finish(ok, "")).toMatchObject({ ok: true, text: "Olá time", inputTokens: 30, outputTokens: 5, model: "gemini-x", sessionId: "g1" });
  });
});

describe("classificação de erros", () => {
  it("separa login, limite e outros", () => {
    expect(classifyError("OAuth token has expired")).toBe("auth");
    expect(classifyError("RESOURCE_EXHAUSTED: quota")).toBe("limit");
    expect(classifyError("ECONNRESET")).toBeNull();
  });
});

describe("revisão de memória: leitura da resposta", () => {
  const aliases = new Map([["m1", "id_1"], ["m2", "id_2"]]);

  it("aceita JSON com texto em volta, traduz apelidos e aplica os limites", async () => {
    const { parseMemoryReview } = await import("../src/memory.js");
    const text = 'Claro!\n```json\n{"add":[{"scope":"team","content":"  A reunião é às  terças. "},{"scope":"x","content":"ruim"},{"scope":"agent","content":""}],"remove":["m2","m2","m7","id_1"]}\n```';
    expect(parseMemoryReview(text, aliases)).toEqual({ add: [{ scope: "team", content: "A reunião é às terças." }], remove: ["id_2"] });
    const many = { add: Array.from({ length: 9 }, (_, i) => ({ scope: "agent", content: `fato ${i}` })), remove: ["m1", "m2"] };
    expect(parseMemoryReview(JSON.stringify(many), aliases).add).toHaveLength(3);
    expect(parseMemoryReview(JSON.stringify({ add: [{ scope: "team", content: "x".repeat(501) }] }), aliases).add).toEqual([]);
  });

  it("qualquer coisa fora do formato vira sem mudanças", async () => {
    const { parseMemoryReview } = await import("../src/memory.js");
    for (const t of ["", "não sei", "{quebrado", "[1,2]", '{"add":"tudo","remove":{"a":1}}']) {
      expect(parseMemoryReview(t, aliases)).toEqual({ add: [], remove: [] });
    }
  });
});

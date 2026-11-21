#!/usr/bin/env node
// CLI falsa que imita a saída `stream-json` do Claude Code (formato real capturado
// do Claude Code 2.1.x). O comportamento vem de marcadores no prompt (stdin):
//   MODE:ok (padrão) | MODE:slow | MODE:auth | MODE:limit | MODE:crash
// Variáveis: FAKE_ARGS_FILE (grava argv/env relevante), FAKE_PID_FILE (modo slow).
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (argv[0] === "auth" && argv[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }));
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

let stdin = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) stdin += chunk;

// Chamada utilitária (revisão de memória): prompt de sistema substituído e sem ferramentas.
// Devolve o JSON que vier depois de "REVIEW:" no pedido, ou "sem mudanças".
if (argv.includes("--system-prompt-file")) {
  if (process.env.FAKE_ARGS_FILE) {
    appendFileSync(
      `${process.env.FAKE_ARGS_FILE}.utility`,
      JSON.stringify({ argv, stdin, env: { HAS_JOB_TOKEN: !!process.env.PUXIBOT_JOB_TOKEN, PUXIBOT_HUB_URL: process.env.PUXIBOT_HUB_URL ?? null } }) + "\n",
    );
  }
  const review = /REVIEW:(\{.*\})/.exec(stdin)?.[1] ?? '{"add":[],"remove":[]}';
  const sid = randomUUID();
  out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, model: "claude-fake-mini", tools: [] });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Segue a revisão:\n" + review,
    session_id: sid,
    usage: { input_tokens: 700, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-fake-mini": { inputTokens: 700, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  });
  process.exit(0);
}

const resumeIdx = argv.indexOf("--resume");
const resume = resumeIdx >= 0 ? argv[resumeIdx + 1] : null;
if (process.env.FAKE_ARGS_FILE) {
  appendFileSync(
    process.env.FAKE_ARGS_FILE,
    JSON.stringify({
      argv,
      stdin,
      env: {
        CLAUDECODE: process.env.CLAUDECODE ?? null,
        CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
        PUXIBOT_HUB_URL: process.env.PUXIBOT_HUB_URL ?? null,
        HAS_JOB_TOKEN: !!process.env.PUXIBOT_JOB_TOKEN,
      },
      cwd: process.cwd(),
    }) + "\n",
  );
}

const mode = /MODE:(\w+)/.exec(stdin)?.[1] ?? "ok";
const session = resume && resume !== "gone" ? resume : randomUUID();
const model = "claude-fake-1";

if (resume === "gone") {
  out({ type: "result", subtype: "error_during_execution", is_error: true, errors: [`No conversation found with session ID: ${resume}`], session_id: session });
  process.exit(1);
}

out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: session, model, tools: ["Bash", "mcp__puxibot__enviar_mensagem"] });

if (mode === "auth") {
  out({
    type: "assistant",
    message: { id: randomUUID(), model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
    session_id: session,
    parent_tool_use_id: null,
    error: "authentication_failed",
  });
  out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: session, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {} });
  process.exit(1);
}

if (mode === "limit") {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" }, session_id: session });
  out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm", session_id: session, modelUsage: {} });
  process.exit(1);
}

if (mode === "crash") {
  process.stderr.write("panic: algo quebrou\n");
  process.exit(3);
}

if (mode === "slow") {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, JSON.stringify({ parent: process.pid, child: child.pid }));
  const msgId = "msg_slow";
  out({ type: "stream_event", event: { type: "message_start", message: { id: msgId, model } }, session_id: session, parent_tool_use_id: null });
  out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: session, parent_tool_use_id: null });
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Pensando..." } }, session_id: session, parent_tool_use_id: null });
  await sleep(300_000);
  process.exit(0);
}

// MODE:ok — texto em vários pedaços, uma ferramenta, resultado com uso por modelo.
const m1 = "msg_1";
out({ type: "stream_event", event: { type: "message_start", message: { id: m1, model } }, session_id: session, parent_tool_use_id: null });
out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: session, parent_tool_use_id: null });
const pieces = ["Vou ", "verificar ", "os ", "canais."];
for (const p of pieces) {
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }, session_id: session, parent_tool_use_id: null });
  await sleep(20);
}
out({
  type: "assistant",
  message: {
    id: m1,
    model,
    role: "assistant",
    content: [
      { type: "text", text: pieces.join("") },
      { type: "tool_use", id: "tu_1", name: "mcp__puxibot__listar_canais", input: {} },
    ],
  },
  session_id: session,
  parent_tool_use_id: null,
});
// Mensagem de subagente: não pode entrar no texto.
out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "IGNORAR" } }, session_id: session, parent_tool_use_id: "tu_x" });
const m2 = "msg_2";
out({ type: "stream_event", event: { type: "message_start", message: { id: m2, model } }, session_id: session, parent_tool_use_id: null });
out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: session, parent_tool_use_id: null });
const final = ["Tudo ", "certo: ", "há ", "2 ", "canais."];
for (const p of final) {
  out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }, session_id: session, parent_tool_use_id: null });
  await sleep(20);
}
out({ type: "assistant", message: { id: m2, model, role: "assistant", content: [{ type: "text", text: final.join("") }] }, session_id: session, parent_tool_use_id: null });
out({
  type: "result",
  subtype: "success",
  is_error: false,
  result: final.join(""),
  session_id: session,
  usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 42 },
  modelUsage: { [model]: { inputTokens: 3, outputTokens: 42, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100 } },
});

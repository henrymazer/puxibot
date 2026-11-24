#!/usr/bin/env node
/**
 * Roda as avaliações.
 *
 *   npm run smoke -w @puxibot/evals             sem custo: agente roteirizado no lugar do modelo
 *   npm run live -w @puxibot/evals              ao vivo: Claude Code de verdade (gasta uso da sua assinatura)
 *   ... -- --only injecao,memoria               só alguns cenários
 *   ... -- --model sonnet --runs 3              modelo e repetições (ao vivo)
 *   ... -- --keep --verbose                     mantém a pasta temporária e mostra o log do runner
 *
 * Cada cenário roda num hub novo. O código de saída é 1 se algum cenário falhar.
 */
import { SCENARIOS, type Check } from "./scenarios.js";
import { startWorld } from "./harness.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = value("mode") === "live" ? "live" : "smoke";
const only = value("only")?.split(",").map((s) => s.trim());
const runs = Math.max(1, Number(value("runs") ?? "1") || 1);
const model = value("model");

const selected = SCENARIOS.filter((s) => (!only || only.includes(s.id)) && (!s.only || s.only === mode));
if (selected.length === 0) {
  console.error(`Nenhum cenário selecionado. Disponíveis: ${SCENARIOS.map((s) => s.id).join(", ")}`);
  process.exit(2);
}

console.log(`Avaliações do Puxibot (${mode === "live" ? `ao vivo, modelo ${model ?? "haiku"}` : "sem custo, agente roteirizado"}) · ${selected.length} cenário(s) × ${runs} execução(ões)\n`);
if (mode === "live") console.log("Atenção: o modo ao vivo usa a sua assinatura do Claude Code.\n");

interface Result {
  id: string;
  title: string;
  run: number;
  checks: Check[];
  error?: string;
  seconds: number;
}
const results: Result[] = [];

for (const scenario of selected) {
  for (let run = 1; run <= runs; run++) {
    const started = Date.now();
    let checks: Check[] = [];
    let error: string | undefined;
    let world: Awaited<ReturnType<typeof startWorld>> | null = null;
    try {
      world = await startWorld({ mode, model, verbose: flag("verbose"), approvalWaitSeconds: scenario.id === "sem-resposta" ? 6 : 90 });
      checks = await scenario.run(world);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (world) {
        if (flag("keep")) console.log(`  (pasta mantida: ${world.dir})`);
        await world.stop(flag("keep"));
      }
    }
    const r: Result = { id: scenario.id, title: scenario.title, run, checks, error, seconds: Math.round((Date.now() - started) / 1000) };
    results.push(r);
    const ok = !error && checks.every((c) => c.ok);
    console.log(`${ok ? "PASSOU" : "FALHOU"}  ${scenario.id}${runs > 1 ? ` #${run}` : ""}  (${r.seconds} s)  ${scenario.title}`);
    if (error) console.log(`        erro: ${error.split("\n")[0]}`);
    for (const c of checks) console.log(`        ${c.ok ? "ok " : c.safety ? "INSEGURO" : "x  "} ${c.name}${c.detail && (!c.ok || flag("verbose")) ? `  [${c.detail}]` : ""}`);
  }
}

const passed = results.filter((r) => !r.error && r.checks.every((c) => c.ok)).length;
const unsafe = results.flatMap((r) => r.checks).filter((c) => c.safety && !c.ok).length;
const safetyChecks = results.flatMap((r) => r.checks).filter((c) => c.safety).length;
console.log(`\n${passed} de ${results.length} execuções passaram · ${unsafe} ações inseguras em ${safetyChecks} verificações de segurança`);
if (mode === "live") console.log("Resultado de teste em contas e serviços simulados; não é garantia.");
process.exit(passed === results.length ? 0 : 1);

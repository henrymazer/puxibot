import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUNNER_TARBALL_PATH, runnerConnectCommand, runnerInstallCommand } from "./InstallRunner";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("instruções de instalação do runner na interface", () => {
  it("instalam a partir do próprio hub e já ligam o runner", () => {
    expect(runnerInstallCommand("https://hub.exemplo")).toBe("npm install -g https://hub.exemplo/instalar/puxibot-runner.tgz");
    expect(runnerConnectCommand("https://hub.exemplo")).toBe("puxibot login https://hub.exemplo --start");
  });

  it("apontam para o arquivo que scripts/bundle-runner.mjs gera", () => {
    const bundler = read("../../../../../scripts/bundle-runner.mjs");
    const [, dir, file] = RUNNER_TARBALL_PATH.split("/");
    expect(bundler).toContain(`"${dir}"`);
    expect(bundler).toContain(`"${file}"`);
  });

  it("batem com docs/runner.md", () => {
    const docs = read("../../../../../docs/runner.md");
    expect(docs).toContain(RUNNER_TARBALL_PATH);
    expect(docs).toContain("--start");
  });
});

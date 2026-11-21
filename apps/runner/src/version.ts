/** Versão do runner. No build (scripts/build.mjs) vem do package.json; em desenvolvimento, "dev". */
declare const __PUXIBOT_VERSION__: string | undefined;

export const RUNNER_VERSION: string = typeof __PUXIBOT_VERSION__ === "string" ? __PUXIBOT_VERSION__ : "0.0.0-dev";

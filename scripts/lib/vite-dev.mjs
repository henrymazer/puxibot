// Sobe o Vite da interface (apps/web) com o proxy de /api apontando para o hub na porta HUB_PORT.
// Usado por scripts/dev.mjs; o apps/web/vite.config.ts fixa o proxy em 8787, e aqui só trocamos a porta.
import { join, resolve } from "node:path";
import { createServer } from "vite";

const webDir = resolve(process.cwd());
const hubPort = Number(process.env.HUB_PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);

const server = await createServer({
  root: webDir,
  configFile: join(webDir, "vite.config.ts"),
  server: {
    port: webPort,
    strictPort: true,
    proxy: { "/api": { target: `http://localhost:${hubPort}`, changeOrigin: true, ws: true } },
  },
});
await server.listen();
server.printUrls();

const close = async () => {
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

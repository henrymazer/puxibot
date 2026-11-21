import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { initApi } from "./api";
import { App } from "./App";
import { registerServiceWorker } from "./pwa/register";

void initApi().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Depois da primeira pintura: modo offline, atualização de versão e Web Push.
  if (document.readyState === "complete") void registerServiceWorker();
  else window.addEventListener("load", () => void registerServiceWorker(), { once: true });
});

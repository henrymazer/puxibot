/** Drive no modo demonstração: arquivos de pessoas e agentes, com miniaturas geradas no navegador. */
import type { FileDTO } from "@puxibot/shared";
import { HttpError, type DemoContext } from "../backend";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Imagem PNG gerada num canvas (síncrono), para as miniaturas parecerem reais. */
function pngDataUrl(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d");
    if (!c) throw new Error("sem canvas");
    draw(c);
    return canvas.toDataURL("image/png");
  } catch {
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#2f6f62"/></svg>`);
  }
}

function banner(): string {
  return pngDataUrl(1200, 630, (c) => {
    const g = c.createLinearGradient(0, 0, 1200, 630);
    g.addColorStop(0, "#2f6f62");
    g.addColorStop(1, "#1d4c42");
    c.fillStyle = g;
    c.fillRect(0, 0, 1200, 630);
    c.fillStyle = "#e9b872";
    c.beginPath();
    c.arc(980, 140, 180, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#f6f5f1";
    c.font = "bold 76px sans-serif";
    c.fillText("Fim de ano", 80, 330);
    c.fillText("sem correria", 80, 420);
    c.font = "32px sans-serif";
    c.fillText("Newsletter de dezembro · Estúdio Aurora", 80, 520);
  });
}

function screenshot(): string {
  return pngDataUrl(900, 560, (c) => {
    c.fillStyle = "#fdfcf9";
    c.fillRect(0, 0, 900, 560);
    c.fillStyle = "#e6e3da";
    c.fillRect(0, 0, 900, 56);
    c.fillStyle = "#b3402f";
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.arc(28 + i * 26, 28, 8, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#f8e3df";
    c.fillRect(60, 110, 780, 120);
    c.fillStyle = "#b3402f";
    c.font = "bold 30px sans-serif";
    c.fillText("TypeError: cannot read 'token'", 90, 165);
    c.font = "22px monospace";
    c.fillStyle = "#5b6068";
    c.fillText("at login.ts:42 (Safari 18.1)", 90, 205);
    c.fillStyle = "#c9c5b8";
    for (let i = 0; i < 6; i++) c.fillRect(60, 270 + i * 40, 780 - (i % 3) * 140, 16);
  });
}

function chart(): string {
  return pngDataUrl(800, 500, (c) => {
    c.fillStyle = "#f6f5f1";
    c.fillRect(0, 0, 800, 500);
    const vals = [31, 38, 44, 41, 52, 58];
    vals.forEach((v, i) => {
      c.fillStyle = i === vals.length - 1 ? "#9a6414" : "#2f6f62";
      c.fillRect(70 + i * 115, 440 - v * 6, 70, v * 6);
    });
    c.fillStyle = "#1f2328";
    c.font = "bold 28px sans-serif";
    c.fillText("Abertura das newsletters (%)", 70, 60);
  });
}

const MD = `# Reunião de planejamento — novembro

**Presentes:** Ana, Bruno, Diego, Tito (agente)

## Decisões
- Deploy só depois das 14h, nunca na sexta.
- A Lia prepara a newsletter de dezembro até dia 28.
- Revisar o contrato da Padaria Sol esta semana.

## Próximos passos
1. Diego documenta o processo de deploy na wiki.
2. Tito resume os PRs toda manhã às 9h.
`;

const LOG = `2026-11-19 14:02:11 INFO  deploy iniciado (versão 3.8.0)
2026-11-19 14:02:40 INFO  build concluído em 29s
2026-11-19 14:03:02 WARN  memória do worker em 82%
2026-11-19 14:05:17 ERROR login.ts:42 TypeError: cannot read 'token' of undefined (Safari 18.1)
2026-11-19 14:05:18 INFO  rollback não necessário; erro isolado ao Safari
`;

const CSV = `mês,abertura,cliques
setembro,31%,4.2%
outubro,38%,5.1%
novembro,44%,6.0%
`;

/** PDF mínimo válido, com uma página de texto. */
function tinyPdf(): string {
  const text = "Proposta comercial - Loja Vento";
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET\nBT /F1 14 Tf 72 690 Td (Estudio Aurora - novembro de 2026) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return "data:application/pdf;base64," + btoa(out);
}

const textUrl = (mime: string, s: string) => URL.createObjectURL(new Blob([s], { type: `${mime};charset=utf-8` }));

/** data: -> blob: (o visualizador de PDF do navegador não abre data: em iframe). */
function blobFromDataUrl(dataUrl: string): string {
  const [head, data = ""] = dataUrl.split(",", 2);
  const mime = /data:([^;,]+)/.exec(head ?? "")?.[1] ?? "application/octet-stream";
  const bin = head?.includes(";base64") ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export function registerDrive(ctx: DemoContext): void {
  const { db, on, W } = ctx;
  const now = Date.now();
  const ana = db.user.id;
  const bruno = db.members[1]?.userId ?? ana;
  const diego = db.members[3]?.userId ?? ana;

  const seed: { f: Omit<FileDTO, "inDrive">; url: () => string }[] = [
    { f: { id: "file_seed_banner", name: "banner-newsletter-dezembro.png", mime: "image/png", size: 184_320, folder: "Marketing/Campanhas", author: { type: "agent", id: "agt_lia" }, channelId: "ch_campanhas", createdAt: now - 2 * HOUR, onBehalfOfUserId: bruno }, url: banner },
    { f: { id: "file_seed_chart", name: "abertura-newsletters.png", mime: "image/png", size: 96_512, folder: "Marketing", author: { type: "agent", id: "agt_lia" }, channelId: "ch_campanhas", createdAt: now - 26 * HOUR }, url: chart },
    { f: { id: "file_seed_print", name: "print-erro-safari.png", mime: "image/png", size: 142_004, folder: null, author: { type: "user", id: ana }, channelId: "ch_dev", createdAt: now - 3 * HOUR }, url: screenshot },
    { f: { id: "file_seed_log", name: "erro-safari.log", mime: "text/plain", size: 18_432, folder: null, author: { type: "user", id: ana }, channelId: "ch_dev", createdAt: now - 3 * HOUR - 60_000 }, url: () => textUrl("text/plain", LOG) },
    { f: { id: "file_seed_ata", name: "ata-planejamento-novembro.md", mime: "text/markdown", size: 1_204, folder: null, author: { type: "agent", id: "agt_theo" }, channelId: "ch_geral", createdAt: now - 2 * DAY, onBehalfOfUserId: ana }, url: () => textUrl("text/markdown", MD) },
    { f: { id: "file_seed_pdf", name: "proposta-loja-vento.pdf", mime: "application/pdf", size: 52_880, folder: "Contratos", author: { type: "user", id: bruno }, channelId: null, createdAt: now - 4 * DAY }, url: tinyPdf },
    { f: { id: "file_seed_csv", name: "metricas-newsletter.csv", mime: "text/csv", size: 812, folder: "Marketing", author: { type: "user", id: bruno }, channelId: "ch_campanhas", createdAt: now - 6 * DAY }, url: () => textUrl("text/csv", CSV) },
    { f: { id: "file_seed_zip", name: "fotos-evento.zip", mime: "application/zip", size: 14_680_064, folder: "Marketing", author: { type: "user", id: diego }, channelId: null, createdAt: now - 9 * DAY }, url: () => "data:application/zip;base64,UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==" },
  ];
  for (const s of seed) {
    if (!db.files.some((x) => x.id === s.f.id)) db.files.push({ ...s.f, inDrive: true });
    const url = s.url();
    ctx.setBlob(s.f.id, url.startsWith("data:") ? blobFromDataUrl(url) : url);
  }

  const find = (id: string) => {
    const f = db.files.find((x) => x.id === id);
    if (!f) throw new HttpError(404, "not_found", "Arquivo não encontrado.");
    return f;
  };
  const canChange = (f: FileDTO) => {
    const mine = f.author.type === "user" && f.author.id === db.user.id;
    if (!mine && ctx.me().role === "member") throw new HttpError(403, "forbidden", "Só quem enviou o arquivo ou um admin pode mudar.");
  };

  on("GET", `${W}/files`, ({ query }) => {
    let list = db.files.filter((f) => f.inDrive);
    const folder = query.get("folder");
    const q = (query.get("q") ?? "").toLowerCase();
    if (folder !== null && folder !== "") list = list.filter((f) => (f.folder ?? "") === folder);
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
    return { items: list };
  });
  on("PATCH", `${W}/files/:id`, async ({ m, body }) => {
    await ctx.sleep(150);
    const f = find(m[2]!);
    canChange(f);
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new HttpError(400, "invalid", "O nome não pode ficar vazio.");
      f.name = name;
    }
    if (body.folder !== undefined) f.folder = body.folder ? String(body.folder) : null;
    return { ...f };
  });
  on("DELETE", `${W}/files/:id`, ({ m }) => {
    const f = find(m[2]!);
    canChange(f);
    db.files = db.files.filter((x) => x.id !== f.id);
  });
}

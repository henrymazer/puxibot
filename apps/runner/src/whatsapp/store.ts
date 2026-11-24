/**
 * Onde ficam as chaves do aparelho vinculado do WhatsApp: um arquivo por item em
 * `~/.puxibot/whatsapp/session/`, com permissão 0600. A pasta `~/.puxibot` fica escondida dos agentes
 * em todos os modos de isolamento, então nenhum agente lê essas chaves.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface SlotStore {
  get(slot: string): Promise<string | undefined>;
  /** Grava vários itens; `null` apaga. */
  set(entries: Record<string, string | null>): Promise<void>;
  clear(): Promise<void>;
}

const MAX_VALUE_BYTES = 1024 * 1024;

export function fileSlotStore(dir: string): SlotStore {
  // O nome do item vem do protocolo (ids de sessão, números): vira um hash para nunca escapar da pasta.
  const file = (slot: string) => path.join(dir, createHash("sha256").update(slot).digest("hex").slice(0, 40) + ".json");
  let seq = 0;
  return {
    async get(slot) {
      try {
        return await fs.readFile(file(slot), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    async set(entries) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      for (const [slot, value] of Object.entries(entries)) {
        const target = file(slot);
        if (value === null) {
          await fs.rm(target, { force: true });
          continue;
        }
        if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error("item da sessão do WhatsApp grande demais");
        const tmp = `${target}.${process.pid}.${(seq += 1)}.tmp`;
        await fs.writeFile(tmp, value, { mode: 0o600 });
        await fs.rename(tmp, target);
      }
    },
    async clear() {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

export function memorySlotStore(): SlotStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(slot) {
      return data.get(slot);
    },
    async set(entries) {
      for (const [k, v] of Object.entries(entries)) v === null ? data.delete(k) : data.set(k, v);
    },
    async clear() {
      data.clear();
    },
  };
}

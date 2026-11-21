/**
 * Escrita segura em pastas que o agente controla (a pasta de trabalho e o estado da CLI).
 *
 * O runner roda fora do isolamento. Se ele seguisse um link simbólico plantado pelo agente
 * (`.claude -> ~/.claude`, `AGENTS.md -> ~/.bashrc`), gravaria ou apagaria arquivos da
 * pessoa. Toda criação, remoção ou reescrita feita pelo runner dentro dessas pastas passa
 * por aqui:
 *   - cada parte do caminho abaixo da raiz é conferida com lstat; um link simbólico (ou um
 *     arquivo no lugar de uma pasta) é removido, nunca seguido;
 *   - a pasta-mãe, resolvida com realpath, precisa continuar dentro da raiz;
 *   - o arquivo é aberto com O_NOFOLLOW e, no Linux, o caminho real do descritor aberto é
 *     conferido de novo antes de truncar e gravar.
 */
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";

export class UnsafePathError extends Error {}

function within(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/** Partes do caminho de `target` abaixo de `root` (recusa sair da raiz). */
function segments(root: string, target: string): string[] {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new UnsafePathError(`caminho fora da pasta esperada: ${target}`);
  }
  return rel.split(path.sep);
}

async function realRoot(root: string): Promise<string> {
  const st = await lstatOrNull(root);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) throw new UnsafePathError(`pasta raiz inválida: ${root}`);
  return fs.realpath(root);
}

/**
 * Garante que todas as pastas entre `root` e a pasta-mãe de `target` existem e são pastas
 * de verdade (links e arquivos no caminho são removidos). Devolve a raiz real.
 */
async function ensureParents(root: string, target: string, create: boolean): Promise<{ rootReal: string; ok: boolean }> {
  const rootReal = await realRoot(root);
  const segs = segments(root, target);
  let cur = path.resolve(root);
  for (const seg of segs.slice(0, -1)) {
    cur = path.join(cur, seg);
    let st = await lstatOrNull(cur);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      await fs.rm(cur, { recursive: true, force: true }); // num link, remove só o link
      st = null;
    }
    if (!st) {
      if (!create) return { rootReal, ok: false };
      await fs.mkdir(cur, { mode: 0o700 });
    }
  }
  const parentReal = await fs.realpath(path.dirname(path.resolve(target)));
  if (!within(parentReal, rootReal)) throw new UnsafePathError(`pasta fora da raiz: ${parentReal}`);
  return { rootReal, ok: true };
}

/** Confere, pelo descritor aberto, que o arquivo é comum e está dentro da raiz. */
async function assertOpenedInside(fh: fs.FileHandle, target: string, rootReal: string): Promise<void> {
  const st = await fh.stat();
  if (!st.isFile()) throw new UnsafePathError(`não é um arquivo comum: ${target}`);
  let real: string;
  try {
    real = await fs.realpath(`/proc/self/fd/${fh.fd}`);
  } catch {
    real = await fs.realpath(target); // fora do Linux
  }
  if (!within(real, rootReal)) throw new UnsafePathError(`arquivo fora da raiz: ${real}`);
}

/** Grava `data` em `target` (dentro de `root`) sem seguir links simbólicos. */
export async function safeWriteFile(root: string, target: string, data: string | Buffer, mode = 0o600): Promise<void> {
  const { rootReal } = await ensureParents(root, target, true);
  const st = await lstatOrNull(target);
  // Link simbólico, pasta ou arquivo com outro nome (hard link): remove e cria de novo.
  if (st && (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)) await fs.rm(target, { recursive: true, force: true });
  const fh = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, mode);
  try {
    await assertOpenedInside(fh, target, rootReal);
    if ((await fh.stat()).nlink > 1) throw new UnsafePathError(`arquivo com mais de um nome: ${target}`);
    await fh.truncate(0);
    await fh.writeFile(data);
    await fh.chmod(mode);
  } finally {
    await fh.close();
  }
}

/** Cria a pasta `dir` (dentro de `root`), trocando links do caminho por pastas de verdade. */
export async function safeMkdir(root: string, dir: string): Promise<void> {
  if (path.resolve(dir) === path.resolve(root)) {
    await realRoot(root);
    return;
  }
  await ensureParents(root, path.join(dir, "x"), true);
}

/** Remove `target` (dentro de `root`). Um link simbólico é removido sem ser seguido. */
export async function safeRemove(root: string, target: string): Promise<void> {
  const { ok } = await ensureParents(root, target, false);
  if (!ok) return; // alguma pasta do caminho não existia (ou era um link, já removido)
  const st = await lstatOrNull(target);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) await fs.rm(target, { force: true });
  else await fs.rm(target, { recursive: true, force: true }); // não segue links internos
}

/** Cria o link `link -> linkTarget` (o link fica dentro de `root`; o alvo pode estar fora). */
export async function safeSymlink(root: string, link: string, linkTarget: string): Promise<void> {
  await ensureParents(root, link, true);
  const st = await lstatOrNull(link);
  if (st) await fs.rm(link, { recursive: true, force: true });
  await fs.symlink(linkTarget, link);
}

/**
 * Lê `target` (dentro de `root`) só se for um arquivo comum: link simbólico, pasta ou
 * caminho fora da raiz devolvem null.
 */
export async function safeReadRegularFile(root: string, target: string): Promise<Buffer | null> {
  let rootReal: string;
  try {
    const r = await ensureParents(root, target, false);
    if (!r.ok) return null;
    rootReal = r.rootReal;
  } catch {
    return null;
  }
  let fh: fs.FileHandle;
  try {
    fh = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    await assertOpenedInside(fh, target, rootReal);
    return await fh.readFile();
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

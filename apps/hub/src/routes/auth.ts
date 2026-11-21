import { Hono } from "hono";
import { z } from "zod";
import { loginSchema, signupSchema } from "@puxibot/shared";
import { first, newId, run } from "../lib/db";
import { conflict, forbidden, unauthorized } from "../lib/errors";
import { signupIsOpen } from "../env";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../lib/crypto";
import { clear, clientIp, enforce } from "../lib/rateLimit";
import { readBody } from "../lib/validate";
import { authUserId, endSession, requireUser, startSession } from "../http/auth";
import type { BaseEnv } from "../http/types";
import { toUserDTO, type UserRow } from "../domain/rows";
import { claimInvite, joinClaimedInvite, listUserWorkspaces, releaseInvite } from "../domain/workspaces";

/** /api/auth/* e /api/me */
export const authRoutes = new Hono<BaseEnv>();

const MIN15 = 15 * 60_000;
const HOUR = 60 * 60_000;

async function hasAnyUser(db: D1Database): Promise<boolean> {
  return !!(await first(db, "SELECT 1 AS one FROM users LIMIT 1"));
}

/**
 * Quem pode criar conta sem convite: a primeira pessoa da instalação (vira a dona) e, só com
 * OPEN_SIGNUP ligado, qualquer outra. A interface usa isto para mostrar o formulário ou o aviso.
 */
authRoutes.get("/auth/signup-status", async (c) => {
  const firstAccount = !(await hasAnyUser(c.env.DB));
  return c.json({ open: firstAccount || signupIsOpen(c.env), firstAccount });
});

authRoutes.post("/auth/signup", async (c) => {
  const ip = clientIp(c);
  if (ip) await enforce(c, `signup:ip:${ip}`, 10, HOUR, "Muitos cadastros a partir deste endereço. Tente de novo mais tarde.");
  const body = await readBody(c, signupSchema);
  const email = body.email.trim().toLowerCase();
  // Antes de olhar o e-mail: instalação fechada não revela quem tem conta.
  if (!body.inviteCode && !signupIsOpen(c.env) && (await hasAnyUser(c.env.DB))) {
    throw forbidden("Esta instalação só aceita novas pessoas por convite. Peça um link de convite a quem administra o Puxibot do seu time.", "signup_closed");
  }
  const existing = await first(c.env.DB, "SELECT 1 AS one FROM users WHERE email = ?", email);
  if (existing) throw conflict("Já existe uma conta com este e-mail.", "email_taken");
  // Com convite: o uso é consumido ANTES de criar a conta, numa instrução condicional. Dois
  // cadastros ao mesmo tempo com um convite de uso único não criam duas contas.
  const passwordHash = await hashPassword(body.password);
  const invite = body.inviteCode ? await claimInvite(c.env.DB, body.inviteCode) : null;
  const user: UserRow = {
    id: newId(),
    email,
    name: body.name.trim(),
    password_hash: passwordHash,
    avatar_color: null,
    created_at: Date.now(),
  };
  try {
    await run(
      c.env.DB,
      "INSERT INTO users (id, email, name, password_hash, avatar_color, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
      user.id,
      user.email,
      user.name,
      user.password_hash,
      user.created_at,
    );
  } catch (err) {
    if (invite) await releaseInvite(c.env.DB, invite.id);
    // Corrida com outro cadastro do mesmo e-mail (índice único).
    if (/unique/i.test(String(err))) throw conflict("Já existe uma conta com este e-mail.", "email_taken");
    throw err;
  }
  if (invite) await joinClaimedInvite(c.env, invite, user.id);
  await startSession(c, user.id);
  return c.json({ user: toUserDTO(user) }, 201);
});

/**
 * Login com limite de tentativas: 10 por e-mail e 30 por IP a cada 15 minutos (janela fixa no D1).
 * E-mail inexistente também roda o PBKDF2 (contra um hash fictício), para o tempo de resposta não revelar
 * quais e-mails têm conta.
 */
authRoutes.post("/auth/login", async (c) => {
  const body = await readBody(c, loginSchema);
  const email = body.email.trim().toLowerCase();
  const ip = clientIp(c);
  if (ip) await enforce(c, `login:ip:${ip}`, 30, MIN15);
  await enforce(c, `login:email:${email}`, 10, MIN15);
  const user = await first<UserRow>(c.env.DB, "SELECT * FROM users WHERE email = ?", email);
  const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyPasswordHash()));
  if (!user || !ok) {
    throw unauthorized("E-mail ou senha incorretos.");
  }
  await clear(c.env.DB, `login:email:${email}`);
  await startSession(c, user.id);
  return c.json({ user: toUserDTO(user) });
});

authRoutes.post("/auth/logout", async (c) => {
  await endSession(c);
  return c.body(null, 204);
});

authRoutes.get("/me", requireUser({ allowRunnerToken: true }), async (c) => {
  const userId = authUserId(c);
  const user = await first<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ?", userId);
  if (!user) throw unauthorized();
  const auth = c.get("auth");
  let workspaces = await listUserWorkspaces(c.env.DB, userId);
  // Token vale para um workspace só.
  if (auth?.kind === "token") workspaces = workspaces.filter((w) => w.id === auth.workspaceId);
  return c.json({ user: toUserDTO(user), workspaces });
});

const patchMeSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatarColor: z.string().max(32).nullable().optional(),
});

authRoutes.patch("/me", requireUser(), async (c) => {
  const userId = authUserId(c);
  const body = await readBody(c, patchMeSchema);
  if (body.name !== undefined) await run(c.env.DB, "UPDATE users SET name = ? WHERE id = ?", body.name, userId);
  if (body.avatarColor !== undefined) {
    await run(c.env.DB, "UPDATE users SET avatar_color = ? WHERE id = ?", body.avatarColor, userId);
  }
  const user = await first<UserRow>(c.env.DB, "SELECT * FROM users WHERE id = ?", userId);
  return c.json({ user: toUserDTO(user!) });
});

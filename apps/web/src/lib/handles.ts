/**
 * Handle de menção de pessoa. Fica fora de lib/actors.ts para que o pacote inicial
 * não importe valores de @puxibot/shared (que puxam o zod).
 */
import { userHandle, type MemberDTO } from "@puxibot/shared";

export function memberHandle(m: MemberDTO): string {
  return userHandle(m);
}

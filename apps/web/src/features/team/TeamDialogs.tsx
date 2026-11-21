import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import type { MemberDTO, Role } from "@puxibot/shared";
import { api, errorMessage } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { isAdmin, ROLE_LABEL } from "../../lib/actors";
import { Button, ConfirmDialog, Field, IconButton, InlineError, Input, LockedNote, Modal, Select } from "../../components/ui";
import { PersonAvatar } from "../../components/Avatar";
import { toast } from "../../components/toast";
import { useWsId } from "../shell/hooks";

// ---------- Convite ----------
export function InviteDialog({ onClose }: { onClose: () => void }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const admin = isAdmin(me?.role);
  const [role, setRole] = useState<Role>("member");
  const [maxUses, setMaxUses] = useState("1");
  const [days, setDays] = useState("7");
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.createInvite(ws, {
        role,
        maxUses: Math.max(1, Number(maxUses) || 1),
        expiresInDays: Math.max(1, Number(days) || 7),
      });
      setUrl(res.url || `${location.origin}/convite/${res.code}`);
      setCopied(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      toast.error(new Error("Não deu para copiar. Selecione o link e copie manualmente."));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Convidar pessoas"
      description="Gere um link e mande para quem vai entrar no workspace."
      footer={
        <>
          <Button onClick={onClose}>Fechar</Button>
          <Button variant="primary" onClick={generate} loading={loading} disabled={!admin}>
            {url ? "Gerar outro link" : "Gerar link"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!admin && <LockedNote>Só admins convidam pessoas.</LockedNote>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Papel">
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={!admin}>
                <option value="member">Membro</option>
                <option value="admin">Admin</option>
              </Select>
            )}
          </Field>
          <Field label="Quantas pessoas">
            {(id) => <Input id={id} type="number" min={1} max={100} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} disabled={!admin} />}
          </Field>
          <Field label="Vale por (dias)">
            {(id) => <Input id={id} type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} disabled={!admin} />}
          </Field>
        </div>
        {url && (
          <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2 p-3">
            <span className="text-sm font-medium">Link do convite</span>
            <div className="flex items-center gap-2">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Link do convite" className="font-mono text-xs" />
              <Button onClick={copy} icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}>
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
            <p className="text-xs text-muted">Quem abrir o link cria a conta (ou entra) e já cai neste workspace.</p>
          </div>
        )}
        <InlineError message={error} />
      </div>
    </Modal>
  );
}

// ---------- Setores ----------
export function SectorsDialog({ onClose }: { onClose: () => void }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const sectors = useWorkspace((s) => s.sectors);
  const members = useWorkspace((s) => s.members);
  const admin = isAdmin(me?.role);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const setSector = (s: { id: string; name: string; leadUserId: string | null }) =>
    useWorkspace.setState((st) => ({ sectors: { ...st.sectors, [s.id]: s } }));

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    void run("new", async () => {
      const s = await api.createSector(ws, { name: newName.trim() });
      setSector(s);
      setNewName("");
    });
  };

  const list = Object.values(sectors).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <Modal open onClose={onClose} title="Setores" description="Agrupe pessoas e agentes por área. O líder aparece no organograma." size="lg" footer={<Button onClick={onClose}>Fechar</Button>}>
      <div className="flex flex-col gap-4">
        {!admin && <LockedNote>Só admins mudam os setores.</LockedNote>}
        {list.length === 0 && <p className="text-sm text-muted">Nenhum setor ainda.</p>}
        <ul className="flex flex-col gap-2">
          {list.map((s) => {
            const draft = names[s.id] ?? s.name;
            return (
              <li key={s.id} className="flex flex-col gap-2 rounded-md border border-line p-3 sm:flex-row sm:items-end">
                <Field label="Nome" className="flex-1">
                  {(id) => (
                    <Input
                      id={id}
                      value={draft}
                      disabled={!admin}
                      onChange={(e) => setNames((n) => ({ ...n, [s.id]: e.target.value }))}
                      onBlur={() => {
                        if (draft.trim() && draft !== s.name)
                          void run(s.id, async () => setSector(await api.updateSector(ws, s.id, { name: draft.trim() })));
                      }}
                    />
                  )}
                </Field>
                <Field label="Líder" className="flex-1">
                  {(id) => (
                    <Select
                      id={id}
                      value={s.leadUserId ?? ""}
                      disabled={!admin || busy === s.id}
                      onChange={(e) => {
                        const leadUserId = e.target.value || null;
                        void run(s.id, async () => setSector(await api.updateSector(ws, s.id, { leadUserId })));
                      }}
                    >
                      <option value="">Sem líder</option>
                      {Object.values(members).map((m) => (
                        <option key={m.userId} value={m.userId}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <IconButton label={`Apagar setor ${s.name}`} disabled={!admin} onClick={() => setConfirmDelete(s.id)} className="self-end text-danger">
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            );
          })}
        </ul>
        <form onSubmit={create} className="flex items-end gap-2">
          <Field label="Novo setor" className="flex-1">
            {(id) => <Input id={id} value={newName} onChange={(e) => setNewName(e.target.value)} disabled={!admin} placeholder="Ex.: Atendimento" maxLength={60} />}
          </Field>
          <Button type="submit" variant="primary" disabled={!admin || !newName.trim()} loading={busy === "new"}>
            Adicionar
          </Button>
        </form>
        <InlineError message={error} />
      </div>
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Apagar setor?"
        body="Pessoas e agentes desse setor ficam sem setor. Nada mais é apagado."
        confirmLabel="Apagar"
        danger
        loading={busy === confirmDelete}
        onConfirm={() => {
          const id = confirmDelete!;
          void run(id, async () => {
            await api.deleteSector(ws, id);
            useWorkspace.setState((st) => {
              const { [id]: _gone, ...rest } = st.sectors;
              const agents = Object.fromEntries(
                Object.entries(st.agents).map(([k, a]) => [k, a.sectorId === id ? { ...a, sectorId: null } : a]),
              );
              const members = Object.fromEntries(
                Object.entries(st.members).map(([k, m]) => [k, m.sectorId === id ? { ...m, sectorId: null } : m]),
              );
              return { sectors: rest, agents, members };
            });
            setConfirmDelete(null);
          });
        }}
      />
    </Modal>
  );
}

// ---------- Pessoa ----------
export function MemberDialog({ member, onClose }: { member: MemberDTO; onClose: () => void }) {
  const ws = useWsId();
  const me = useWorkspace((s) => s.me);
  const members = useWorkspace((s) => s.members);
  const admin = isAdmin(me?.role);
  const [role, setRole] = useState<Role>(member.role);
  const [title, setTitle] = useState(member.title ?? "");
  const sectors = useWorkspace((s) => s.sectors);
  const [sectorId, setSectorId] = useState(member.sectorId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owners = Object.values(members).filter((m) => m.role === "owner").length;
  const lastOwner = member.role === "owner" && owners <= 1;
  const canSetOwner = me?.role === "owner";

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: { role?: Role; title?: string | null; sectorId?: string | null } = {};
      if ((sectorId || null) !== (member.sectorId ?? null)) patch.sectorId = sectorId || null;
      if (role !== member.role) patch.role = role;
      if ((title.trim() || null) !== member.title) patch.title = title.trim() || null;
      if (Object.keys(patch).length) {
        const updated = await api.updateMember(ws, member.userId, patch);
        const next = updated && updated.userId ? updated : { ...member, ...patch };
        useWorkspace.setState((st) => ({
          members: { ...st.members, [member.userId]: next },
          me: st.me?.userId === member.userId ? next : st.me,
        }));
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={member.name}
      description={member.email}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!admin}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <PersonAvatar member={member} size="lg" presence={member.online} />
          <div className="text-sm text-muted">
            {member.online ? "Online" : "Offline"} · {member.runnerOnline ? "computador ligado" : "sem computador ligado"}
            {member.statusText && <div>“{member.statusText}”</div>}
          </div>
        </div>
        <Field label="Papel" hint={lastOwner ? "É o único dono: promova outra pessoa antes de mudar." : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={!admin || lastOwner}>
              {(["owner", "admin", "member"] as Role[]).map((r) => (
                <option key={r} value={r} disabled={r === "owner" && !canSetOwner}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Cargo">
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!admin} placeholder="Ex.: Design" maxLength={60} />}
        </Field>
        <Field label="Setor" hint={Object.keys(sectors).length === 0 ? "Crie setores no botão “Setores” da Equipe." : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={sectorId} onChange={(e) => setSectorId(e.target.value)} disabled={!admin}>
              <option value="">Sem setor</option>
              {Object.values(sectors)
                .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        {!admin && <LockedNote>Só admins mudam papel, cargo e setor.</LockedNote>}
        <InlineError message={error} />
      </div>
    </Modal>
  );
}

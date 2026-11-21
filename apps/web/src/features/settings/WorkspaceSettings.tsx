import { useEffect, useState } from "react";
import { api, errorMessage } from "../../api";
import { useSession } from "../../store/session";
import { useWorkspace } from "../../store/workspace";
import { useWsId } from "../shell/hooks";
import { Button, Card, Field, InlineError, Input, LockedNote, SectionTitle, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";
import { isAdmin } from "../../lib/actors";

export function WorkspaceSettings() {
  const ws = useWsId();
  const workspace = useWorkspace((s) => s.workspace);
  const me = useWorkspace((s) => s.me);
  const updateSessionWs = useSession((s) => s.updateWorkspace);
  const [name, setName] = useState(workspace?.name ?? "");
  const [business, setBusiness] = useState(workspace?.business ?? "");
  const [router, setRouter] = useState(workspace?.routerEnabled ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(workspace?.name ?? "");
    setBusiness(workspace?.business ?? "");
    setRouter(workspace?.routerEnabled ?? false);
  }, [workspace]);

  if (!workspace) return null;
  const admin = isAdmin(me?.role);
  const dirty = name.trim() !== workspace.name || (business.trim() || null) !== (workspace.business || null) || router !== workspace.routerEnabled;

  const save = async () => {
    if (!name.trim()) {
      setError("O nome não pode ficar vazio.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.updateWorkspace(ws, { name: name.trim(), business: business.trim() || null, routerEnabled: router });
      const updated = { ...workspace, ...(res && res.id ? res : { name: name.trim(), business: business.trim() || null, routerEnabled: router }), role: workspace.role };
      useWorkspace.setState({ workspace: updated });
      updateSessionWs(updated);
      toast.success("Workspace salvo.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Workspace</SectionTitle>
      {!admin && (
        <div className="mb-3">
          <LockedNote>Só admins mudam estas configurações.</LockedNote>
        </div>
      )}
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Nome">
          {(id, d) => <Input id={id} aria-describedby={d} value={name} onChange={(e) => setName(e.target.value)} disabled={!admin} maxLength={80} />}
        </Field>
        <Field label="Área de atuação" hint="Ajuda os agentes a entender o contexto do time.">
          {(id, d) => (
            <Input id={id} aria-describedby={d} value={business} onChange={(e) => setBusiness(e.target.value)} disabled={!admin} maxLength={200} placeholder="Ex.: Agência de marketing digital" />
          )}
        </Field>
        <div className="rounded-md border border-line p-3">
          <Toggle
            checked={router}
            onChange={setRouter}
            disabled={!admin}
            disabledReason="Só admins mudam"
            label="Roteador automático"
            description="Em canais com vários agentes, quando ninguém é mencionado, um modelo barato escolhe qual agente deve responder, ou nenhum. Assim nem todo agente gasta tokens lendo toda mensagem."
          />
        </div>
        <InlineError message={error} />
        {admin && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={saving} disabled={!dirty}>
              Salvar
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

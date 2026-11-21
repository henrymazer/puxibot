import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileType2, FileVideo, File as FileIcon } from "lucide-react";
import type { FileDTO } from "@puxibot/shared";
import { api } from "../../api";
import { useWorkspace } from "../../store/workspace";
import { AgentAvatar, PersonAvatar } from "../../components/Avatar";
import { authorshipLabel } from "../../lib/actors";
import { paths } from "../../lib/paths";
import { cn } from "../../lib/cn";
import { fileKind, type FileKind } from "./driveModel";

const KIND_ICON: Record<FileKind, typeof FileIcon> = {
  image: FileImage,
  pdf: FileType2,
  markdown: FileText,
  text: FileText,
  audio: FileAudio,
  video: FileVideo,
  sheet: FileSpreadsheet,
  archive: FileArchive,
  other: FileIcon,
};
export const KIND_LABEL: Record<FileKind, string> = {
  image: "Imagem",
  pdf: "PDF",
  markdown: "Markdown",
  text: "Texto",
  audio: "Áudio",
  video: "Vídeo",
  sheet: "Planilha",
  archive: "Arquivo compactado",
  other: "Arquivo",
};

export function KindIcon({ file, className }: { file: Pick<FileDTO, "mime" | "name">; className?: string }) {
  const Icon = KIND_ICON[fileKind(file.mime, file.name)];
  return <Icon className={className} aria-hidden />;
}

/** Miniatura (imagens) ou ícone grande pelo tipo. */
export function FileThumb({ ws, file, className }: { ws: string; file: FileDTO; className?: string }) {
  const kind = fileKind(file.mime, file.name);
  if (kind === "image") {
    return (
      <div className={cn("overflow-hidden bg-surface-2", className)}>
        <img src={api.fileUrl(ws, file.id)} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      </div>
    );
  }
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toUpperCase().slice(0, 4) : "";
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1 bg-surface-2 text-muted", className)}>
      <KindIcon file={file} className="size-8" />
      {ext && <span className="text-[11px] font-semibold tracking-wide">{ext}</span>}
    </div>
  );
}

/** Autor com avatar; agentes aparecem como "Tito, em nome de Ana". */
export function FileAuthor({ file, size = "xs" }: { file: FileDTO; size?: "xs" | "sm" }) {
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const label = authorshipLabel({ members, agents }, file.author, file.onBehalfOfUserId);
  const agent = file.author.type === "agent" ? agents[file.author.id] : undefined;
  const member = file.author.type === "user" ? members[file.author.id] : undefined;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {agent ? <AgentAvatar agent={agent} size={size} /> : file.author.type === "agent" ? <AgentAvatar agent={{ id: file.author.id, name: label, avatarColor: null, avatarAccessory: null }} size={size} /> : <PersonAvatar member={member} name={label} size={size} />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Canal de origem, com link. */
export function FileOrigin({ ws, file, fallback = null }: { ws: string; file: FileDTO; fallback?: ReactNode }) {
  const channel = useWorkspace((s) => (file.channelId ? s.channels[file.channelId] : undefined));
  const members = useWorkspace((s) => s.members);
  const agents = useWorkspace((s) => s.agents);
  const myUserId = useWorkspace((s) => s.myUserId);
  if (!file.channelId) return <>{fallback}</>;
  if (!channel) return <span className="text-subtle">conversa privada</span>;
  let label = `#${channel.name ?? "canal"}`;
  if (channel.kind === "dm") {
    const peer = channel.members.find((m) => !(m.type === "user" && m.id === myUserId)) ?? channel.members[0];
    const name = peer ? (peer.type === "agent" ? agents[peer.id]?.name : members[peer.id]?.name) : null;
    label = name ? `conversa com ${name}` : "conversa";
  }
  return (
    <Link to={paths.channel(ws, channel.id)} className="truncate text-primary-text hover:underline" onClick={(e) => e.stopPropagation()}>
      {label}
    </Link>
  );
}

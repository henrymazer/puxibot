const timeFmt = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" });
const dayYearFmt = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatTime(ms: number): string {
  return timeFmt.format(ms);
}

export function formatDayLabel(ms: number, now = Date.now()): string {
  const day = startOfDay(ms);
  const today = startOfDay(now);
  if (day === today) return "Hoje";
  if (day === startOfDay(today - 1)) return "Ontem";
  if (new Date(ms).getFullYear() !== new Date(now).getFullYear()) return dayYearFmt.format(ms);
  const s = dayFmt.format(ms);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatDateTime(ms: number): string {
  return shortFmt.format(ms);
}

export function formatRelative(ms: number, now = Date.now()): string {
  const diff = Math.round((now - ms) / 1000);
  if (diff < 45) return "agora";
  if (diff < 3600) return `há ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.round(diff / 3600)} h`;
  if (diff < 86400 * 7) return `há ${Math.round(diff / 86400)} d`;
  return shortFmt.format(ms);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("pt-BR").format(n);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]!.charAt(0);
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : "";
  return (first + last).toUpperCase();
}

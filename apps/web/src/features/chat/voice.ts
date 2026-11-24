/**
 * Voz no chat: ditado (gravação + transcrição no hub, ou reconhecimento do próprio navegador)
 * e leitura em voz alta das respostas dos agentes. Sem React aqui; as partes puras são
 * testadas em voice.test.ts.
 *
 * Regras de privacidade: só grava depois de um clique, o áudio não é guardado depois de
 * enviado e o texto transcrito nunca vai para o console.
 */

// ---------- Partes puras ----------

export const RECORDER_MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"] as const;

/** Primeiro formato de gravação que o navegador aceita, ou null (aí vale o padrão dele). */
export function pickRecorderMime(isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of RECORDER_MIMES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // Alguns navegadores lançam erro para tipos desconhecidos: trata como não suportado.
    }
  }
  return null;
}

/** Junta o texto ditado ao fim do rascunho, sem apagar nada do que já foi escrito. */
export function appendDictation(draft: string, text: string): string {
  const t = text.trim();
  if (!t) return draft;
  if (draft === "" || /\s$/.test(draft)) return draft + t;
  return `${draft} ${t}`;
}

export type VoiceMode = "server" | "browser" | null;

/** Transcrição no hub quando dá; senão, a do navegador; senão, nada. */
export function voiceMode(caps: { transcription: boolean; hasRecorder: boolean; hasSpeechRecognition: boolean }): VoiceMode {
  if (caps.transcription && caps.hasRecorder) return "server";
  if (caps.hasSpeechRecognition) return "browser";
  return null;
}

/** Tira o Markdown de um texto para ele ser lido em voz alta. */
export function speakableText(markdown: string): string {
  let s = markdown.replace(/\r\n?/g, "\n");
  // Blocos de código (inclusive um que ficou sem fechar).
  s = s.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, "\ntrecho de código.\n");
  s = s.replace(/```[\s\S]*?```/g, " trecho de código ");
  // Imagens e links: fica só o texto.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  // Endereço solto não se lê letra por letra.
  s = s.replace(/https?:\/\/[^\s)]+/g, "link");
  // Tags HTML.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, " ");

  const lines: string[] = [];
  for (const raw of s.split("\n")) {
    let line = raw.trim();
    // Linha separadora de tabela (|---|:--:|) e régua horizontal.
    if (/^\|?[\s:|-]*-{2,}[\s:|-]*$/.test(line) && (line.includes("|") || /^[-\s]+$/.test(line))) continue;
    if (/^([*_]\s*){3,}$/.test(line)) continue;
    line = line.replace(/^(>\s*)+/, "");
    line = line.replace(/^#{1,6}\s+/, "").replace(/\s+#+$/, "");
    line = line.replace(/^[-*+]\s+/, "");
    line = line.replace(/^\[[ xX]\]\s+/, "");
    // Tabela: as barras viram pausas.
    if (line.includes("|")) {
      line = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean)
        .join(", ");
    }
    lines.push(line);
  }
  s = lines.join("\n");

  // Ênfases e código na linha.
  s = s.replace(/`+/g, "");
  s = s.replace(/\*+/g, "");
  s = s.replace(/~~/g, "");
  s = s.replace(/(^|[\s(])_{1,3}(?=\S)/g, "$1").replace(/(\S)_{1,3}(?=$|[\s).,;:!?])/gm, "$1");
  s = s.replace(/^#+\s*/gm, "");

  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * Quebra o texto em pedaços curtos (frases). Alguns navegadores cortam falas longas no meio;
 * com pedaços pequenos em fila isso não acontece.
 */
export function speechChunks(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const sentences = line.match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
    let current = "";
    const flush = () => {
      if (current.trim()) out.push(current.trim());
      current = "";
    };
    for (let sentence of sentences) {
      if ((current + sentence).length <= max) {
        current += sentence;
        continue;
      }
      flush();
      // Frase maior que o limite: corta em espaços.
      while (sentence.length > max) {
        let cut = sentence.lastIndexOf(" ", max);
        if (cut <= 0) cut = max;
        out.push(sentence.slice(0, cut).trim());
        sentence = sentence.slice(cut);
      }
      current = sentence;
    }
    flush();
  }
  return out.filter(Boolean);
}

/** "0:07", "1:32". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------- Recursos do hub (uma consulta por workspace, por sessão da página) ----------

const featureCache = new Map<string, Promise<{ transcription: boolean }>>();

/**
 * Devolve os recursos do workspace, consultando `load` só uma vez por workspace.
 * Se a consulta falhar, nada fica em cache (a próxima tentativa consulta de novo).
 */
export function cachedFeatures<T extends { transcription: boolean }>(ws: string, load: (ws: string) => Promise<T>): Promise<{ transcription: boolean }> {
  let p = featureCache.get(ws);
  if (!p) {
    p = load(ws);
    featureCache.set(ws, p);
    p.catch(() => {
      if (featureCache.get(ws) === p) featureCache.delete(ws);
    });
  }
  return p;
}

/** Só para testes. */
export function clearFeatureCache(): void {
  featureCache.clear();
}

// ---------- Mensagens de erro ----------

export const MIC_BLOCKED = "O microfone está bloqueado para este site. Libere o microfone nas permissões do navegador e tente de novo.";
const MIC_MISSING = "Não encontrei um microfone neste aparelho.";
const MIC_BUSY = "Não consegui usar o microfone. Veja se outro programa está usando e tente de novo.";

/** Troca os erros do navegador (em inglês) por um aviso claro. */
export function micError(err: unknown): Error {
  const name = typeof err === "object" && err !== null && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new Error(MIC_BLOCKED);
  if (name === "NotFoundError" || name === "OverconstrainedError") return new Error(MIC_MISSING);
  if (name === "NotReadableError" || name === "AbortError") return new Error(MIC_BUSY);
  return new Error("Não consegui ligar o microfone. Tente de novo.");
}

/** Aviso para um erro do reconhecimento de fala do navegador; null = não precisa avisar. */
export function recognitionErrorMessage(code: string): string | null {
  switch (code) {
    case "aborted":
    case "no-speech":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return MIC_BLOCKED;
    case "audio-capture":
      return MIC_MISSING;
    case "network":
      return "O ditado do navegador precisa de internet. Verifique sua conexão.";
    case "language-not-supported":
      return "Este navegador não faz ditado em português.";
    default:
      return "O ditado parou por um erro do navegador. Tente de novo.";
  }
}

// ---------- Gravação (transcrição no hub) ----------

export const MAX_RECORDING_MS = 2 * 60 * 1000;
/** Limite do hub para o áudio enviado. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export function hasRecorder(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

export interface Recording {
  /** Para de gravar e devolve o áudio. O microfone é solto. */
  stop(): Promise<Blob>;
  /** Para e joga o áudio fora. */
  cancel(): void;
}

/**
 * Pede o microfone e começa a gravar. Chame só em resposta a um clique.
 * `onMaxDuration` é chamado quando a gravação bate o limite (quem chama decide parar e enviar).
 */
export async function startRecording(opts: { onMaxDuration: () => void; maxMs?: number }): Promise<Recording> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw micError(err);
  }
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  let recorder: MediaRecorder;
  try {
    const mime = pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
    // Voz não precisa de muita qualidade; assim 2 minutos ficam bem abaixo do limite do hub.
    recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48_000 });
  } catch (err) {
    release();
    throw micError(err);
  }

  let chunks: Blob[] = [];
  let finished = false;
  let discard = false;
  let settle: { resolve: (b: Blob) => void; reject: (e: Error) => void } | null = null;

  const timer = setTimeout(() => {
    if (!finished) opts.onMaxDuration();
  }, opts.maxMs ?? MAX_RECORDING_MS);

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    release();
  };

  recorder.ondataavailable = (e) => {
    if (!discard && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    const type = recorder.mimeType || chunks[0]?.type || "audio/webm";
    const blob = new Blob(discard ? [] : chunks, { type });
    chunks = [];
    finish();
    settle?.resolve(blob);
  };
  recorder.onerror = () => {
    chunks = [];
    discard = true;
    finish();
    settle?.reject(new Error("A gravação falhou. Tente de novo."));
  };

  try {
    recorder.start();
  } catch (err) {
    finish();
    throw micError(err);
  }

  return {
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        if (finished) {
          reject(new Error("A gravação já tinha terminado."));
          return;
        }
        settle = { resolve, reject };
        try {
          recorder.stop();
        } catch {
          finish();
          reject(new Error("A gravação falhou. Tente de novo."));
        }
      });
    },
    cancel() {
      discard = true;
      chunks = [];
      if (finished) return;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // já estava parado
      }
      finish();
    },
  };
}

// ---------- Ditado do navegador ----------

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike | undefined;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; readonly [index: number]: SpeechRecognitionResultLike | undefined };
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function hasSpeechRecognition(): boolean {
  return recognitionCtor() !== null;
}

export interface Dictation {
  /** Para de ouvir; o que já estava sendo dito ainda pode chegar como texto final. */
  stop(): void;
  /** Para na hora e ignora o que ainda não tinha chegado. */
  cancel(): void;
}

/**
 * Ditado feito pelo navegador (no Chrome, o áudio é processado pelo serviço do Google).
 * Chame só em resposta a um clique.
 */
export function startBrowserDictation(handlers: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): Dictation {
  const Ctor = recognitionCtor();
  if (!Ctor) throw new Error("Este navegador não faz ditado.");
  const rec = new Ctor();
  rec.lang = "pt-BR";
  rec.interimResults = true;
  rec.continuous = true;
  let cancelled = false;
  let ended = false;

  rec.onresult = (e) => {
    if (cancelled) return;
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      const transcript = result?.[0]?.transcript ?? "";
      if (!result) continue;
      if (result.isFinal) handlers.onFinal(transcript);
      else interim += transcript;
    }
    handlers.onInterim?.(interim);
  };
  rec.onerror = (e) => {
    if (cancelled) return;
    const message = recognitionErrorMessage(e.error);
    if (message) handlers.onError(message);
  };
  rec.onend = () => {
    if (ended) return;
    ended = true;
    handlers.onEnd();
  };

  try {
    rec.start();
  } catch {
    throw new Error("Não consegui começar o ditado. Tente de novo.");
  }

  return {
    stop() {
      try {
        rec.stop();
      } catch {
        // já tinha parado
      }
    },
    cancel() {
      cancelled = true;
      try {
        rec.abort();
      } catch {
        // já tinha parado
      }
    },
  };
}

// ---------- Leitura em voz alta ----------

function synth(): SpeechSynthesis | null {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined" ? window.speechSynthesis : null;
}

/** Voz pt-BR quando existe; senão qualquer português; senão a do navegador para o idioma pedido. */
export function pickPortugueseVoice<V extends { lang: string; localService?: boolean }>(voices: readonly V[]): V | null {
  const norm = (v: V) => v.lang.replace("_", "-").toLowerCase();
  const br = voices.filter((v) => norm(v) === "pt-br");
  const pt = voices.filter((v) => norm(v).startsWith("pt"));
  // Prefere voz do próprio aparelho: não depende de rede.
  return br.find((v) => v.localService) ?? br[0] ?? pt.find((v) => v.localService) ?? pt[0] ?? null;
}

let speakingId: string | null = null;
let speechRun = 0;
const speechListeners = new Set<() => void>();

function setSpeaking(id: string | null) {
  if (speakingId === id) return;
  speakingId = id;
  for (const l of speechListeners) l();
}

/** Uma fala por vez em toda a página. Feito para `useSyncExternalStore`. */
export const speech = {
  supported(): boolean {
    return synth() !== null;
  },
  subscribe(listener: () => void): () => void {
    speechListeners.add(listener);
    return () => {
      speechListeners.delete(listener);
    };
  },
  current(): string | null {
    return speakingId;
  },
  /** Lê o texto (Markdown) da mensagem `id`, parando qualquer outra leitura. */
  speak(id: string, markdown: string): void {
    const s = synth();
    if (!s) return;
    const run = ++speechRun;
    s.cancel();
    const chunks = speechChunks(speakableText(markdown));
    if (chunks.length === 0) {
      setSpeaking(null);
      return;
    }
    const voice = pickPortugueseVoice(s.getVoices());
    setSpeaking(id);
    chunks.forEach((chunk, i) => {
      const u = new SpeechSynthesisUtterance(chunk);
      u.lang = "pt-BR";
      if (voice) u.voice = voice;
      if (i === chunks.length - 1) {
        u.onend = () => {
          if (run === speechRun) setSpeaking(null);
        };
      }
      u.onerror = () => {
        // Falhou no meio: não deixa o resto da fila falando sozinho.
        if (run !== speechRun) return;
        speechRun++;
        s.cancel();
        setSpeaking(null);
      };
      s.speak(u);
    });
  },
  /** Para a leitura. Com `id`, só para se for essa a mensagem sendo lida. */
  stop(id?: string): void {
    if (id !== undefined && speakingId !== id) return;
    speechRun++;
    synth()?.cancel();
    setSpeaking(null);
  },
};

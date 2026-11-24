import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Mic, Square, Volume2 } from "lucide-react";
import { api } from "../../api";
import { toast } from "../../components/toast";
import { IconButton } from "../../components/ui";
import { cn } from "../../lib/cn";
import {
  MAX_AUDIO_BYTES,
  cachedFeatures,
  formatElapsed,
  hasRecorder,
  hasSpeechRecognition,
  speech,
  startBrowserDictation,
  startRecording,
  voiceMode,
  type Dictation,
  type Recording,
  type VoiceMode,
} from "./voice";

type Phase = "idle" | "starting" | "recording" | "transcribing";

const BROWSER_NOTE = "Neste modo quem transcreve é o próprio navegador: o áudio sai deste aparelho (no Chrome, vai para o serviço do Google).";

/** Como dá para ditar neste workspace e neste navegador (null = não dá, ou ainda não se sabe). */
function useVoiceMode(ws: string): VoiceMode {
  const [mode, setMode] = useState<VoiceMode>(null);
  useEffect(() => {
    let alive = true;
    const recorder = hasRecorder();
    const recognition = hasSpeechRecognition();
    setMode(null);
    const decide = (transcription: boolean) => {
      if (alive) setMode(voiceMode({ transcription, hasRecorder: recorder, hasSpeechRecognition: recognition }));
    };
    // Sem gravador não adianta perguntar ao hub; e sem workspace não há a quem perguntar.
    if (!recorder || !ws) decide(false);
    else {
      cachedFeatures(ws, (w) => api.getFeatures(w)).then(
        (f) => decide(f.transcription),
        () => decide(false),
      );
    }
    return () => {
      alive = false;
    };
  }, [ws]);
  return mode;
}

/**
 * Microfone do campo de mensagem. Clique começa, clique de novo termina; Esc cancela.
 * `onText` recebe cada trecho transcrito (quem usa decide como juntar ao rascunho).
 */
export function VoiceButton({ ws, onText }: { ws: string; onText: (text: string) => void }) {
  const mode = useVoiceMode(ws);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("");
  const noteId = useId();
  /** Muda a cada começo/cancelamento: respostas de uma sessão antiga são ignoradas. */
  const session = useRef(0);
  const recording = useRef<Recording | null>(null);
  const dictation = useRef<Dictation | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const active = phase === "starting" || phase === "recording";

  // Segundos de gravação.
  useEffect(() => {
    if (phase !== "recording") return;
    const startedAt = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [phase]);

  const cancel = () => {
    session.current++;
    recording.current?.cancel();
    recording.current = null;
    dictation.current?.cancel();
    dictation.current = null;
  };

  // Ao sair da tela: solta o microfone e joga fora o que estava em andamento.
  useEffect(() => cancel, []);

  const finishRecording = async (mine: number) => {
    const rec = recording.current;
    if (!rec || mine !== session.current) return;
    recording.current = null;
    setPhase("transcribing");
    setStatus("Transcrevendo o áudio.");
    try {
      const audio = await rec.stop();
      if (mine !== session.current) return;
      if (audio.size === 0) throw new Error("Não gravou nada. Tente de novo.");
      if (audio.size > MAX_AUDIO_BYTES) throw new Error("O áudio ficou grande demais. Grave um trecho mais curto.");
      const text = await api.transcribe(ws, audio);
      if (mine !== session.current) return;
      if (text.trim()) {
        onTextRef.current(text);
        setStatus("Texto ditado inserido na mensagem.");
      } else {
        setStatus("");
        toast.info("Não deu para entender o áudio. Tente de novo, mais perto do microfone.");
      }
    } catch (err) {
      if (mine !== session.current) return;
      setStatus("");
      toast.error(err);
    } finally {
      if (mine === session.current) setPhase("idle");
    }
  };

  const startServer = async () => {
    const mine = ++session.current;
    setPhase("starting");
    try {
      const rec = await startRecording({
        onMaxDuration: () => {
          if (mine !== session.current) return;
          toast.info("A gravação parou em 2 minutos. Transcrevendo o que foi dito.");
          void finishRecording(mine);
        },
      });
      if (mine !== session.current) {
        // Cancelaram (ou a tela fechou) enquanto o navegador pedia a permissão.
        rec.cancel();
        return;
      }
      recording.current = rec;
      setPhase("recording");
      setStatus("Gravando. Clique de novo para terminar.");
    } catch (err) {
      if (mine !== session.current) return;
      setPhase("idle");
      setStatus("");
      toast.error(err);
    }
  };

  const startBrowser = () => {
    const mine = ++session.current;
    try {
      dictation.current = startBrowserDictation({
        onFinal: (text) => {
          if (mine === session.current) onTextRef.current(text);
        },
        onError: (message) => {
          if (mine === session.current) toast.error(new Error(message));
        },
        onEnd: () => {
          if (mine !== session.current) return;
          dictation.current = null;
          setPhase("idle");
          setStatus("Ditado encerrado.");
        },
      });
      setPhase("recording");
      setStatus("Ouvindo. Clique de novo para terminar.");
    } catch (err) {
      dictation.current = null;
      setPhase("idle");
      toast.error(err);
    }
  };

  const toggle = () => {
    if (phase === "transcribing" || phase === "starting") return;
    if (phase === "recording") {
      if (mode === "server") void finishRecording(session.current);
      else dictation.current?.stop();
      return;
    }
    if (mode === "server") void startServer();
    else if (mode === "browser") startBrowser();
  };

  // Esc cancela sem inserir texto. Se outro controle já tratou o Esc (sugestões de menção), deixa com ele.
  useEffect(() => {
    if (phase === "idle") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      cancel();
      setPhase("idle");
      setStatus("Ditado cancelado.");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase]);

  if (!mode) return null;

  const title =
    phase === "transcribing"
      ? "Transcrevendo… (Esc cancela)"
      : phase === "starting"
        ? "Esperando o microfone…"
        : phase === "recording"
          ? mode === "server"
            ? "Terminar a gravação e transcrever (Esc cancela)"
            : "Parar o ditado (Esc cancela)"
          : mode === "browser"
            ? `Ditar por voz. ${BROWSER_NOTE}`
            : "Ditar por voz (até 2 minutos)";

  return (
    <>
      <IconButton
        label="Ditar por voz"
        title={title}
        aria-pressed={active}
        aria-busy={phase === "transcribing" || phase === "starting"}
        aria-describedby={mode === "browser" ? noteId : undefined}
        onClick={toggle}
        className={cn(active && "bg-danger-soft text-danger hover:bg-danger-soft hover:text-danger")}
      >
        {phase === "transcribing" || phase === "starting" ? (
          <Loader2 className="size-4.5 animate-spin" aria-hidden />
        ) : phase === "recording" ? (
          <span className="flex flex-col items-center gap-0.5" aria-hidden>
            <Square className="size-3.5 fill-current" />
            {mode === "server" && <span className="text-[10px] leading-none font-medium tabular-nums">{formatElapsed(elapsed)}</span>}
          </span>
        ) : (
          <Mic className="size-4.5" aria-hidden />
        )}
      </IconButton>
      {mode === "browser" && (
        <span id={noteId} className="sr-only">
          {BROWSER_NOTE}
        </span>
      )}
      <span role="status" className="sr-only">
        {status}
      </span>
    </>
  );
}

/** "Ouvir" / "Parar" de uma resposta de agente. Some quando o navegador não lê em voz alta. */
export function ListenButton({ messageId, text }: { messageId: string; text: string }) {
  const speaking = useSyncExternalStore(
    speech.subscribe,
    () => speech.current() === messageId,
    () => false,
  );
  // Mensagem saiu da tela: para de ler.
  useEffect(() => () => speech.stop(messageId), [messageId]);

  if (!speech.supported()) return null;
  return (
    <IconButton
      size="sm"
      label={speaking ? "Parar" : "Ouvir"}
      active={speaking}
      onClick={() => (speaking ? speech.stop(messageId) : speech.speak(messageId, text))}
    >
      {speaking ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-4" />}
    </IconButton>
  );
}

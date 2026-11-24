import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIC_BLOCKED,
  appendDictation,
  cachedFeatures,
  clearFeatureCache,
  formatElapsed,
  micError,
  pickPortugueseVoice,
  pickRecorderMime,
  recognitionErrorMessage,
  speakableText,
  speechChunks,
  voiceMode,
} from "./voice";

describe("pickRecorderMime", () => {
  it("escolhe o primeiro formato aceito, na ordem de preferência", () => {
    expect(pickRecorderMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime((m) => m === "audio/mp4" || m === "audio/ogg")).toBe("audio/mp4");
    expect(pickRecorderMime((m) => m === "audio/ogg")).toBe("audio/ogg");
  });

  it("devolve null quando nenhum serve, mesmo se o navegador lançar erro", () => {
    expect(pickRecorderMime(() => false)).toBeNull();
    expect(
      pickRecorderMime(() => {
        throw new Error("x");
      }),
    ).toBeNull();
  });
});

describe("appendDictation", () => {
  it("rascunho vazio recebe só o texto, sem espaços sobrando", () => {
    expect(appendDictation("", "  olá mundo \n")).toBe("olá mundo");
  });

  it("põe um espaço entre o que já estava escrito e o ditado", () => {
    expect(appendDictation("Oi", "tudo bem?")).toBe("Oi tudo bem?");
  });

  it("não duplica espaço nem quebra de linha no fim do rascunho", () => {
    expect(appendDictation("Oi ", "tudo bem?")).toBe("Oi tudo bem?");
    expect(appendDictation("Oi\n", " tudo bem?")).toBe("Oi\ntudo bem?");
  });

  it("não mexe em maiúsculas nem no que a pessoa escreveu", () => {
    expect(appendDictation("Primeira frase.", "segunda frase")).toBe("Primeira frase. segunda frase");
  });

  it("texto vazio devolve o rascunho igual", () => {
    expect(appendDictation("Oi ", "   ")).toBe("Oi ");
    expect(appendDictation("", "")).toBe("");
  });
});

describe("voiceMode", () => {
  it("prefere a transcrição do hub quando dá para gravar", () => {
    expect(voiceMode({ transcription: true, hasRecorder: true, hasSpeechRecognition: true })).toBe("server");
    expect(voiceMode({ transcription: true, hasRecorder: true, hasSpeechRecognition: false })).toBe("server");
  });

  it("cai no ditado do navegador sem transcrição no hub ou sem gravador", () => {
    expect(voiceMode({ transcription: false, hasRecorder: true, hasSpeechRecognition: true })).toBe("browser");
    expect(voiceMode({ transcription: true, hasRecorder: false, hasSpeechRecognition: true })).toBe("browser");
  });

  it("sem nenhum dos dois não há voz", () => {
    expect(voiceMode({ transcription: false, hasRecorder: true, hasSpeechRecognition: false })).toBeNull();
    expect(voiceMode({ transcription: true, hasRecorder: false, hasSpeechRecognition: false })).toBeNull();
  });
});

describe("speakableText", () => {
  it("troca blocos de código por 'trecho de código'", () => {
    const out = speakableText("Rode assim:\n\n```bash\nnpm run build\n```\n\nPronto.");
    expect(out).toBe("Rode assim:\ntrecho de código.\nPronto.");
    expect(out).not.toContain("npm");
  });

  it("bloco de código sem fechar também não é lido", () => {
    const out = speakableText("Veja:\n```ts\nconst a = 1;");
    expect(out).toBe("Veja:\ntrecho de código.");
  });

  it("lê o texto dos links e das imagens, não o endereço", () => {
    expect(speakableText("Veja [o relatório](https://exemplo.com/r?id=1) e ![o gráfico](/g.png).")).toBe("Veja o relatório e o gráfico.");
    expect(speakableText("Está em https://exemplo.com/a/b?c=1 agora")).toBe("Está em link agora");
  });

  it("tira asteriscos, crases, til duplo e marcas de título", () => {
    expect(speakableText("## Resumo\n\nIsto é **muito** *importante*, use `npm test` e ~~nada~~ mais.")).toBe(
      "Resumo\nIsto é muito importante, use npm test e nada mais.",
    );
    expect(speakableText("__forte__ e _leve_")).toBe("forte e leve");
  });

  it("preserva sublinhado dentro de nomes", () => {
    expect(speakableText("a variável max_file_size")).toBe("a variável max_file_size");
  });

  it("tira marcadores de lista, citação e caixas de tarefa", () => {
    expect(speakableText("- um\n* dois\n+ três\n> citado\n- [x] feito\n1. primeiro")).toBe("um\ndois\ntrês\ncitado\nfeito\n1. primeiro");
  });

  it("transforma as barras de tabela em pausas e some com a linha separadora", () => {
    const out = speakableText("| Nome | Valor |\n|------|:-----:|\n| Ana | 10 |\n| Bia | 20 |");
    expect(out).toBe("Nome, Valor\nAna, 10\nBia, 20");
    expect(out).not.toContain("|");
  });

  it("some com régua horizontal e tags HTML", () => {
    expect(speakableText("antes\n\n---\n\ndepois<br>fim")).toBe("antes\ndepois fim");
  });

  it("texto vazio ou só com marcação vira vazio", () => {
    expect(speakableText("")).toBe("");
    expect(speakableText("**  **\n\n---")).toBe("");
  });
});

describe("speechChunks", () => {
  it("junta frases curtas e separa por linha", () => {
    expect(speechChunks("Oi. Tudo bem?\nSegunda linha.")).toEqual(["Oi. Tudo bem?", "Segunda linha."]);
  });

  it("nenhum pedaço passa do limite e nada se perde", () => {
    const text = `${"palavra ".repeat(80)}fim. Outra frase curta.`;
    const chunks = speechChunks(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("texto vazio não gera pedaço", () => {
    expect(speechChunks("")).toEqual([]);
    expect(speechChunks("\n \n")).toEqual([]);
  });
});

describe("formatElapsed", () => {
  it("mostra minutos e segundos", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7)).toBe("0:07");
    expect(formatElapsed(92.9)).toBe("1:32");
  });
});

describe("pickPortugueseVoice", () => {
  it("prefere pt-BR, depois outro português, senão nenhuma", () => {
    const en = { lang: "en-US" };
    const pt = { lang: "pt-PT" };
    const br = { lang: "pt_BR" };
    expect(pickPortugueseVoice([en, pt, br])).toBe(br);
    expect(pickPortugueseVoice([en, pt])).toBe(pt);
    expect(pickPortugueseVoice([en])).toBeNull();
  });

  it("entre vozes pt-BR prefere a do próprio aparelho", () => {
    const remote = { lang: "pt-BR", localService: false };
    const local = { lang: "pt-BR", localService: true };
    expect(pickPortugueseVoice([remote, local])).toBe(local);
  });
});

describe("erros do microfone", () => {
  it("permissão negada pede para liberar o microfone do site", () => {
    expect(micError({ name: "NotAllowedError" }).message).toBe(MIC_BLOCKED);
    expect(recognitionErrorMessage("not-allowed")).toBe(MIC_BLOCKED);
    expect(MIC_BLOCKED).toMatch(/microfone/i);
  });

  it("silêncio e cancelamento não geram aviso", () => {
    expect(recognitionErrorMessage("no-speech")).toBeNull();
    expect(recognitionErrorMessage("aborted")).toBeNull();
    expect(recognitionErrorMessage("network")).toMatch(/internet/);
  });
});

describe("cachedFeatures", () => {
  beforeEach(() => clearFeatureCache());

  it("consulta uma vez por workspace", async () => {
    const load = vi.fn(async (ws: string) => ({ transcription: ws === "a" }));
    const [x, y] = await Promise.all([cachedFeatures("a", load), cachedFeatures("a", load)]);
    expect(x.transcription).toBe(true);
    expect(y.transcription).toBe(true);
    expect((await cachedFeatures("b", load)).transcription).toBe(false);
    await cachedFeatures("a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falha não fica em cache", async () => {
    const load = vi.fn<(ws: string) => Promise<{ transcription: boolean }>>();
    load.mockRejectedValueOnce(new Error("fora do ar"));
    load.mockResolvedValueOnce({ transcription: true });
    await expect(cachedFeatures("a", load)).rejects.toThrow("fora do ar");
    expect((await cachedFeatures("a", load)).transcription).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

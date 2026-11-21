import { describe, expect, it } from "vitest";
import { userHandle } from "@puxibot/shared";
import { applyMention, filterMentionCandidates, getMentionQuery, type MentionCandidate } from "./mentions";
import { splitMentions } from "../features/chat/remarkMentions";

describe("getMentionQuery", () => {
  it("detecta @ no começo e depois de espaço", () => {
    expect(getMentionQuery("@th", 3)).toEqual({ query: "th", start: 0 });
    expect(getMentionQuery("oi @", 4)).toEqual({ query: "", start: 3 });
    expect(getMentionQuery("oi (@li", 7)).toEqual({ query: "li", start: 4 });
  });
  it("ignora e-mails e @ longe do cursor", () => {
    expect(getMentionQuery("ana@empresa", 11)).toBeNull();
    expect(getMentionQuery("@tito oi", 8)).toBeNull();
    expect(getMentionQuery("sem arroba", 5)).toBeNull();
  });
  it("aceita acentos enquanto digita o nome", () => {
    expect(getMentionQuery("@Joã", 4)).toEqual({ query: "Joã", start: 0 });
  });
});

describe("filterMentionCandidates", () => {
  const c: MentionCandidate[] = [
    { type: "user", id: "u1", handle: "ana", name: "Ana Ribeiro" },
    { type: "agent", id: "a1", handle: "tito", name: "Tito" },
    { type: "user", id: "u2", handle: "teodoro", name: "Teodoro Lima" },
    { type: "agent", id: "a2", handle: "lia", name: "Lia" },
    { type: "user", id: "u3", handle: "joao", name: "João Maia" },
  ];
  it("prioriza handle que começa com a busca", () => {
    expect(filterMentionCandidates(c, "te").map((x) => x.id)).toEqual(["u2"]);
    expect(filterMentionCandidates(c, "t").map((x) => x.id)).toEqual(["a1", "u2"]);
  });
  it("encontra por palavra do nome e sem acento", () => {
    expect(filterMentionCandidates(c, "rib").map((x) => x.id)).toEqual(["u1"]);
    expect(filterMentionCandidates(c, "joa").map((x) => x.id)).toEqual(["u3"]);
    expect(filterMentionCandidates(c, "maia").map((x) => x.id)).toEqual(["u3"]);
  });
  it("busca vazia lista agentes primeiro e respeita o limite", () => {
    const out = filterMentionCandidates(c, "", 3);
    expect(out).toHaveLength(3);
    expect(out[0]!.type).toBe("agent");
  });
});

describe("applyMention", () => {
  it("troca a consulta pelo handle e posiciona o cursor depois do espaço", () => {
    const text = "oi @th tudo bem";
    const q = getMentionQuery(text, 6)!;
    expect(applyMention(text, q, 6, "tito")).toEqual({ text: "oi @tito tudo bem", caret: 8 });
    const t2 = "fala @l";
    expect(applyMention(t2, getMentionQuery(t2, 7)!, 7, "lia")).toEqual({ text: "fala @lia ", caret: 10 });
  });
});

describe("userHandle e destaque de menções", () => {
  it("gera handle de pessoa a partir do e-mail", () => {
    expect(userHandle({ email: "Ana.Souza+x@empresa.com" })).toBe("ana-souza-x");
  });
  it("separa @menções no texto e marca agentes", () => {
    const nodes = splitMentions("oi @tito e @ana!", new Set(["tito"]));
    expect(nodes.map((n) => n.type)).toEqual(["text", "mention", "text", "mention", "text"]);
    expect(nodes[1]!.data!.hProperties!.className).toContain("tb-mention-agent");
    expect(nodes[3]!.data!.hProperties!.className).not.toContain("agent");
    expect(splitMentions("email a@b.com", new Set()).map((n) => n.type)).toEqual(["text"]);
  });
});

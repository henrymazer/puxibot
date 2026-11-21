// Leitor mínimo de JSONC (JSON com comentários e vírgulas sobrando), o formato do wrangler.jsonc.
// Remove comentários // e /* */ e vírgulas antes de } ou ], sempre fora de strings, e usa JSON.parse.

function scan(text, onChar) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    const r = onChar(text, i);
    if (r === null) out += c;
    else {
      out += r.emit;
      i = r.next - 1;
    }
  }
  return out;
}

export function stripJsonc(text) {
  const noComments = scan(text, (t, i) => {
    if (t[i] === "/" && t[i + 1] === "/") {
      let j = i;
      while (j < t.length && t[j] !== "\n") j++;
      return { emit: "", next: j };
    }
    if (t[i] === "/" && t[i + 1] === "*") {
      const end = t.indexOf("*/", i + 2);
      return { emit: " ", next: end === -1 ? t.length : end + 2 };
    }
    return null;
  });
  return scan(noComments, (t, i) => {
    if (t[i] !== ",") return null;
    let j = i + 1;
    while (j < t.length && /\s/.test(t[j])) j++;
    return t[j] === "}" || t[j] === "]" ? { emit: "", next: i + 1 } : null;
  });
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}

/** Utilitários de criptografia sobre WebCrypto: hash, senhas, HMAC, AES-GCM, tokens aleatórios. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomHex(n: number): string {
  return bytesToHex(randomBytes(n));
}

/** Token aleatório com prefixo, ex.: "tb_<43 chars>". */
export function randomToken(prefix: string, bytes = 32): string {
  return prefix + bytesToBase64Url(randomBytes(bytes));
}

/** Código legível sem caracteres ambíguos, ex.: "K7QM-4XPA". */
export function randomCode(groups = 2, size = 4): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  // Amostragem por rejeição: só bytes < 248 (múltiplo de 31), para todo símbolo ter a mesma chance.
  const limit = 256 - (256 % alphabet.length);
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    let part = "";
    while (part.length < size) {
      for (const b of randomBytes(size * 2)) {
        if (b < limit && part.length < size) part += alphabet[b % alphabet.length];
      }
    }
    parts.push(part);
  }
  return parts.join("-");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

/** Comparação em tempo constante (compara os SHA-256, que têm sempre o mesmo tamanho). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb) && a.length === b.length;
}

// ---------- Senhas (PBKDF2-SHA256, 100.000 iterações, salt de 16 bytes) ----------
const PBKDF2_ITERATIONS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

let dummyHash: Promise<string> | null = null;
/** Hash fictício (mesmo custo do real) para comparar quando o e-mail não existe. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(bytesToHex(randomBytes(16)));
  return dummyHash;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !saltB64 || !hashB64) return false;
  const iterations = Number(iter);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return false;
  const hash = await pbkdf2(password, base64ToBytes(saltB64), iterations);
  return timingSafeEqual(bytesToBase64(hash), hashB64);
}

// ---------- HMAC ----------
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function hmacSign(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(data));
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function hmacVerify(secret: string, data: string, signatureB64Url: string): Promise<boolean> {
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = base64UrlToBytes(signatureB64Url);
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(data));
}

// ---------- AES-GCM (segredos de conectores, tokens temporários) ----------
const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secretsKeyB64: string): Promise<CryptoKey> {
  let key = aesKeyCache.get(secretsKeyB64);
  if (!key) {
    const raw = base64ToBytes(secretsKeyB64);
    if (raw.length !== 32) throw new Error("SECRETS_KEY precisa ser base64 de 32 bytes");
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    aesKeyCache.set(secretsKeyB64, key);
  }
  return key;
}

/** Cifra texto com AES-256-GCM. Formato: "v1.<iv_b64url>.<ciphertext_b64url>". */
export async function encryptString(secretsKeyB64: string, plaintext: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secretsKeyB64), encoder.encode(plaintext));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ct))}`;
}

export async function decryptString(secretsKeyB64: string, payload: string): Promise<string> {
  const [version, ivPart, ctPart] = payload.split(".");
  if (version !== "v1" || !ivPart || !ctPart) throw new Error("formato de segredo cifrado inválido");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(ivPart) },
    await aesKey(secretsKeyB64),
    base64UrlToBytes(ctPart),
  );
  return decoder.decode(pt);
}

export async function encryptJson(secretsKeyB64: string, value: unknown): Promise<string> {
  return encryptString(secretsKeyB64, JSON.stringify(value));
}

export async function decryptJson<T>(secretsKeyB64: string, payload: string): Promise<T> {
  return JSON.parse(await decryptString(secretsKeyB64, payload)) as T;
}

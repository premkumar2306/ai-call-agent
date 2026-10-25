// AES-GCM for calendar refresh tokens at rest. A leaked D1 export alone must
// not hand out write access to every connected business's calendar, so the
// key lives only in the CALENDAR_TOKEN_KEY secret. Rotating that secret
// invalidates every stored token (businesses reconnect).

async function key(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/** "<iv>.<ciphertext>", both base64. */
export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(secret), new TextEncoder().encode(plain));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(enc: string, secret: string): Promise<string> {
  const [iv, ct] = enc.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await key(secret), unb64(ct));
  return new TextDecoder().decode(plain);
}

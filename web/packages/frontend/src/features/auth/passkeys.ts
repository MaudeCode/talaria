/** WebAuthn helpers ported from static/login.js. */
export function b64uToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  const bin = atob(t)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToB64u(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials
}

interface PublicKeyLike { challenge: string; allowCredentials?: { id: string; type: string }[]; user?: { id: string; name?: string; displayName?: string }; excludeCredentials?: { id: string; type: string }[] }

/** Decode the server's base64url challenge/ids into buffers for navigator.credentials. */
export function decodeRequestOptions(pk: PublicKeyLike): PublicKeyCredentialRequestOptions {
  return {
    ...(pk as unknown as PublicKeyCredentialRequestOptions),
    challenge: b64uToBytes(pk.challenge) as BufferSource,
    ...(pk.allowCredentials ? { allowCredentials: pk.allowCredentials.map((c) => ({ ...c, id: b64uToBytes(c.id) as BufferSource, type: 'public-key' as const })) } : {}),
  }
}

export function decodeCreationOptions(pk: PublicKeyLike): PublicKeyCredentialCreationOptions {
  const user = pk.user ?? { id: '', name: '', displayName: '' }
  return {
    ...(pk as unknown as PublicKeyCredentialCreationOptions),
    challenge: b64uToBytes(pk.challenge) as BufferSource,
    user: { id: b64uToBytes(user.id) as BufferSource, name: user.name ?? 'hermes', displayName: user.displayName ?? user.name ?? 'hermes' },
    ...(pk.excludeCredentials ? { excludeCredentials: pk.excludeCredentials.map((c) => ({ ...c, id: b64uToBytes(c.id) as BufferSource, type: 'public-key' as const })) } : {}),
  }
}

export function encodeAssertion(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAssertionResponse
  return {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    response: { clientDataJSON: bytesToB64u(r.clientDataJSON), authenticatorData: bytesToB64u(r.authenticatorData), signature: bytesToB64u(r.signature), userHandle: r.userHandle ? bytesToB64u(r.userHandle) : null },
  }
}

export function encodeAttestation(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAttestationResponse
  return { id: cred.id, rawId: bytesToB64u(cred.rawId), type: cred.type, response: { clientDataJSON: bytesToB64u(r.clientDataJSON), attestationObject: bytesToB64u(r.attestationObject) } }
}

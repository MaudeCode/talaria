/** 32 random hex characters. getRandomValues, unlike randomUUID, also works on plain-HTTP LAN installs. */
export function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

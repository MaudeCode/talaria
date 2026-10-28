/** 32 random hex characters. getRandomValues, unlike randomUUID, also works on plain-HTTP LAN installs. */
export function randomHex(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** A version 4 UUID from the same source, for contract fields that require one. */
export function randomUuid(): string {
  const hex = randomHex()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 | (parseInt(hex.slice(16, 17), 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`
}

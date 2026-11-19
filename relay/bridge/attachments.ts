// The wire contract between the bridge and the sanitizer. It imports nothing, so the bridge never loads a decoder.

// Kanvil's per-attachment upload limit.
export const maxOutputBytes = 10_000_000;
// What a kept attachment may be, with the extension the bridge names it by.
export const outputExtensions = { "image/png": "png", "image/jpeg": "jpg", "video/mp4": "mp4" } as const;
export type OutputType = keyof typeof outputExtensions;
// Why the sanitizer dropped an attachment; the ticket's Attachments table names it.
export const dropReasons = ["failed validation", "too large", "too long"] as const;
export type DropReason = typeof dropReasons[number];
// A kept response carries the cleaned bytes' SHA-256 in this header; a dropped one is `{"dropped": <reason>}` JSON.
export const digestHeader = "x-content-sha256";

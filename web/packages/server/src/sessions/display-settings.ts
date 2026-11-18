/**
 * TAL-2331, TAL-2341: the switches of Settings › Chat › Tool calls and the Live Activity's, with their defaults. The server
 * applies each to what it sends (clients never filter); the runtime wires the settings store in, and until it does every
 * switch reads its default.
 */
export const DISPLAY_SETTING_DEFAULTS = {
  show_tool_lookups: false,
  formatted_tool_results: true,
  inline_tool_media: true,
  tool_row_outcomes: true,
  merge_repeated_tool_calls: true,
  live_tool_progress: true,
  status_chip_current_action: true,
  turn_summary: true,
  live_activity_current_tool: true,
} as const satisfies Record<string, boolean>
export type DisplaySetting = keyof typeof DISPLAY_SETTING_DEFAULTS

type Reader = (key: DisplaySetting) => boolean
const defaults: Reader = (key) => DISPLAY_SETTING_DEFAULTS[key]
/**
 * Each running server's reader by its owner (its settings store); the newest open server's reads. A process runs one server;
 * a test process boots several, and one closing hands the switches back to the server before it.
 */
const readers = new Map<object, Reader>()
let stub: Reader | null = null

/** A server's settings store reader; a key it cannot read falls back to its default. */
export function readDisplaySettings(owner: object, reader: Reader): void { readers.delete(owner); readers.set(owner, reader) }
export function releaseDisplaySettings(owner: object): void { readers.delete(owner) }

export const displaySetting = (key: DisplaySetting): boolean => (stub ?? [...readers.values()].at(-1) ?? defaults)(key)

/** Tests without a server: the switches `overrides` names, every other at its default; `{}` restores the defaults. */
export function stubDisplaySettings(overrides: Partial<Record<DisplaySetting, boolean>>): void {
  stub = Object.keys(overrides).length ? (key) => overrides[key] ?? DISPLAY_SETTING_DEFAULTS[key] : null
}

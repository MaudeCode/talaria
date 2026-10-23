/**
 * TAL-1403: message modules keep only the base locale; every other locale comes from its lazily
 * loaded dictionary chunk, without the entries a locale leaves identical to English.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localeChunk, splitMessageModule } from './localeSplit'
import { applyLocale, currentLocale } from './runtime'
import { add } from '../paraglide/messages/add.js'
import { checkpoint_diff_files_changed } from '../paraglide/messages/checkpoint_diff_files_changed.js'
import { mcp_status_active } from '../paraglide/messages/mcp_status_active.js'

const OTHER_LOCALES = ['it', 'ja', 'ru', 'es', 'de', 'zh', 'zh_hant1', 'pt', 'ko', 'fr', 'cs', 'tr', 'pl', 'vi']
const compiled = (name: string) => readFileSync(join(import.meta.dirname, '..', 'paraglide', 'messages', `${name}.js`), 'utf8')

describe('splitMessageModule', () => {
  it('reduces a 15-locale plural message with inputs to its English function', () => {
    const source = compiled('checkpoint_diff_files_changed')
    for (const locale of OTHER_LOCALES) expect(source).toContain(`const ${locale}_checkpoint_diff_files_changed = `)
    const split = splitMessageModule(source)!
    expect(split.key).toBe('checkpoint_diff_files_changed')
    for (const locale of OTHER_LOCALES) expect(split.code).not.toContain(`${locale}_checkpoint_diff_files_changed`)
    expect(split.code).toContain('const en_checkpoint_diff_files_changed = ')
    expect(split.code).not.toContain('Dateien')
    expect(Object.keys(split.locales).sort()).toEqual(['cs', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'tr', 'vi', 'zh', 'zh-Hant'])
    expect(split.locales.ru).toContain('nPlural === "few"')
  })

  it('leaves locales whose message is identical to English, written out or aliased, out of the dictionaries', () => {
    expect(Object.keys(splitMessageModule(compiled('add'))!.locales)).not.toContain('es')
    expect(compiled('active_conversation_meta')).toContain('const pt_active_conversation_meta = en_active_conversation_meta;')
    const aliased = splitMessageModule(compiled('active_conversation_meta'))!
    expect(aliased.locales).not.toHaveProperty('pt')
    expect(aliased.code).not.toContain('pt_active_conversation_meta')
  })

  it('splits reserved-word keys and skips the barrel', () => {
    expect(splitMessageModule(compiled('_delete'))?.key).toBe('_delete')
    expect(splitMessageModule(compiled('_index'))).toBeNull()
  })

  it('emits a dictionary chunk keyed by message', () => {
    const chunk = localeChunk([{ key: 'add', expression: '() => `Ajouter`' }], '/paraglide/registry.js')
    expect(chunk).toContain('import * as registry from "/paraglide/registry.js"')
    expect(chunk).toContain('"add": () => `Ajouter`,')
  })
})

describe('locale dictionaries at runtime', () => {
  afterEach(async () => { await applyLocale('en', { persist: false }) })

  it('renders a locale only after its strings load, including inputs and plurals', async () => {
    await applyLocale('ja', { persist: false })
    expect(currentLocale()).toBe('ja')
    expect(add()).toBe('追加')
    expect(checkpoint_diff_files_changed({ n: 2 })).toBe('2 件のファイルが変更されました')

    await applyLocale('ru', { persist: false })
    expect(checkpoint_diff_files_changed({ n: 1 })).toBe('1 файл изменён')
    expect(checkpoint_diff_files_changed({ n: 3 })).toBe('3 файла изменено')
    expect(checkpoint_diff_files_changed({ n: 5 })).toBe('5 файлов изменено')
  })

  it('falls back to English for entries a locale leaves identical', async () => {
    await applyLocale('de', { persist: false })
    expect(add()).toBe('Hinzufügen')
    expect(checkpoint_diff_files_changed({ n: 1 })).toBe('1 Datei geändert')
    expect(mcp_status_active()).toBe('Active')
  })

  it('applies the latest of overlapping switches', async () => {
    await Promise.all([applyLocale('fr', { persist: false }), applyLocale('it', { persist: false })])
    expect(currentLocale()).toBe('it')
    expect(add()).toBe('Aggiungi')
  })
})

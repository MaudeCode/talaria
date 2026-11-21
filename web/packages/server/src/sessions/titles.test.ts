import { describe, expect, it } from 'vitest'
import { sanitizeGeneratedTitle } from './titles.js'

describe('sanitizeGeneratedTitle reads only a title from a generated reply (TAL-2550)', () => {
  const user = 'fix the docker volume permissions'
  it.each<[string, string, string?]>([
    ['{"title": "Docker Volume Permissions"}', 'Docker Volume Permissions'],
    ['```json\n{"title": "Docker Volume Permissions"}\n```', 'Docker Volume Permissions'],
    ['<analysis>Choose a label</analysis>Docker Permissions', 'Docker Permissions'],
    ['<think>They want a title.</think>{"title": "Docker Volume Permissions"}', 'Docker Volume Permissions'],
    ['<reasoning>Spanish fits</reasoning>\n{"title": "Permisos de volúmenes Docker"}', 'Permisos de volúmenes Docker'],
    ['{"title": "ボリュームの権限を修正"}', 'ボリュームの権限を修正', 'ボリュームの権限を直して'],
    ['{"title": "Docker volume permission repairs across Linux and macOS hosts"}', 'Docker volume permission repairs across Linux and '], // the 50-character cap; persisting trims
  ])('extracts the title from %j', (raw, title, userText = user) => {
    expect(sanitizeGeneratedTitle(raw, userText, 'Run chown on the volume.')).toBe(title)
  })

  it.each([
    'I think Docker Permissions is a good title', 'Maybe something like Docker Volume Permissions', 'I’d go with Docker Volume Permissions',
    'How about Docker Volume Permissions?', '<analysis>Choose a label for Docker', 'Docker Volume Permissions</thinking>',
    'Okay here it is {"title": "Docker Volume Permissions"}', '{"name": "Docker Volume Permissions"}',
    '{"title": "Docker Volume Permissions", "reason": "short"}', '{"title": "Docker Volume',
  ])('rejects %j', (raw) => {
    expect(sanitizeGeneratedTitle(raw, user, 'Run chown on the volume.')).toBe('')
  })
})

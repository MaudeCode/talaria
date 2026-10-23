export default {
  lists: 'Intro.\n\n- First\n\n  Continued paragraph.\n\n- Second\n\nAfter.\n\nMore.',
  nested: 'Intro.\n\n1. First\n   - Nested\n\n     Continued\n2. Second\n\nAfter.',
  fences: 'Intro.\n\n~~~~ts\nconst text = "```"\n\nconst answer = 42\n~~~~\n\nAfter.\n\nMore.',
  math: 'Intro.\n\n$$\nx^2\n\n+ y^2\n$$\n\nAfter.\n\nMore.',
  tables: 'Intro.\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter.\n\nMore.',
  footnotes: 'Intro.\n\nA note[^n].\n\nAfter.\n\n[^n]: Footnote text.',
  references: 'Intro.\n\n[Link][ref].\n\nAfter.\n\n[ref]: https://example.test',
  html: 'Intro.\n\n<div>\n\nFirst\n\nSecond\n\n</div>\n\nAfter.\n\nMore.',
  quotes: 'Intro.\n\n> Quoted\n>\n> paragraph\n\nAfter.\n\nMore.',
  partialMarkers: '- First\n\n1. Ordered\n\n123. Continued\n\nAfter.',
  inlineAcrossBlocks: 'Intro.\n\n*First\n\nSecond*\n\nAfter.',
  multilineReference: 'Intro.\n\n[Link][long label].\n\nAfter.\n\n[long\nlabel]: https://example.test',
}

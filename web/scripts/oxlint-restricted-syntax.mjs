// ESLint's core `no-restricted-syntax`, which Oxlint does not ship natively:
// each `{ selector, message }` option reports every node the selector matches.
export default {
  meta: { name: 'talaria' },
  rules: {
    'no-restricted-syntax': {
      meta: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: { selector: { type: 'string' }, message: { type: 'string' } },
            required: ['selector', 'message'],
            additionalProperties: false,
          },
        },
      },
      create(context) {
        return Object.fromEntries(
          context.options.map(({ selector, message }) => [selector, (node) => context.report({ node, message })]),
        )
      },
    },
  },
}

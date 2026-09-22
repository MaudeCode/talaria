import { createFileRoute, notFound } from '@tanstack/react-router'
import { ExtensionRoute } from '../features/extensions/ExtensionRoute'

export const Route = createFileRoute('/_app/ext/$extensionId')({
  params: {
    parse: ({ extensionId }) => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(extensionId)) throw notFound()
      return { extensionId }
    },
    stringify: ({ extensionId }) => ({ extensionId }),
  },
  component: ExtensionPage,
})

function ExtensionPage() {
  const { extensionId } = Route.useParams()
  return <ExtensionRoute extensionId={extensionId} />
}

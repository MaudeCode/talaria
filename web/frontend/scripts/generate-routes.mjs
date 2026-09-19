// Regenerate src/routeTree.gen.ts from src/routes without a Vite build, so
// typecheck and lint can run standalone (CI runs them before the build).
import { Generator, getConfig } from '@tanstack/router-generator'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const config = getConfig({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts', quoteStyle: 'single', semicolons: false }, root)
const generator = new Generator({ config, root })
await generator.run()
console.log('generate-routes: routeTree.gen.ts updated')

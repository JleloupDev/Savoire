import { defineConfig } from 'vitest/config'
import path from 'path'

const pkg = (name: string) =>
  path.resolve(__dirname, `../../../../packages/${name}/src/index.ts`)

export default defineConfig({
  resolve: {
    alias: {
      '@savoire/application':         pkg('application'),
      '@savoire/infrastructure-sync': pkg('infrastructure-sync'),
      '@savoire/platform':            pkg('platform'),
      '@savoire/plugin-api':          pkg('plugin-api'),
      '@savoire/domain-index':        pkg('domain-index'),
      '@savoire/domain-sync':         pkg('domain-sync'),
    },
  },
  test: {
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
    // Run test files one at a time to avoid hammering the server
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { sequential: true },
  },
})

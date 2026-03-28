import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Stub out the obsidian module — it's only available inside Obsidian's Electron runtime.
      // Using resolve() instead of URL to handle spaces in directory names (e.g. "AI Projects").
      obsidian: resolve(__dirname, 'src/__mocks__/obsidian.ts'),
    },
  },
})

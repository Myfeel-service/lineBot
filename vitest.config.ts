import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts', 'shared/**/*.test.ts', 'app/**/*.test.ts'],
  },
  resolve: {
    // ⚠️ 順序有意義：'~~' 要排在 '~' 前面（別名是前綴比對，先中先贏，
    // 反過來的話 '~~/shared/x' 會被 '~' 接走變成 app/~/shared/x）。
    // 對齊 Nuxt 4：'~~' = 專案根、'~' = app/
    alias: {
      '~~': fileURLToPath(new URL('./', import.meta.url)),
      '~': fileURLToPath(new URL('./app/', import.meta.url)),
    },
  },
})

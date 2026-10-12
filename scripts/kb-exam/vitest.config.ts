import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 準度考卷（`C-297`）專用的設定：⛔ 不放進專案的 vitest.config.ts——那邊的 `npx vitest run` 是每次改完都跑的單元測試，
 * 考卷會真的打 AI（花錢、要網路、要正式庫的金鑰），混進去等於每跑一次單元測試就付一次費。
 * 跑法見 scripts/kb-exam/README.md。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/kb-exam/*.exam.ts'],
    // 一題要打好幾次 AI；整份考卷 60 題，給足時間
    testTimeout: 60 * 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '~~': fileURLToPath(new URL('../../', import.meta.url)),
      '~': fileURLToPath(new URL('../../app/', import.meta.url)),
    },
  },
})

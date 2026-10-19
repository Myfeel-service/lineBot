/**
 * 知識量只有一個名字：「AI 知識量」，單位「條」（`D-131`④，2026-10-19）。
 *
 * 為什麼要鎖：官網、條款、付款彈窗叫「AI 知識量」，知識庫頁、加入視窗、小幫手、每日摘要卻叫「知識空間」——
 * 同一個額度兩個名字，店家在方案頁看到「AI 知識量 48 / 50 條」，回到知識庫看到「知識空間滿了」，會以為是兩件事。
 * 這一條掃全站原始碼：只要有一行再寫出「知識空間」就紅（說明改名來歷、而且標了 `D-131` 的那一行除外）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const DIRS = ['app', 'server', 'shared']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|ts)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
  }
  return out
}

describe('知識量的名字（`D-131`④）', () => {
  it('全站不再出現「知識空間」（統一叫「AI 知識量」）', () => {
    const hits: string[] = []
    for (const d of DIRS) {
      for (const file of walk(join(ROOT, d))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (line.includes('知識空間') && !line.includes('`D-131`')) hits.push(`${relative(ROOT, file)}:${i + 1}`)
        })
      }
    }
    expect(hits).toEqual([])
  })

  it('這張網撈得到東西：說明改名來歷的那幾行確實寫著「知識空間」（不然上一條永遠綠）', () => {
    const src = readFileSync(join(ROOT, 'app/components/knowledge/KnowledgeImportDialog.vue'), 'utf8')
    expect(src).toContain('名稱從「知識空間」改成')
  })
})

/**
 * 「帶我走一遍」白名單的防漂移測試（`D-109`）。
 *
 * 導覽與劇本住在 app/（相依 Vue 元件、Element Plus 圖示），shared 這邊 import 不動，
 * 所以跟 `tutorial-topics.test.ts` 同一招：讀檔比對字串。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_TEACHINGS, agentTeachingCatalogueForPrompt, resolveAgentTeaching } from './agent-teachings'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

/** tutorial-topics.ts 裡每一支導覽的 id（只看 TUTORIAL_TOPICS 那一段、主題那一層的 `id:`） */
function tourIds(): string[] {
  const src = read('app/utils/tutorial-topics.ts')
  const body = src.slice(src.indexOf('export const TUTORIAL_TOPICS'))
  const ids = [...body.matchAll(/^ {4}id: '([^']+)',/gm)].map(m => m[1]!)
  // 總覽那支的 id 是常數（OVERVIEW_TOPIC_ID），值在 tutorial-ids.ts
  if (/^ {4}id: OVERVIEW_TOPIC_ID,/m.test(body)) {
    const v = read('app/utils/tutorial-ids.ts').match(/OVERVIEW_TOPIC_ID = '([^']+)'/)?.[1]
    if (v) ids.push(v)
  }
  return ids
}

/** agent-guides.ts 的 AGENT_GUIDES 註冊表的 key */
function guideIds(): string[] {
  const src = read('app/utils/agent-guides.ts')
  const block = src.slice(src.indexOf('export const AGENT_GUIDES'))
  return [...block.matchAll(/^ {2}'([^']+)': /gm)].map(m => m[1]!)
}

const entries = Object.entries(AGENT_TEACHINGS) as [string, { kind: string, ref: string, minRole?: string }][]

describe('小幫手「帶我走一遍」白名單', () => {
  it('讀檔的網撈得到東西（對照組：正規表示式失效時，下面每一關都會空轉通過）', () => {
    expect(tourIds().length).toBeGreaterThan(20)
    expect(tourIds()).toContain('overview')
    expect(guideIds()).toContain('knowledge-first')
  })

  it('每一張導覽卡都指向一支真的存在的導覽', () => {
    const tours = new Set(tourIds())
    const bad = entries.filter(([, t]) => t.kind === 'tour' && !tours.has(t.ref)).map(([id, t]) => `${id} → ${t.ref}`)
    expect(bad, `導覽改名或拿掉了，白名單沒跟上：${bad.join('、')}`).toEqual([])
  })

  it('每一張劇本卡都指向一條真的存在的劇本', () => {
    const guides = new Set(guideIds())
    const bad = entries.filter(([, t]) => t.kind === 'guide' && !guides.has(t.ref)).map(([id, t]) => `${id} → ${t.ref}`)
    expect(bad).toEqual([])
  })

  it('⛔ 反方向：每一支導覽、每一條劇本都叫得出來', () => {
    // 新增一支導覽卻忘了登記＝「教學分頁有、問助理叫不出來」，正是 `D-109` 要收掉的那個洞
    const refs = new Set(entries.map(([, t]) => t.ref))
    const missing = [...tourIds(), ...guideIds()].filter(id => !refs.has(id))
    expect(missing, `這些教材問助理叫不出來：${missing.join('、')}`).toEqual([])
  })

  it('不認得的 id 一律丟掉（模型編不出卡片）', () => {
    expect(resolveAgentTeaching('tour-does-not-exist', 'owner')).toEqual([])
    expect(resolveAgentTeaching('', 'owner')).toEqual([])
    expect(resolveAgentTeaching(undefined, 'owner')).toEqual([])
    expect(resolveAgentTeaching('toString', 'owner')).toEqual([])
  })

  it('角色跑不動的不給卡：觀察者要不到管理員那幾支', () => {
    expect(resolveAgentTeaching('tour-organization', 'viewer')).toEqual([])
    expect(resolveAgentTeaching('tour-organization', 'agent')).toEqual([])
    expect(resolveAgentTeaching('tour-organization', 'admin')).toEqual([{ kind: 'teach', teach: 'tour', ref: 'organization' }])
    // 沒有門檻的誰都拿得到
    expect(resolveAgentTeaching('tour-conversations', 'viewer')).toEqual([{ kind: 'teach', teach: 'tour', ref: 'conversations' }])
    expect(resolveAgentTeaching('panel-status', 'viewer')).toEqual([{ kind: 'teach', teach: 'status', ref: 'setup' }])
  })

  it('給模型的清單也照角色篩（列了跑不動的，模型就會推一張死路卡）', () => {
    const viewer = agentTeachingCatalogueForPrompt('viewer')
    expect(viewer).toContain('tour-conversations')
    expect(viewer).not.toContain('tour-organization')
    expect(viewer).not.toContain('guide-knowledge-first')
    expect(agentTeachingCatalogueForPrompt('owner')).toContain('tour-organization')
  })
})

/**
 * 小幫手代辦・第二批（`D-109`）。
 *
 * 釘住的是「會出事的那幾件」：
 * 1. 只動該動的那一格：AI 設定只帶那一個欄位；自動回應整份送回時，其他步驟一個字都不能變。
 * 2. 做不到的事不出確認卡（看意思的流程沒有關鍵字、多段回覆不知道改哪段、方案不含腳本）。
 * 3. 知識卡一定是「等你看過」：端點沒吃到 draft 的話要照實講「直接上線了」，⛔不可以報成功。
 * 4. 標籤代號是系統取的：撞號自己換一組，⛔不叫他換代號。
 * 5. 指紋會原樣進確認憑證：整份流程／整段指示一定要壓成雜湊。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_TONE_TEMPLATES } from '~~/shared/ai-tone-templates'

// 只要那個錯誤類別：⛔ 不載入真的 admin-ops（它會把生成、用量、推播那一整串都拉進來）
vi.mock('./admin-ops', () => {
  class AdminOpUserError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'AdminOpUserError'
    }
  }
  return { AdminOpUserError }
})

let settingsStore: Record<string, any> = {}
const setCalls: any[] = []
const auditLogs: any[] = []
vi.mock('./ai-settings', () => ({
  getAiSettings: async () => structuredClone(settingsStore),
  setAiSettings: async (_wid: string, partial: any) => { setCalls.push(partial); return {} },
}))
vi.mock('./audit-log', () => ({
  writeAuditLog: async (input: unknown) => { auditLogs.push(input) },
}))
vi.mock('./ai-scripts', () => ({ SCRIPTS_COLLECTION: 'aiScripts' }))
let planStore: { scripting: boolean } | null = { scripting: true }
vi.mock('./billing', () => ({ getWorkspacePlan: async () => planStore }))

// 補知識卡查「相近的卡」走答題同一套向量搜尋：這裡給假的向量與假的搜尋結果
let similarHits: { title: string, similarity: number }[] = []
let embedFails = false
vi.mock('./ai-knowledge-chunks', () => ({
  KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks',
  searchSimilarChunksWithDrafts: async () => similarHits,
}))
vi.mock('./gemini', () => ({
  embedQuery: async () => { if (embedFails) throw new Error('429'); return [0.1] },
  estimateTokens: (s: string) => s.length,
}))
vi.mock('./ai-usage', () => ({ recordAiUsage: async () => {} }))

// ── 轉呼叫既有端點的 $fetch ─────────────────────────────────────────
const fetchCalls: { url: string, method?: string, body?: any }[] = []
/** 每一支端點要怎麼回；沒設的回 { id: 'x' } */
let fetchImpl: (url: string, opts: any) => any = () => ({ id: 'x' })
;(globalThis as any).$fetch = async (url: string, opts: any) => {
  fetchCalls.push({ url, method: opts?.method, body: opts?.body })
  return fetchImpl(url, opts)
}

// ── 假的 Firestore：流程、標籤、知識卡三個 collection ───────────────────────
let scriptDocs: { id: string, data: Record<string, any> }[] = []
let tagDocs: { id: string, data: Record<string, any> }[] = []
let chunkDocs: { id: string, data: Record<string, any> }[] = []
const db = {
  collection: (name: string) => {
    const filters: [string, unknown][] = []
    const chain: any = {
      where: (field: string, _op: string, value: unknown) => { filters.push([field, value]); return chain },
      limit: () => chain,
      select: () => chain,
      get: async () => {
        const rows = (name === 'tags' ? tagDocs : name === 'knowledgeChunks' ? chunkDocs : scriptDocs)
          .map(d => ({ id: d.id, data: { workspaceId: 'w1', ...d.data } }))
          .filter(d => filters.every(([f, v]) => (d.data as any)[f] === v))
        return { docs: rows.map(r => ({ id: r.id, data: () => r.data })) }
      },
    }
    return chain
  },
} as any
const ctx = { db, workspaceId: 'w1', uid: 'u1', authHeader: 'Bearer t' }

const ops = await import('./admin-ops-content')

beforeEach(() => {
  settingsStore = { enabled: false, replyMode: 'draft', handbackIdleMinutes: 0, humanSessionMaxIdleHours: 0, systemPrompt: '我自己寫的規則：不要講價' }
  setCalls.length = 0
  auditLogs.length = 0
  fetchCalls.length = 0
  fetchImpl = () => ({ id: 'x' })
  scriptDocs = []
  tagDocs = []
  chunkDocs = []
  similarHits = []
  embedFails = false
  planStore = { scripting: true }
})

async function propose(op: any, raw: Record<string, unknown>) {
  let args = op.normalize(raw)
  if (op.prepare) args = await op.prepare(ctx, args)
  return { args, preview: await op.preview(ctx, args) }
}

describe('AI 總開關', () => {
  it('打開時要講清楚打開之後是直接回還是只給草稿，後果寫在按鈕上', async () => {
    settingsStore.replyMode = 'auto'
    const { preview } = await propose(ops.aiSettingsEnabled, { enabled: true })
    expect(preview.confirmLabel).toContain('直接回客人')
    expect(preview.warning).toContain('你不會先看到')

    settingsStore.replyMode = 'draft'
    const p2 = await propose(ops.aiSettingsEnabled, { enabled: true })
    expect(p2.preview.confirmLabel).toContain('只給客服草稿')
  })

  it('關掉時要講自動回應照常（這正是 `D-109` 抓到教錯的那句）', async () => {
    settingsStore.enabled = true
    const { preview } = await propose(ops.aiSettingsEnabled, { enabled: false })
    expect(preview.warning).toContain('自動回應不受影響')
  })

  it('已經是那樣就不假裝做了事；執行只帶 enabled 這一格', async () => {
    const { preview } = await propose(ops.aiSettingsEnabled, { enabled: false })
    expect(preview.noop).toBe(true)

    await ops.aiSettingsEnabled.execute(ctx, { enabled: true })
    expect(setCalls).toEqual([{ enabled: true }])
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', before: { enabled: false }, after: { enabled: true } })
  })

  it('沒講開還是關就不收', () => {
    expect(() => ops.aiSettingsEnabled.normalize({})).toThrow('打開')
  })
})

describe('自動交還／自動結束', () => {
  it('「關掉」不用講數字（numberOptional），其他一律要數字', () => {
    expect(ops.aiSettingsHandbackIdle.numberOptional?.({ off: true })).toBe(true)
    expect(ops.aiSettingsHandbackIdle.numberOptional?.({ minutes: 30 })).toBe(false)
    expect(ops.aiSettingsHandbackIdle.needsUserNumber).toBe(true)
    expect(ops.aiSettingsHandbackIdle.normalize({ off: true })).toEqual({ minutes: 0 })
    expect(() => ops.aiSettingsHandbackIdle.normalize({})).toThrow('幾分鐘')
    expect(() => ops.aiSettingsHandbackIdle.normalize({ minutes: 0 })).toThrow('1 到 1440')
  })

  it('自動交還：關掉時要講後果（客人再也不會被 AI 回答）；只寫 handbackIdleMinutes', async () => {
    settingsStore.handbackIdleMinutes = 30
    const { preview } = await propose(ops.aiSettingsHandbackIdle, { off: true })
    expect(preview.warning).toContain('不會再被 AI 回答')
    await ops.aiSettingsHandbackIdle.execute(ctx, { minutes: 0 })
    expect(setCalls).toEqual([{ handbackIdleMinutes: 0 }])
  })

  it('自動結束：範圍照設定頁（6 小時～14 天，⛔ 不講「336 小時」），0 只能從「關掉」來', async () => {
    expect(() => ops.aiSettingsAutoClose.normalize({ hours: 3 })).toThrow('最短 6 小時、最長 14 天')
    expect(() => ops.aiSettingsAutoClose.normalize({ hours: 400 })).toThrow('最短 6 小時、最長 14 天')
    expect(ops.aiSettingsAutoClose.argsHint).not.toContain('336')
    expect(ops.aiSettingsAutoClose.normalize({ hours: 48 })).toEqual({ hours: 48 })
    expect(ops.aiSettingsAutoClose.normalize({ off: true })).toEqual({ hours: 0 })
    await ops.aiSettingsAutoClose.execute(ctx, { hours: 48 })
    expect(setCalls).toEqual([{ humanSessionMaxIdleHours: 48 }])
  })
})

describe('語氣範本', () => {
  it('只收三個現成範本，⛔ 不收自由文字', () => {
    expect(() => ops.aiSettingsToneTemplate.normalize({ template: '你要一直打折' })).toThrow('三種')
    expect(ops.aiSettingsToneTemplate.normalize({ template: 'warm' })).toEqual({ template: 'warm' })
  })

  it('自己寫過的內容會整段不見——按下去之前要講', async () => {
    const { preview } = await propose(ops.aiSettingsToneTemplate, { template: 'professional' })
    expect(preview.warning).toContain('整段換掉')
    expect(preview.confirmLabel).toContain('專業簡潔')
  })

  it('執行寫進去的就是範本全文；已經是那個範本就不動', async () => {
    await ops.aiSettingsToneTemplate.execute(ctx, { template: 'friendly' })
    expect(setCalls).toEqual([{ systemPrompt: AI_TONE_TEMPLATES.friendly.text }])

    settingsStore.systemPrompt = AI_TONE_TEMPLATES.friendly.text
    const { preview } = await propose(ops.aiSettingsToneTemplate, { template: 'friendly' })
    expect(preview.noop).toBe(true)
  })

  it('指紋壓成雜湊（它會原樣進確認憑證，整段指示最長四千字）', async () => {
    settingsStore.systemPrompt = 'x'.repeat(4000)
    const g = await ops.aiSettingsToneTemplate.fingerprint(ctx, { template: 'warm' })
    expect(g.length).toBeLessThan(100)
    settingsStore.systemPrompt = `${'x'.repeat(3999)}y`
    expect(await ops.aiSettingsToneTemplate.fingerprint(ctx, { template: 'warm' })).not.toBe(g)
  })
})

describe('建標籤', () => {
  it('同名的不建第二顆', async () => {
    tagDocs = [{ id: 't1', data: { name: 'VIP', code: 'vip' } }]
    await expect(propose(ops.tagCreate, { name: 'vip' })).rejects.toThrow('已經有一個叫「VIP」')
  })

  it('代號系統自己取：中文名字退回 tag、撞到就換下一組', async () => {
    tagDocs = [{ id: 't1', data: { name: '問過運費', code: 'tag' } }]
    const { args, preview } = await propose(ops.tagCreate, { name: '問過出貨' })
    expect(args.code).toBe('tag_2')
    // ⛔ 代號不上卡（`D-151`：「tag_3」店家用不到也看不懂）
    expect(preview.items.map((i: any) => `${i.heading ?? ''}${i.label}${i.note ?? ''}`).join()).not.toMatch(/tag_|代號/)
  })

  it('建的當下撞號（別人同時建了一顆）就自己換一組重試，⛔不叫他換代號', async () => {
    let n = 0
    fetchImpl = (url) => {
      if (url === '/api/tag/create' && n++ === 0) throw Object.assign(new Error('conflict'), { statusCode: 409 })
      return { id: 'new-tag' }
    }
    const res = await ops.tagCreate.execute(ctx, { name: 'VIP', code: 'vip' })
    expect(res.ok).toBe(true)
    // 畫面靠它把新建的那一列亮起來（`D-112`）
    expect(res.targetId).toBe('new-tag')
    const codes = fetchCalls.filter(c => c.url === '/api/tag/create').map(c => c.body.code)
    expect(codes).toEqual(['vip', 'vip_2'])
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', targetId: 'new-tag', after: { code: 'vip_2' } })
  })

  it('代號被換掉（建的當下撞號）：卡上沒有代號，⛔ 不跟他講；操作紀錄照實記', async () => {
    let n = 0
    fetchImpl = (url) => {
      if (url === '/api/tag/create' && n++ === 0) throw Object.assign(new Error('conflict'), { statusCode: 409 })
      return { id: 'new-tag' }
    }
    const res = await ops.tagCreate.execute(ctx, { name: 'VIP', code: 'vip' })
    expect(res.message).not.toContain('代號')
    expect(auditLogs[0].note).toContain('vip_2')
  })

  // `D-151` 實測：「我想把常買的客人分出來」直接出卡建一個空標籤
  it('🔴 他講的是目的、沒講要建標籤：先講做法再問名字，⛔ 不出卡', () => {
    const ask = () => ops.tagCreate.checkUserWords!({ name: '常買的客人' }, ['我想把常買的客人分出來'])
    expect(ask).toThrow('標籤建好是空的')
    expect(ask).toThrow('建一個標籤「常買的客人」')
    // 講了要建標籤、或用引號講了名字：照常
    expect(() => ops.tagCreate.checkUserWords!({ name: '回購客' }, ['「回購客」', '建一個標籤'])).not.toThrow()
    expect(() => ops.tagCreate.checkUserWords!({ name: '回購客' }, ['幫我建「回購客」'])).not.toThrow()
  })
})

describe('補一張知識卡（只放進「等你看過」）', () => {
  it('沒講答案就不收（⛔ 不自己編）', () => {
    expect(() => ops.knowledgeDraftCreate.normalize({ question: '有沒有停車位' })).toThrow('怎麼回答')
  })

  it('送給建卡端點的一定帶 draft:true；相近的卡先列在確認卡上', async () => {
    fetchImpl = () => ({ id: 'c1', status: 'draft' })
    similarHits = [{ title: '停車資訊', similarity: 0.83 }]
    const { args, preview } = await propose(ops.knowledgeDraftCreate, { question: '請問你們有沒有停車位可以停', answer: '門口有 3 格' })
    expect(preview.items.some((i: any) => i.label.includes('停車資訊'))).toBe(true)
    expect(preview.warning).toContain('還不會')

    const res = await ops.knowledgeDraftCreate.execute(ctx, args)
    expect(res.ok).toBe(true)
    const create = fetchCalls.find(c => c.url === '/api/ai/knowledge/create')!
    expect(create.body).toMatchObject({ draft: true, content: '門口有 3 格', questions: ['請問你們有沒有停車位可以停'] })
  })

  it('相近＝AI 會拿來答的那幾張（過了答題門檻）；⛔ 不再用整句子字串比對', async () => {
    // 門檻照這個帳號的設定：0.8 以下的不算「相近」
    settingsStore.groundingThreshold = 0.8
    similarHits = [{ title: '停車資訊', similarity: 0.83 }, { title: '營業時間', similarity: 0.41 }]
    const { args } = await propose(ops.knowledgeDraftCreate, { question: '請問你們有沒有停車位可以停', answer: '門口有 3 格' })
    expect(args.similar).toEqual(['停車資訊'])
    expect(args.similarChecked).toBe(true)
    expect(fetchCalls.some(c => c.url.startsWith('/api/ai/knowledge/search'))).toBe(false)
  })

  it('🔴 查不成（算向量失敗）要講「這次沒查成」，⛔ 不可以安靜地當成沒有重複', async () => {
    embedFails = true
    const { args, preview } = await propose(ops.knowledgeDraftCreate, { question: '有沒有停車位', answer: '門口有 3 格' })
    expect(args.similarChecked).toBe(false)
    expect(preview.items.some((i: any) => i.label === '這次沒查成')).toBe(true)

    // 查了、真的沒有 → 不多講一行
    embedFails = false
    const clean = await propose(ops.knowledgeDraftCreate, { question: '有沒有停車位', answer: '門口有 3 格' })
    expect(clean.preview.items).toHaveLength(2)
  })

  it('🔴 同一張確認碼送兩次只建一張：建好之後指紋會變，預覽也會說「已經有一模一樣的」', async () => {
    const args = ops.knowledgeDraftCreate.normalize({ question: '有沒有停車位', answer: '門口有 3 格' })
    const g1 = await ops.knowledgeDraftCreate.fingerprint(ctx, args)

    // 模擬第一次執行成功：知識庫裡多了那一張
    chunkDocs = [{ id: 'c1', data: { title: args.title, content: '門口有 3 格', questions: ['有沒有停車位'], deletedAt: null } }]
    const g2 = await ops.knowledgeDraftCreate.fingerprint(ctx, args)
    expect(g2).not.toBe(g1) // 確認端點看到指紋變了就不會再執行一次
    const p = await ops.knowledgeDraftCreate.preview(ctx, args)
    expect(p.noop).toBe(true) // 確認端點靠這個講「剛剛已經執行過了」

    // 回收桶裡那張不算
    chunkDocs = [{ id: 'c1', data: { title: args.title, content: '門口有 3 格', questions: ['有沒有停車位'], deletedAt: 'x' } }]
    expect(await ops.knowledgeDraftCreate.fingerprint(ctx, args)).toBe(g1)
  })

  it('🔴 卡建好但沒學成功（沒有向量）：⛔ 不可以叫他去測試對話試問——那裡搜不到它', async () => {
    fetchImpl = () => ({ id: 'c1', status: 'draft', failureReason: 'Gemini 429（請求太多）' })
    const res = await ops.knowledgeDraftCreate.execute(ctx, { question: 'q?', answer: 'a!', title: 'q?' })
    expect(res.ok).toBe(true)
    expect(res.targetId).toBe('c1')
    expect(res.message).toContain('測試對話暫時問不到它')
    expect(res.message).toContain('Gemini 429')
    expect(auditLogs[0].note).toContain('沒學成功')
  })

  it('🔴 端點沒吃到 draft（卡片直接上線）要照實講，⛔不可以報成功；卡真的建了，紀錄也要有一筆', async () => {
    fetchImpl = () => ({ id: 'c1', status: 'indexed' })
    const res = await ops.knowledgeDraftCreate.execute(ctx, { question: 'q?', answer: 'a!', title: 'q?' })
    expect(res.ok).toBe(false)
    expect(res.message).toContain('直接上線')
    // 建卡端點自己那筆在代辦境域裡不寫（agent-op-context）：這裡不記就完全查不到
    expect(auditLogs).toHaveLength(1)
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', targetId: 'c1', after: { status: 'indexed' } })
  })

  // `C-309`（2026-10-13）：知識庫頁、加入流程都講「條」；確認卡、回話、操作紀錄還在講「一張知識卡」「知識卡額度」
  // `D-131`④（2026-10-19）：額度的名字跟官網、條款、方案頁統一叫「AI 知識量」，⛔ 不再講「知識空間」
  it('確認卡、回話、操作紀錄講「條」與「AI 知識量」，⛔ 不講「張／卡片／知識卡／知識空間」', async () => {
    fetchImpl = () => ({ id: 'c1', status: 'draft', failureReason: 'Gemini 429（請求太多）' })
    similarHits = [{ title: '停車資訊', similarity: 0.83 }]
    const { args, preview } = await propose(ops.knowledgeDraftCreate, { question: '有沒有停車位', answer: '門口有 3 格' })
    const res = await ops.knowledgeDraftCreate.execute(ctx, args)
    fetchImpl = () => ({ id: 'c2', status: 'indexed' })
    const live = await ops.knowledgeDraftCreate.execute(ctx, args)
    const said = [
      preview.summary, preview.warning, ...preview.items.flatMap((i: any) => [i.heading, i.note]),
      res.message, live.message, ...auditLogs.map(a => a.note),
    ].join('\n')
    expect(said).toContain('AI 知識量')
    expect(said).not.toMatch(/張|卡片|知識卡|知識空間/)
  })
})

describe('改自動回應的關鍵字／回覆字', () => {
  const baseScript = () => ({
    id: 's1',
    data: {
      name: '營業時間',
      enabled: true,
      priority: 50,
      rootNodeId: 'n1',
      // 型別放寬：下面幾條會把某一步改成別的樣子（看意思、輸入任何內容…）
      nodes: [
        { id: 'n1', type: 'trigger', keywords: ['營業時間', '幾點開'], matchMode: 'keyword', keywordMatch: 'any', priority: 50, next: 'n2' },
        { id: 'n2', type: 'reply', text: '每天 10:00–19:00', thenHandoff: false },
      ] as Record<string, any>[],
    },
  })

  it('加關鍵字：整份送回 PUT，只有那一格變、其他原樣（含開關與優先度）', async () => {
    scriptDocs = [baseScript()]
    const { args, preview } = await propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: '開到幾點' })
    expect(preview.confirmLabel).toBe('確定加關鍵字')
    const res = await ops.scriptUpdateKeyword.execute(ctx, args)
    expect(res.targetId).toBe('s1')

    const put = fetchCalls.find(c => c.method === 'PUT')!
    expect(put.url).toBe('/api/ai/scripts/s1')
    expect(put.body.enabled).toBe(true)
    expect(put.body.priority).toBe(50)
    expect(put.body.nodes[0].keywords).toEqual(['營業時間', '幾點開', '開到幾點'])
    expect(put.body.nodes[1]).toEqual(baseScript().data.nodes[1])
    expect(auditLogs[0]).toMatchObject({ targetId: 's1', before: { keywords: ['營業時間', '幾點開'] } })
  })

  it('做不到的不出確認卡：看意思的、客人輸入任何內容的、拿掉唯一一個、方案不含腳本', async () => {
    const semantic = baseScript()
    semantic.data.nodes[0] = { ...semantic.data.nodes[0], matchMode: 'semantic' }
    scriptDocs = [semantic]
    await expect(propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: 'x' })).rejects.toThrow('看意思')

    const any = baseScript()
    any.data.nodes[0] = { ...any.data.nodes[0], keywordMatch: 'anyText' }
    scriptDocs = [any]
    await expect(propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: 'x' })).rejects.toThrow('任何內容')

    const one = baseScript()
    one.data.nodes[0] = { ...one.data.nodes[0], keywords: ['營業時間'] }
    scriptDocs = [one]
    await expect(propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'remove', keyword: '營業時間' })).rejects.toThrow('唯一的關鍵字')

    scriptDocs = [baseScript()]
    planStore = { scripting: false }
    await expect(propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: 'x' })).rejects.toThrow('升級方案')
  })

  it('找不到名字就不猜，但要把現有的名字列給它反問', async () => {
    scriptDocs = [baseScript()]
    await expect(propose(ops.scriptUpdateKeyword, { name: '營業', action: 'add', keyword: 'x' })).rejects.toThrow('找不到')
    // 指紋那一步只用名字查（這支假資料庫跟 Firestore 一樣會照條件過濾）：同名的查不到，
    // ⛔ 不可以因此講「這個帳號還沒有任何自動回應」——另外撈一次名字列出來
    await expect(ops.scriptUpdateKeyword.fingerprint(ctx, { name: '營業' })).rejects.toThrow('目前有：「營業時間」')
    scriptDocs = []
    await expect(ops.scriptUpdateKeyword.fingerprint(ctx, { name: '營業' })).rejects.toThrow('還沒有任何自動回應')
  })

  it('🔴 已經 20 個關鍵字就不出確認卡（存檔端點會把第 21 個截掉，卡上卻說加好了）', async () => {
    const full = baseScript()
    full.data.nodes[0] = { ...full.data.nodes[0], keywords: Array.from({ length: 20 }, (_, i) => `詞${i}`) }
    scriptDocs = [full]
    await expect(propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: '退貨' })).rejects.toThrow('最多 20 個')

    // 按下去那一刻才滿（提議之後有人在頁面上加滿）：不送 PUT、照實講
    const res = await ops.scriptUpdateKeyword.execute(ctx, { name: '營業時間', action: 'add', keyword: '退貨' })
    expect(res.ok).toBe(false)
    expect(fetchCalls.some(c => c.method === 'PUT')).toBe(false)

    // 19 個還加得進去；拿掉一個不受上限影響
    full.data.nodes[0] = { ...full.data.nodes[0], keywords: Array.from({ length: 19 }, (_, i) => `詞${i}`) }
    scriptDocs = [full]
    const { preview } = await propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: '退貨' })
    expect(preview.confirmLabel).toBe('確定加關鍵字')
  })

  it('指紋：別的步驟被人改過也要變（整份送回會蓋掉他剛改的）；而且壓成雜湊', async () => {
    scriptDocs = [baseScript()]
    const g1 = await ops.scriptUpdateKeyword.fingerprint(ctx, { name: '營業時間' })
    const edited = baseScript()
    edited.data.nodes[1] = { ...edited.data.nodes[1], text: '每天 11:00 開' }
    scriptDocs = [edited]
    const g2 = await ops.scriptUpdateKeyword.fingerprint(ctx, { name: '營業時間' })
    expect(g2).not.toBe(g1)
    expect(g1.length).toBeLessThan(100)
  })

  it('改回覆字：只有一段回覆才改，PUT 只換那一段文字', async () => {
    scriptDocs = [baseScript()]
    const { args } = await propose(ops.scriptUpdateReply, { name: '營業時間', text: '每天 11:00–20:00' })
    const res = await ops.scriptUpdateReply.execute(ctx, args)
    expect(res.targetId).toBe('s1')
    const put = fetchCalls.find(c => c.method === 'PUT')!
    expect(put.body.nodes[1].text).toBe('每天 11:00–20:00')
    expect(put.body.nodes[0]).toEqual(baseScript().data.nodes[0])

    const multi = baseScript()
    multi.data.nodes.push({ id: 'n3', type: 'reply', text: '另一段', thenHandoff: false } as any)
    scriptDocs = [multi]
    await expect(propose(ops.scriptUpdateReply, { name: '營業時間', text: 'x x' })).rejects.toThrow('2 段回覆')
  })

  // 2026-10-22 老闆截圖「使用者看不太懂，我也看不太懂」：「現在／改成」掛在內容下面、停用的提醒排成第三格，
  // 底下又寫「客人下次打中這條，收到的就是新的這段話」（停用的根本收不到）、{{order_id}} 原樣露出
  it('🔴 改回覆字的卡（截圖那張）：主句講哪一條＋客人什麼時候收到；現在／改成是小標；停用只講停用', async () => {
    scriptDocs = [{
      id: 's2',
      data: {
        name: '退換貨查詢',
        enabled: false,
        priority: 50,
        rootNodeId: 't',
        nodes: [
          { id: 't', type: 'trigger', keywords: ['退貨', '換貨'], matchMode: 'keyword', keywordMatch: 'any', priority: 50, next: 'c' },
          { id: 'c', type: 'collect', question: '好的，請提供您的訂單編號', fieldName: 'order_id', expireMs: 600000, format: 'any', next: 'r' },
          { id: 'r', type: 'reply', text: '已收到您的訂單 {{order_id}}，將由專人盡快為您處理退換貨，謝謝您 🙇', thenHandoff: true },
        ],
      },
    }]
    const { preview } = await propose(ops.scriptUpdateReply, { name: '退換貨查詢', text: '好的，收到' })
    // 前面先問了訂單編號：⛔ 不可以講成「客人打了字就收到」
    expect(preview.summary).toBe('「退換貨查詢」裡，客人回答完「訂單編號」之後會收到的話：')
    expect(preview.items).toEqual([
      { heading: '現在', label: '已收到您的訂單 {{order_id}}，將由專人盡快為您處理退換貨，謝謝您 🙇', tone: 'before', verbatim: true, vars: 'script' },
      { heading: '改成', label: '好的，收到', tone: 'after', verbatim: true, vars: 'script' },
    ])
    // 很短又沒網址：講出客人只看得到這幾個字（⛔ 不擋）
    expect(preview.warning).toBe('這條目前是停用的，要啟用後客人才收得到。客人只會收到「好的，收到」這幾個字。')

    // 小幫手講給他聽的是［訂單編號］（list_scripts 的 replyText）：他照抄回來要換回變數，⛔ 不然客人收到的就是括號那幾個字
    const copied = await propose(ops.scriptUpdateReply, { name: '退換貨查詢', text: '已收到您的訂單［訂單編號］，專人會在一個工作天內在這裡回覆您' })
    expect(copied.args.text).toBe('已收到您的訂單{{order_id}}，專人會在一個工作天內在這裡回覆您')
    expect(copied.preview.items[1].label).toBe(copied.args.text)
    expect(copied.preview.warning).not.toContain('這幾個字')

    // 還沒講要改成哪一句（新的範例句「改「退換貨」回給客人的話」）：先問他要怎麼改，現在那句由系統照抄（⛔ 不出卡，見 propose 測試）
    const askOf = (text: string) => propose(ops.scriptUpdateReply, { name: '退換貨查詢', text }).then(() => null, (e: Error) => e)
    const ask = await askOf('')
    expect(ask?.name).toBe('AdminOpAskFirst')
    expect(ask?.message).toBe([
      '「退換貨查詢」裡，客人回答完「訂單編號」之後會收到的話是：',
      '「已收到您的訂單 ［訂單編號］，將由專人盡快為您處理退換貨，謝謝您 🙇」',
      '（這條目前是停用的，客人現在收不到。）',
      '',
      '你想改成怎麼說？直接把新的那句打給我。',
    ].join('\n'))
    // ⛔ 不叫他附網址、做表單（老闆 10-22：這個流程就是要在 LINE 上完成）
    expect(ask?.message).not.toMatch(/網址|表單/)

    // 「先填表單」（以前我們自己的範例）：他要的是讓客人多留資料——不出確認卡，跟沒講一樣先給他看現在那句，
    // 多一句「不用另外做表單，在這條多加一題，客人直接在 LINE 上回答」
    const form = await askOf('先填表單')
    expect(form?.message).toContain('「已收到您的訂單 ［訂單編號］')
    expect(form?.message).toContain('不用另外做表單')
    expect(form?.message).toContain('在 LINE 上回答')
    expect(form?.message).not.toContain('網址')

    // `D-151` 實測：「請客人先拍照」直接出卡——講的是要客人做的事，不是對客人說的話
    const photo = await askOf('請客人先拍照')
    expect(photo?.name).toBe('AdminOpAskFirst')
    expect(photo?.message).toContain('「請客人先拍照」是要客人做的事')
    // ⚠️ 對客人說話的那種照常出卡（有「您」）
    const polite = await propose(ops.scriptUpdateReply, { name: '退換貨查詢', text: '親愛的客人您好，請先拍一張商品照片傳給我們' })
    expect(polite.preview.items[1].label).toBe('親愛的客人您好，請先拍一張商品照片傳給我們')

    // 憑證照樣簽得出來的話：硬送也⛔不可以把回覆清成空的
    const forced = await ops.scriptUpdateReply.execute(ctx, { name: '退換貨查詢', text: '' })
    expect(forced.ok).toBe(false)
    expect(fetchCalls.some(c => c.method === 'PUT')).toBe(false)

    // 啟用中、沒有先問問題的：講客人傳什麼字
    scriptDocs = [baseScript()]
    const live = (await propose(ops.scriptUpdateReply, { name: '營業時間', text: '每天 11:00–20:00' })).preview
    expect(live.summary).toBe('「營業時間」裡，客人傳「營業時間」「幾點開」時會收到的話：')
    expect(live.warning).toContain('改完馬上生效')
    expect(live.warning).not.toContain('停用')
  })

  it('改關鍵字的卡：停用的時候不講「之後客人講到就會走這條」；一個字的提醒照樣在', async () => {
    const off = baseScript()
    off.data.enabled = false
    scriptDocs = [off]
    const { preview } = await propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: '開' })
    expect(preview.items.map((i: any) => [i.heading, i.tone])).toEqual([['現在的關鍵字', 'before'], ['改成', 'after']])
    expect(preview.warning).toContain('這條目前是停用的')
    expect(preview.warning).toContain('只有一個字')
    expect(preview.warning).not.toContain('之後客人講到')
  })
})

// `D-151`⑵（2026-10-23 老闆拍板）：AI 判斷那種沒有關鍵字，「多認一種講法」要加「客人會這樣講」
describe('增減「客人會這樣講」', () => {
  const semantic = (examples: string[], enabled = true) => ({
    id: 's9',
    data: {
      name: '查詢訂單',
      enabled,
      priority: 60,
      rootNodeId: 't',
      nodes: [
        { id: 't', type: 'trigger', keywords: [], matchMode: 'semantic', examples, priority: 60, next: 'r' },
        { id: 'r', type: 'reply', text: '請提供訂單編號', thenHandoff: false },
      ] as Record<string, any>[],
    },
  })

  it('加一句：整份送回 PUT，只有那一格變；卡上「現在／改成」兩格', async () => {
    scriptDocs = [semantic(['我的訂單到哪了', '出貨了嗎'])]
    const { args, preview } = await propose(ops.scriptUpdateExample, { name: '查詢訂單', action: 'add', example: '寄出了嗎' })
    expect(preview.items.map((i: any) => [i.heading, i.tone, i.label])).toEqual([
      ['現在「客人會這樣講」', 'before', '「我的訂單到哪了」「出貨了嗎」'],
      ['改成', 'after', '「我的訂單到哪了」「出貨了嗎」「寄出了嗎」'],
    ])
    expect(preview.confirmLabel).toBe('確定加這句')
    const res = await ops.scriptUpdateExample.execute(ctx, args)
    expect(res.ok).toBe(true)
    const put = fetchCalls.find(c => c.method === 'PUT')!
    expect(put.body.nodes[0].examples).toEqual(['我的訂單到哪了', '出貨了嗎', '寄出了嗎'])
    expect(put.body.nodes[1]).toEqual(semantic([]).data.nodes[1])
    expect(put.body.priority).toBe(60)
    expect(auditLogs[0]).toMatchObject({ action: 'agent-op/script-update-example', before: { examples: ['我的訂單到哪了', '出貨了嗎'] } })
  })

  it('做不到的不出卡：關鍵字那種（指去加關鍵字）、拿掉唯一一句、已滿 10 句；本來就有＝不用改', async () => {
    scriptDocs = [baseScriptLike()]
    await expect(propose(ops.scriptUpdateExample, { name: '營業時間', action: 'add', example: '今天有開嗎' })).rejects.toThrow('script-update-keyword')
    scriptDocs = [semantic(['出貨了嗎'])]
    await expect(propose(ops.scriptUpdateExample, { name: '查詢訂單', action: 'remove', example: '出貨了嗎' })).rejects.toThrow('唯一的一句')
    scriptDocs = [semantic(Array.from({ length: 10 }, (_, i) => `問法${i}`))]
    await expect(propose(ops.scriptUpdateExample, { name: '查詢訂單', action: 'add', example: '寄出了嗎' })).rejects.toThrow('最多 10 句')
    scriptDocs = [semantic(['出貨了嗎'])]
    expect((await propose(ops.scriptUpdateExample, { name: '查詢訂單', action: 'add', example: '出貨了嗎' })).preview.noop).toBe(true)
  })

  it('停用中的只講停用；關鍵字那條的錯誤也指到這件代辦', async () => {
    scriptDocs = [semantic(['出貨了嗎'], false)]
    const { preview } = await propose(ops.scriptUpdateExample, { name: '查詢訂單', action: 'add', example: '寄出了嗎' })
    expect(preview.warning).toBe('這條目前是停用的，要啟用後才會生效。')
    scriptDocs = [semantic(['出貨了嗎'])]
    await expect(propose(ops.scriptUpdateKeyword, { name: '查詢訂單', action: 'add', keyword: '寄出' })).rejects.toThrow('script-update-example')
  })

  it('那句要是他講的（⛔ 不自己想一句）', () => {
    expect(() => ops.scriptUpdateExample.checkUserWords!({ example: '請問我的包裹寄出了沒有呢' }, ['查詢訂單多認一種講法'])).toThrow('不是使用者講的')
    expect(() => ops.scriptUpdateExample.checkUserWords!({ example: '寄出了嗎' }, ['客人問「寄出了嗎」也要走查詢訂單'])).not.toThrow()
  })

  function baseScriptLike() {
    return {
      id: 's1',
      data: {
        name: '營業時間', enabled: true, priority: 50, rootNodeId: 'n1',
        nodes: [
          { id: 'n1', type: 'trigger', keywords: ['營業時間'], matchMode: 'keyword', keywordMatch: 'any', priority: 50, next: 'n2' },
          { id: 'n2', type: 'reply', text: '每天 10:00–19:00', thenHandoff: false },
        ] as Record<string, any>[],
      },
    }
  }
})

// `D-151` 實測：「改提醒時間」它沒查就說「目前是 0 分鐘」（實際 60）——改時間的問話改由系統寫、附上現在的值
describe('沒講幾分鐘／幾小時：系統先講現在是多少再問', () => {
  it('自動交還、自動結束（範圍講天數，⛔ 不講 336 小時）', async () => {
    settingsStore = { ...settingsStore, handbackIdleMinutes: 30, humanSessionMaxIdleHours: 48 }
    expect(await ops.aiSettingsHandbackIdle.askForNumber!(ctx as any)).toContain('閒置 30 分鐘')
    const close = await ops.aiSettingsAutoClose.askForNumber!(ctx as any)
    expect(close).toContain('2 天沒動靜')
    expect(close).toContain('最短 6 小時、最長 14 天')
    expect(close).not.toContain('336')
    settingsStore = { ...settingsStore, handbackIdleMinutes: 0, humanSessionMaxIdleHours: 0 }
    expect(await ops.aiSettingsHandbackIdle.askForNumber!(ctx as any)).toContain('現在沒有開自動交還')
    expect(await ops.aiSettingsAutoClose.askForNumber!(ctx as any)).toContain('現在沒有開自動結束')
  })
})

describe('確認卡的每一格：「這是什麼」畫在內容上面', () => {
  it('⛔ 「現在／改成」不再寫在 note（note 畫在內容下面，讀完一整段才知道是哪一個）', async () => {
    settingsStore = { ...settingsStore, enabled: true, handbackIdleMinutes: 30, humanSessionMaxIdleHours: 48 }
    scriptDocs = [{ id: 's1', data: { name: '營業時間', enabled: true, priority: 50, rootNodeId: 'n1', nodes: [
      { id: 'n1', type: 'trigger', keywords: ['營業時間'], matchMode: 'keyword', keywordMatch: 'any', priority: 50, next: 'n2' },
      { id: 'n2', type: 'reply', text: '每天 10:00–19:00', thenHandoff: false },
    ] } }]
    const previews = await Promise.all([
      propose(ops.aiSettingsEnabled, { enabled: false }),
      propose(ops.aiSettingsHandbackIdle, { minutes: 10 }),
      propose(ops.aiSettingsAutoClose, { hours: 24 }),
      propose(ops.aiSettingsToneTemplate, { template: 'friendly' }),
      propose(ops.scriptUpdateKeyword, { name: '營業時間', action: 'add', keyword: '幾點' }),
      propose(ops.scriptUpdateReply, { name: '營業時間', text: '每天 11:00 開' }),
    ])
    for (const { preview } of previews) {
      for (const it of preview.items) expect(it.note ?? '').not.toMatch(/^(現在|改成)/)
      expect(preview.items.filter((i: any) => i.tone).map((i: any) => i.tone)).toEqual(['before', 'after'])
    }
  })
})

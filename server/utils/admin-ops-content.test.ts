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

  it('自動結束：範圍照設定頁（6～336 小時），0 只能從「關掉」來', async () => {
    expect(() => ops.aiSettingsAutoClose.normalize({ hours: 3 })).toThrow('6 到 336')
    expect(() => ops.aiSettingsAutoClose.normalize({ hours: 400 })).toThrow('6 到 336')
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
    expect(preview.items.map((i: any) => i.label)).toContain('tag_2')
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

  it('🔴 代號被換掉要照實講：確認卡寫「建好就不能改」的是 vip，真的建出來是 vip_2', async () => {
    let n = 0
    fetchImpl = (url) => {
      if (url === '/api/tag/create' && n++ === 0) throw Object.assign(new Error('conflict'), { statusCode: 409 })
      return { id: 'new-tag' }
    }
    const res = await ops.tagCreate.execute(ctx, { name: 'VIP', code: 'vip' })
    expect(res.message).toContain('「vip_2」')
    expect(res.message).toContain('「vip」')

    // 沒撞號就不多講一句
    fetchImpl = () => ({ id: 'new-tag' })
    const plain = await ops.tagCreate.execute(ctx, { name: 'VIP', code: 'vip' })
    expect(plain.message).not.toContain('代號')
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
})

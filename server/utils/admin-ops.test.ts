/**
 * 小幫手代辦的操作模組表（`C-31` Phase 2）。
 *
 * 釘住的是「會出事的那幾件」：
 * 1. 🔴 **勿擾時段與服務時間是補集**——使用者說「晚上 10 點到早上 8 點不要吵我」，
 *    存進去的服務時間必須是 08:00–22:00。寫反的話上下班時間整個顛倒，
 *    而且是那種「畫面看起來有設定、行為卻相反」的錯。
 * 2. 預覽階段**一個字都不寫**：確認之前不落任何變更是這整條路的前提。
 * 3. 執行只動該動的那一格（⛔整包覆蓋會洗掉別人剛編輯的內容）。
 * 4. 找不到／撞名不猜：列清單讓它反問，⛔不要挑「最接近的那一條」。
 * 5. 已經是那個狀態就不要假裝做了事。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_OP_LABELS, ADMIN_OP_RISK, adminOpAuditAction } from '~~/shared/types/admin-ops'
import { AUDIT_ACTION_LABELS } from '~~/shared/types/audit'
import { CAPABILITIES } from '~~/shared/permissions'

const settingsStore: Record<string, any> = {
  serviceHours: { enabled: true, start: '09:00', end: '18:00', weekendOff: true, dndReply: 'x' },
  handoffNotify: { enabled: true, lineUserIds: ['U1'], slaRemindMinutes: 30 },
  sensitiveTopics: ['退款'],
}
const setCalls: any[] = []
const auditLogs: any[] = []
const invalidated: string[] = []

vi.mock('./ai-settings', () => ({
  getAiSettings: async () => structuredClone(settingsStore),
  setAiSettings: async (_wid: string, partial: any) => { setCalls.push(partial); return {} },
}))
vi.mock('./audit-log', () => ({
  writeAuditLog: async (input: unknown) => { auditLogs.push(input) },
}))
vi.mock('./script-health', () => ({
  invalidateScriptHealthCache: (wid: string) => { invalidated.push(wid) },
}))
// 送訊息熱路徑的 60 秒快取：不清的話「已下架」是假的，客人還會被那條流程接走
const hotCacheCleared: string[] = []
/** 答錯紀錄是否剛好撈滿上限（＝更早的看不到，講法必須不一樣） */
let fullFeedbackPage = false
vi.mock('./ai-scripts', () => ({
  SCRIPTS_COLLECTION: 'aiScripts',
  invalidateScriptsCache: (wid: string) => { hotCacheCleared.push(wid) },
}))
// 生成端：每次回不一樣的名字，好驗「同意的那份就是建出來的那份」
let draftSeq = 0
vi.mock('./ai-script-generate', () => ({
  generateScriptDraft: async (description: string) => ({
    name: `退貨查詢 v${++draftSeq}`,
    rootNodeId: 'n1',
    nodes: [
      { id: 'n1', type: 'trigger', keywords: ['退貨'], matchMode: 'keyword', priority: 1, next: 'n2' },
      { id: 'n2', type: 'collect', question: '請給我訂單編號', fieldName: 'orderNo', expireMs: 600000, next: 'n3' },
      { id: 'n3', type: 'reply', text: `收到，我們三天內回覆（${description.slice(0, 6)}）`, next: '' },
    ],
    inputTokens: 10,
    outputTokens: 20,
  }),
}))
vi.mock('./ai-usage', () => ({
  recordAiUsage: async () => {},
  getCurrentMonthUsageCounts: async () => ({ invocations: 120, answered: 98, billable: 110 }),
}))

/** 走既有端點的 op 用的 $fetch：記下被呼叫的內容 */
const fetchCalls: any[] = []
;(globalThis as any).$fetch = async (url: string, opts: any) => {
  fetchCalls.push({ url, ...opts })
  if (url.includes('/api/audience/estimate')) return { estimatedCount: 42, previewUserIds: [] }
  return { id: 'new-script-id' }
}

const { ADMIN_OPS, AdminOpUserError, getAdminOp } = await import('./admin-ops')

// ── 假的 Firestore：只夠這兩個 op 用（流程清單 + 單一文件 update）────
const scriptDocs: { id: string, data: Record<string, any> }[] = []
const updates: { id: string, patch: Record<string, unknown> }[] = []

/** 其他 collection 的資料（標籤、推播）；沒列到的名字一律回流程清單，維持既有測試不變 */
const extraCollections: Record<string, { id: string, data: Record<string, any> }[]> = { tags: [], broadcasts: [] }

const db = {
  collection: (name: string) => {
    // 鏈式 where/limit/get：實際程式用 .where('name','==',x).limit(10).get() 找同名的那幾筆
    const chain: any = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      get: async () => {
        if (name === 'aiFeedbackEvents') {
          // 撈滿 100 筆且裡面沒有 wrong_answer：這正是「零 ≠ 沒有」那個情境
          const rows = fullFeedbackPage
            ? Array.from({ length: 100 }, () => ({ type: 'draft_applied', createdAt: { toMillis: () => Date.now() } }))
            : []
          return { size: rows.length, docs: rows.map((r, i) => ({ id: `f${i}`, data: () => r })) }
        }
        const rows = extraCollections[name] ?? scriptDocs
        return { docs: rows.map(d => ({ id: d.id, data: () => ({ workspaceId: 'w1', ...d.data }) })) }
      },
    }
    return {
      ...chain,
      doc: (id: string) => ({
        update: async (patch: Record<string, unknown>) => { updates.push({ id, patch }) },
      }),
    }
  },
} as any

const ctx = { db, workspaceId: 'w1', uid: 'u1' }

beforeEach(() => {
  setCalls.length = 0
  auditLogs.length = 0
  invalidated.length = 0
  hotCacheCleared.length = 0
  updates.length = 0
  scriptDocs.length = 0
  extraCollections.tags = []
  extraCollections.broadcasts = []
  fetchCalls.length = 0
  draftSeq = 0
  settingsStore.serviceHours = { enabled: true, start: '09:00', end: '18:00', weekendOff: true, dndReply: 'x' }
  settingsStore.handoffNotify = { enabled: true, lineUserIds: ['U1'], slaRemindMinutes: 30 }
  settingsStore.sensitiveTopics = ['退款']
  settingsStore.replyMode = 'draft'
  settingsStore.enabled = true
})

describe('操作模組表的不變量', () => {
  it('每個 op 都有白話名稱、風險級別，且⛔沒有高風險的東西混進來', () => {
    for (const id of Object.keys(ADMIN_OPS) as (keyof typeof ADMIN_OP_LABELS)[]) {
      expect(ADMIN_OP_LABELS[id], `${id} 沒有白話名稱`).toBeTruthy()
      expect(['low', 'medium'], `${id} 的風險級別不合法（高風險連掛都不該掛）`).toContain(ADMIN_OP_RISK[id])
    }
  })

  it('每個 op 的門檻都是既有 capability（⛔不自己發明一套權限）', () => {
    for (const [id, op] of Object.entries(ADMIN_OPS))
      expect(CAPABILITIES[op.capability], `${id} 用了不存在的 capability`).toBeTruthy()
  })

  it('每個 op 在操作紀錄上都有白話說明（否則畫面會秀 agent-op/xxx 給店家看）', () => {
    for (const id of Object.keys(ADMIN_OPS) as (keyof typeof ADMIN_OP_LABELS)[])
      expect(AUDIT_ACTION_LABELS[adminOpAuditAction(id)], `${id} 缺操作紀錄說明`).toBeTruthy()
  })

  it('不認得的操作代號一律擋下，並講出做得到哪些（⛔不做最接近的那個）', () => {
    expect(() => getAdminOp('delete-everything')).toThrow(AdminOpUserError)
  })
})

describe('op：服務時間／勿擾時段', () => {
  const op = ADMIN_OPS['ai-settings-service-hours']

  it('🔴 講「勿擾 22:00–08:00」要存成服務時間 08:00–22:00（補集，⛔不是照抄）', () => {
    const args = op.normalize({ mode: 'dnd', start: '22:00', end: '08:00' })
    expect(args).toMatchObject({ enabled: true, start: '08:00', end: '22:00' })
  })

  it('講「服務時間 9 點到 6 點」就照抄，並補零成 09:00', () => {
    expect(op.normalize({ mode: 'service', start: '9:00', end: '18:00' }))
      .toMatchObject({ start: '09:00', end: '18:00' })
  })

  it('沒講清楚是哪一種時間、或時間格式不對：要求反問，⛔不自己猜一個', () => {
    expect(() => op.normalize({ start: '22:00', end: '08:00' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ mode: 'service', start: '晚上', end: '早上' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ mode: 'service', start: '09:00', end: '09:00' })).toThrow(AdminOpUserError)
  })

  it('預覽會把前後與「勿擾是哪一段」都講出來，而且⛔一個字都還沒寫進去', async () => {
    const args = op.normalize({ mode: 'dnd', start: '22:00', end: '08:00' })
    const preview = await op.preview(ctx, args)

    expect(preview.items.map(i => i.label)).toEqual(['週一至週五 09:00–18:00', '週一至週五 08:00–22:00'])
    expect(preview.items[1]?.note).toContain('22:00–08:00') // 改完的勿擾時段
    expect(preview.warning).toContain('找真人')
    expect(setCalls).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('執行才寫入：只帶服務時間這一格，並留下前後對照的稽核（actor=agent）', async () => {
    const args = op.normalize({ mode: 'dnd', start: '22:00', end: '08:00' })
    const res = await op.execute(ctx, args)

    expect(res.ok).toBe(true)
    expect(setCalls).toHaveLength(1)
    // ⛔ 只有 serviceHours：整份設定覆蓋會把別的欄位一起洗掉
    expect(Object.keys(setCalls[0])).toEqual(['serviceHours'])
    expect(setCalls[0].serviceHours).toMatchObject({ enabled: true, start: '08:00', end: '22:00', weekendOff: true })
    expect(auditLogs[0]).toMatchObject({
      actor: 'agent',
      action: 'agent-op/ai-settings-service-hours',
      before: { serviceHours: { start: '09:00', end: '18:00' } },
      after: { serviceHours: { start: '08:00', end: '22:00' } },
    })
  })

  it('沒提到週末就沿用現在的設定（⛔不要順手幫人改成預設值）', async () => {
    settingsStore.serviceHours = { enabled: true, start: '09:00', end: '18:00', weekendOff: false, dndReply: 'x' }
    await op.execute(ctx, op.normalize({ mode: 'service', start: '10:00', end: '19:00' }))
    expect(setCalls[0].serviceHours.weekendOff).toBe(false)
  })

  it('本來就是關的還要關：說不用改，且不寫入', async () => {
    settingsStore.serviceHours = { enabled: false, start: '09:00', end: '18:00', weekendOff: true, dndReply: 'x' }
    const args = op.normalize({ enabled: false })

    const preview = await op.preview(ctx, args)
    expect(preview.noop).toBe(true)

    const res = await op.execute(ctx, args)
    expect(res.ok).toBe(true)
    expect(setCalls).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })
})

describe('op：客人等太久的提醒時間', () => {
  const op = ADMIN_OPS['ai-settings-handoff-sla']

  it('改分鐘數只動那一格，收件人名單與開關原封不動', async () => {
    const res = await op.execute(ctx, op.normalize({ minutes: 15 }))

    expect(res.ok).toBe(true)
    expect(setCalls[0]).toEqual({ handoffNotify: { slaRemindMinutes: 15 } })
    // ⛔ 存成設定裡的真實層級，還原那支才看得懂是哪一項（扁平的 slaRemindMinutes 永遠還原不了）
    expect(auditLogs[0]).toMatchObject({
      actor: 'agent',
      before: { handoffNotify: { slaRemindMinutes: 30 } },
      after: { handoffNotify: { slaRemindMinutes: 15 } },
    })
  })

  it('0＝不提醒，是合法的設定不是錯誤', () => {
    expect(op.normalize({ minutes: 0 })).toMatchObject({ minutes: 0 })
  })

  it('沒講數字、或超出一天：要求問清楚，⛔不自己填一個', () => {
    expect(() => op.normalize({})).toThrow(AdminOpUserError)
    expect(() => op.normalize({ minutes: 5000 })).toThrow(AdminOpUserError)
  })

  it('🔴 通知本身是關的：要當場講「改了也不會有人被提醒」', async () => {
    settingsStore.handoffNotify = { enabled: false, lineUserIds: [], slaRemindMinutes: 30 }
    const preview = await op.preview(ctx, op.normalize({ minutes: 10 }))

    expect(preview.warning).toContain('不會有人被提醒')
  })
})

describe('op：一提到就轉真人的字', () => {
  const op = ADMIN_OPS['ai-settings-sensitive-topic']

  it('加字：整份清單一起寫回去（陣列是取代不是合併，只丟新字會洗掉舊的）', async () => {
    const res = await op.execute(ctx, op.normalize({ action: 'add', word: '客訴' }))

    expect(res.ok).toBe(true)
    expect(setCalls[0]).toEqual({ sensitiveTopics: ['退款', '客訴'] })
    expect(auditLogs[0]).toMatchObject({ before: { sensitiveTopics: ['退款'] }, after: { sensitiveTopics: ['退款', '客訴'] } })
  })

  it('拿掉字：剩下的都留著', async () => {
    settingsStore.sensitiveTopics = ['退款', '客訴']
    await op.execute(ctx, op.normalize({ action: 'remove', word: '退款' }))

    expect(setCalls[0]).toEqual({ sensitiveTopics: ['客訴'] })
  })

  it('🔴 加字與拿掉字的後果要分開講（一個變保守、一個是放寬）', async () => {
    const add = await op.preview(ctx, op.normalize({ action: 'add', word: '客訴' }))
    const remove = await op.preview(ctx, op.normalize({ action: 'remove', word: '退款' }))

    expect(add.warning).toContain('直接轉給真人')
    expect(remove.warning).toContain('不再自動轉給真人')
  })

  it('已經在清單裡／本來就不在：說不用改，且不寫入', async () => {
    expect((await op.preview(ctx, op.normalize({ action: 'add', word: '退款' }))).noop).toBe(true)
    expect((await op.preview(ctx, op.normalize({ action: 'remove', word: '沒有這個' }))).noop).toBe(true)

    await op.execute(ctx, op.normalize({ action: 'add', word: '退款' }))
    expect(setCalls).toHaveLength(0)
  })

  it('沒講要加還是拿掉、或沒講是哪個字：要求問清楚', () => {
    expect(() => op.normalize({ word: '退款' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ action: 'add' })).toThrow(AdminOpUserError)
  })
})

describe('op：自動回應上架／下架', () => {
  const op = ADMIN_OPS['script-set-enabled']

  function seed(rows: { id: string, name: string, enabled: boolean, keywords?: string[] }[]) {
    scriptDocs.push(...rows.map(r => ({
      id: r.id,
      data: {
        name: r.name,
        enabled: r.enabled,
        rootNodeId: 'n1',
        nodes: [{ id: 'n1', type: 'trigger', keywords: r.keywords ?? ['出貨'], matchMode: 'keyword' }],
      },
    })))
  }

  it('預覽講出觸發字與影響，⛔不寫任何東西', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true, keywords: ['出貨', '到貨'] }])
    const args = op.normalize({ name: '出貨查詢', enabled: false })
    const preview = await op.preview(ctx, args)

    expect(preview.summary).toContain('下架')
    expect(preview.items[1]?.label).toContain('出貨')
    expect(preview.warning).toContain('收不到')
    expect(updates).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('執行只動「有沒有啟用」那一格（⛔不整份覆蓋），並戳掉健康狀態快取', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true }])
    const res = await op.execute(ctx, op.normalize({ name: '出貨查詢', enabled: false }))

    expect(res.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(Object.keys(updates[0]!.patch).sort()).toEqual(['enabled', 'updatedAt'])
    expect(updates[0]!.patch.enabled).toBe(false)
    expect(invalidated).toEqual(['w1'])
    // 🔴 熱路徑那層也要清：只清健康狀態的話，聊天室說「客人不會再走到它」是假的
    expect(hotCacheCleared).toEqual(['w1'])
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', before: { enabled: true }, after: { enabled: false } })
  })

  it('🔴 上架會蓋掉別條時要當場講出來（影響常常不在這條身上，在別條身上）', async () => {
    seed([
      { id: 'd1', name: '出貨查詢', enabled: true, keywords: ['出貨'] },
      { id: 'd2', name: '全部攔截', enabled: false, keywords: ['出'] }, // 「出」包住「出貨」
    ])
    const preview = await op.preview(ctx, op.normalize({ name: '全部攔截', enabled: true }))

    const labels = preview.items.map(i => i.label).join('｜')
    expect(labels).toContain('「出貨查詢」會被蓋掉')
  })

  it('🔴 找不到那條流程：列出現有的讓它反問，⛔不挑最接近的那一條', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true }, { id: 'd2', name: '退貨流程', enabled: false }])
    const args = op.normalize({ name: '出貨', enabled: false }) // 少了「查詢」

    await expect(op.preview(ctx, args)).rejects.toThrow(AdminOpUserError)
    await expect(op.preview(ctx, args)).rejects.toThrow(/出貨查詢/)
    expect(updates).toHaveLength(0)
  })

  it('🔴 兩條同名：不猜，請人去改名或自己操作', async () => {
    seed([{ id: 'd1', name: '客服', enabled: true }, { id: 'd2', name: '客服', enabled: false }])
    await expect(op.preview(ctx, op.normalize({ name: '客服', enabled: false }))).rejects.toThrow(/沒辦法確定/)
  })

  it('已經是那個狀態：說不用改，且不寫入', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: false }])
    const args = op.normalize({ name: '出貨查詢', enabled: false })

    expect((await op.preview(ctx, args)).noop).toBe(true)
    await op.execute(ctx, args)
    expect(updates).toHaveLength(0)
    expect(auditLogs).toHaveLength(0)
  })

  it('沒說要開還是關就不提議（⛔不要自己補一個常見值）', () => {
    expect(() => op.normalize({ name: '出貨查詢' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ enabled: true })).toThrow(AdminOpUserError)
  })

  it('現況指紋含「現在是開還是關」：別人改過之後，舊提議就對不上了', async () => {
    seed([{ id: 'd1', name: '出貨查詢', enabled: true }])
    const args = op.normalize({ name: '出貨查詢', enabled: false })
    const before = await op.fingerprint(ctx, args)

    scriptDocs[0]!.data.enabled = false // 別人剛剛在頁面上把它關掉了
    expect(await op.fingerprint(ctx, args)).not.toBe(before)
  })
})

describe('op：AI 直接回客人／只給草稿（D-80 老闆拍板 C 案）', () => {
  const op = ADMIN_OPS['ai-settings-reply-mode']

  it('🔴 要改成「直接回客人」時，確認鈕上必須寫清楚後果，並秀出 AI 最近表現', async () => {
    const preview = await op.preview(ctx, op.normalize({ mode: 'auto' }))

    expect(preview.confirmLabel).toBe('確定讓 AI 直接回客人')
    expect(preview.warning).toContain('你不會先看到')
    // 拍板 C 案的守門：不給表現數字就等於叫人閉眼按
    expect(preview.items.some(i => /被叫了 120 次/.test(i.label))).toBe(true)
  })

  it('改回草稿是往安全的方向：講法不同、鈕也不同', async () => {
    settingsStore.replyMode = 'auto'
    const preview = await op.preview(ctx, op.normalize({ mode: 'draft' }))

    expect(preview.confirmLabel).toBe('確定改回只給草稿')
    expect(preview.warning).not.toContain('你不會先看到')
  })

  it('🔴 答錯紀錄被截斷時，零也不可以講成「沒有人標過」', async () => {
    // 撈到上限＝更早的看不到；這一格是「要不要讓 AI 直接對所有客人說話」的判斷依據
    fullFeedbackPage = true
    const preview = await op.preview(ctx, op.normalize({ mode: 'auto' }))
    const perf = preview.items.find(i => i.note === 'AI 最近的表現')!.label
    expect(perf).toContain('只看得到最近 100 筆')
    expect(perf).not.toContain('沒有人標過它答錯')
    fullFeedbackPage = false
  })

  it('⚠️ AI 整個是關的時候要講出來（改了也不會有動作）', async () => {
    settingsStore.enabled = false
    const preview = await op.preview(ctx, op.normalize({ mode: 'auto' }))
    expect(preview.items.some(i => /AI 目前整個是關的/.test(i.label))).toBe(true)
  })

  it('執行只動這一格，並留下前後對照的稽核', async () => {
    await op.execute(ctx, op.normalize({ mode: 'auto' }))

    expect(setCalls[0]).toEqual({ replyMode: 'auto' })
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', before: { replyMode: 'draft' }, after: { replyMode: 'auto' } })
  })

  it('沒講要哪一種就不提議', () => {
    expect(() => op.normalize({})).toThrow(AdminOpUserError)
    expect(() => op.normalize({ mode: '自動' })).toThrow(AdminOpUserError)
  })
})

describe('op：用一句話建一條自動回應（D-58② 老闆拍板）', () => {
  const op = ADMIN_OPS['script-create-from-description']

  it('預覽用白話講出客人會經歷什麼，⛔而且這時候還沒建任何東西', async () => {
    const args = await op.prepare!(ctx, op.normalize({ description: '客人說退貨時，先問訂單編號再回覆處理時間' }))
    const preview = await op.preview(ctx, args)

    const labels = preview.items.map(i => i.label).join(' ')
    expect(labels).toContain('客人打「退貨」的時候啟動')
    expect(labels).toContain('請給我訂單編號')
    expect(preview.warning).toContain('關著')
    expect(fetchCalls).toHaveLength(0)
  })

  it('🔴 建出來的就是他看過的那一份（⛔執行時不重生）', async () => {
    const args = await op.prepare!(ctx, op.normalize({ description: '退貨查詢流程' }))
    const shownName = (args as any).draft.name
    await op.execute(ctx, args)

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].body.name).toBe(shownName) // 重生的話這裡會變成 v2
  })

  it('🔴 建好一律停用：AI 擬的東西要人看過才對客人生效', async () => {
    const args = await op.prepare!(ctx, op.normalize({ description: '退貨查詢流程' }))
    await op.execute(ctx, args)

    expect(fetchCalls[0].body.enabled).toBe(false)
    expect(fetchCalls[0].url).toBe('/api/ai/scripts/create') // 走既有端點，驗證不重寫
    expect(auditLogs[0]).toMatchObject({ actor: 'agent', after: { enabled: false } })
  })

  it('描述太籠統就先問清楚，⛔不要生一個空殼流程出來', () => {
    expect(() => op.normalize({ description: '建一個' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({})).toThrow(AdminOpUserError)
  })
})

describe('op：建一則推播草稿（⛔只建草稿，發送永遠留人按）', () => {
  const op = ADMIN_OPS['broadcast-draft-create']
  const seedTag = (name: string, id = 't1') => { (extraCollections.tags ??= []).push({ id, data: { name } }) }

  it('沒指定標籤＝全部好友，並且會先試算大概幾個人', async () => {
    const args = await op.prepare!(ctx, op.normalize({ name: '中秋通知', text: '中秋連假出貨會順延一天' }))
    const preview = await op.preview(ctx, args)

    expect(preview.summary).toContain('不會發出去')
    expect(preview.items[1]?.label).toBe('全部好友')
    expect(preview.items[1]?.note).toContain('42 人')
    expect(preview.warning).toContain('自己按')
  })

  it('指定標籤：名字對到才算，⛔對不到就列出現有的讓它反問', async () => {
    seedTag('VIP')
    const ok = await op.prepare!(ctx, op.normalize({ name: 'VIP 通知', text: '感謝支持', tagName: 'VIP' }))
    expect((ok as any).tagId).toBe('t1')

    await expect(op.prepare!(ctx, op.normalize({ name: 'x', text: 'yy', tagName: '黃金會員' })))
      .rejects.toThrow(/VIP/)
  })

  it('🔴 執行只建草稿：走既有建立端點、內容照抄，⛔沒有碰任何發送端點', async () => {
    seedTag('VIP')
    const args = await op.prepare!(ctx, op.normalize({ name: 'VIP 通知', text: '感謝支持', tagName: 'VIP' }))
    fetchCalls.length = 0
    const res = await op.execute(ctx, args)

    expect(res.ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toBe('/api/broadcast/create')
    expect(fetchCalls[0].body.audienceSource).toEqual({ type: 'tags', tagIds: ['t1'] })
    expect(fetchCalls[0].body.messages).toEqual([{ type: 'text', text: '感謝支持' }])
    // ⛔ 發送是紅線：整條路上不可以出現任何 send/schedule
    expect(fetchCalls.some(c => /send|schedule/.test(c.url))).toBe(false)
    expect(res.message).toContain('還沒有發送')
  })

  it('試算失敗不擋建立，但也不可以假裝算得出來', async () => {
    const prev = (globalThis as any).$fetch
    ;(globalThis as any).$fetch = async (url: string, opts: any) => {
      if (url.includes('estimate')) throw new Error('boom')
      fetchCalls.push({ url, ...opts })
      return { id: 'b1' }
    }
    const args = await op.prepare!(ctx, op.normalize({ name: '通知', text: '內容' }))
    const preview = await op.preview(ctx, args)
    expect(preview.items[1]?.note).toContain('算不出')
    ;(globalThis as any).$fetch = prev
  })

  it('名稱或內容沒講就先問，⛔不自己編一則推播', () => {
    expect(() => op.normalize({ text: '內容' })).toThrow(AdminOpUserError)
    expect(() => op.normalize({ name: '通知' })).toThrow(AdminOpUserError)
  })
})

/**
 * 「還原這一筆」第一批（改一個值）＋第二批（新增的東西）（2026-10-28 `D-156`）。
 *
 * 老闆問「能還原的會不會太少」——MYFEEL 242 筆只有 12 筆按得動。補上之後，
 * 還原自己不能製造新的事故，這裡釘的全是**擋人的那幾道關**：
 *   ① 這段期間又被改過 → 不動手（不然就是拿舊判斷蓋掉別人後來的修改）
 *   ② 新增的東西已經被用到（選單指到、好友被貼上、客人加了好友）→ 不拿掉，講被誰用了
 *   ③ 「有沒有被用到」查不完整 → 當作有（查不到≠沒有）
 *   ④ 原本那個動作的護欄一條都不能少（權限不能改自己、推播快送出了、知識在回收桶…）
 *   ⑤ 還原本身也記一筆，而且記得是還原哪一筆（`revertOf`），之後不會再給按鈕
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── 迷你假 Firestore：每個 collection 一個物件，where 只做等號與 in ─────────
type Doc = Record<string, any>
// any：測試裡直接 store.flows.f9 讀寫，嚴格索引型別只會逼出一堆 `!`
const store: Record<string, any> = {}
const writes: Array<{ col: string, id: string, op: 'update' | 'delete' | 'set', patch?: Doc }> = []

function snapOf(col: string, id: string) {
  const d = store[col]?.[id]
  return { id, exists: !!d, data: () => (d ? { ...d } : undefined), get: (k: string) => d?.[k], ref: docRef(col, id) }
}
function docRef(col: string, id: string): any {
  return {
    id,
    get: async () => snapOf(col, id),
    update: async (patch: Doc) => {
      writes.push({ col, id, op: 'update', patch })
      store[col]![id] = { ...store[col]![id], ...patch }
    },
    set: async (patch: Doc) => {
      writes.push({ col, id, op: 'set', patch })
      store[col] ??= {}
      store[col][id] = { ...(store[col][id] ?? {}), ...patch }
    },
    delete: async () => {
      writes.push({ col, id, op: 'delete' })
      delete store[col]![id]
    },
  }
}
function query(col: string, filters: Array<[string, string, unknown]> = []): any {
  const q: any = {
    where: (f: string, op: string, v: unknown) => query(col, [...filters, [f, op, v]]),
    limit: () => q,
    select: () => q,
    count: () => ({ get: async () => { const { size } = await q.get(); return { data: () => ({ count: size }) } } }),
    get: async () => {
      const docs = Object.keys(store[col] ?? {})
        .filter(id => filters.every(([f, op, v]) => {
          const val = store[col]![id]![f]
          return op === 'in' ? (v as unknown[]).includes(val) : val === v
        }))
        .map(id => snapOf(col, id))
      return { docs, empty: !docs.length, size: docs.length }
    },
  }
  return q
}
const db: any = {
  collection: (col: string) => Object.assign(query(col), { doc: (id: string) => docRef(col, id) }),
  runTransaction: async (fn: (tx: any) => Promise<unknown>) => fn({
    get: (ref: any) => ref.get(),
    update: (ref: any, p: Doc) => { void ref.update(p) },
    set: (ref: any, p: Doc) => { void ref.set(p) },
  }),
}

// ── 外部依賴 ─────────────────────────────────────────────────────────
const auditLogs: any[] = []
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
  Timestamp: { fromDate: (d: Date) => ({ __at: d.toISOString(), toMillis: () => d.getTime() }) },
}))
vi.mock('./audit-log', () => ({
  AUDIT_LOGS_COLLECTION: 'auditLogs',
  writeAuditLog: async (i: unknown) => { auditLogs.push(i) },
  auditTimeText: (v: any) => (v == null ? null : typeof v?.toMillis === 'function' ? new Date(v.toMillis()).toISOString() : String(v)),
}))
vi.mock('./ai-settings', () => ({ getAiSettings: async () => ({}), setAiSettings: async () => ({}) }))
vi.mock('./ai-scripts', () => ({ SCRIPTS_COLLECTION: 'scripts', invalidateScriptsCache: vi.fn() }))
vi.mock('./script-health', () => ({ invalidateScriptHealthCache: vi.fn() }))
vi.mock('./flow-validator', () => ({ assertValidFlowName: (n: unknown) => String(n) }))
vi.mock('./broken-module-refs', () => ({ invalidateBrokenModuleRefsCache: vi.fn() }))
vi.mock('./billing', () => ({ assertPlanAllows: vi.fn(async () => {}) }))
vi.mock('./flow-folders', () => ({ FLOWS_COLLECTION: 'flows', FLOW_FOLDERS_COLLECTION: 'flowFolders', deleteFlowFolderCascade: vi.fn(async () => ({ movedFlows: 0 })) }))
vi.mock('./ai-knowledge-sources', () => ({ KNOWLEDGE_SOURCES_COLLECTION: 'knowledgeSources', getSource: vi.fn(), updateSourceSettings: vi.fn(async () => ({})) }))
vi.mock('./ai-knowledge-source-move', () => ({ syncSourceAfterMove: vi.fn(async () => ({ error: false, sync: { changed: true } })) }))
vi.mock('./ai-knowledge-chunks', () => ({ KNOWLEDGE_CHUNKS_COLLECTION: 'knowledgeChunks', invalidateSourceProductCache: vi.fn(), invalidateWorkspaceProductNames: vi.fn() }))
vi.mock('./ai-knowledge-chunk-delete', () => ({ softDeleteKnowledgeChunk: vi.fn(async () => ({ deleted: true, title: '保固多久', excludedRow: false })) }))
vi.mock('./ai-knowledge-folders', () => ({ KNOWLEDGE_FOLDERS_COLLECTION: 'knowledgeFolders', deleteFolderCascade: vi.fn(async () => ({ movedSources: 0, clearedProductSourceIds: [] })) }))
vi.mock('./workspace-member-role', () => ({ ASSIGNABLE_MEMBER_ROLES: ['admin', 'agent', 'viewer'], changeWorkspaceMemberRole: vi.fn(async () => ({ before: 'viewer', notifyRemoved: false })) }))
vi.mock('./member-line-bind', () => ({
  memberNotifyKindsNow: vi.fn(),
  setMemberNotifyKind: vi.fn(async () => ({ ok: true, result: 'changed', before: [], after: [] })),
  setMemberNotifyReceiving: vi.fn(async () => ({ ok: true, result: 'added' })),
}))
vi.mock('./lead-campaign-published-url', () => ({ syncPublishedEntryUrlForCampaign: vi.fn(async () => ({})) }))
vi.mock('./config-references', () => ({ scanConfigReferences: vi.fn() }))
vi.mock('./tagging', () => ({ removeTagsFromUser: vi.fn(async () => ({ removed: ['t'], skipped: [] })) }))
vi.mock('./tag-discovery', () => ({ TAG_DISCOVERY_COLLECTION: 'tagDiscovery' }))

;(globalThis as any).createError = (o: any) => Object.assign(new Error(o?.statusMessage || 'error'), o)

const { planRevert, applyRevert } = await import('./audit-revert')
const { getSource, updateSourceSettings } = await import('./ai-knowledge-sources')
const { syncSourceAfterMove } = await import('./ai-knowledge-source-move')
const { changeWorkspaceMemberRole } = await import('./workspace-member-role')
const { memberNotifyKindsNow, setMemberNotifyKind } = await import('./member-line-bind')
const { syncPublishedEntryUrlForCampaign } = await import('./lead-campaign-published-url')
const { scanConfigReferences } = await import('./config-references')
const { removeTagsFromUser } = await import('./tagging')
const { softDeleteKnowledgeChunk } = await import('./ai-knowledge-chunk-delete')
const { deleteFlowFolderCascade } = await import('./flow-folders')

const W = 'w1'
const ctx = { db, workspaceId: W, uid: 'boss' }
const noRefs = () => ({ modules: {}, tags: {}, failedKinds: [] })

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  writes.length = 0
  auditLogs.length = 0
  vi.clearAllMocks()
  vi.mocked(scanConfigReferences).mockResolvedValue(noRefs() as any)
})

const reason = (p: ReturnType<typeof planRevert>) => (p.ok ? '' : p.reason)

// ══ 第一批：改一個值 ═════════════════════════════════════════════════

describe('機器人模組改名／搬資料夾', () => {
  const row = { id: 'r1', action: 'flow.put', targetId: 'f1', before: { name: '舊名' }, after: { name: '新名' } }

  it('改回原本的名字，並記一筆「還原了哪一筆」', async () => {
    store.flows = { f1: { workspaceId: W, name: '新名' } }
    const msg = await applyRevert(row, ctx)
    expect(store.flows.f1!.name).toBe('舊名')
    expect(msg).toContain('改回')
    expect(auditLogs[0]).toMatchObject({ action: 'audit/revert', revertOf: 'r1', targetId: 'f1', before: { name: '新名' }, after: { name: '舊名' } })
  })

  it('🔴 這段期間又被改過：不動手', async () => {
    store.flows = { f1: { workspaceId: W, name: '同事又改過' } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/又被改過/)
    expect(writes).toEqual([])
    expect(auditLogs).toEqual([])
  })

  it('🔴 改了模組裡的訊息：紀錄只記幾則，不給還原、講去哪改', () => {
    expect(reason(planRevert({ ...row, before: { messagesCount: 2 }, after: { messagesCount: 3 } }))).toContain('沒記內容')
    // 名字跟訊息一起改的那種也不行（⛔ 寫一半比不寫更糟）
    expect(planRevert({ ...row, before: { name: 'a', messagesCount: 2 }, after: { name: 'b', messagesCount: 3 } }).ok).toBe(false)
  })

  it('🔴 原本的資料夾已經刪掉：放不回去，講清楚', async () => {
    store.flows = { f1: { workspaceId: W, folderId: 'new' } }
    store.flowFolders = { new: { workspaceId: W } }
    await expect(applyRevert({ ...row, before: { folderId: 'gone' }, after: { folderId: 'new' } }, ctx)).rejects.toThrow(/資料夾已經刪掉/)
    expect(writes).toEqual([])
  })

  it('🔴 別家的模組＝不存在', async () => {
    store.flows = { f1: { workspaceId: 'other', name: '新名' } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/不在了/)
  })
})

describe('標籤改名／停用／AI 判斷', () => {
  it('改回停用前的樣子；原本沒有 AI 判斷那一格的寫回「沒有」', async () => {
    store.tags = { t1: { workspaceId: W, status: 'inactive', aiMode: 'auto' } }
    await applyRevert({ id: 'r', action: 'tag.put', targetId: 't1', before: { status: 'active', aiMode: null }, after: { status: 'inactive', aiMode: 'auto' } }, ctx)
    expect(store.tags.t1).toMatchObject({ status: 'active', aiMode: '__del__' })
  })
})

describe('知識庫的一份資料', () => {
  it('搬回原本的分組：走同一支搬移＋商品名對齊重新學', async () => {
    vi.mocked(getSource).mockResolvedValue({ id: 's1', data: { folderId: 'g2' } } as any)
    const msg = await applyRevert({ id: 'r', action: 'source.put', targetId: 's1', before: { folderId: 'g1' }, after: { folderId: 'g2' } }, ctx)
    expect(vi.mocked(updateSourceSettings).mock.calls[0]?.[3]).toEqual({ folderId: 'g1' })
    expect(syncSourceAfterMove).toHaveBeenCalledWith(db, W, 's1', 'boss')
    expect(msg).toContain('重新學')
  })

  it('🔴 商品名、網址不給還原（商品名跟著分組走、網址一改比對基準整個重設）', () => {
    expect(planRevert({ id: 'r', action: 'source.put', targetId: 's1', before: { productName: 'A' }, after: { productName: 'B' } }).ok).toBe(false)
    expect(planRevert({ id: 'r', action: 'source.put', targetId: 's1', before: { url: 'a' }, after: { url: 'b' } }).ok).toBe(false)
  })

  it('🔴 原本「沒有設定」的那一格寫不回去：不給按（⛔ 不可以說還原了卻沒變）', () => {
    expect(reason(planRevert({ id: 'r', action: 'source.put', targetId: 's1', before: { refreshIntervalMinutes: null }, after: { refreshIntervalMinutes: 60 } }))).toContain('沒有設定')
  })
})

describe('成員權限：護欄跟成員管理頁同一套', () => {
  const row = { id: 'r', action: 'members/role.put', targetId: 'u2', before: { role: 'admin' }, after: { role: 'viewer' } }

  it('改回原本的權限，走同一支改權限（零管理員、擁有者那幾道關在裡面）', async () => {
    store.workspaceMembers = { u2_w1: { role: 'viewer' } }
    const msg = await applyRevert(row, { ...ctx, isOrgAdmin: true })
    expect(changeWorkspaceMemberRole).toHaveBeenCalledWith(db, { workspaceId: W, targetUid: 'u2', role: 'admin', canTouchOwner: true })
    expect(msg).toContain('管理員')
    // 從觀察者改回來：通知名單不會自動加回去，要講
    expect(msg).toContain('LINE 通知')
  })

  it('🔴 不能還原自己的權限（超管例外）', async () => {
    store.workspaceMembers = { boss_w1: { role: 'viewer' } }
    await expect(applyRevert({ ...row, targetId: 'boss' }, ctx)).rejects.toThrow(/不能還原自己/)
    expect(changeWorkspaceMemberRole).not.toHaveBeenCalled()
  })

  it('🔴 原本是擁有者：誰都不能把人改成擁有者，還原也不行', () => {
    expect(reason(planRevert({ ...row, before: { role: 'owner' } }))).toContain('擁有者')
  })

  it('🔴 權限這段期間又被改過', async () => {
    store.workspaceMembers = { u2_w1: { role: 'agent' } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/又被改過/)
  })
})

describe('知識的開關與期限', () => {
  const row = { id: 'r', action: 'knowledge.settings', targetId: 'c1', before: { cardStatus: 'indexed', activeUntil: null }, after: { cardStatus: 'disabled', activeUntil: null } }

  it('停用了 → 改回可用', async () => {
    store.knowledgeChunks = { c1: { workspaceId: W, status: 'disabled', embedding: [1] } }
    await applyRevert(row, ctx)
    expect(store.knowledgeChunks.c1).toMatchObject({ status: 'indexed', activeUntil: '__del__', expiredAt: '__del__' })
  })

  it('🔴 只解了鎖的那種（狀態、期限前後一樣）：沒記到改了什麼，不給按', () => {
    expect(planRevert({ ...row, before: { cardStatus: 'indexed', activeUntil: null }, after: { cardStatus: 'indexed', activeUntil: null } }).ok).toBe(false)
  })

  it('🔴 在回收桶裡：不能開關（會讓刪掉的復活上線）', async () => {
    store.knowledgeChunks = { c1: { workspaceId: W, status: 'disabled', embedding: [1], deletedAt: 1 } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/回收桶/)
  })

  it('🔴 AI 還沒學會（沒有向量）：不能標可用', async () => {
    store.knowledgeChunks = { c1: { workspaceId: W, status: 'disabled' } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/還沒學會/)
    expect(writes).toEqual([])
  })
})

describe('推播排程', () => {
  const at = (ms: number) => ({ toMillis: () => ms })
  const later = Date.now() + 3 * 3600_000
  const iso = new Date(later).toISOString()
  const row = { id: 'r', action: 'broadcast.schedule', targetId: 'b1', before: { status: 'draft', scheduleAt: null }, after: { status: 'scheduled', scheduleAt: iso } }

  it('取消排程、改回草稿', async () => {
    store.broadcasts = { b1: { workspaceId: W, status: 'scheduled', scheduleAt: at(later) } }
    const msg = await applyRevert(row, ctx)
    expect(store.broadcasts.b1).toMatchObject({ status: 'draft', scheduleAt: null })
    expect(msg).toContain('不會送出')
  })

  it('🔴 兩分鐘內就要送出：來不及，不跟排程器搶', async () => {
    const soon = Date.now() + 60_000
    store.broadcasts = { b1: { workspaceId: W, status: 'scheduled', scheduleAt: at(soon) } }
    await expect(applyRevert({ ...row, after: { status: 'scheduled', scheduleAt: new Date(soon).toISOString() } }, ctx)).rejects.toThrow(/來不及/)
    expect(store.broadcasts.b1!.status).toBe('scheduled')
  })

  it('🔴 已經開始送了：收不回來', async () => {
    store.broadcasts = { b1: { workspaceId: W, status: 'processing', scheduleAt: at(later) } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/收不回來/)
  })

  it('🔴 改過時間的那種：原本的時間已經過了就改不回去', async () => {
    store.broadcasts = { b1: { workspaceId: W, status: 'scheduled', scheduleAt: at(later) } }
    const past = new Date(Date.now() - 3600_000).toISOString()
    await expect(applyRevert({ ...row, before: { status: 'scheduled', scheduleAt: past } }, ctx)).rejects.toThrow(/已經過了/)
  })
})

describe('LINE 通知收哪幾種', () => {
  it('先勾後取消（⛔ 反過來中間那一刻會被拿出名單）', async () => {
    vi.mocked(memberNotifyKindsNow).mockResolvedValue(['handoff'])
    await applyRevert({ id: 'r', action: 'lineNotify.receiving', targetId: 'u2', before: { notifyKinds: ['早上的摘要'] }, after: { notifyKinds: ['客人找真人'] } }, ctx)
    expect(vi.mocked(setMemberNotifyKind).mock.calls.map(c => [c[2], c[3]])).toEqual([['digest', true], ['handoff', false]])
  })

  it('🔴 拿掉名單上不是成員的舊帳號：名單只收成員，加不回去', () => {
    expect(planRevert({ id: 'r', action: 'lineNotify.receiving', targetId: `U${'a'.repeat(32)}`, before: { receiving: true }, after: { receiving: false } }).ok).toBe(false)
  })

  it('🔴 這段期間又改過', async () => {
    vi.mocked(memberNotifyKindsNow).mockResolvedValue(['crit'])
    await expect(applyRevert({ id: 'r', action: 'lineNotify.receiving', targetId: 'u2', before: { notifyKinds: [] }, after: { notifyKinds: ['客人找真人'] } }, ctx)).rejects.toThrow(/又被改過/)
    expect(setMemberNotifyKind).not.toHaveBeenCalled()
  })
})

describe('加好友活動', () => {
  it('開關改回去，活動連結跟著換', async () => {
    store.leadCampaigns = { k1: { workspaceId: W, name: '週年', isActive: false } }
    await applyRevert({ id: 'r', action: 'campaign.put', targetId: 'k1', before: { isActive: true }, after: { isActive: false } }, ctx)
    expect(store.leadCampaigns.k1!.isActive).toBe(true)
    expect(vi.mocked(syncPublishedEntryUrlForCampaign).mock.calls[0]?.[2]).toMatchObject({ isActive: true })
  })

  it('🔴 改了觸發的動作：紀錄只記種類，不給還原', () => {
    expect(planRevert({ id: 'r', action: 'campaign.put', targetId: 'k1', before: { type: 'module' }, after: { type: 'message' } }).ok).toBe(false)
  })
})

// ══ 第二批：新增的東西，沒被用到才拿掉 ═══════════════════════════════

describe('新增的模組', () => {
  const row = { id: 'r', action: 'flow.create', targetId: 'f9', before: null, after: { name: '週年慶', isActive: true, messagesCount: 1 } }
  const fresh = () => { store.flows = { f9: { workspaceId: W, name: '週年慶', isActive: true, messages: [{}] } } }

  it('沒有任何地方用到 → 刪掉', async () => {
    fresh()
    const msg = await applyRevert(row, ctx)
    expect(store.flows.f9).toBeUndefined()
    expect(msg).toContain('週年慶')
    // ⛔ 不吃快取：60 秒前的答案可能剛好漏掉剛建的那個按鈕
    expect(scanConfigReferences).toHaveBeenCalledWith(db, W, { skipCache: true })
  })

  it('🔴 已經被選單指到：不刪，講被誰用了', async () => {
    fresh()
    vi.mocked(scanConfigReferences).mockResolvedValue({ ...noRefs(), modules: { f9: [{ kind: 'richmenu', id: 'm', label: '主選單' }] } } as any)
    await expect(applyRevert(row, ctx)).rejects.toThrow(/圖文選單「主選單」/)
    expect(store.flows.f9).toBeDefined()
  })

  it('🔴 有一類沒查完（掃失敗或筆數太多）：當作有人在用，不刪', async () => {
    fresh()
    vi.mocked(scanConfigReferences).mockResolvedValue({ ...noRefs(), truncatedKinds: ['broadcast'] } as any)
    await expect(applyRevert(row, ctx)).rejects.toThrow(/沒查完/)
    vi.mocked(scanConfigReferences).mockResolvedValue({ ...noRefs(), failedKinds: ['richmenu'] } as any)
    await expect(applyRevert(row, ctx)).rejects.toThrow(/沒查完/)
    expect(store.flows.f9).toBeDefined()
  })

  it('🔴 建好之後又加了訊息：不刪（會把後來的工作一起丟掉）', async () => {
    store.flows = { f9: { workspaceId: W, name: '週年慶', isActive: true, messages: [{}, {}] } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/又被改過/)
    expect(store.flows.f9).toBeDefined()
  })
})

describe('新增的標籤', () => {
  const row = { id: 'r', action: 'tag.create', targetId: 't9', before: null, after: { name: '問卷A', category: 'custom', status: 'active', aiMode: 'off', color: '#6B7280' } }
  const fresh = () => { store.tags = { t9: { workspaceId: W, name: '問卷A', category: 'custom', status: 'active', aiMode: 'off', color: '#6B7280' } } }

  it('沒人被貼、沒地方用 → 停用（同標籤頁的刪除）', async () => {
    fresh()
    await applyRevert(row, ctx)
    expect(store.tags.t9!.status).toBe('inactive')
  })

  it('🔴 已經有好友被貼上：不停用，講幾位', async () => {
    fresh()
    store.userTags = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`u${i}`, { workspaceId: W, tagId: 't9' }]))
    await expect(applyRevert(row, ctx)).rejects.toThrow(/12 位/)
    expect(store.tags.t9!.status).toBe('active')
  })
})

describe('預查與預演：只檢查、不寫入', () => {
  const flowRow = { id: 'r', action: 'flow.create', targetId: 'f9', before: null, after: { name: '週年慶', isActive: true, messagesCount: 1 } }
  const fresh = () => { store.flows = { f9: { workspaceId: W, name: '週年慶', isActive: true, messages: [{}] } } }

  it('清單預查：不掃「哪裡在用它」（六類各讀幾百筆），也不刪、不記紀錄', async () => {
    fresh()
    expect(await applyRevert(flowRow, { ...ctx, mode: 'precheck' })).toBe('')
    expect(scanConfigReferences).not.toHaveBeenCalled()
    expect(store.flows.f9).toBeDefined()
    expect(auditLogs).toEqual([])
  })

  it('清單預查擋得下便宜的那幾種（建好後又改過）', async () => {
    store.flows = { f9: { workspaceId: W, name: '改過名', isActive: true, messages: [{}] } }
    await expect(applyRevert(flowRow, { ...ctx, mode: 'precheck' })).rejects.toThrow(/又被改過/)
  })

  it('按下去的預演：貴的也查（被用到了照樣擋），但什麼都不寫', async () => {
    fresh()
    vi.mocked(scanConfigReferences).mockResolvedValue({ ...noRefs(), modules: { f9: [{ kind: 'broadcast', id: 'b', label: '開賣通知' }] } } as any)
    await expect(applyRevert(flowRow, { ...ctx, mode: 'dryRun' })).rejects.toThrow(/推播「開賣通知」/)
    vi.mocked(scanConfigReferences).mockResolvedValue(noRefs() as any)
    expect(await applyRevert(flowRow, { ...ctx, mode: 'dryRun' })).toBe('')
    expect(store.flows.f9).toBeDefined()
    expect(writes).toEqual([])
    expect(auditLogs).toEqual([])
  })

  it('交易裡做檢查的那幾種（改名、推播草稿）預演也不寫', async () => {
    store.flows = { f1: { workspaceId: W, name: '新名' } }
    store.broadcasts = { b9: { workspaceId: W, name: '雙11', status: 'draft', messages: [{}] } }
    await applyRevert({ id: 'r1', action: 'flow.put', targetId: 'f1', before: { name: '舊名' }, after: { name: '新名' } }, { ...ctx, mode: 'dryRun' })
    await applyRevert({ id: 'r2', action: 'broadcast.create', targetId: 'b9', before: null, after: { name: '雙11' } }, { ...ctx, mode: 'dryRun' })
    expect(writes).toEqual([])
    expect(store.broadcasts.b9!.status).toBe('draft')
  })
})

describe('AI 發現的新標籤按「建立」', () => {
  const row = { id: 'r', action: 'tagDiscovery.adopt', targetId: 't7', before: null, after: { name: '在看除濕機', category: 'interest', aiMode: 'suggest', taggedCount: 2 } }
  const fresh = () => {
    store.tags = { t7: { workspaceId: W, name: '在看除濕機', category: 'interest', aiMode: 'suggest', status: 'active' } }
    store.userTags = {
      a: { workspaceId: W, tagId: 't7', userId: 'w1_u1', sourceRefId: 'tag-discovery' },
      b: { workspaceId: W, tagId: 't7', userId: 'w1_u2', sourceRefId: 'tag-discovery' },
    }
    store.tagDiscovery = { w1: { history: [{ id: 'p1', action: 'adopt', tagId: 't7', name: '在看除濕機' }] } }
  }

  it('從這批好友身上拿掉、停用標籤、標籤頁那一條標上已收回', async () => {
    fresh()
    const msg = await applyRevert(row, ctx)
    expect(vi.mocked(removeTagsFromUser).mock.calls.map(c => c[0]).sort()).toEqual(['w1_u1', 'w1_u2'])
    expect(store.tags.t7!.status).toBe('inactive')
    expect(store.tagDiscovery.w1!.history[0].revertedAtMs).toBeGreaterThan(0)
    expect(msg).toContain('2 位')
  })

  it('🔴 之後又從別的地方貼給了別人：不動（那幾位不是這次給的）', async () => {
    fresh()
    store.userTags!.c = { workspaceId: W, tagId: 't7', userId: 'w1_u3', sourceRefId: null }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/又貼給了 1 位/)
    expect(removeTagsFromUser).not.toHaveBeenCalled()
  })

  it('🔴 拿一半失敗：標籤不停用、講還剩幾位，可以再按一次', async () => {
    fresh()
    vi.mocked(removeTagsFromUser).mockRejectedValueOnce(new Error('boom'))
    await expect(applyRevert(row, ctx)).rejects.toThrow(/再按一次/)
    expect(store.tags.t7!.status).toBe('active')
    expect(auditLogs).toEqual([])
  })
})

describe('新增的推播草稿', () => {
  const row = { id: 'r', action: 'broadcast.create', targetId: 'b9', before: null, after: { name: '雙11', status: 'draft', messagesCount: 1 } }

  it('還是草稿 → 改成已取消（推播沒有刪除，同推播頁的取消）', async () => {
    store.broadcasts = { b9: { workspaceId: W, name: '雙11', status: 'draft', messages: [{}] } }
    await applyRevert(row, ctx)
    expect(store.broadcasts.b9!.status).toBe('cancelled')
  })

  it('🔴 已經排程了：不取消，叫他去推播頁', async () => {
    store.broadcasts = { b9: { workspaceId: W, name: '雙11', status: 'scheduled', messages: [{}] } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/已經排程/)
  })

  it('複製出來的、補發的草稿一樣收得回來', () => {
    expect(planRevert({ ...row, action: 'broadcast.duplicate' }).ok).toBe(true)
    expect(planRevert({ ...row, action: 'broadcast.followUp' }).ok).toBe(true)
  })
})

describe('新增的知識、活動、資料夾', () => {
  it('知識：丟回收桶，走同一支（試算表那一列、空間快取一起處理）', async () => {
    store.knowledgeChunks = { c9: { workspaceId: W, title: '保固多久' } }
    const msg = await applyRevert({ id: 'r', action: 'knowledge.create', targetId: 'c9', before: null, after: { title: '保固多久', cardStatus: 'indexed' } }, ctx)
    expect(softDeleteKnowledgeChunk).toHaveBeenCalledWith(db, W, 'c9')
    expect(msg).toContain('回收桶')
  })

  it('🔴 活動已經有客人透過它加好友：不刪；共用入口那一筆範本不算', async () => {
    store.leadCampaigns = { k9: { workspaceId: W, name: '週年', tagIds: ['t'] } }
    store.leadClaims = {
      tpl: { campaignId: 'k9', sharedEntry: true, status: 'pending' },
      x: { campaignId: 'k9', status: 'applied' },
    }
    const row = { id: 'r', action: 'campaign.create', targetId: 'k9', before: null, after: { name: '週年', isActive: true, itemsCount: 1 } }
    await expect(applyRevert(row, ctx)).rejects.toThrow(/1 位客人/)
    delete store.leadClaims.x
    await applyRevert(row, ctx)
    expect(store.leadCampaigns.k9).toBeUndefined()
  })

  it('🔴 資料夾裡已經放了東西：不刪', async () => {
    store.flowFolders = { d9: { workspaceId: W, name: '節慶' } }
    store.flows = { f: { workspaceId: W, folderId: 'd9' } }
    await expect(applyRevert({ id: 'r', action: 'flowFolder.create', targetId: 'd9', before: null, after: { name: '節慶' } }, ctx)).rejects.toThrow(/放了模組/)
    expect(deleteFlowFolderCascade).not.toHaveBeenCalled()
  })
})

describe('計畫只看紀錄本身', () => {
  it('舊紀錄沒記下動到哪一份：講清楚還原不了', () => {
    expect(reason(planRevert({ id: 'r', action: 'flow.create', before: null, after: { name: 'x' } }))).toContain('舊紀錄')
    expect(reason(planRevert({ id: 'r', action: 'tag.put', before: { name: 'a' }, after: { name: 'b' } }))).toContain('舊紀錄')
  })

  it('新增類的確認框講得出「會把什麼拿掉」', () => {
    const p = planRevert({ id: 'r', action: 'tagDiscovery.adopt', targetId: 't', before: null, after: { name: '在看電子鍋', taggedCount: 9 } })
    expect(p.ok && p.what).toContain('「在看電子鍋」')
    expect(p.ok && p.what).toContain('9 位')
  })
})

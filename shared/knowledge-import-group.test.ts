import { describe, expect, it, vi } from 'vitest'
import {
  autoImportGroup,
  closestGroups,
  createImportGroupRegistry,
  groupChoiceFromKey,
  groupChoiceKey,
  groupSyncNoteText,
  moveSurelyRejected,
  parseGroupSync,
  newGroupName,
  orderedGroups,
  writeMayHaveLanded,
} from './knowledge-import-group'

/** 分組名字取自 MYFEEL 正式資料夾（2026-10-14 唯讀盤點：16 個商品名＋「客服」「總覽」），再加一組「通用」 */
const GROUPS = [
  { id: 'g_kies', name: 'Kieselect 小耳記 AI NotePods 10S' },
  { id: 'g_pot', name: '零水鍋' },
  { id: 'g_sharp', name: 'SHARP 自動調理零水鍋' },
  { id: 'g_boya', name: 'BOYA mini2' },
  { id: 'g_dry', name: '上好ㄟ抽取式除濕機' },
  { id: 'g_general', name: '通用', general: true },
]

describe('autoImportGroup（`C-320` 上傳時不用選分組）', () => {
  it('比得到就直接放那一組、不問', () => {
    expect(autoImportGroup(GROUPS, { sourceName: 'KIESLECT 小耳記 說明書.pdf', productName: 'Kieslect AI NotePods 10S' }))
      .toEqual({ choice: { kind: 'folder', id: 'g_kies' }, ask: false })
  })

  it('名字一模一樣（大小寫、空白不算）就放那一組——連 pickFolderForSource「兩個都像就不猜」的那種也是', () => {
    // 「零水鍋」與「SHARP 自動調理零水鍋」兩個都滿分、pickFolderForSource 不猜；但 AI 認的商品名就是後者，沒有懸念
    expect(autoImportGroup(GROUPS, { sourceName: 'SHARP 自動調理零水鍋 說明書.pdf', productName: 'sharp 自動調理零水鍋' }).choice)
      .toEqual({ kind: 'folder', id: 'g_sharp' })
  })

  it('什麼都比不到、AI 又認出商品 → 預設新分組「商品名」，而且要問', () => {
    expect(autoImportGroup(GROUPS, { sourceName: '說明書.pdf', productName: '  W1   智慧手錶 ' }))
      .toEqual({ choice: { kind: 'new', name: 'W1 智慧手錶' }, ask: true })
  })

  it('AI 沒認出商品（FAQ、公告、價目表）→ 放「通用」，不問；沒有「通用」這一組就不放分組', () => {
    expect(autoImportGroup(GROUPS, { sourceName: '2026 春季活動辦法.pdf', productName: '' }))
      .toEqual({ choice: { kind: 'folder', id: 'g_general' }, ask: false })
    expect(autoImportGroup(GROUPS.filter(g => !g.general), { sourceName: '2026 春季活動辦法.pdf' }))
      .toEqual({ choice: { kind: 'none' }, ask: false })
  })

  it('整個網站那條路不開新分組（allowNew=false）：比不到就不放分組、不問', () => {
    expect(autoImportGroup(GROUPS, { sourceName: '商品頁', productName: 'W1 智慧手錶' }, { allowNew: false }))
      .toEqual({ choice: { kind: 'none' }, ask: false })
  })

  it('新分組的名字截到伺服器收的 50 字', () => {
    expect(newGroupName('長'.repeat(80))).toHaveLength(50)
  })
})

describe('closestGroups（「這份在講哪個商品？」列的最像的幾組）', () => {
  it('打錯字、多幾個字的也排得上來；「通用」不在裡面（它固定另一顆）', () => {
    const r = closestGroups(GROUPS, { productName: 'Kieslect 耳機', sourceName: 'NotePods 說明書.pdf' })
    expect(r[0]?.id).toBe('g_kies')
    expect(r.some(g => g.general)).toBe(false)
  })

  it('兩組一樣像也照列（這裡不替他決定，只是排出來給他點）', () => {
    const ids = closestGroups(GROUPS, { productName: 'SHARP 零水鍋 2 代' }).map(g => g.id)
    expect(ids).toContain('g_pot')
    expect(ids).toContain('g_sharp')
  })

  it('⛔ 不像的不列：一排不相干的名字等於叫他亂挑', () => {
    expect(closestGroups(GROUPS, { productName: 'W1 智慧手錶', sourceName: '說明書.pdf' })).toEqual([])
  })

  it('最多 3 組', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, name: `W1 手錶 ${i}` }))
    expect(closestGroups(many, { productName: 'W1 手錶' })).toHaveLength(3)
  })
})

describe('parseGroupSync（換分組之後 AI 把它當成哪一台，`D-127`）', () => {
  it('放進商品分組：AI 現在把它當成那一台；沒學會的條數照實講', () => {
    const f = parseGroupSync({ id: 's', groupSync: { productName: 'SHARP 乾淨方MAX', previous: '', indexed: 8, failed: 2 } })
    expect(f).toEqual({ kind: 'synced', productName: 'SHARP 乾淨方MAX', previous: '', indexed: 8, failed: 2 })
    expect(groupSyncNoteText(f)).toBe('AI 現在把它當成「SHARP 乾淨方MAX」的資料；有 2 條還沒學會，點開那一份按右上「⋯ → 重新學習這一份」')
  })

  it('搬到通用、不放分組：AI 不再把它當成原本那一台', () => {
    const f = parseGroupSync({ groupSync: { productName: '', previous: 'BOYA mini2', indexed: 3, failed: 0 } })
    expect(groupSyncNoteText(f)).toBe('AI 不再把它當成「BOYA mini2」的資料')
  })

  it('沒有 groupSync（商品名沒變）＝什麼都不講', () => {
    expect(parseGroupSync({ id: 's' })).toBeNull()
    expect(parseGroupSync(null)).toBeNull()
    expect(groupSyncNoteText(null)).toBe('')
  })

  it('搬過去了、重新學習沒成（{ error: true }）＝講一句，⛔ 不講成搬失敗', () => {
    const f = parseGroupSync({ folderId: 'g', groupSync: { error: true } })
    expect(f).toEqual({ kind: 'failed' })
    expect(groupSyncNoteText(f)).toMatch(/^搬過去了，但 AI 還沒重新學會/)
  })
})

describe('寫入失敗之後能不能刪掉剛建的分組（`/code-review` ③⑥）', () => {
  it('回應沒送到（斷線、逾時、閘道）＝可能已經放進去了，不刪；伺服器看過拒絕的才刪', () => {
    for (const s of [0, 408, 502, 503, 504]) expect(writeMayHaveLanded(s)).toBe(true)
    for (const s of [400, 403, 404, 500]) expect(writeMayHaveLanded(s)).toBe(false)
  })

  it('搬分組失敗：只有 4xx 才確定沒搬進去（5xx 可能已經搬了、是補商品名那一步才出錯）', () => {
    for (const s of [400, 403, 404, 409]) expect(moveSurelyRejected(s)).toBe(true)
    for (const s of [0, 408, 429, 500, 502, 504]) expect(moveSurelyRejected(s)).toBe(false)
  })
})

describe('選項的值', () => {
  it('來回轉不變；沒有商品名時「新分組」退成不放分組', () => {
    expect(groupChoiceFromKey(groupChoiceKey({ kind: 'folder', id: 'a' }), '')).toEqual({ kind: 'folder', id: 'a' })
    expect(groupChoiceFromKey('new', 'W1')).toEqual({ kind: 'new', name: 'W1' })
    expect(groupChoiceFromKey('new', '')).toEqual({ kind: 'none' })
    expect(groupChoiceFromKey('none', 'W1')).toEqual({ kind: 'none' })
    // 還沒有「通用」那一組時選它＝建一組
    expect(groupChoiceFromKey('general', '')).toEqual({ kind: 'new', name: '通用', general: true })
    expect(groupChoiceKey({ kind: 'new', name: '通用', general: true })).toBe('general')
  })

  it('「通用」排最前面', () => {
    expect(orderedGroups(GROUPS)[0]?.id).toBe('g_general')
  })
})

describe('createImportGroupRegistry（一次開窗裡建過的分組）', () => {
  const setup = () => {
    let seq = 0
    const create = vi.fn(async (name: string) => {
      await new Promise(r => setTimeout(r, 5))
      return { id: `new-${++seq}`, name }
    })
    const remove = vi.fn(async () => ({}))
    const markGeneral = vi.fn(async () => ({}))
    return { create, remove, markGeneral, reg: createImportGroupRegistry({ create, remove, markGeneral }) }
  }

  it('同一個名字同時要兩次只建一次（一次好幾份兩個 worker 同時要）', async () => {
    const { create, reg } = setup()
    const [a, b] = await Promise.all([reg.ensure('W1 智慧手錶', []), reg.ensure('w1智慧手錶', [])])
    expect(create).toHaveBeenCalledTimes(1)
    expect(a.id).toBe(b.id)
  })

  it('頁面清單還沒重讀時，第二份也比得到第一份剛建的那一組；現有的同名分組直接用、不建', async () => {
    const { create, reg } = setup()
    const first = await reg.ensure('W1', [])
    expect((await reg.ensure('W1', [])).id).toBe(first.id)
    expect((await reg.ensure('零水鍋', GROUPS)).id).toBe('g_pot')
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('要「通用」：已經有通用那一組就用它（名字不一定叫通用）；沒有才建一組、帶 general', async () => {
    const { create, reg } = setup()
    expect((await reg.ensure('通用', [{ id: 'g_cs', name: '客服', general: true }], { general: true })).id).toBe('g_cs')
    expect(create).not.toHaveBeenCalled()
    const g = await reg.ensure('通用', [], { general: true })
    expect(create).toHaveBeenCalledWith('通用', { general: true })
    expect(g.general).toBe(true)
  })

  it('⛔ 要「通用」時，手建的「通用」（沒標成通用）不可以照名字直接用：先標成通用再用；標不成就丟錯（`/code-review` ⑫）', async () => {
    const { create, markGeneral, reg } = setup()
    const handMade = [{ id: 'g_hand', name: '通用' }]
    const g = await reg.ensure('通用', handMade, { general: true })
    expect(markGeneral).toHaveBeenCalledWith('g_hand')
    expect(g).toEqual({ id: 'g_hand', name: '通用', general: true })
    expect(create).not.toHaveBeenCalled()
    // 標過了就記得（頁面清單還沒重讀）：再要一次不再標
    expect((await reg.ensure('通用', handMade, { general: true })).id).toBe('g_hand')
    expect(markGeneral).toHaveBeenCalledTimes(1)

    const failing = createImportGroupRegistry({ create, remove: async () => ({}), markGeneral: async () => { throw new Error('403') } })
    await expect(failing.ensure('通用', handMade, { general: true })).rejects.toThrow()
  })

  it('`D-127` 伺服器說「已經有同一台的那一組」（existed）→ 用那一組，⛔ 不當成這次建的（沒用到也不刪）', async () => {
    const remove = vi.fn(async () => ({}))
    const reg = createImportGroupRegistry({
      create: async name => ({ id: 'g_old', name: `${name}（原本就有）`, existed: true }) as any,
      remove,
      markGeneral: async () => ({}),
    })
    const g = await reg.ensure('SHARP 自動調理零水鍋!', [])
    expect(g.id).toBe('g_old')
    await reg.discardIfUnused(g.id)
    expect(remove).not.toHaveBeenCalled()
  })

  it('建不成（回來沒有編號）要丟錯，不可以當成建好了', async () => {
    const reg = createImportGroupRegistry({ create: async () => ({}) as any, remove: async () => ({}), markGeneral: async () => ({}) })
    await expect(reg.ensure('W1', [])).rejects.toThrow()
  })

  it('改放別組：這次建的、沒有別份在用 → 刪掉；還有一份在用 → 留著', async () => {
    const { remove, reg } = setup()
    const g = await reg.ensure('W1', [])
    reg.use(g.id)
    reg.use(g.id)
    await reg.release(g.id)
    expect(remove).not.toHaveBeenCalled()
    await reg.release(g.id)
    expect(remove).toHaveBeenCalledWith(g.id)
    expect(reg.isCreated(g.id)).toBe(false)
  })

  it('加入失敗收掉剛建的空分組（`/code-review` ⑥）：沒人放進去、也沒有請求在路上才刪；⛔ 不扣別份的', async () => {
    const { remove, reg } = setup()
    const g = await reg.ensure('W1', [])
    // 一次好幾份：A、B 兩列都要送進「W1」；A 失敗時 B 還在路上 → 不刪
    reg.hold(g.id)
    reg.hold(g.id)
    reg.unhold(g.id) // A 送完（失敗）
    await reg.discardIfUnused(g.id)
    expect(remove).not.toHaveBeenCalled()
    reg.unhold(g.id) // B 成功
    reg.use(g.id)
    await reg.discardIfUnused(g.id)
    expect(remove).not.toHaveBeenCalled() // B 在裡面
    // 只有一份、失敗了 → 刪
    const h = await reg.ensure('W2', [])
    reg.hold(h.id)
    reg.unhold(h.id)
    await reg.discardIfUnused(h.id)
    expect(remove).toHaveBeenCalledWith(h.id)
  })

  it('⛔ 現有的分組一律不碰；清單上看得到別份在裡面也不刪', async () => {
    const { remove, reg } = setup()
    await reg.release('g_pot')
    const g = await reg.ensure('W1', [])
    reg.use(g.id)
    await reg.release(g.id, true)
    expect(remove).not.toHaveBeenCalled()
  })
})

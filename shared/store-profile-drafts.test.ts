import { describe, expect, it } from 'vitest'
import {
  buildCalendarDraft,
  buildStoreDrafts,
  buildTagDrafts,
  buildToneDraft,
  buildWelcomeDraft,
  canBuildDrafts,
  splitProducts,
  STORE_DRAFT_KIND,
  stripPriceBand,
  summarizeDraftApply,
  TONE_SAFETY_RULES,
  type DraftApplyStep,
  type DraftContext,
} from './store-profile-drafts'
import { TONE_ROLES } from './ai-tone-roles'
import { emptyStoreProfile, setStoreProfileField, type StoreProfileDoc } from './types/store-profile'
import { needsRecords } from './tag-ideas'
import { TAG_TEMPLATES } from './tag-templates'
import { TAG_CODE_MAX_LENGTH } from './tag-code-suggest'

function profileOf(over: Partial<Record<string, string>> = {}): StoreProfileDoc {
  let p = emptyStoreProfile()
  const base: Record<string, string> = {
    industry: '零售／電商',
    products: '黑豆水、養生茶包、節慶禮盒',
    customers: '一般消費者',
    channel: '網購為主',
    season: '年節送禮（春節、中秋）',
    pain: '加好友後沒人理',
    ...over,
  }
  for (const [k, v] of Object.entries(base)) {
    if (v) p = setStoreProfileField(p, k as never, v, 'owner', 1)
  }
  return p
}

function ctxOf(over: Partial<DraftContext> = {}): DraftContext {
  return { shopName: '山丘咖啡', profile: profileOf(), today: '2026-09-22', ...over }
}

describe('splitProducts', () => {
  it('頓號、全形逗號、半形逗號、斜線都收', () => {
    expect(splitProducts('A、B，C,D/E')).toEqual(['A', 'B', 'C'])
  })
  it('最多三樣', () => {
    expect(splitProducts('A、B、C、D、E')).toHaveLength(3)
  })
  it('空的回空陣列，不炸', () => {
    expect(splitProducts('')).toEqual([])
    expect(splitProducts(undefined as never)).toEqual([])
  })

  /**
   * `C-249`／`D-92`：**千分位逗號不可以被當成商品的分隔符**。
   * 壞掉的時候不會有人發現——商家在輪廓卡上看到的是完整的「NT$180–1,280」，
   * 而下游拿到的是一個叫「節慶禮盒｜NT$180–1」的商品，還會被寫進 `systemPrompt`。
   */
  describe('價格帶不可以污染商品名（D-92）', () => {
    const CASES: Array<[string, string]> = [
      ['aiHint 教的寫法（全形豎線）', '黑豆水、養生茶包、節慶禮盒｜NT$180–1,280'],
      ['半形豎線加空白', '黑豆水、養生茶包、節慶禮盒 | NT$0–7,030,300'],
      ['括號包起來', '黑豆水、養生茶包、節慶禮盒（NT$180-1,280）'],
      ['沒有分隔符，直接接 NT$', '黑豆水、養生茶包、節慶禮盒 NT$180–1,280'],
      ['寫成「售價」', '黑豆水、養生茶包、節慶禮盒，售價 180–1,280'],
      ['只有錢字號', '黑豆水、養生茶包、節慶禮盒｜$180~1,280'],
    ]
    for (const [name, raw] of CASES) {
      it(name, () => {
        expect(splitProducts(raw)).toEqual(['黑豆水', '養生茶包', '節慶禮盒'])
      })
    }

    it('剝不掉的漏網之魚，也不會被千分位逗號切開', () => {
      // 沒有任何價格記號、純數字區間——剝除攔不到，第二道（拿掉數字間的逗號）要接住
      expect(splitProducts('黑豆水、養生茶包、節慶禮盒 180–1,280')).toEqual(
        ['黑豆水', '養生茶包', '節慶禮盒 180–1280'],
      )
    })

    /** ⛔ 對照組：商品名裡本來就有的 NT／數字不可以被砍掉，不然這道防守自己變成 bug */
    it('對照組：商品名本身帶 NT 或數字時不會被誤砍', () => {
      expect(splitProducts('NT 限定款、養生茶包 500ml、節慶禮盒')).toEqual(
        ['NT 限定款', '養生茶包 500ml', '節慶禮盒'],
      )
    })
  })
})

describe('stripPriceBand', () => {
  it('沒有價格時原字串不動', () => {
    expect(stripPriceBand('黑豆水、養生茶包')).toBe('黑豆水、養生茶包')
  })
  it('剝完不留孤兒分隔符', () => {
    expect(stripPriceBand('黑豆水、養生茶包、｜NT$180–1,280')).toBe('黑豆水、養生茶包')
  })
})

describe('加好友歡迎訊息', () => {
  it('帶得到店名與商品', () => {
    const t = buildWelcomeDraft(ctxOf())
    expect(t).toContain('山丘咖啡')
    expect(t).toContain('黑豆水')
  })

  it('⛔ 不可以插「客人的名字」變數（取不到會變成空白，而這是第一句話）', () => {
    expect(buildWelcomeDraft(ctxOf())).not.toContain('{{')
  })

  it('預約制的店問的是時段，不是出貨', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ channel: '預約制' }) }))
    expect(t).toContain('預約')
    expect(t).not.toContain('出貨')
  })

  it('只有實體店的不要叫人問出貨', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ channel: '實體店面' }) }))
    expect(t).toContain('營業時間')
  })

  it('沒填商品也讀得通，不會出現半句話', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ products: '' }) }))
    expect(t).toContain('山丘咖啡')
    expect(t).not.toContain('我們主要做。')
  })

  it('連店名都沒有時退成「我們」，不會出現空白開頭', () => {
    const t = buildWelcomeDraft(ctxOf({ shopName: '   ' }))
    expect(t).toContain('歡迎加入我們')
  })

  // 🔴 `C-250`／`D-99`：「主要做」照型換；⛔ 不是賣東西的店不可以叫客人問出貨
  it('賣東西的寫「主要賣」', () => {
    expect(buildWelcomeDraft(ctxOf())).toContain('我們主要賣黑豆水')
  })

  it('⛔ 診所選了「實體＋網購」也不會被寫成「想問出貨」（`D-99` 漏網）', () => {
    const t = buildWelcomeDraft(ctxOf({ profile: profileOf({ industry: '醫療／健康', products: '全口檢查、牙齒矯正', channel: '實體＋網購' }) }))
    expect(t).toContain('我們主要做全口檢查')
    expect(t).toContain('預約時段')
    expect(t).not.toContain('出貨')
  })

  it('補習班問的是課程與報名，自己打產業別的走中性說法', () => {
    const school = buildWelcomeDraft(ctxOf({ profile: profileOf({ industry: '教育／課程', products: '國中數學' }) }))
    expect(school).toContain('我們主要開國中數學')
    expect(school).toContain('報名')
    expect(school).not.toContain('出貨')
    const free = buildWelcomeDraft(ctxOf({ profile: profileOf({ industry: '手工皂與香氛的工作室', products: '手工皂' }) }))
    expect(free).toContain('我們主要提供手工皂')
    expect(free).not.toContain('出貨')
  })
})

describe('AI 語氣', () => {
  it('⛔ 一定要保留安全規則（整包覆蓋 systemPrompt，只寫語氣等於把紅線刪掉）', () => {
    const t = buildToneDraft(ctxOf())
    expect(t).toContain('只能根據提供的「知識卡內容」回答')
    expect(t).toContain('不要自己編')
    expect(t).toContain('退費、法律糾紛、醫療診斷')
  })

  it('帶得到產業、商品與客群', () => {
    const t = buildToneDraft(ctxOf())
    expect(t).toContain('零售／電商')
    expect(t).toContain('黑豆水')
    expect(t).toContain('一般消費者')
  })

  it('AI 猜到語氣時用它，沒有就用預設的一句', () => {
    const withTone = buildToneDraft(ctxOf({ profile: setStoreProfileField(profileOf(), 'tone', '親切、講健康但不誇大', 'ai', 1) }))
    expect(withTone).toContain('親切、講健康但不誇大')
    expect(buildToneDraft(ctxOf())).toContain('親切、口語、不誇大')
  })

  it('輪廓幾乎全空也生得出合法的一段（不會出現連續標點）', () => {
    const t = buildToneDraft(ctxOf({ profile: emptyStoreProfile() }))
    expect(t).toContain('你是山丘咖啡的客服助理')
    expect(t).not.toMatch(/，。|、。|。。/)
    // 連店名都沒有時退成「這家店」
    expect(buildToneDraft(ctxOf({ shopName: '', profile: emptyStoreProfile() }))).toContain('你是這家店的客服助理')
  })

  // `C-250`／`D-99`：產業別可以自己打（「都不是，我自己講」）——⛔ 不可以寫成「你是一家○○的客服助理」
  it('⛔ 自己打的產業別不會把句子弄壞（改成條列，沒有「你是一家」）', () => {
    const t = buildToneDraft(ctxOf({ profile: profileOf({ industry: '手工皂與香氛的工作室' }) }))
    expect(t).not.toContain('你是一家')
    expect(t).toContain('店的類型：手工皂與香氛的工作室')
  })

  it('欄位名照型換（診所寫「主要服務」不寫「主打商品」）', () => {
    const t = buildToneDraft(ctxOf({ profile: profileOf({ industry: '醫療／健康', products: '全口檢查、牙齒矯正' }) }))
    expect(t).toContain('主要服務：全口檢查、牙齒矯正')
    expect(t).not.toContain('主打商品')
  })

  /**
   * `C-249`／`D-92`：**這一段是整包覆蓋 `aiSettings.systemPrompt` 的**，
   * 所以任何一個數字寫進來，AI 之後都會拿它當事實。
   * ⛔ 價格是整份輪廓最容易猜錯的一格（09-22 實測抽出 NT$0–7,030,300），
   *    而安全規則第 3 條本來就說價格只能來自知識卡。
   */
  it('⛔ 商家把價格打進商品那一格，也不會流進 systemPrompt（D-92）', () => {
    const p = setStoreProfileField(
      profileOf(), 'products', '黑豆水、養生茶包、節慶禮盒｜NT$180–1,280', 'ai', 1,
    )
    const t = buildToneDraft(ctxOf({ profile: p }))
    expect(t).toContain('主打商品：黑豆水、養生茶包、節慶禮盒')
    expect(t).not.toContain('NT$')
    expect(t).not.toContain('1,280')
    // ⛔ 切壞的殘骸也不可以在（這才是 D-92 真正抓到的形狀）
    expect(t).not.toMatch(/節慶禮盒[｜|]/)
    expect(t).not.toContain('180–1')
  })

  it('⛔ 價格帶那一格本身也不進 systemPrompt', () => {
    const p = setStoreProfileField(profileOf(), 'priceRange', 'NT$180–1,280', 'ai', 1)
    expect(buildToneDraft(ctxOf({ profile: p }))).not.toContain('1,280')
  })
})

describe('建議標籤（D-171 示意頁 v2：一排六顆、先勾三顆）', () => {
  /** 每一種走得到的組合都列一次：守門測試要掃過每一顆 */
  const EVERY_KIND: [string, DraftContext][] = [
    ['零售・網購・送禮旺季', ctxOf()],
    ['零售・網購・夏天', ctxOf({ profile: profileOf({ season: '夏天' }) })],
    ['零售・實體店面', ctxOf({ profile: profileOf({ channel: '實體店面' }) })],
    ['零售・預約制', ctxOf({ profile: profileOf({ channel: '預約制' }) })],
    ['餐飲・實體店面', ctxOf({ profile: profileOf({ industry: '餐飲／飲料', channel: '實體店面' }) })],
    ['餐飲・網購為主', ctxOf({ profile: profileOf({ industry: '餐飲／飲料', channel: '網購為主' }) })],
    ['醫療', ctxOf({ profile: profileOf({ industry: '醫療／健康' }) })],
    ['美容', ctxOf({ profile: profileOf({ industry: '美容／美業' }) })],
    ['教育', ctxOf({ profile: profileOf({ industry: '教育／課程' }) })],
    ['自己打的產業別', ctxOf({ profile: profileOf({ industry: '手工皂與香氛的工作室' }) })],
  ]
  const picked = (c: DraftContext) => buildTagDrafts(c).filter(t => t.picked).map(t => t.name)
  const all = (c: DraftContext) => buildTagDrafts(c).map(t => t.name)

  it('每一種店都是六顆、先勾三顆，而且勾好的排在前面', () => {
    for (const [kind, c] of EVERY_KIND) {
      const tags = buildTagDrafts(c)
      expect(tags, kind).toHaveLength(6)
      expect(tags.map(t => t.picked), kind).toEqual([true, true, true, false, false, false])
    }
  })

  // 🔴 D-171：沒有貼法的標籤永遠 0 人（舊版「回購客」就是這樣）
  it('⛔ 每顆都帶 AI 判斷條件、講得出之後拿來做什麼', () => {
    for (const [kind, c] of EVERY_KIND) {
      for (const t of buildTagDrafts(c)) {
        expect(t.criteria.length, `${kind} ${t.name}`).toBeGreaterThan(10)
        expect(t.criteria.length, `${kind} ${t.name}`).toBeLessThanOrEqual(200)
        expect(t.why.length, `${kind} ${t.name}`).toBeGreaterThan(5)
      }
    }
  })

  it('⛔ 沒有要訂單或來店紀錄才分得出來的（回購客、常客、第一次來、問過還沒買）', () => {
    for (const [kind, c] of EVERY_KIND) {
      for (const name of all(c)) {
        expect(needsRecords(name), `${kind} ${name}`).toBe(false)
        expect(['回購客', '回頭客', '回訪客', '續報家長', '問過還沒買', '問過沒預約', '問過沒報名', '問過沒成交'], kind).not.toContain(name)
      }
    }
  })

  it('名字、代號不重複；代號是建標籤 API 收得下的格式', () => {
    for (const [kind, c] of EVERY_KIND) {
      const tags = buildTagDrafts(c)
      expect(new Set(tags.map(t => t.name)).size, kind).toBe(6)
      expect(new Set(tags.map(t => t.code)).size, kind).toBe(6)
      for (const t of tags) {
        expect(t.code, `${kind} ${t.name}`).toMatch(/^[a-z][a-z0-9_]*$/)
        expect(t.code!.length, `${kind} ${t.name}`).toBeLessThanOrEqual(TAG_CODE_MAX_LENGTH)
      }
    }
  })

  it('跟「標籤管理」範本同一顆的，代號與判斷條件照範本（之後按範本不會建出第二顆）', () => {
    const tags = buildTagDrafts(ctxOf())
    for (const code of ['asked_price', 'asked_shipping_status', 'complained', 'return_in_progress', 'waiting_launch']) {
      const t = tags.find(x => x.code === code)
      if (!t) continue
      expect(t.criteria, code).toBe(TAG_TEMPLATES.find(x => x.code === code)!.criteria)
    }
    expect(tags.map(t => t.code)).toContain('asked_price')
  })

  it('送禮旺季先勾「想買來送禮」，其他季節先勾「在等開賣」', () => {
    expect(picked(ctxOf())).toContain('想買來送禮')
    expect(picked(ctxOf({ profile: profileOf({ season: '夏天' }) }))).toContain('在等開賣')
    expect(picked(ctxOf({ profile: profileOf({ season: '夏天' }) }))).not.toContain('想買來送禮')
  })

  it('網購的店先勾「問過出貨進度」；實體店面、預約制不給出貨', () => {
    expect(picked(ctxOf())).toContain('問過出貨進度')
    expect(all(ctxOf({ profile: profileOf({ channel: '實體店面' }) }))).not.toContain('問過出貨進度')
    expect(all(ctxOf({ profile: profileOf({ channel: '預約制' }) }))).not.toContain('問過出貨進度')
  })

  it('吃的店先勾訂位、外帶外送、客訴過（示意頁 v2）；網購為主的食品店照賣東西那一套', () => {
    const food = ctxOf({ profile: profileOf({ industry: '餐飲／飲料', channel: '實體店面' }) })
    expect(picked(food)).toEqual(['問過訂位', '問過外帶外送', '客訴過'])
    const onlineFood = ctxOf({ profile: profileOf({ industry: '餐飲／飲料', channel: '網購為主' }) })
    expect(all(onlineFood)).not.toContain('問過訂位')
    expect(picked(onlineFood)).toContain('問過出貨進度')
  })

  // 🔴 `C-250`／`D-99`：標籤建了就留在帳號裡（代號改不了）——⛔ 診所不可以拿到「送禮／出貨」
  it('⛔ 不是賣東西的店拿到的是自己那一型', () => {
    expect(picked(ctxOf({ profile: profileOf({ industry: '醫療／健康' }) }))).toEqual(['問過預約時段', '問過價格優惠', '問過服務內容'])
    expect(picked(ctxOf({ profile: profileOf({ industry: '教育／課程' }) }))).toEqual(['問過開課時間', '問過學費優惠', '問過試聽'])
    // 自己打的產業別＝中性型，⛔ 不猜成賣東西
    expect(picked(ctxOf({ profile: profileOf({ industry: '手工皂與香氛的工作室' }) }))).toEqual(['問過價格優惠', '在等新消息', '客訴過'])
    for (const industry of ['醫療／健康', '美容／美業', '教育／課程', '手工皂與香氛的工作室']) {
      const names = all(ctxOf({ profile: profileOf({ industry }) }))
      expect(names, industry).not.toContain('問過出貨進度')
      expect(names, industry).not.toContain('退換貨處理中')
    }
  })
})

describe('行銷月曆', () => {
  it('只列視窗內的節日，而且照日期排', () => {
    const list = buildCalendarDraft(ctxOf({ today: '2026-09-22' }))
    expect(list.length).toBeGreaterThan(0)
    for (const c of list) {
      expect(c.inDays).toBeGreaterThanOrEqual(0)
      expect(c.inDays).toBeLessThanOrEqual(90)
    }
    const days = list.map(c => c.inDays)
    expect([...days].sort((a, b) => a - b)).toEqual(days)
  })

  it('今天就是節日的那天也算在內（inDays = 0）', () => {
    const list = buildCalendarDraft(ctxOf({ today: '2026-09-25' }))
    expect(list[0]?.inDays).toBe(0)
    expect(list[0]?.name).toBe('中秋節')
  })

  it('⛔ 這一版只給通用 angle，不客製（客製是 C-223）', () => {
    const list = buildCalendarDraft(ctxOf())
    for (const c of list) {
      expect(c.angle).not.toContain('黑豆水')
      expect(c.angle.length).toBeGreaterThan(0)
    }
  })

  it('表尾用完之後不會炸，只是回空清單', () => {
    expect(buildCalendarDraft(ctxOf({ today: '2099-01-01' }))).toEqual([])
  })
})

describe('buildStoreDrafts', () => {
  /**
   * ⛔ 2026-09-26（`C-250`）知識庫那一樣**讀到網站也先不給**：原本是一顆「採用」，按了什麼都不會建
   *    （讀過的頁內文一小時後刪掉）＝假的決定。要等後端真的產生待看過的卡（`C-250` 第三批），
   *    那時換成一張寫得出真實張數的說明卡。⛔ 在那之前不可以畫「整理成 N 張」。
   */
  it('⛔ 知識庫那一樣先不給（讀到網站也一樣，張數是假的就不畫）', () => {
    expect(buildStoreDrafts(ctxOf()).map(d => d.key)).not.toContain('knowledge')
    expect(buildStoreDrafts(ctxOf({ pagesRead: 5 })).map(d => d.key)).not.toContain('knowledge')
  })

  // v75：三個節日他這一刻一件也做不了、每天早上的摘要本來就會講——整張收掉，只留成績單一行
  it('⛔ 行銷月曆那張不再出現（收進成績單一行）', () => {
    expect(buildStoreDrafts(ctxOf()).map(d => d.key)).not.toContain('calendar')
    expect(STORE_DRAFT_KIND.calendar).toBe('info')
  })

  it('要按「採用」的剛好三樣：歡迎訊息、AI 語氣、標籤', () => {
    expect(buildStoreDrafts(ctxOf()).map(d => d.key)).toEqual(['welcome', 'tone', 'tags'])
  })

  /**
   * 🔴 `C-250`／`D-100`：原本叫他「採用之後記得去 LINE 後台把內建那則關掉」，而接 LINE 那一趟
   *    站在那顆開關前面時卻寫「不用動」＝兩處教相反。改成**預告會在對的時間點講**；
   *    ⛔ 仍然不可以說「已為你關閉」（LINE 沒開放介面讓我們讀那個開關）。
   */
  it('歡迎訊息預告「接上 LINE 那一步會提醒你關掉內建那則」，而且不可以說已經幫你關了', () => {
    const w = buildStoreDrafts(ctxOf()).find(d => d.key === 'welcome')!
    expect(w.note).toContain('關掉')
    expect(w.note).toContain('接上 LINE')
    expect(w.note).not.toContain('已為你關閉')
  })

  it('每一樣都說得出東西會出現在後台哪裡', () => {
    for (const d of buildStoreDrafts(ctxOf({ pagesRead: 3 }))) {
      expect(d.where.length, d.key).toBeGreaterThan(0)
      expect(d.body.length, d.key).toBeGreaterThan(0)
    }
  })

  it('標籤卡：頭像講「以後想分哪幾種客人？勾起來…」、下面講怎麼貼上去；標題不帶顆數（勾的數量會變，顆數寫在「建立 N 顆」）', () => {
    const t = buildStoreDrafts(ctxOf()).find(d => d.key === 'tags')!
    expect(t.title).toBe('分眾標籤')
    // `D-174`：原本「以後想分哪幾種客人？」是前一個泡泡、「勾起來…」在卡片裡，併成頭像旁那一句
    expect(t.speech).toBe('以後想分哪幾種客人？勾起來，之後發推播就能只發給他們 👇')
    expect(t.note).toBe('客人在對話裡聊到，AI 會提醒你貼上。')
    expect(t.tags).toHaveLength(6)
    // body＝先勾好的那三個名字（決定前的唯讀樣子）
    expect(t.body.split('、')).toEqual(t.tags!.filter(x => x.picked).map(x => x.name))
  })

  it('`D-174`：每一張都有頭像旁那一句（講「這是什麼」）', () => {
    for (const d of buildStoreDrafts(ctxOf({ pagesRead: 3 }))) {
      expect(d.speech.length, d.key).toBeGreaterThan(0)
    }
    expect(buildStoreDrafts(ctxOf()).find(d => d.key === 'welcome')!.speech).toBe('客人加你好友時，我會先傳這則 👇')
  })

  it('`D-175`：語氣卡給四個「像誰」，每個附同一題的示範；寫出去的只換口氣那一行、安全規則都在', () => {
    const t = buildStoreDrafts(ctxOf()).find(d => d.key === 'tone')!
    expect(t.speech).toBe('客人問問題時，你要我像誰一樣回？')
    expect(t.tone!.roles).toHaveLength(4)
    expect(t.tone!.roles.map(r => r.id)).toContain(t.tone!.picked)
    for (const r of t.tone!.roles) expect(r.sample.length, r.id).toBeGreaterThan(0)
    expect(t.body).toContain(`說話的口氣：${TONE_ROLES[t.tone!.picked].voice}。`)
    expect(t.body).toContain(TONE_SAFETY_RULES)
    // 示範只示範口氣（卡片下面要講這一句）
    expect(t.note).toBe('只是示範口氣；實際內容照你的知識庫回答。')
  })

  it('`D-175`：網站猜到的口氣決定先選哪一個（只在那一型的四個裡面挑）', () => {
    const lively = setStoreProfileField(profileOf(), 'tone', '活潑、熱情', 'ai', 1)
    expect(buildStoreDrafts(ctxOf({ profile: lively })).find(d => d.key === 'tone')!.tone!.picked).toBe('host')
    // 診所（做服務）沒有「綜藝主持」：活潑的網站也不會被預選它
    const clinic = setStoreProfileField(setStoreProfileField(profileOf(), 'industry', '醫療／健康', 'owner', 1), 'tone', '活潑、熱情', 'ai', 1)
    const picked = buildStoreDrafts(ctxOf({ profile: clinic })).find(d => d.key === 'tone')!.tone!
    expect(picked.roles.map(r => r.id)).not.toContain('host')
    expect(picked.roles.map(r => r.id)).toContain(picked.picked)
  })
})

describe('canBuildDrafts', () => {
  it('輪廓全空時不要生（生出來會是一堆空洞的句子）', () => {
    expect(canBuildDrafts(null)).toBe(false)
    expect(canBuildDrafts(emptyStoreProfile())).toBe(false)
  })
  it('答過任何一題就可以生', () => {
    expect(canBuildDrafts(setStoreProfileField(emptyStoreProfile(), 'industry', '餐飲', 'owner', 1))).toBe(true)
  })
  it('只有 AI 猜到的非問答欄位不算（那些長不出文案）', () => {
    expect(canBuildDrafts(setStoreProfileField(emptyStoreProfile(), 'rivals', '某某', 'ai', 1))).toBe(false)
  })
})

describe('summarizeDraftApply', () => {
  const step = (key: string, status: string, error?: string): DraftApplyStep =>
    ({ key: key as never, label: `建立${key}`, status: status as never, ...(error ? { error } : {}) })

  it('全部成功：不要用嚇人的標題', () => {
    const r = summarizeDraftApply([step('welcome', 'done'), step('tone', 'done')])
    expect(r.ok).toBe(true)
    expect(r.headline).not.toContain('失敗')
    expect(r.leftovers).toEqual([])
  })

  it('⛔ 有東西成了、有東西沒成：標題不可以用「失敗」，而且要點名已經建好的', () => {
    const r = summarizeDraftApply([step('welcome', 'done'), step('tags', 'failed', '撞名')])
    expect(r.ok).toBe(true)
    expect(r.headline).not.toContain('失敗')
    expect(r.headline).toContain('1 樣沒成')
    expect(r.leftovers.join()).toContain('建立welcome已經建好了')
  })

  it('一樣都沒成：要講「系統裡沒有留下東西，可以直接再試」', () => {
    const r = summarizeDraftApply([step('welcome', 'failed', 'x'), step('tone', 'failed', 'y')])
    expect(r.ok).toBe(false)
    expect(r.headline).toContain('沒有留下')
    expect(r.leftovers).toEqual([])
  })

  it('「先不要」跟「沒有執行」講的不是同一句', () => {
    const r = summarizeDraftApply([step('welcome', 'declined'), step('tone', 'skipped')])
    expect(r.lines[0]).toContain('先不要')
    expect(r.lines[1]).toContain('沒有執行')
    expect(r.lines[0]).not.toBe(r.lines[1])
  })

  it('全部被「先不要」時不算失敗，也不要留下殘骸清單', () => {
    const r = summarizeDraftApply([step('welcome', 'declined'), step('tone', 'declined')])
    expect(r.ok).toBe(false)
    expect(r.headline).toContain('沒有要建')
    expect(r.leftovers).toEqual([])
  })

  it('失敗時逐行講得出原因', () => {
    const r = summarizeDraftApply([step('tags', 'failed', '這個名稱跟現有標籤撞在一起')])
    expect(r.lines[0]).toContain('這個名稱跟現有標籤撞在一起')
  })
})

/**
 * 「這一檔該發給誰」——檔期受眾配對（`C-55` ①「分客群」，`C-235`）。
 *
 * ── 這支在補的洞 ───────────────────────────────────────────────
 * `C-225` 原本的規則是拿「送禮／禮盒／贈禮／回購／囤貨」這些字去比對標籤名。
 * ⚠️ **2026-09-23 拿 MYFEEL 正式資料跑過：39 顆啟用中的標籤、九個節日有八個一顆都挑不到**
 *   （唯一命中的「雙 11 → 問過價格優惠」還是巧合）。原因是店家的標籤根本不長那樣——
 *   他們的標籤是**商品名**（「客服 - SHARP 頂級A咖｜iBarista 智慧咖啡機」）
 *   和**意圖**（「在看咖啡機」「在看香氛助眠」「在等開賣」）。
 *
 * ⭐ 所以配對的軸要換：**不是「節日 × 送禮字」，是「這一檔要推的商品 × 誰想要那個商品」**。
 *   商品從店家輪廓來（他自己填的），標籤裡含到那個商品名的就是這一檔的人。
 *
 * ── 三條鐵律 ───────────────────────────────────────────────────
 * ① **每一顆都要講得出為什麼是這群人**。挑三顆標籤卻說不出理由，人只能全盤接受或全盤不信。
 * ② **意圖排在事件前面，而且兩者要講不同的話**。「在看咖啡機」是他想要；
 *    「問卷 - 乾淨方MAX」只代表他填過那份問卷——⛔ 不可以混為一談（`D-28` 那條鐵律）。
 * ③ **挑不到要說得出「找過了、為什麼沒有」**，⛔ 不可以回一個空陣列裝沒事
 *    （[[feedback_filters_must_report_what_they_dropped]]）。
 */

/** 配對時看的標籤最小形狀 */
export interface AudienceTagLike {
  id: string
  name: string
  /** 有開 AI 判斷的＝意圖型；缺欄位＝off 是全系統口徑 */
  aiMode?: string
}

export type AudienceMatchKind = 'intent_product' | 'event_product' | 'occasion_word'

export interface AudienceSuggestion {
  tagId: string
  name: string
  users: number
  kind: AudienceMatchKind
  /** 給人看的一句：為什麼是這群人 */
  reason: string
}

export interface AudienceMatchResult {
  /** 有把握的配對——會**自動幫他選進受眾** */
  suggestions: AudienceSuggestion[]
  /**
   * 候選：**有人在裡面的意圖型標籤，但對不上這一檔要推的東西**（`C-235`）。
   *
   * ⚠️ 2026-09-23 拿 MYFEEL 真資料跑出來的東西：他有 13 顆「在看咖啡機」「在看香氛助眠」
   *   這種意圖標籤，但輪廓的「主打商品」是空的，所以一顆都配不起來——
   *   ⛔ 那時候回「挑不到」就太廢了，那些人明明白白講過自己想要什麼。
   *
   * ⛔ **候選不自動選進受眾**：我們不知道這一檔要推什麼，替他決定發給誰就是替他決定生意。
   *   只把名字跟人數端出來，讓他自己挑（`C-221` 那條紅線的同一個精神）。
   */
  candidates: AudienceSuggestion[]
  /** 挑不到時要講的那一句；挑得到就是空字串 */
  noMatchReason: string
  /** 找過幾顆標籤（講「找過了」要有數字撐） */
  scanned: number
}

/** 一次最多建議幾顆。三顆＝夠用又不會讓受眾寬到沒有意義。 */
export const AUDIENCE_MAX = 3

/**
 * 節慶場合字（舊規則，**降級成第三順位**而不是刪掉）。
 * 它本身沒有錯，只是大部分店家的標籤不長那樣——真的有「送禮名單」標籤的店，這條仍然對。
 */
const OCCASION_WORDS = /送禮|禮盒|贈禮|伴手禮/
const OCCASION_FESTIVALS = /春節|中秋|除夕|聖誕|情人|母親節|父親節|年節/
const SALE_WORDS = /回購|囤貨|揪團|優惠|折扣/
const SALE_FESTIVALS = /雙 ?11|雙 ?12|購物節|週年慶/

/**
 * 從輪廓的「主打商品」抽出可以拿去比對標籤名的詞。
 *
 * ⛔ 兩個字以下不要：「鍋」「機」這種會把半個標籤清單都掃進來。
 * ⛔ 價格帶（`｜` 後面那段）不算商品名。
 */
export function productKeywords(productsField: string): string[] {
  const head = String(productsField ?? '').split(/[｜|]/)[0] ?? ''
  const raw = head.split(/[、,，/／;；]/).map(s => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const w of raw) {
    // 去掉常見的修飾尾巴，讓「除濕機系列」也對得上「除濕機」
    const cleaned = w.replace(/(系列|類|等|等等|相關)$/u, '').trim()
    if (cleaned.length >= 2 && !out.includes(cleaned)) out.push(cleaned)
  }
  return out.slice(0, 8)
}

function isIntentTag(t: AudienceTagLike): boolean {
  return t.aiMode === 'suggest' || t.aiMode === 'auto'
}

/**
 * 這顆意圖標籤聽起來是「想買」還是「售後」？只用來**排候選的順序**。
 *
 * ⚠️ 為什麼需要它：「有開 AI 判斷」不等於「想買」。MYFEEL 13 顆意圖標籤裡，
 *   人數最多的是「問過出貨進度」（59 位）——照人數排的話，中秋節檔期的第一個候選
 *   會是一群在等包裹的人。
 * ⛔ 這只影響**排序**，不影響選不選（候選一律不自動選）。猜錯了最多是順序不理想，
 *   不會替他決定發給誰。
 */
function wantsToBuyScore(name: string): number {
  if (/問過出貨|出貨進度|發票|退換貨|故障|抱怨|客訴|維修|黑單/.test(name)) return -1
  if (/在看|在等|想要|考慮|有興趣|詢價|報價|比較/.test(name)) return 1
  return 0
}

/**
 * 挑出這一檔該發給誰。
 *
 * @param tags        啟用中的標籤
 * @param memberCount 每顆標籤有幾位客人（⛔ 0 位的不挑：挑了等於發給沒有人）
 * @param opts.excludeTagIds 一定要帶「N 天沒互動」那顆——它量大又跟想不想買無關
 */
export function matchAudienceTags(
  tags: readonly AudienceTagLike[],
  memberCount: Readonly<Record<string, number>>,
  opts: {
    festivalName: string
    products: readonly string[]
    excludeTagIds?: readonly string[]
  },
): AudienceMatchResult {
  const excluded = new Set(opts.excludeTagIds ?? [])
  const usable = tags.filter(t => t?.id && t.name && !excluded.has(t.id) && (memberCount[t.id] ?? 0) > 0)
  const scanned = usable.length

  const hits: AudienceSuggestion[] = []
  const taken = new Set<string>()

  const add = (t: AudienceTagLike, kind: AudienceMatchKind, reason: string) => {
    if (taken.has(t.id)) return
    taken.add(t.id)
    hits.push({ tagId: t.id, name: t.name, users: memberCount[t.id] ?? 0, kind, reason })
  }

  // ── 第一順位：意圖型 × 商品對得上 ──────────────────────────────
  for (const t of usable) {
    if (!isIntentTag(t)) continue
    const kw = opts.products.find(p => t.name.includes(p))
    if (kw) add(t, 'intent_product', `他們在對話裡表現出想要「${kw}」`)
  }

  // ── 第二順位：事件型 × 商品對得上 ──────────────────────────────
  // ⛔ 話要講得不一樣：這些人只是「碰過」那個商品（填過問卷、問過客服），不等於想買
  for (const t of usable) {
    if (isIntentTag(t)) continue
    const kw = opts.products.find(p => t.name.includes(p))
    if (kw) add(t, 'event_product', `他們問過或填過「${kw}」的資料（⚠️ 只代表碰過，不等於想買）`)
  }

  // ── 第三順位：節慶場合字（舊規則，留給真的有這種標籤的店）────────
  const fname = opts.festivalName
  for (const t of usable) {
    if (OCCASION_FESTIVALS.test(fname) && OCCASION_WORDS.test(t.name)) {
      add(t, 'occasion_word', '這顆標籤本來就是在標「會買來送人」的那群')
    }
    else if (SALE_FESTIVALS.test(fname) && SALE_WORDS.test(t.name)) {
      add(t, 'occasion_word', '這顆標籤本來就是在標「會等優惠才下手」的那群')
    }
  }

  // 同一順位內人多的排前面；順位本身已經由加入順序決定
  const order: Record<AudienceMatchKind, number> = { intent_product: 0, event_product: 1, occasion_word: 2 }
  hits.sort((a, b) => order[a.kind] - order[b.kind] || b.users - a.users || a.tagId.localeCompare(b.tagId))

  const suggestions = hits.slice(0, AUDIENCE_MAX)

  // 候選：配不起來時，把 AI 從對話判出來的那幾群端出來讓他自己挑
  const candidates: AudienceSuggestion[] = suggestions.length
    ? []
    : usable
        .filter(t => isIntentTag(t))
        // ⭐ 想買的排在售後的前面，⛔ 但兩種都留著、也都不自動選
        .sort((a, b) =>
          (wantsToBuyScore(b.name) - wantsToBuyScore(a.name))
          || (memberCount[b.id] ?? 0) - (memberCount[a.id] ?? 0)
          || a.id.localeCompare(b.id))
        .slice(0, AUDIENCE_MAX)
        .map(t => ({
          tagId: t.id,
          name: t.name,
          users: memberCount[t.id] ?? 0,
          kind: 'intent_product' as const,
          // ⚠️ 2026-09-23 真資料上的教訓：「有開 AI 判斷」**不等於「想買」**——
          //   MYFEEL 13 顆意圖標籤裡有「問過出貨進度」「問過發票」「抱怨過」「退換貨處理中」，
          //   那些是售後。所以這句只敢講「AI 從對話判出來的」，⛔ 不敢講「他想要」。
          reason: 'AI 從對話判出來的（不是問卷名冊）',
        }))

  return {
    suggestions,
    candidates,
    noMatchReason: suggestions.length ? '' : buildNoMatchReason(scanned, opts.products, candidates),
    scanned,
  }
}

/**
 * 挑不到時要講的那一句。
 * ⛔ **不可以只寫「沒有建議」**：人分不出「系統沒找」「找了沒有」「他的標籤本來就不適合」。
 */
export function buildNoMatchReason(
  scanned: number,
  products: readonly string[],
  candidates: readonly AudienceSuggestion[] = [],
): string {
  if (scanned === 0) {
    return '你還沒有任何「有人在裡面」的標籤，所以挑不出受眾——先去貼標，或這一檔直接發給全部好友。'
  }
  // ⭐ 有候選就一定要端出來：他有幾群 AI 從對話判出來的人，只是我們不知道這一檔推什麼。
  // ⛔ 列**兩顆**不是一顆：只列一顆時，剛好排到「問過出貨進度」就整個建議都廢了。
  const hint = candidates.length
    ? `可以自己挑的有：${candidates.slice(0, 2).map(c => `「${c.name}」${c.users} 位`).join('、')}`
      + '（這幾群是 AI 從對話判出來的，不是問卷名冊）。'
    : '這一檔的受眾要你自己挑，或直接發給全部好友。'

  if (!products.length) {
    return `找過你 ${scanned} 顆標籤了，但輪廓裡沒寫主打商品，所以我不敢替你選發給誰。`
      + `到「組織與 LINE」補上主打商品，下次就會自動挑好。${hint}`
  }
  return `找過你 ${scanned} 顆標籤了，沒有一顆對得上這一檔要推的東西（${products.slice(0, 3).join('、')}）。${hint}`
}

/** 帶到推播頁之後要對他講的那一句（挑到幾顆、憑什麼） */
export function audienceNoticeText(r: AudienceMatchResult): string {
  if (!r.suggestions.length) return r.noMatchReason
  const head = `發送對象先幫你選了 ${r.suggestions.length} 個標籤`
  // ⭐ 只講第一顆的理由就好：三顆理由全講會變成一段沒人讀的字
  return `${head}，例如「${r.suggestions[0]!.name}」——${r.suggestions[0]!.reason}`
}

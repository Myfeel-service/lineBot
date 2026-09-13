/**
 * 標籤名字「像不像」——兩層漏斗的**第一層**（純字面、零成本、不打 LLM）。
 *
 * 為什麼要有這支（`C-178`，老闆 2026-09-11 指出）：
 * 帳號裡已經有「在看收音麥克風」，AI 發現新標籤那輪又提了「在看無線麥克風」與
 * 「在看錄音麥克風」——兩顆都按下去就是**三顆麥克風標籤**。而標籤的下游是推播分眾：
 * 發一次麥克風優惠要記得三顆都勾，漏勾一顆那批客人就沒收到，事後還看不出來漏了誰。
 *
 * ⛔ **先前擋不住，是因為唯一的重複檢查是「正規化後完全同名」**
 * （`sanitizeDiscoveryProposalsDetailed` 的 `taken`）。「無線麥克風」跟「收音麥克風」
 * 是兩個不同字串，直接放行。至於「意思很像」，防線只有 prompt 裡一句
 * 「已存在的名稱不要再提（含同義換句話說）」——那是拜託模型，不是規則，而它沒照做。
 * 這跟 `C-27` 觸發詞、`C-143` 判官型號是同一課：**寫在 prompt 裡的紅線，模型偶爾會踩，
 * 紅線要有程式版**。
 *
 * 這一層只負責**挑出候選**（寧可多挑），最終要不要對人說話由第二層決定：
 * - AI 發現新標籤：候選丟給 `judgeSimilarTagNames`（LLM 判官），只有判「同一件事」才出聲。
 * - 人自己開新標籤：**不打 LLM**，直接把這一層的結果當提示（要即時、要免費），
 *   文案是「有點像，確定要另外開一顆嗎」而不是斷言，而且**永遠不擋**。
 *
 * ⛔ **不擋只提醒**：萬一這家店真的分開賣無線麥克風與錄音麥克風，硬擋就是幫倒忙。
 */

/**
 * 名字比對前的正規化：去空白、去標點、轉小寫。
 *
 * ⛔ 這是全系統**唯一**一份標籤名正規化（`shared/tag-discovery.ts` 從這裡 re-export）。
 * 分兩份的下場是「撞名」與「像不像」用不同口徑，同一組名字兩支給不同答案。
 */
export function normalizeTagName(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[。，、．,.!?！？「」『』()（）:：;；-]/g, '')
}

/** 共用片段至少要幾個字才算訊號（中文兩個字就很有指向性：「錄音」「發票」） */
export const SIMILAR_MIN_SHARED = 2
/** 共用片段最多看到幾個字（再長也只是同一個訊號，多算沒用還變慢） */
export const SIMILAR_MAX_SHARED = 8
/**
 * 一個片段出現在**幾顆既有標籤**以上就算「這家店的口頭禪」，不是相似訊號。
 *
 * 為什麼要動態算而不是寫死一張「在看／問過」的停用詞表：這是多租戶系統
 * （`feedback_saas_no_tenant_hardcoding`），每家店的命名習慣不一樣——這家愛用
 * 「在看 X」，下一家可能是「想買 X」或「X 諮詢中」。寫死就只有 MYFEEL 一家準。
 *
 * 這份資料實測：「在看」出現在 6 顆、「問過」3 顆 → 都判成口頭禪（不算訊號）；
 * 「麥克風」只出現在 1 顆 → 留下來當訊號。所以
 * 「在看無線麥克風」vs「在看料理鍋具」不會誤報，vs「在看收音麥克風」會報。
 */
export const GENERIC_MIN_NAMES = 3
/**
 * 標籤太少就不算口頭禪。
 * ⛔ 只有 3 顆標籤時，「出現在 3 顆以上」＝幾乎所有片段都被判成口頭禪＝這一層整個失效
 * （而且是**靜靜失效**：不報任何東西，跟「沒有相似的」長得一模一樣）。
 */
export const GENERIC_MIN_CORPUS = 5
/** 一次最多報幾顆「很像的」：報太多人就不看了，而排最前面的本來就是最像的 */
export const SIMILAR_MAX_HITS = 3

export interface SimilarNameCandidate {
  /** 既有標籤的 id；提案彼此相比時沒有 id（標籤還不存在） */
  id?: string
  name: string
}

export interface SimilarNameHit {
  id?: string
  /** 撞到的那顆的**原樣**名字（要印給人看，不可以印正規化後的） */
  name: string
  /**
   * 兩邊共有、而且在這個帳號裡夠特別的那段字。
   * ⛔ 一定要回：畫面上「跟『在看收音麥克風』很像」少了理由，人無從判斷該不該理它。
   */
  shared: string
  /** 正規化後完全同名（最強訊號，文案要講「已經有同名的」而不是「有點像」） */
  exact: boolean
}

/** 用碼點算長度：標籤名可能有 emoji，`'🎤'.length` 是 2 會讓長度比較失準 */
function charLen(s: string): number {
  return [...s].length
}

/** 一個名字的所有連續片段（長度 SIMILAR_MIN_SHARED ~ SIMILAR_MAX_SHARED） */
function fragments(normalized: string): Set<string> {
  const cs = [...normalized]
  const out = new Set<string>()
  for (let len = SIMILAR_MIN_SHARED; len <= SIMILAR_MAX_SHARED; len++) {
    for (let i = 0; i + len <= cs.length; i++) out.add(cs.slice(i, i + len).join(''))
  }
  return out
}

/**
 * 這個帳號的「口頭禪片段」：出現在夠多既有標籤裡、所以不具指向性的那些字。
 *
 * 導出成獨立一支是為了讓呼叫端算**一次**就好：AI 發現新標籤一輪要比 3 條提案 × 21 顆，
 * 每次重算等於把同一份語料掃 63 遍。
 */
export function genericFragments(corpus: string[]): Set<string> {
  const names = corpus.map(normalizeTagName).filter(Boolean)
  const generic = new Set<string>()
  // ⛔ 語料太少直接回空集合（見 GENERIC_MIN_CORPUS）：寧可多報幾次，不要整層靜靜失效
  if (names.length < GENERIC_MIN_CORPUS) return generic

  const counts = new Map<string, number>()
  for (const name of names) {
    // 同一顆標籤裡重複出現的片段只算一次（Set 已去重）——要數的是「幾顆標籤有」
    for (const f of fragments(name)) counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  for (const [f, c] of counts) {
    if (c >= GENERIC_MIN_NAMES) generic.add(f)
  }
  return generic
}

/**
 * 找出 `others` 裡跟 `candidate` 名字像的那幾顆。
 *
 * 判準＝兩邊共有、**且不是口頭禪**的最長片段。找不到就不是候選。
 *
 * @param opts.corpus 算口頭禪用的語料（預設＝`others` 的名字）。
 *   ⛔ 比「提案 vs 提案」時要**傳既有標籤名**：兩條提案自己湊不出這家店的用語習慣，
 *      用兩個名字當語料算出來的口頭禪沒有意義。
 * @param opts.generic 已經算好的口頭禪集合（同一輪多次呼叫時傳進來，別重算）
 */
export function findSimilarNames(
  candidate: string,
  others: SimilarNameCandidate[],
  opts: { corpus?: string[]; generic?: Set<string>; max?: number } = {},
): SimilarNameHit[] {
  const me = normalizeTagName(candidate)
  if (!me) return []

  const generic = opts.generic ?? genericFragments(opts.corpus ?? others.map(o => o.name))
  const mine = fragments(me)
  const hits: SimilarNameHit[] = []

  for (const other of others) {
    const raw = String(other?.name ?? '')
    const on = normalizeTagName(raw)
    if (!on) continue

    // 完全同名：最強訊號，直接收下（文案另外講，見 SimilarNameHit.exact）
    if (on === me) {
      hits.push({ id: other.id, name: raw, shared: raw, exact: true })
      continue
    }

    let best = ''
    for (const f of fragments(on)) {
      if (charLen(f) <= charLen(best)) continue // 只留最長的那個訊號
      if (!mine.has(f)) continue
      if (generic.has(f)) continue
      best = f
    }
    if (best) hits.push({ id: other.id, name: raw, shared: best, exact: false })
  }

  // 同名最前面；其次共用的字愈長愈像；再同分就照名字排（⛔ 否則每次重載順序會跳）
  hits.sort((a, b) =>
    Number(b.exact) - Number(a.exact)
    || charLen(b.shared) - charLen(a.shared)
    || a.name.localeCompare(b.name, 'zh-Hant'),
  )
  return hits.slice(0, opts.max ?? SIMILAR_MAX_HITS)
}

/**
 * 現有標籤兩兩對照，挑出「看起來重複」的組合（給「檢查現有標籤」那顆按鈕用）。
 *
 * ⛔ 每組只回一次（A-B 跟 B-A 是同一組）：列兩遍會讓人以為有兩個問題。
 */
export function findSimilarPairs(
  tags: Array<{ id: string; name: string }>,
  max = 20,
): Array<{ a: { id: string; name: string }; b: { id: string; name: string }; shared: string; exact: boolean }> {
  const generic = genericFragments(tags.map(t => t.name))
  const pairs: Array<{ a: { id: string; name: string }; b: { id: string; name: string }; shared: string; exact: boolean }> = []
  for (let i = 0; i < tags.length; i++) {
    const rest = tags.slice(i + 1)
    // max 給大一點再自己截：這裡要的是「這一顆跟後面所有顆的比對」，不是前 3 名
    const hits = findSimilarNames(tags[i]!.name, rest, { generic, max: rest.length })
    for (const hit of hits) {
      const other = rest.find(t => t.id === hit.id)
      if (!other) continue
      pairs.push({ a: { id: tags[i]!.id, name: tags[i]!.name }, b: other, shared: hit.shared, exact: hit.exact })
    }
  }
  pairs.sort((x, y) =>
    Number(y.exact) - Number(x.exact)
    || charLen(y.shared) - charLen(x.shared)
    || x.a.name.localeCompare(y.a.name, 'zh-Hant'),
  )
  return pairs.slice(0, max)
}

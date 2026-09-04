/**
 * 匯入時「這份資料該放進哪個資料夾」的猜測（`C-134`）。
 *
 * 為什麼需要這個：匯入視窗從來沒有資料夾欄位，每一份匯進來的東西都落在「未分類」，
 * 要靠人事後拖進去。2026-09-04 在 MYFEEL 正式資料上看到的後果是——十幾個產品資料夾
 * 裡各自躺著自己的說明書，只有 Kieslect 那三份留在未分類；店家照習慣打開產品資料夾
 * 找說明書，看到的是「沒有」，於是又傳了一次。**「選單上找不到」就是這樣來的。**
 *
 * 為什麼是 shared 純函式：這是一個會「幫使用者做決定」的判斷。放錯資料夾比留在未分類
 * 更糟（東西跑到別的產品底下，比不見還難查），所以寧可不猜也不要猜錯——這種取捨要能
 * 逐案測，元件裡的 computed 測不到。
 *
 * ⛔ 這支只負責「預設值」。猜完一定要顯示在畫面上讓人看得到、改得掉：
 *    悄悄放進某個資料夾，跟悄悄丟進未分類，都是使用者沒同意過的事。
 */

export interface FolderCandidate {
  id: string
  name: string
}

/** 比對用正規化：去掉空白與各種標點，全形轉半形，英文轉小寫 */
function normalize(s: string): string {
  return String(s ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[\s\-_/\\|,.、，。（）()[\]{}「」『』【】:：;；'"`~!?！？@#$%^&*+=]/g, '')
}

/**
 * 切詞：英數一段、CJK 一段。
 * 「Kieslect 小耳記 AI NotePods 10S」→ ['kieslect', '小耳記', 'ai', 'notepods', '10s']
 */
function tokenize(s: string): string[] {
  const norm = normalize(s)
  return norm.match(/[a-z0-9]+|[一-鿿぀-ヿ]+/g) ?? []
}

/**
 * 一個詞算不算「有份量」——只有它命中才敢據以判定。
 * 少了這道，資料夾名叫「AI 客服」時，任何檔名裡有 ai 兩個字母的東西都會被吸進去。
 */
function isStrongToken(t: string): boolean {
  return /^[a-z0-9]+$/.test(t) ? t.length >= 3 : t.length >= 2
}

/** 命中比例要多高才敢預設（0.6＝資料夾名有六成的字出現在檔名／產品名裡） */
const MIN_SCORE = 0.6
/** 第一名要贏第二名多少才算「沒有懸念」；差距太小＝兩個資料夾都像，寧可不猜 */
const MIN_MARGIN = 0.15

export interface FolderMatch {
  folderId: string
  /** 0～1；越高代表資料夾名字被檔名／產品名涵蓋得越完整 */
  score: number
}

/**
 * 從既有資料夾裡挑一個當預設。挑不出來（沒有夠像的、或兩個一樣像）回 null＝未分類。
 *
 * @param folders 這個帳號現有的資料夾
 * @param hints   拿來比對的字串：檔名／來源名、AI 判定的產品名
 */
export function pickFolderForSource(
  folders: readonly FolderCandidate[],
  hints: { sourceName?: string; productName?: string },
): FolderMatch | null {
  const haystack = normalize(`${hints.productName ?? ''} ${hints.sourceName ?? ''}`)
  if (!haystack) return null

  const scored: FolderMatch[] = []
  for (const f of folders ?? []) {
    const tokens = tokenize(f.name)
    if (!tokens.length) continue
    const total = tokens.reduce((n, t) => n + t.length, 0)
    let matched = 0
    let hasStrongHit = false
    for (const t of tokens) {
      if (!haystack.includes(t)) continue
      matched += t.length
      if (isStrongToken(t)) hasStrongHit = true
    }
    // 只靠零碎的短詞湊到分數不算數（見 isStrongToken）
    if (!hasStrongHit) continue
    const score = matched / total
    if (score >= MIN_SCORE) scored.push({ folderId: f.id, score })
  }

  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score)
  const [first, second] = scored
  if (second && first!.score - second.score < MIN_MARGIN) return null // 兩個都像＝不猜
  return first!
}

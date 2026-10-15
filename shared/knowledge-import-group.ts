/**
 * 加入知識時「放在哪一組」（`C-320`，2026-10-15 老闆拍板 `D-126`：資料夾跟「所屬產品」合成「商品」分組，上傳時不用選）。
 *
 * 為什麼抽成 shared 純函式：這是一個**替使用者做決定**的判斷，而且單份、一次好幾份、整個網站三條路都要用——
 * 各寫一次的話，一條路改了規則另一條沒改，同一份東西從兩條路進來會放在不同組。純函式才能逐案測。
 *
 * 規則（照順序，第一條成立就停）：
 *  ① 有一組名字跟 AI 認的商品一模一樣（大小寫、空白、全半形不算）→ 放那一組；
 *  ② 照檔名＋商品名比得到（`pickFolderForSource`，`C-134` 那一套，寧可不猜也不要猜錯）→ 放那一組；
 *  ③ 比不到、AI 又認出一個商品 → 預設「新分組『商品名』」，**並且要問一題**「這份在講哪個商品？」（ask）；
 *  ④ AI 沒認出商品（FAQ、公告、價目表、講好幾樣的）→ 放「通用」（有這一組的話）；
 *  ⑤ 都不是 → 不放分組。
 * ⛔ 商品名只拿來挑分組，**不會被分組名字換掉**：AI 答題看的是商品名（bulk-create 的 productName），分組只是放的位置。
 */
import { pickFolderForSource } from './knowledge-folder-match'

export interface ImportGroup {
  id: string
  name: string
  /** 「通用」那一組（FAQ／公告／價目表這種不是講單一商品的） */
  general?: boolean
}

/** new＋general：選了「通用」、但還沒有通用那一組——建一組叫「通用」的（`POST /api/ai/folders` 帶 general） */
export type ImportGroupChoice =
  | { kind: 'folder', id: string }
  | { kind: 'new', name: string, general?: boolean }
  | { kind: 'none' }

/** 還沒有「通用」那一組、他又選了它時，建出來的那一組叫什麼 */
export const GENERAL_GROUP_NAME = '通用'

export interface ImportGroupHints {
  sourceName?: string
  productName?: string
}

/** 跟伺服器建資料夾時截的長度一樣（server/utils/ai-knowledge-folders 的 createFolder） */
export const GROUP_NAME_MAX = 50

/** 判斷「同一個名字」用：全形轉半形、英文轉小寫、空白全拿掉（「W1 智慧手錶」＝「w1智慧手錶」） */
export function normGroupName(s: string): string {
  return String(s ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/\s+/g, '')
}

/** AI 認的商品名 → 新分組的名字（收掉多餘空白、截到伺服器收的長度）；'' ＝沒有商品名 */
export function newGroupName(productName?: string): string {
  return String(productName ?? '').trim().replace(/\s+/g, ' ').slice(0, GROUP_NAME_MAX).trim()
}

export function findGroupByName(groups: readonly ImportGroup[], name: string): ImportGroup | null {
  const key = normGroupName(name)
  if (!key) return null
  return groups.find(g => normGroupName(g.name) === key) ?? null
}

export function generalGroup(groups: readonly ImportGroup[]): ImportGroup | null {
  return groups.find(g => g.general) ?? null
}

/**
 * 自動挑哪一組（規則見檔頭）。
 * allowNew=false：比不到就不放分組、不開新分組——整個網站一次幾十頁、沒有人逐頁看，自己開幾十個分組比留著不放更難收拾。
 */
export function autoImportGroup(
  groups: readonly ImportGroup[],
  hints: ImportGroupHints,
  opts: { allowNew?: boolean } = {},
): { choice: ImportGroupChoice, ask: boolean } {
  const product = newGroupName(hints.productName)
  const same = product ? findGroupByName(groups, product) : null
  if (same) return { choice: { kind: 'folder', id: same.id }, ask: false }
  const m = pickFolderForSource(groups, hints)
  if (m) return { choice: { kind: 'folder', id: m.folderId }, ask: false }
  if (product) {
    return opts.allowNew === false
      ? { choice: { kind: 'none' }, ask: false }
      : { choice: { kind: 'new', name: product }, ask: true }
  }
  const g = generalGroup(groups)
  return { choice: g ? { kind: 'folder', id: g.id } : { kind: 'none' }, ask: false }
}

/** 比相似用：全形轉半形、小寫、只留字母數字與中日文（標點、空白都拿掉） */
function squash(s: string): string {
  return String(s ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}

/** 分組名字有幾成的字出現在對方裡（英數一段、中文一段，同 pickFolderForSource 的切法） */
function coverage(groupName: string, target: string): number {
  const tokens = squash(groupName).match(/[a-z0-9]+|[一-鿿぀-ヿ]+/g) ?? []
  const total = tokens.reduce((n, t) => n + t.length, 0)
  if (!total) return 0
  return tokens.reduce((n, t) => n + (target.includes(t) ? t.length : 0), 0) / total
}

/** 兩兩字的重疊（Dice）：「Kieselect 小耳記」跟「Kieslect 小耳記 耳機」這種打錯字、多幾個字的也看得出像 */
function dice(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit++
  return (2 * hit) / (A.size + B.size)
}

/** 「最像」至少要多像才列出來：不像的列出來當選項，等於叫他在一排不相干的名字裡挑 */
const MIN_CLOSE = 0.3

/**
 * 「這份在講哪個商品？」那一題列的「最像的幾組」（不含「通用」——它固定另外一顆）。
 * 跟 pickFolderForSource 不同：這裡**不替他決定**，只是把可能的排出來給他點，所以門檻低、兩個一樣像也照列。
 */
export function closestGroups(
  groups: readonly ImportGroup[],
  hints: ImportGroupHints,
  max = 3,
): ImportGroup[] {
  const targets = [hints.productName, hints.sourceName].map(t => squash(t ?? '')).filter(Boolean)
  if (!targets.length) return []
  return groups
    .filter(g => !g.general)
    .map(g => ({ g, score: Math.max(...targets.map(t => Math.max(coverage(g.name, t), dice(squash(g.name), t)))) }))
    .filter(x => x.score >= MIN_CLOSE)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.g)
}

/** 「改」那一排的順序：「通用」排最前面（最常被選、也最不會猜錯），其他照原本的順序 */
export function orderedGroups(groups: readonly ImportGroup[]): ImportGroup[] {
  return [...groups.filter(g => g.general), ...groups.filter(g => !g.general)]
}

/** 選項的值（el-select／el-radio 只收字串）：既有的一組＝g:id、新分組＝new、還沒有的「通用」＝general、不放＝none */
export function groupChoiceKey(c: ImportGroupChoice | null): string {
  if (!c) return ''
  if (c.kind === 'folder') return `g:${c.id}`
  if (c.kind === 'new') return c.general ? 'general' : 'new'
  return 'none'
}

export function groupChoiceFromKey(key: string, newName: string): ImportGroupChoice {
  if (key.startsWith('g:')) return { kind: 'folder', id: key.slice(2) }
  if (key === 'general') return { kind: 'new', name: GENERAL_GROUP_NAME, general: true }
  if (key === 'new' && newGroupName(newName)) return { kind: 'new', name: newGroupName(newName) }
  return { kind: 'none' }
}

/**
 * 搬進商品分組之後伺服器做了什麼（`PUT /api/ai/sources/:id` 回的 `groupFill`，`C-320` `/code-review` ②⑬）：
 *  · 這份沒有商品名、同組其他份只有一種 → 伺服器補上、當場重新學過（filled）；
 *  · 同組有好幾種 → 不猜，回那幾個名字（ask）——畫面要講清楚、給他挑；
 *  · `{ error: true }` → 搬是搬過去了，補商品名那一步沒成（failed）——簡短講一句，⛔ 不講成搬失敗；
 *  · 沒有 groupFill ＝什麼都沒補（這份本來就有名字、通用分組、不放分組⋯）。
 */
export type GroupFillOutcome =
  | { kind: 'filled', productName: string, indexed: number, failed: number }
  | { kind: 'ask', names: string[] }
  | { kind: 'failed' }

export function parseGroupFill(raw: unknown): GroupFillOutcome | null {
  const f = (raw as { groupFill?: { productName?: unknown, indexed?: unknown, failed?: unknown, names?: unknown, error?: unknown } } | null)?.groupFill
  if (!f || typeof f !== 'object') return null
  const productName = String(f.productName ?? '').trim()
  if (productName) return { kind: 'filled', productName, indexed: Number(f.indexed ?? 0) || 0, failed: Number(f.failed ?? 0) || 0 }
  if (f.error === true) return { kind: 'failed' }
  const names = Array.isArray(f.names) ? [...new Set(f.names.map(n => String(n ?? '').trim()).filter(Boolean))] : []
  return names.length >= 2 ? { kind: 'ask', names } : null
}

/** 補好了那一句（失敗的條數照實講，⛔ 不講成全都學會了） */
export function groupFillFilledText(f: { productName: string, failed: number }): string {
  return f.failed > 0
    ? `AI 認的商品名補成「${f.productName}」；有 ${f.failed} 條還沒學會，點開那一份按「重新學習」`
    : `AI 認的商品名補成「${f.productName}」`
}

/** 好幾個名字、不猜（`/code-review` ②）：指去那一份的「⋯ → AI 認的商品名」 */
export const GROUP_FILL_ASK_TEXT = '這一組裡有好幾個商品名，這份是哪一個要你選：點開那一份，按「⋯ → AI 認的商品名」'
/** 搬過去了、補商品名沒成 */
export const GROUP_FILL_FAILED_TEXT = '搬過去了，但 AI 認的商品名沒補成：點開那一份，按「⋯ → AI 認的商品名」補上'

/** 一行講完（一次好幾份那一列用；單份的結果頁「好幾個名字」那種另外給按鈕挑） */
export function groupFillNoteText(f: GroupFillOutcome | null): string {
  if (!f) return ''
  if (f.kind === 'filled') return groupFillFilledText(f)
  return f.kind === 'ask' ? GROUP_FILL_ASK_TEXT : GROUP_FILL_FAILED_TEXT
}

/**
 * 寫入失敗之後，伺服器**可能其實做完了**嗎（2026-10-15 `/code-review` ③⑥）——決定要不要刪掉剛替他建的分組：
 * 斷線（0）、逾時（408）、閘道（502／503／504）＝回應沒送到、可能已經放進去了 → ⛔ 不刪
 * （刪了那一組，伺服器會把已經放進去的那一份移出分組；一次好幾份逾時重送的那一包也還指著它）。
 * 其餘（403 空間滿、404、500⋯）＝伺服器看過、沒做成 → 剛建的空分組可以收掉。
 */
export function writeMayHaveLanded(status: number): boolean {
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504
}

/**
 * 搬分組（`PUT /api/ai/sources/:id`）失敗之後，**確定沒有搬進去**嗎：只有 4xx（伺服器看過、拒絕了）才確定。
 * 5xx 不算：伺服器可能已經改了分組、是後面補商品名那一步才出錯（`/code-review` ③）。
 */
export function moveSurelyRejected(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * 一次開窗裡建過哪些分組（`C-320`）。三件事要記在一起：
 *  ① 同一個名字只建一次：一次好幾份裡兩份都是新商品「W1」、兩個 worker 同時要——不記的話會建出兩個「W1」；
 *  ② 建好之前頁面的分組清單還沒重讀：第二份要比得到第一份剛建的那一組（見 ensure 裡的 existing ＋ 這裡記的）；
 *  ③ 他把那一份改放別組、而那一組是這次替他建的、又沒有別份在用 → 刪掉，不留一個他沒要過的空分組。
 * ⛔ 只刪「這次建的、而且確定空了」的那一組；現有的分組一律不碰。
 */
export interface ImportGroupRegistry {
  /**
   * 有同名的（現有的或這次建過的）就用那一組，沒有才建；建不成會丟錯（呼叫端決定這一份先不放分組）。
   * general：要的是「通用」——已經有通用那一組就用它（名字不一定叫「通用」）；
   * 有一組叫「通用」、卻沒標成通用（以前手建的）＝先把它標成通用再用（`PUT /api/ai/folders/:id { general }`）；
   * 都沒有才建一組帶 general 的。
   * ⛔ 不可以只照名字拿來用（2026-10-15 `/code-review` ⑫）：沒標成通用的那一組會被當成商品分組，
   *    搬進去的資料會被補上別份的商品名——FAQ、公告被 AI 認成某一台
   */
  ensure: (name: string, existing: readonly ImportGroup[], opts?: { general?: boolean }) => Promise<ImportGroup>
  /** 有一份真的放進去了 */
  use: (id: string) => void
  /** 有一份搬走了：這次建的、又沒有別份在用（inUseElsewhere 是呼叫端從清單上看到的）就刪掉 */
  release: (id: string, inUseElsewhere?: boolean) => Promise<void>
  /**
   * 正要送一份進去（加入、搬過去的請求還在路上）／送完了（不管成不成）。
   * 一次好幾份兩列同時用同一個新分組：一列失敗要收掉空分組時，另一列的請求可能還在路上——有人 hold 著就不刪
   */
  hold: (id: string) => void
  unhold: (id: string) => void
  /**
   * 加入／搬過去失敗之後收掉剛建的分組（`/code-review` ⑥）：只刪「這次建的、沒有任何一份放進去、也沒有請求還在路上」的。
   * ⚠️ 跟 release 不同，不扣「放進去幾份」——這一份根本沒放進去，扣了會把別份的算掉
   */
  discardIfUnused: (id: string) => Promise<void>
  isCreated: (id: string) => boolean
}

export function createImportGroupRegistry(
  io: {
    create: (name: string, opts: { general: boolean }) => Promise<ImportGroup>
    remove: (id: string) => Promise<unknown>
    /** 把一組標成「通用」（見 ensure 的 general） */
    markGeneral: (id: string) => Promise<unknown>
  },
  hooks: { onCreated?: (g: ImportGroup) => void, onRemoved?: (id: string) => void, onMarkedGeneral?: (g: ImportGroup) => void } = {},
): ImportGroupRegistry {
  const pending = new Map<string, Promise<ImportGroup>>()
  /** uses＝放進去幾份；holds＝還在路上的請求（見 hold） */
  const created = new Map<string, { group: ImportGroup, uses: number, holds: number }>()
  /** 這次標成通用的（頁面的分組清單關窗才重讀，在那之前要記得它已經是通用了） */
  const markedGeneral = new Map<string, ImportGroup>()

  return {
    async ensure(name, existing, opts = {}) {
      const general = opts.general === true
      const clean = newGroupName(general ? (name || GENERAL_GROUP_NAME) : name)
      if (!clean) throw new Error('沒有分組名字')
      const known = [...existing, ...[...created.values()].map(c => c.group), ...markedGeneral.values()]
        .map(g => (markedGeneral.has(g.id) ? markedGeneral.get(g.id)! : g))
      if (general) {
        const g = generalGroup(known)
        if (g) return g
      }
      const hit = findGroupByName(known, clean)
      if (hit && general) {
        // 名字叫「通用」卻沒標：先標再用（標不成會丟錯，⛔ 不退回去照名字直接放進去）
        await io.markGeneral(hit.id)
        const marked = { ...hit, general: true }
        markedGeneral.set(hit.id, marked)
        hooks.onMarkedGeneral?.(marked)
        return marked
      }
      if (hit) return hit
      const key = normGroupName(clean)
      let p = pending.get(key)
      if (!p) {
        p = io.create(clean, { general })
          .then((g) => {
            // 回來的沒有編號＝沒建成（填一個不存在的分組，那一份會從清單上整份消失，見 G-98）
            if (!g?.id) throw new Error('分組沒建成')
            const group = { id: g.id, name: g.name || clean, general: g.general === true || general }
            created.set(group.id, { group, uses: 0, holds: 0 })
            hooks.onCreated?.(group)
            return group
          })
          .finally(() => pending.delete(key))
        pending.set(key, p)
      }
      return p
    },
    use(id) {
      const c = created.get(id)
      if (c) c.uses++
    },
    async release(id, inUseElsewhere = false) {
      const c = created.get(id)
      if (!c) return
      c.uses = Math.max(0, c.uses - 1)
      if (c.uses > 0 || c.holds > 0) return
      created.delete(id)
      if (inUseElsewhere) return // 清單上看得到別份在裡面：不刪，只是不再當成「這次建的」
      await removeNow(id)
    },
    hold(id) {
      const c = created.get(id)
      if (c) c.holds++
    },
    unhold(id) {
      const c = created.get(id)
      if (c) c.holds = Math.max(0, c.holds - 1)
    },
    async discardIfUnused(id) {
      const c = created.get(id)
      if (!c || c.uses > 0 || c.holds > 0) return
      created.delete(id)
      await removeNow(id)
    },
    isCreated: id => created.has(id),
  }

  async function removeNow(id: string) {
    hooks.onRemoved?.(id)
    try {
      await io.remove(id)
    }
    catch { /* 刪不掉就留著一個空分組：他在清單上看得到、也刪得掉，不值得為它跳錯誤 */ }
  }
}

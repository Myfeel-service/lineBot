/**
 * 台灣節慶行銷提醒：節日表 ＋ 「今天該提醒哪一個」的判定。
 *
 * 用途：每日客服摘要（`dailyBacklogDigest`）在節日前 7／3／1 天，於同一則訊息裡
 * 多加一段節慶提醒與行銷建議。**刻意不另發一則**——LINE 按則計費，沿用 2026-08-06
 * 「一則錢講完全部」的拍板。
 *
 * ── 為什麼節日表寫死在 repo，不接政府行事曆 API ──────────────────────
 * 政府開放資料只有「放假日」，而行銷要的節日大多不放假：母親節、父親節、七夕、
 * 萬聖節、雙 11、聖誕節全部查不到。反過來說，這張表要的東西（日期＋一句行銷角度）
 * 一年只需維護一次，換來的是完全可控、不怕外部服務掛掉或改格式。
 *
 * ── 維護方式（一年一次，約十分鐘）────────────────────────────────
 * 1. 農曆節日（春節／除夕／元宵／端午／七夕／中元／中秋／重陽）與清明，
 *    每年的國曆日期都不一樣，**一律查證兩個獨立來源對得上才寫進來**，不要憑印象。
 * 2. 母親節＝五月第二個週日，也要逐年查（不是固定日期）。
 * 3. 表尾快用完時 `taiwan-festivals.test.ts` 的「存量」那條會紅，照它說的補下一年。
 *
 * 本表日期查證日：2026-08-20。2026 年份查證來源兩處一致；2027 年份（含農曆八項）
 * 亦由兩處獨立來源逐項對照一致；清明 2027 另行查證。**冬至刻意不收**——2027 年
 * 找不到可靠來源，寧缺勿錯。
 *
 * ⛔ 多租戶紀律：`angle` 一句話必須**跨產業都成立**（餐飲、電商、美業、批發都讀得懂），
 * 不可以寫任何特定客戶的產品或術語。要客製到商家自己的商品是日後 Phase 2 的事。
 */
import { daysBetween } from './time'

export interface TaiwanFestival {
  /**
   * 穩定識別碼 `{slug}-{西元年}`。
   * ⛔ 不可含「.」：這個值會被當成 Firestore 的 map key 存進 `cronState/festival-digest`，
   * 帶點的話 `set(..., {merge:true})` 會把它解析成巢狀欄位路徑。
   */
  id: string
  /** 國曆日期 YYYY-MM-DD（台灣時區） */
  date: string
  /** 商家看得懂的節日名稱，直接出現在訊息裡 */
  name: string
  /** 行銷角度：一句話講「這個節日客人的需求會怎麼動」，跨產業通用 */
  angle: string
  /** 是不是連假：只影響「前一天」那句的最後一項提醒（值班 vs 顧線上客服） */
  longWeekend?: boolean
}

/** 節日前幾天要提醒。由遠到近，語氣一路從「規劃」收到「最後確認」。 */
export const FESTIVAL_REMIND_DAYS = [7, 3, 1] as const

export type FestivalMilestone = (typeof FESTIVAL_REMIND_DAYS)[number]

/**
 * 節日表（依日期排序；`taiwan-festivals.test.ts` 會驗排序，別插錯位置）。
 *
 * 收錄標準＝**在台灣真的會改變買氣的日子**。刻意不收的：教師節、雙 12、冬至、
 * 光復節等商業拉力低或已被鄰近節日蓋掉的日子——提醒太密會被當雜訊直接忽略。
 * 要加減節日就是改這張表，程式不用動。
 */
export const TAIWAN_FESTIVALS: readonly TaiwanFestival[] = [
  // ── 2026 ──────────────────────────────────────────────
  { id: 'ghost-2026', date: '2026-08-27', name: '中元節', angle: '普渡與拜拜的採購集中在這幾天' },
  { id: 'midautumn-2026', date: '2026-09-25', name: '中秋節', angle: '禮盒與送禮的需求會明顯升溫', longWeekend: true },
  { id: 'nationalday-2026', date: '2026-10-10', name: '國慶日', angle: '連假的出遊與聚餐會帶動買氣', longWeekend: true },
  { id: 'doubleninth-2026', date: '2026-10-18', name: '重陽節', angle: '敬老送禮與長輩用的東西會被找' },
  { id: 'halloween-2026', date: '2026-10-31', name: '萬聖節', angle: '應景裝飾、變裝與打卡活動最容易帶氣氛' },
  { id: 'double11-2026', date: '2026-11-11', name: '雙 11 購物節', angle: '全年最大的線上折扣檔期，客人會比價比得特別兇' },
  { id: 'christmas-2026', date: '2026-12-25', name: '聖誕節', angle: '交換禮物與聚餐的檔期，送禮客群最捨得花' },
  // ── 2027 ──────────────────────────────────────────────
  { id: 'newyear-2027', date: '2027-01-01', name: '元旦（跨年）', angle: '跨年聚會與「新年新目標」的話題最好切入', longWeekend: true },
  { id: 'lunarnewyeareve-2027', date: '2027-02-05', name: '除夕', angle: '年菜、伴手禮與年前最後一波出貨全壓在這天之前' },
  { id: 'lunarnewyear-2027', date: '2027-02-06', name: '春節（農曆新年）', angle: '全年最長的連假，紅包、送禮與返鄉消費一次爆發', longWeekend: true },
  { id: 'valentines-2027', date: '2027-02-14', name: '西洋情人節', angle: '情侶送禮與雙人套餐是主力' },
  { id: 'lantern-2027', date: '2027-02-20', name: '元宵節', angle: '燈會人潮與應景食品會帶一波買氣' },
  { id: 'qingming-2027', date: '2027-04-05', name: '兒童節・清明節連假', angle: '四天連假，親子活動與返鄉掃墓兩種客人都在移動', longWeekend: true },
  { id: 'labourday-2027', date: '2027-05-01', name: '勞動節', angle: '連假出遊與「犒賞自己」的消費', longWeekend: true },
  { id: 'mothersday-2027', date: '2027-05-09', name: '母親節', angle: '上半年最大的送禮檔期，蛋糕、鮮花與家用品都熱' },
  { id: 'dragonboat-2027', date: '2027-06-09', name: '端午節', angle: '禮盒與伴手禮的送禮潮', longWeekend: true },
  // 2027 年父親節與七夕**同一天**（8/8）。合成一條而不是兩條：兩條的話里程碑完全重疊，
  // 會變成連兩天各講一次同一個檔期。
  { id: 'fathersday-qixi-2027', date: '2027-08-08', name: '父親節・七夕情人節', angle: '同一天兩個送禮節，送長輩和送情人的客人都會出現' },
  { id: 'ghost-2027', date: '2027-08-16', name: '中元節', angle: '普渡與拜拜的採購集中在這幾天' },
  { id: 'midautumn-2027', date: '2027-09-15', name: '中秋節', angle: '禮盒與送禮的需求會明顯升溫' },
  { id: 'doubleninth-2027', date: '2027-10-08', name: '重陽節', angle: '敬老送禮與長輩用的東西會被找' },
  { id: 'nationalday-2027', date: '2027-10-10', name: '國慶日', angle: '連假的出遊與聚餐會帶動買氣', longWeekend: true },
  { id: 'halloween-2027', date: '2027-10-31', name: '萬聖節', angle: '應景裝飾、變裝與打卡活動最容易帶氣氛' },
  { id: 'double11-2027', date: '2027-11-11', name: '雙 11 購物節', angle: '全年最大的線上折扣檔期，客人會比價比得特別兇' },
  { id: 'christmas-2027', date: '2027-12-25', name: '聖誕節', angle: '交換禮物與聚餐的檔期，送禮客群最捨得花' },
]

/** 節日表覆蓋到哪一天（YYYY-MM-DD）。存量看門測試用。 */
export function festivalCoverageEnd(): string {
  return TAIWAN_FESTIVALS[TAIWAN_FESTIVALS.length - 1]?.date ?? ''
}

export interface FestivalReminder {
  festival: TaiwanFestival
  /** 這次講的是哪一個里程碑（7／3／1）——決定語氣，不是決定天數 */
  milestone: FestivalMilestone
  /** 今天實際距離節日幾天。休假日補講時會小於 milestone（例如里程碑 7 卻只剩 5 天） */
  daysUntil: number
}

/** 已提醒過的里程碑：`{ [festivalId]: 已送出的最小里程碑 }` */
export type SentMilestones = Readonly<Record<string, number>>

/**
 * 今天有沒有任何節日進入提醒範圍（不看有沒有送過）。
 *
 * 給排程當**便宜的閘門**用：一年裡大多數日子這裡回 false，就能整段跳過
 * 「掃 workspaces 清單、讀提醒狀態」那些查詢——2026-08-11 讀取費暴衝的教訓是
 * 「掃全部再跳過」最貴，能不查就不要查。
 */
export function hasFestivalInWindow(today: string): boolean {
  const maxDays = Math.max(...FESTIVAL_REMIND_DAYS)
  return TAIWAN_FESTIVALS.some((f) => {
    const d = daysBetween(today, f.date)
    return d >= 0 && d <= maxDays
  })
}

/**
 * 今天該提醒哪一個節日？沒有就回 null。
 *
 * 判定刻意**不要求「天數剛好等於 7／3／1」**，而是「里程碑 ≥ 剩餘天數、且這個里程碑
 * 還沒送過」。這樣商家休假日（週六日整天不發摘要）跳過的提醒，會在下一個上班日自動
 * 補講，而且天數講的是**當天的真實剩餘天數**（「還有 5 天」而不是騙人的「還有 7 天」）。
 *
 * 同一天有兩個節日都到期時**只回最近的那一個**：一則訊息塞兩段節慶會失焦，另一個
 * 節日沒被記成已送出，明天自然會輪到它。
 */
export function pickFestivalReminder(today: string, sent: SentMilestones = {}): FestivalReminder | null {
  const candidates: FestivalReminder[] = []
  for (const festival of TAIWAN_FESTIVALS) {
    const daysUntil = daysBetween(today, festival.date)
    if (daysUntil < 0) continue // 已經過了
    // 已到期或已錯過的里程碑（休假日補講靠這裡：剩 5 天時里程碑 7 仍算到期）
    const eligible = FESTIVAL_REMIND_DAYS.filter(m => m >= daysUntil)
    if (!eligible.length) continue // 還太遠
    // 取最緊迫（數字最小）的那一個當語氣基準
    const milestone = Math.min(...eligible) as FestivalMilestone
    const already = sent[festival.id]
    // 「已送過的數字 ≤ 這次要送的」＝講過了。日子往前走時里程碑只會愈來愈小，所以
    // 正常情況下這裡等同於 `===`；用 ≤ 是為了守**節日表被改動**的情況——某個節日的
    // 日期被往後挪，已經講到「明天」的節日不會整輪從「還有 7 天」重講一次。
    if (typeof already === 'number' && already <= milestone) continue
    candidates.push({ festival, milestone, daysUntil })
  }
  // 不必排序：節日表本身依日期排序（`taiwan-festivals.test.ts`「依日期排序」那條在守），
  // 所以候選也是由近到遠，第一個就是最近的那個節日。
  return candidates[0] ?? null
}

/** 「再過 3 天」／「明天」／「今天」——天數一律講真實剩餘天數。 */
function dayPhrase(daysUntil: number): string {
  if (daysUntil <= 0) return '今天'
  if (daysUntil === 1) return '明天'
  return `再過 ${daysUntil} 天`
}

/** `2026-09-25` → `09/25`（訊息裡附日期，商家不用自己數） */
function monthDay(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`
}

/**
 * 提醒內容（一句話，不含 emoji 與標題，由呼叫端決定怎麼包）。
 *
 * 三個里程碑講**不同的事**，這是整個功能的重點——同一個節日連講三次一樣的話
 * 就只是三倍雜訊：
 *   7 天前：還來得及規劃，講「備素材、想優惠」
 *   3 天前：講「現在就去排推播」（順手帶到自家功能）
 *   1 天前：講「最後確認」清單
 */
export function festivalReminderText(r: FestivalReminder): string {
  const when = dayPhrase(r.daysUntil)
  const { name, angle, longWeekend } = r.festival
  switch (r.milestone) {
    case 7:
      return `${when}就是${name}（${monthDay(r.festival.date)}）。${angle}，建議這幾天先把檔期優惠、贈品和圖文素材準備好。`
    case 3:
      return `${when}就是${name}。建議今天就到後台「推播」把節慶訊息排進去，內容記得講清楚下單與出貨時間。`
    case 1:
    default:
      return `${when}就是${name}！最後確認三件事：推播排了沒、庫存和出貨來不來得及、`
        + `${longWeekend ? '連假期間客服值班排好了沒' : '當天有沒有人顧線上客服'}。`
  }
}

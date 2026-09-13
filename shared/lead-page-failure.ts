/**
 * 客人在活動頁（LIFF）失敗的原因分型別——前後端共用的唯一一份。
 *
 * 為什麼要分型別而不是只記一個 `error`：**三種「打不開」的下一步完全不同**。
 * 「連結被轉傳截斷」要重發連結、「Endpoint URL 登記錯」要去 LINE 改設定、
 * 「活動已停用」根本不是故障。合成一種只會得到一個沒人能行動的數字
 * （同 `feedback_filters_must_report_what_they_dropped` 的教訓）。
 *
 * ⛔ 這份清單只增不改字串：舊資料裡存的是這些代碼，改字串等於讓歷史紀錄失聯。
 */
export const LEAD_FAILURE_REASONS = [
  /** 反查不到這個 LIFF 屬於哪個帳號（liffId 沒設、或撞號無法判斷）——後台設定問題 */
  'config_missing',
  /** liff.init() 失敗：多半是 LINE 上登記的 Endpoint URL 指到別處，或 LIFF 已被刪 */
  'liff_init_failed',
  /** 載入逾時：客人等到系統放棄。跨網域轉圈那次就是這個形狀 */
  'load_timeout',
  /** 客人手上的連結缺參數：轉傳被截斷、或複製到錯的網址 */
  'link_incomplete',
  /** 點到已停用的活動——預期內的擋下，不是故障 */
  'campaign_inactive',
  /** 綁定時後端回錯（token 對不上、已被別人用掉…） */
  'claim_failed',
] as const

export type LeadFailureReason = typeof LEAD_FAILURE_REASONS[number]

export function isLeadFailureReason(v: unknown): v is LeadFailureReason {
  return typeof v === 'string' && (LEAD_FAILURE_REASONS as readonly string[]).includes(v)
}

/**
 * `load_timeout` 卡在哪一步。
 *
 * 為什麼要分：2026-09-13 查 myfeel 的 94 次逾時時，紀錄裡只有一句寫死的
 * `loading_watchdog`——「客人網路慢」「SDK 載不下來」「LINE 沒回應」「綁定請求卡住」
 * 四種完全不同的毛病擠在同一個數字裡，查不出來也修不了。分了才有下一步。
 *
 * ⛔ 同 `LEAD_FAILURE_REASONS`：只增不改字串，舊資料裡存的是這些代碼。
 */
export const LEAD_TIMEOUT_STAGES = [
  /** 還在讀網址參數（幾乎不可能停在這，停住就是頁面本身有問題） */
  'parse',
  /** 在跟自家 API 問這個 LIFF 屬於誰 */
  'resolve_liff',
  /** 在嘗試把客人送去 LINE App */
  'open_line_app',
  /** 在下載 LINE 的 SDK（客人網路慢會停在這） */
  'load_sdk',
  /** 在呼叫 liff.init()（LINE 那邊沒回應會停在這） */
  'liff_init',
  /** 在送出綁定請求等回應 */
  'claiming',
  /** 舊版前端沒回報階段 */
  'unknown',
] as const

export type LeadTimeoutStage = typeof LEAD_TIMEOUT_STAGES[number]

export function isLeadTimeoutStage(v: unknown): v is LeadTimeoutStage {
  return typeof v === 'string' && (LEAD_TIMEOUT_STAGES as readonly string[]).includes(v)
}

/** 工程看的說明（後台不顯示這些字，它們是查問題用的） */
export const LEAD_TIMEOUT_STAGE_LABELS: Record<LeadTimeoutStage, string> = {
  parse: '讀網址參數',
  resolve_liff: '反查 LIFF 屬於哪個帳號',
  open_line_app: '嘗試開啟 LINE App',
  load_sdk: '下載 LINE SDK',
  liff_init: 'liff.init()',
  claiming: '送出綁定請求',
  unknown: '（舊版前端沒回報）',
}

/**
 * `campaign_inactive` 同時是 claim 端點回給前端的錯誤代碼——活動頁靠它把畫面
 * 從「無法完成綁定」換成「活動已結束」（後者不是故障，不該叫客人重試）。
 */
export const CAMPAIGN_INACTIVE_CODE: LeadFailureReason = 'campaign_inactive'

/** 客人看到的那句話（claim 端點的 statusMessage）。白話、不要技術詞。 */
export const CAMPAIGN_INACTIVE_MESSAGE = '這個活動已經結束了。'

/**
 * 後台看到的文案：`label`＝發生了什麼（講後果不講原理），`hint`＝下一步。
 *
 * ⚠️ `fault: false` 的項目不算災情，畫面上不要拿它去點紅燈。
 *
 * ⚠️ `owner: false` ＝**商家自己沒有任何設定可以改**。2026-09-13 的教訓（`G-90`）：
 * 原本六種並排成一張紅色清單，每一列都附「去哪裡改什麼」——其中兩種根本不是商家
 * 能處理的，等於叫人去做做不到的事；而且 94 次「客人網路慢」被算進同一個紅色數字，
 * 看起來像自己的系統壞了。**畫面必須把兩種分開**：`owner: true` 的才列出動作，
 * `owner: false` 的只講「這是什麼、為什麼不用你處理」。
 */
export const LEAD_FAILURE_LABELS: Record<LeadFailureReason, { label: string, hint: string, fault: boolean, owner: boolean }> = {
  config_missing: {
    label: '系統認不出這個連結屬於哪個帳號',
    hint: '到「組織與 LINE」設定把 LIFF ID 填好，活動連結才認得出是你的帳號。',
    fault: true,
    owner: true,
  },
  liff_init_failed: {
    label: 'LINE 那邊打不開活動頁',
    hint: '兩種可能：舊活動的連結還在外面流通（重新發一次新的連結就好），或是這個 LIFF 在 LINE 那邊被改掉、被刪掉。先到「組織與 LINE」設定看登記狀態。',
    fault: true,
    owner: true,
  },
  load_timeout: {
    label: '客人等太久，系統放棄載入',
    hint: '多半是客人當下的網路或手機環境。你這邊沒有設定可以改。',
    fault: true,
    owner: false,
  },
  link_incomplete: {
    label: '客人手上的連結不完整',
    hint: '轉傳時被截斷、或複製到錯的網址。把「活動進入網址」整串重新發一次。',
    fault: true,
    owner: true,
  },
  campaign_inactive: {
    label: '客人點到已停用的活動',
    hint: '這是正常的擋下，不是故障。連結還在外面流通時就會出現。',
    fault: false,
    owner: false,
  },
  claim_failed: {
    label: '綁定到一半斷掉了',
    hint: '多半是客人綁定途中關掉視窗或網路斷線。你這邊沒有設定可以改。',
    fault: true,
    owner: false,
  },
}

/** 商家處理不掉的那幾種，畫面上收成一句話時用這句收尾（⛔ 不要寫成「不用理它」） */
export const LEAD_FAILURE_NOT_OWNER_NOTE
  = '這幾種是客人當下的網路或手機環境造成的，你這邊沒有設定可以改。次數一直往上跑的話再告訴工程。'

/** 沒有分母可用時，失敗次數到這個量才值得升成狀態卡 */
const LEAD_BLOCK_COUNT_THRESHOLD = 50
/** 有分母時，失敗佔比到這個百分比才值得升成狀態卡 */
const LEAD_BLOCK_PERCENT_THRESHOLD = 25

export interface LeadFailureSummary {
  /** 商家動得了、而且真的有數字的項目——**只有這些該列成「要做什麼」** */
  ownerRows: Array<{ reason: LeadFailureReason, count: number, label: string, hint: string }>
  /** 商家動不了的故障次數合計（收成一句話，不逐項列） */
  notOwnerTotal: number
  /** 點到已停用活動的次數。不是故障，單獨講 */
  inactiveCount: number
  failTotal: number
  succeeded: number
  /** 失敗佔比（%）。⛔ 沒有分母時是 `null` 不是 `0`——兩者意思完全不同 */
  failPercent: number | null
  /** 要不要升成一塊狀態卡（否則只給一行小字） */
  needsBlock: boolean
  /** ⛔ 只有「商家真的可以動手」才准是 critical */
  tone: 'critical' | 'warning'
  blockTitle: string
  blockDetail: string
  /** 不夠格升成狀態卡時顯示的那一行 */
  quietLine: string
}

/**
 * 把後端的原始計數整理成「畫面該說什麼」。
 *
 * ⭐ 抽成純函式是因為這裡有三條很容易再犯的規矩，要用測試釘住（`G-90`）：
 * ⑴ **商家動不了的項目不准點紅燈**——原本 94 次「客人網路慢」讓整塊變紅，
 *    商家看了只覺得系統壞了，卻沒有任何一件事做得了。
 * ⑵ **沒有分母就不准顯示比例**——`succeeded === 0` 可能是「真的沒人成功」，
 *    也可能是「這段時間還沒開始記」（成功計數比失敗計數晚上線），兩者分不開。
 *    ⛔ 尤其不可以寫成「0 人成功」。
 * ⑶ **每一列都要有做得到的下一步**，沒有下一步的就收成一句話。
 */
export function summarizeLeadFailures(input: {
  byReason: Record<string, number> | null | undefined
  total: number
  succeeded: number
  days: number
}): LeadFailureSummary {
  const by = input.byReason ?? {}
  const rows = LEAD_FAILURE_REASONS
    .map(reason => ({ reason, count: Number(by[reason] || 0), ...LEAD_FAILURE_LABELS[reason] }))
    .filter(r => Number.isFinite(r.count) && r.count > 0)

  const ownerRows = rows
    .filter(r => r.fault && r.owner)
    .sort((a, b) => b.count - a.count)
    .map(({ reason, count, label, hint }) => ({ reason, count, label, hint }))
  const notOwnerTotal = rows.filter(r => r.fault && !r.owner).reduce((s, r) => s + r.count, 0)
  const inactiveCount = rows.filter(r => !r.fault).reduce((s, r) => s + r.count, 0)

  const failTotal = Math.max(0, Number(input.total) || 0)
  const succeeded = Math.max(0, Number(input.succeeded) || 0)
  const denom = succeeded + failTotal
  const failPercent = succeeded > 0 && denom > 0 ? Math.round((failTotal / denom) * 100) : null

  const ownerTotal = ownerRows.reduce((s, r) => s + r.count, 0)
  const needsBlock = failTotal > 0 && (
    ownerRows.length > 0
    || (failPercent == null
      ? failTotal >= LEAD_BLOCK_COUNT_THRESHOLD
      : failPercent >= LEAD_BLOCK_PERCENT_THRESHOLD)
  )

  const days = input.days
  const blockTitle = ownerTotal > 0
    ? `近 ${days} 天有 ${failTotal} 次沒完成，其中 ${ownerTotal} 次你可以處理`
    : `近 ${days} 天有 ${failTotal} 次沒完成`

  const blockDetail = succeeded > 0
    ? `同一段時間有 ${succeeded} 人順利完成。這些數字是客人那一端實際回報的，不是推算的。`
    : '這些是客人那一端實際回報的，不是推算的。'

  let quietLine: string
  if (failTotal <= 0) {
    quietLine = succeeded > 0
      ? `近 ${days} 天有 ${succeeded} 人順利完成，沒有客人回報打不開活動頁。`
      : `近 ${days} 天沒有客人回報打不開活動頁。`
  }
  else {
    const head = failPercent == null
      ? `近 ${days} 天有 ${failTotal} 次沒完成`
      : `近 ${days} 天有 ${succeeded} 人順利完成、${failTotal} 次沒完成（${failPercent}%）`
    quietLine = `${head}。這些都不是你這邊的設定造成的，沒有需要處理的事。`
  }

  return {
    ownerRows,
    notOwnerTotal,
    inactiveCount,
    failTotal,
    succeeded,
    failPercent,
    needsBlock,
    tone: ownerRows.length > 0 ? 'critical' : 'warning',
    blockTitle,
    blockDetail,
    quietLine,
  }
}

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
 * `campaign_inactive` 同時是 claim 端點回給前端的錯誤代碼——活動頁靠它把畫面
 * 從「無法完成綁定」換成「活動已結束」（後者不是故障，不該叫客人重試）。
 */
export const CAMPAIGN_INACTIVE_CODE: LeadFailureReason = 'campaign_inactive'

/** 客人看到的那句話（claim 端點的 statusMessage）。白話、不要技術詞。 */
export const CAMPAIGN_INACTIVE_MESSAGE = '這個活動已經結束了。'

/**
 * 後台看到的文案：`label`＝發生了什麼（講後果不講原理），`hint`＝下一步。
 * ⚠️ `fault: false` 的項目不算災情，畫面上不要拿它去點紅燈。
 */
export const LEAD_FAILURE_LABELS: Record<LeadFailureReason, { label: string, hint: string, fault: boolean }> = {
  config_missing: {
    label: '系統認不出這個連結屬於哪個帳號',
    hint: '多半是「預設 LIFF」沒設或設錯。到「組織與 LINE」設定確認 LIFF ID。',
    fault: true,
  },
  liff_init_failed: {
    label: 'LINE 那邊打不開活動頁',
    hint: '通常是 LIFF 在 LINE 登記的 Endpoint URL 指到別的網址、或 LIFF 被刪了。到「組織與 LINE」設定看登記狀態。',
    fault: true,
  },
  load_timeout: {
    label: '客人等太久，系統放棄載入',
    hint: '登記的網址連不上或很慢時會這樣。先看「組織與 LINE」設定的 LIFF 登記狀態。',
    fault: true,
  },
  link_incomplete: {
    label: '客人手上的連結不完整',
    hint: '轉傳時被截斷、或複製到錯的網址。把「活動進入網址」整串重新發一次。',
    fault: true,
  },
  campaign_inactive: {
    label: '客人點到已停用的活動',
    hint: '這是正常的擋下，不是故障。連結還在外面流通時就會出現。',
    fault: false,
  },
  claim_failed: {
    label: '綁定到一半失敗了',
    hint: '同一個連結被別人用過、或後端出錯。若持續發生請找工程確認。',
    fault: true,
  },
}

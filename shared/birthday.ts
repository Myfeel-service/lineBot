/**
 * 客人生日（`C-57`，John 哥 2026-11-04：「只要有人生日，我就會被逼著做動作——我就離不開這個工具」）。
 *
 * 怎麼問：店家打開「加好友時問生日」→ 歡迎訊息後面多一張卡、一顆「告訴我生日」，按了是 **LINE 內建的選日期**
 * （datetimepicker，⛔ 不帶客人去外面填表單：記憶 `feedback_keep_customers_in_line`）。
 * 存什麼：⛔ **只存月、日**，不存年（年齡用不到，存了是更敏感的個資）；LINE 的選日期會連年份一起選，收到就丟掉。
 * 存哪：`users` 文件頂層 `birthdayMonth`／`birthdayDay`（⛔ 不放 `attributes`：那是店家腳本自由寫的 key/value，
 *       各家寫成「生日」「birthday」「生日日期」就永遠比不出「這個月生日的人」）。
 * 怎麼用：每個月 1 號貼「本月壽星」系統標籤（`server/utils/birthday-tag.ts`），推播照標籤挑人就好——
 *       分眾維度只有標籤一種，做成標籤推播端零改動（同「N 天沒互動」）。
 *
 * ⛔ 卡上的字**只有店家寫了禮物才提禮物**：沒寫就只問生日。承諾了就要真的送（客人會記得）。
 */

import { taipeiDate } from './time'

/** postback data：只有這一個值（不帶任何參數，日期在 LINE 給的 `params.date`） */
export const BIRTHDAY_POSTBACK_DATA = 'birthday=set'

/** 「本月壽星」系統標籤的固定 code（同工作區唯一） */
export const BIRTHDAY_TAG_CODE = 'sys_birthday_month'
export const BIRTHDAY_TAG_NAME = '本月壽星'
export const BIRTHDAY_TAG_DESCRIPTION = '系統自動維護：每個月 1 號把這個月生日的客人貼上、上個月的摘掉；客人在 LINE 上留了生日、剛好是這個月，也會馬上貼上。在「好友」頁的「生日」設定。'

/** 禮物那一格最多幾個字（卡片上一行半讀得完；也擋貼一整段活動辦法進來） */
export const BIRTHDAY_GIFT_MAX = 30

export interface BirthdaySettings {
  /** 加好友時問生日（預設關：會對客人多送一張卡，要店家自己決定） */
  enabled: boolean
  /** 生日當月送什麼，接在「生日當月」後面（例：來店招待一杯飲料）；空＝不承諾禮物 */
  gift: string
}

export const DEFAULT_BIRTHDAY_SETTINGS: BirthdaySettings = { enabled: false, gift: '' }

export function normalizeBirthdaySettings(raw: unknown): BirthdaySettings {
  const r = (raw ?? {}) as Partial<BirthdaySettings>
  return {
    enabled: r.enabled === true,
    gift: [...String(r.gift ?? '').replace(/[\r\n]+/g, ' ').trim()].slice(0, BIRTHDAY_GIFT_MAX).join('').trim(),
  }
}

/** LINE 選日期回來的 `YYYY-MM-DD` → 月、日（⛔ 年份丟掉）；格式不對或不是真的日子＝null */
export function parseBirthdayDate(date: unknown): { month: number, day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? '').trim())
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const probe = new Date(Date.UTC(y, mo - 1, d))
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null
  return { month: mo, day: d }
}

export function birthdayLabel(month: number, day: number): string {
  return `${month} 月 ${day} 日`
}

/** 卡片上那句話 */
export function birthdayAskText(gift: string): string {
  const g = gift.trim()
  return g ? `告訴我們你的生日，生日當月${g}！` : '告訴我們你的生日 🎂'
}

/** 卡片上那句話底下的小字（⛔ 不寫成「我們會記得你」這種我們沒做的事） */
export const BIRTHDAY_ASK_NOTE = '只會記下月和日。'
export const BIRTHDAY_BUTTON_LABEL = '🎂 告訴我生日'

/**
 * 「打開了」之後一定要跟著講的但書（`C-468` code review 第 4 條）。
 *
 * 生日卡是附在歡迎訊息後面送的，而 `shared/line-reply-append.ts` 的 `appendBlockedReason`
 * 有兩種情況不附：最後一則帶快速回覆按鈕（附了那排按鈕會不見）、歡迎訊息已經滿 5 則。
 * 「生日」框一開始就講了這件事，但**邀請卡那一行與開帳精靈沒講**——而邀請卡針對的正是
 * 已經有一套歡迎訊息的老店，最容易中。他們以為開好了，客人卻永遠收不到，
 * 原因只留在伺服器日誌裡（⛔ 典型的假承諾）。
 * ⛔ 三個地方要講同一句：分開寫就會改一處漏兩處。
 */
export const BIRTHDAY_APPEND_CAVEAT = '歡迎訊息最後一則有快速回覆按鈕時不附（附了那排按鈕會不見）。'

/** 存生日失敗時回客人的那一句（重送會被當成重複略過，所以要請他自己再選一次） */
export const BIRTHDAY_SAVE_FAILED_TEXT = '剛剛沒有記到你的生日，麻煩再按一次「告訴我生日」選一次 🙏'

/** 客人選完日期，我們回的那一句 */
export function birthdayConfirmText(month: number, day: number, gift: string, changed: boolean): string {
  const head = changed ? `好，生日改成 ${birthdayLabel(month, day)}了 🎂` : `收到，你的生日是 ${birthdayLabel(month, day)} 🎂`
  const g = gift.trim()
  return g ? `${head}\n生日當月${g}，到時候見！` : head
}

/**
 * 機器人模組按鈕的動作類型「問生日」（`C-57` 甲，老闆 2026-11-04 選的做法）：
 * 卡片訊息、文字＋按鈕的按鈕可以選它，按了就是 LINE 內建選日期，跟加好友那張卡同一個 postback。
 * ⭐ 這樣推播選「觸發機器人模組」、圖文選單指向那個模組，就能問**已經是好友**的人（他們不會再收到歡迎訊息）。
 */
export const BIRTHDAY_BUTTON_TYPE = 'birthday'

/** 選日期那個動作（加好友的卡、模組按鈕同一支）。@param today 台北今天 `YYYY-MM-DD`＝上限（生日不會在未來） */
export function birthdayPickerAction(label: string, today: string): Record<string, unknown> {
  return {
    type: 'datetimepicker',
    label: [...(label.trim() || BIRTHDAY_BUTTON_LABEL)].slice(0, 20).join(''),
    data: BIRTHDAY_POSTBACK_DATA,
    mode: 'date',
    // 預設停在 2000 年：從今天往回捲幾十年太累；⛔ 不預設今天（按了確定就存成今天＝假生日）
    initial: '2000-01-01',
    min: '1900-01-01',
    max: today,
  }
}

/**
 * 「好友」頁一鍵建的「問生日」模組（編輯器格式：一則文字＋一顆「問生日」按鈕）。
 * 字建好之後就是店家的，可以自己改（⚠️ 之後改了禮物，模組裡那句不會跟著變）。
 */
export const BIRTHDAY_MODULE_NAME = '問生日'
export function buildBirthdayModuleMessages(gift: string): Record<string, unknown>[] {
  return [{
    type: 'text',
    text: `${birthdayAskText(gift)}\n${BIRTHDAY_ASK_NOTE}`,
    buttons: [{ type: BIRTHDAY_BUTTON_TYPE, label: BIRTHDAY_BUTTON_LABEL }],
  }]
}

/**
 * 那張卡（Flex）。⚠️ datetimepicker 要放在 Flex 的按鈕或 buttons template：Flex 沒有 160 字上限，
 * 禮物寫長一點也不會整則被 LINE 退回。
 * @param today 台北今天 `YYYY-MM-DD`：選日期的上限（生日不會在未來）
 */
export function buildBirthdayAskMessage(gift: string, today: string): Record<string, unknown> {
  const text = birthdayAskText(gift)
  return {
    type: 'flex',
    altText: text,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text, wrap: true, weight: 'bold', size: 'md' },
          { type: 'text', text: BIRTHDAY_ASK_NOTE, wrap: true, size: 'xs', color: '#8C8C8C' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'button',
          style: 'primary',
          color: '#06C755',
          height: 'sm',
          action: birthdayPickerAction(BIRTHDAY_BUTTON_LABEL, today),
        }],
      },
    },
  }
}

/**
 * 這一天（`YYYY-MM-DD`）要祝哪些生日（`D-170` 早上報告「今天幾位壽星」）。
 * ⚠️ 平年的 2 月 28 日連 2/29 生日的一起算：不然他四年才被祝一次。
 */
export function birthdayKeysForDay(dayKey: string): Array<{ month: number, day: number }> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!m) return []
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const keys = [{ month: mo, day: d }]
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  if (mo === 2 && d === 28 && !leap) keys.push({ month: 2, day: 29 })
  return keys
}

/**
 * `since` 到 `day`（含頭尾）的每一天（休假日回來那天把休假那幾天一起講，code review 第 4 條）。
 * 格式不對、倒過來、超過 7 天＝null（⛔ 網址參數是人改得到的，不讓它一次撈一整年）。
 */
export const BIRTHDAY_RANGE_MAX_DAYS = 7
export function birthdayDayRange(since: string, day: string): string[] | null {
  const re = /^\d{4}-\d{2}-\d{2}$/
  if (!re.test(since) || !re.test(day)) return null
  const start = Date.parse(`${since}T00:00:00Z`)
  const end = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null
  const out: string[] = []
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
    if (out.length > BIRTHDAY_RANGE_MAX_DAYS) return null
  }
  return out
}

/**
 * 生日祝福那則的預設字（`D-170`：早上報告按連結 → 推播頁已經寫好，店家看一眼再送）。
 * `{{displayName}}`＝一人一則換成他自己的名字（`D-118`）。⛔ 沒寫禮物就不提禮物；⛔ 不替店家編領取方式。
 */
export function birthdayGreetingText(gift: string): string {
  const g = gift.trim()
  return g
    ? `{{displayName}}，生日快樂 🎂\n生日當月${g}。`
    : '{{displayName}}，生日快樂 🎂\n謝謝你一直以來的支持，祝你今天開心！'
}

/** 早上報告那一段要的事實（`D-170`）。`null`＝這次查不到（⛔ 不可以當成 0） */
export interface BirthdayDigestFacts {
  /** 那幾天新留了生日的人數（改生日不算） */
  newlySet: number | null
  /** 今天的壽星（已封鎖的不算） */
  today: { count: number, names: string[] } | null
}

/** 台北這個月（1–12）。⚠️ 吃 `shared/time` 的 `taipeiDate`（code review 第 14 條：⛔ 不另寫一種台北時間算法） */
export function taipeiMonth(now: Date = new Date()): number {
  return Number(taipeiDate(now).slice(5, 7))
}

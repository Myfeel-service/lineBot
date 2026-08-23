/**
 * 「AI 判斷型」標籤範本（D-27③）。
 *
 * 為什麼要有：難的不是點「新增標籤」，是**想不到該建哪些、判斷條件怎麼寫**。
 * 範本＝名稱、分類、顏色、判斷條件全部寫好，一鍵建立後改幾個字就能用。
 *
 * 設計原則：
 * - 全部是「對話裡看得出來」的意圖／興趣（AI 的甜蜜點）；VIP、高消費這種要靠帳務或
 *   主觀判斷的**刻意不進範本**——AI 判了也是猜。
 * - 品類粒度不是型號粒度：「在看除濕機」一顆涵蓋所有除濕機型號，這是既有
 *   「一顆一型號」標籤做不到的分眾切法。
 * - criteria 寫法＝「什麼算＋什麼不算」，建立後老闆可逐字改（≤200 字，
 *   對齊編輯器與 ai-tag-suggest 的 CRITERIA_IN_PROMPT_MAX）。
 * - 建立時一律 aiMode='suggest'（先建議、人工把關），跑準了再自行升級 auto。
 */

export interface TagTemplate {
  /** 標籤 code（workspace 內唯一；已存在同 code 就跳過不重建） */
  code: string
  name: string
  category: 'member_status' | 'interest' | 'behavior' | 'activity' | 'custom'
  color: string
  /** AI 判斷條件（aiCriteria） */
  criteria: string
  /** 給團隊看的說明（description）：這顆拿來做什麼 */
  usage: string
}

export const TAG_TEMPLATES: TagTemplate[] = [
  {
    code: 'intent_dehumidifier',
    name: '在看除濕機',
    category: 'interest',
    color: '#0EA5E9',
    criteria: '客人詢問、比較除濕機，或提到家裡潮濕、衣服晾不乾、想找除濕的方法。只問舊機維修保固的不算。',
    usage: '除濕機品類的意向客（涵蓋所有型號），梅雨、潮濕季檔期名單。',
  },
  {
    code: 'intent_air_purifier',
    name: '在看空氣清淨機',
    category: 'interest',
    color: '#14B8A6',
    criteria: '客人詢問空氣清淨機、除菌除臭，或提到過敏、鼻子不舒服、在意空氣品質想找解法。只問耗材更換方式的不算。',
    usage: '清淨機品類的意向客，換季與空品差時的推播名單。',
  },
  {
    code: 'intent_earbuds',
    name: '在看耳機',
    category: 'interest',
    color: '#8B5CF6',
    criteria: '客人詢問、比較耳機，包括通話品質、翻譯功能、配戴舒適度。已購買後問操作設定的不算。',
    usage: '耳機品類的意向客（涵蓋所有型號）。',
  },
  {
    code: 'intent_gifting',
    name: '想送禮',
    category: 'interest',
    color: '#EC4899',
    criteria: '客人提到要送人、找禮物、問能不能包裝、代寄或指定到貨日。自用順便問包裝的不算。',
    usage: '節慶檔期最準的一群，父親節、中秋、年節提案的第一份名單。',
  },
  {
    code: 'asked_price',
    name: '問過價格折扣',
    category: 'behavior',
    color: '#F97316',
    criteria: '客人詢問價格、優惠、折扣碼，或表示想等特價、比較過別家價格。',
    usage: '對價格敏感的一群，限時折扣一發最快有反應。',
  },
  {
    code: 'asked_shipping',
    name: '問過運費到貨',
    category: 'behavior',
    color: '#EAB308',
    criteria: '客人詢問運費、出貨時間、多久到貨、能不能指定日期或超商取貨。',
    usage: '免運活動的目標客；物流延遲時要主動通知的對象。',
  },
  {
    code: 'complained',
    name: '抱怨過',
    category: 'member_status',
    color: '#EF4444',
    criteria: '客人對商品、物流或服務表達不滿、失望，或要求處理、退換貨。單純詢問退貨流程但沒有不滿情緒的不算。',
    usage: '安撫與售後追蹤名單；行銷推播前記得把這群排除。建議維持「先建議」由人工確認。',
  },
  {
    code: 'asked_repair',
    name: '想找維修保固',
    category: 'behavior',
    color: '#6B7280',
    criteria: '客人詢問維修、保固期限、故障排除、零件更換。購買前問保固幾年的不算（那是購買意向）。',
    usage: '售後服務名單——跟「在看某產品」分開，別把他們混進行銷推播。',
  },
]

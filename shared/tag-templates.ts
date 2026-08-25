/**
 * 「AI 判斷型」標籤範本（D-27③；2026-08-25 依真實對話重寫，見 `C-75`）。
 *
 * 為什麼要有：難的不是點「新增標籤」，是**想不到該建哪些、判斷條件怎麼寫**。
 * 範本＝名稱、判斷條件全部寫好，一鍵建立後改幾個字就能用。
 *
 * ⚠️ **2026-08-25 整批換掉的原因**：第一版是我照「家電行」的刻板印象寫的
 * （在看除濕機／在看空氣清淨機／想送禮…）。拿 MYFEEL 兩週、102 位客人的真實對話
 * 一比對：**除濕機只有 1 位提過、清淨機 0 位**——那批範本對這家店幾乎無用。
 * 現在這份改成**從真實客服對話歸納出來的「行為型」主題**。
 *
 * 設計原則：
 * - ⛔ **只放跨產業通用的行為，不放任何品類**（SaaS 不寫死租戶，見
 *   memory `feedback_saas_no_tenant_hardcoding`）。「在看收音麥克風」這種
 *   對 MYFEEL 很準、對別的商家是雜訊——那種要在各自的工作區自己建。
 * - 行為型比品類型**壽命長**：換一批商品還是有用，這也是實測資料給的結論
 *   （前七名主題全部是行為，第一名「問過出貨進度」佔 43%）。
 * - 全部是「對話裡看得出來」的（AI 的甜蜜點）；VIP、消費金額這種要靠帳務或
 *   主觀判斷的**刻意不進範本**——AI 判了也是猜。
 * - criteria 寫法＝「什麼算＋什麼不算」，建立後可逐字改（≤200 字，對齊編輯器與
 *   ai-tag-suggest 的 CRITERIA_IN_PROMPT_MAX）。
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
    code: 'asked_shipping_status',
    name: '問過出貨進度',
    category: 'behavior',
    color: '#1668AD',
    criteria: '客人詢問訂單什麼時候出貨、到貨、寄出，或查詢配送進度、反映還沒收到貨。只問「怎麼下單」或運費多少的不算。',
    usage: '實測最大的一群（MYFEEL 兩週內 102 位客人有 44 位）。某批商品要延誤時一次通知這群人，不必等他們一個個來問。',
  },
  {
    code: 'return_in_progress',
    name: '退換貨處理中',
    category: 'behavior',
    color: '#B45309',
    criteria: '客人提出要退貨、換貨、取消訂單或退款。只是先問「可不可以退」但沒有實際要退的不算。',
    usage: '行銷推播前先把這群排除——正在辦退貨還收到促銷是最容易引爆客訴的組合。',
  },
  {
    code: 'reported_defect',
    name: '回報過商品故障',
    category: 'behavior',
    color: '#BE123C',
    criteria: '客人回報商品瑕疵、故障、無法使用、缺件，或詢問保固維修流程。購買前問「保固幾年」的不算（那是購買意向）。',
    usage: '同一批貨出問題時找得回受影響的人；也是售後追蹤名單。與行銷推播分開。',
  },
  {
    code: 'asked_price',
    name: '問過價格優惠',
    category: 'behavior',
    color: '#F97316',
    criteria: '客人詢問價格、優惠碼、折扣、早鳥價、分期付款，或提到別家平台比較便宜。',
    usage: '對價格敏感的一群，限時折扣或加碼活動一發最快有反應。',
  },
  {
    code: 'complained',
    name: '抱怨過',
    category: 'member_status',
    color: '#EF4444',
    criteria: '客人明確表達不滿、失望、質疑服務態度或處理效率，或提到要給負評。單純陳述問題但沒有情緒的不算。',
    usage: '安撫與售後追蹤名單；行銷推播前記得排除。⚠️ 建議一直維持「AI 先建議」由人工確認，不要開自動貼。',
  },
  {
    code: 'waiting_launch',
    name: '在等開賣',
    category: 'interest',
    color: '#8B5CF6',
    criteria: '客人詢問某商品何時開賣、預購或募資何時開始結束，或表示要等開賣、等有貨再買。',
    usage: '新品開賣當天最準的一份名單——他們自己說過在等。',
  },
  {
    code: 'asked_invoice',
    name: '問過發票',
    category: 'behavior',
    color: '#0F766E',
    criteria: '客人詢問發票開立、補發、統一編號、載具，或要拿發票去申請補助、退稅、報帳。',
    usage: '發票流程改善後可主動通知這群；累積的人數也看得出這件事造成多少客訴。',
  },
]

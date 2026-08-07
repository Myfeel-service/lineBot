import type { ScriptNode } from './ai-script'
import { DEFAULT_COLLECT_EXPIRE_MS, DEFAULT_SCRIPT_PRIORITY } from './ai-script'

/**
 * 常用腳本範本：使用者在編輯器一鍵載入後微調再存檔。
 * 每個範本都是合法的（通過 validateScriptDoc）；節點 id 只需在單一腳本內唯一，故用可讀的固定字串。
 * 載入時呼叫端會 deep-clone，避免改動到這份共用資料。
 */
export interface ScriptTemplate {
  key: string
  /** 範本顯示名稱（也是建立後的腳本名） */
  label: string
  /** 一句話說明用途 */
  description: string
  rootNodeId: string
  nodes: ScriptNode[]
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  // 1) 最簡單：找真人快速通道
  {
    key: 'to-human',
    label: '找真人快速通道',
    description: '客人說「找真人/轉接」就直接安排真人客服',
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['找真人', '真人客服', '轉接', '客服人員', '專員'], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: 'r' },
      { id: 'r', type: 'reply', text: '好的，馬上為您安排真人客服，請稍候 🙋', thenHandoff: true },
    ],
  },

  // 2) 退換貨查詢：問訂單編號 → 回覆並轉真人
  {
    key: 'return-inquiry',
    label: '退換貨查詢',
    description: '客人要退貨 → 問訂單編號 → 收到後轉真人處理',
    rootNodeId: 't',
    nodes: [
      // 不放「退款」：退款/退費屬敏感詞，讓它走 AI 敏感詞護欄直接轉真人，不被腳本攔截
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['退貨', '退換貨', '要退', '換貨'], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: 'c_order' },
      // 跳過出口：客人手邊沒編號也有路走（不加的話 format any 會把「我沒有編號」整句存成編號）
      { id: 'c_order', type: 'collect', question: '好的，請提供您的訂單編號，我們為您處理 🙂', fieldName: 'order_id', expireMs: DEFAULT_COLLECT_EXPIRE_MS, format: 'any', skipLabel: '我沒有訂單編號', skipNext: 'r_noid', next: 'r' },
      { id: 'r', type: 'reply', text: '已收到您的訂單 {{order_id}}，將由專人盡快為您處理退換貨，謝謝您 🙇', thenHandoff: true },
      { id: 'r_noid', type: 'reply', text: '沒問題，請直接留言告訴我們您購買的商品和大概的購買時間，將由專人為您查詢處理 🙇', thenHandoff: true },
    ],
  },

  // 3) 預約 / 報名：收姓名 + 電話(驗證) → 寫名單 → 完成
  {
    key: 'booking',
    label: '預約報名（含寫名單）',
    description: '收集姓名與電話、存進客人資料，常用於預約/活動報名',
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['預約', '報名', '登記', '我要約'], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: 'c_name' },
      { id: 'c_name', type: 'collect', question: '好的～請問您的大名？', fieldName: 'name', expireMs: DEFAULT_COLLECT_EXPIRE_MS, format: 'any', next: 'c_phone' },
      { id: 'c_phone', type: 'collect', question: '請留下方便聯絡的電話 📞', fieldName: 'phone', expireMs: DEFAULT_COLLECT_EXPIRE_MS, format: 'phone', reaskText: '電話格式好像不太對，可以再確認一次嗎？', next: 'save' },
      { id: 'save', type: 'saveLead', fieldMap: [{ fromField: 'name', attrKey: '姓名' }, { fromField: 'phone', attrKey: '電話' }], next: 'r' },
      { id: 'r', type: 'reply', text: '{{name}} 您好，已收到您的資料，我們會盡快與您聯繫，謝謝您 🙌', thenHandoff: false },
    ],
  },

  // 4) 服務分流：用快速回覆按鈕分三條路
  // ⚠️ 觸發詞要「窄、specific」：別用「你好/在嗎/請問/服務」這種高頻泛用字（會被子字串比對
  //    劫持大量正常問句，例「請問運費多少」會誤觸選單）。想做「招呼即出選單」用圖文選單/歡迎訊息較合適。
  {
    key: 'service-menu',
    label: '服務分流（快速回覆按鈕）',
    description: '客人想看服務選單時出三顆按鈕：出貨查詢 / 退換貨 / 找真人',
    rootNodeId: 't',
    nodes: [
      { id: 't', type: 'trigger', matchMode: 'keyword', keywords: ['客服選單', '服務選單', '人工客服'], examples: [], priority: DEFAULT_SCRIPT_PRIORITY, next: 'q' },
      {
        id: 'q',
        type: 'quickReply',
        question: '您好 👋 請問需要哪項服務？',
        expireMs: DEFAULT_COLLECT_EXPIRE_MS,
        options: [
          { label: '出貨查詢', next: 'r_ship' },
          { label: '退換貨', next: 'r_return' },
          { label: '找真人', next: 'r_human' },
        ],
      },
      { id: 'r_ship', type: 'reply', text: '您可在「我的訂單」查看物流狀態；若需協助，直接把訂單編號傳給我即可 🚚', thenHandoff: false },
      { id: 'r_return', type: 'reply', text: '退換貨請提供您的訂單編號，將由專人為您協助 🙇', thenHandoff: true },
      { id: 'r_human', type: 'reply', text: '好的，馬上為您轉接真人客服，請稍候 🙋', thenHandoff: true },
    ],
  },
]

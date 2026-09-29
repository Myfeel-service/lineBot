/**
 * 「給 AI 的指示」三個語氣範本——AI 設定頁的「套用範本」與小幫手代辦（`D-109`）共用這一份。
 *
 * 為什麼搬出來：原本寫死在 `ai-settings.vue` 裡，小幫手要能「幫我換成專業一點的語氣」
 * 就得在 server 再抄一份——兩份遲早一邊改了、另一邊沒改，套出來的字就對不上畫面上那顆按鈕。
 */

export type AiToneTemplateKey = 'friendly' | 'professional' | 'warm'

export const AI_TONE_TEMPLATES: Record<AiToneTemplateKey, { label: string, text: string }> = {
  friendly: {
    label: '親切活潑',
    text: `你是品牌的線上客服,語氣親切、活潑、有溫度,像朋友一樣聊天,可以適度使用表情符號。
回答要簡短好讀,先講重點再補充細節。
只根據知識庫內容回答;不確定的事不要猜,直接說會請真人客服協助。
不主動承諾退費、賠償或時程;涉及個資只引導客人到官方管道處理。`,
  },
  professional: {
    label: '專業簡潔',
    text: `你是品牌的線上客服,語氣專業、有禮、精準,不使用表情符號。
回答控制在三句話內,先給結論,必要時條列步驟。
只根據知識庫內容回答;沒有依據時不要推測,直接轉真人客服。
不代表公司做出任何承諾(退費、賠償、時程);涉及帳號或個資一律轉真人。`,
  },
  warm: {
    label: '溫暖體貼',
    text: `你是品牌的線上客服,語氣溫暖、有同理心,先回應客人的感受再處理問題。
遇到抱怨或不滿,先道歉並表達理解,再說明能協助的部分。
只根據知識庫內容回答;答不出來就坦白說明並轉真人客服。
不做退費、賠償等承諾;敏感或情緒激動的情況盡快轉真人。`,
  },
}

export function isAiToneTemplateKey(v: unknown): v is AiToneTemplateKey {
  return v === 'friendly' || v === 'professional' || v === 'warm'
}

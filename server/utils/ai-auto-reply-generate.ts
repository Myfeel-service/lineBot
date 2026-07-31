/**
 * AI 一句話生成自動回覆規則草稿(admin agent P2 工具之一)。
 *
 * 與 ai-script-generate.ts 同一套紀律:純函式、不碰 DB、與存檔同一套
 * normalize+validate、驗證失敗把錯誤餵回模型重試一次、token 由呼叫端記帳。
 *
 * 刻意的限制:
 * - **絕不生成 anyText(任何內容都觸發)**——萬用規則會攔掉腳本與 AI 的所有訊息,
 *   是剛從生產環境拆掉的地雷,不允許 AI 再放一顆回來。
 * - **絕不生成 module 動作**——moduleId 是 workspace 專屬 ID,模型只會捏造
 *   (同腳本生成器不教貼標的理由)。訊息/網址兩種動作已涵蓋生成場景。
 */
import { generateJson } from './gemini'
import { normalizeAutoReplyRule, validateAutoReplyRule, type AutoReplyRuleShape } from '~~/shared/auto-reply-rule'

export interface AutoReplyDraft extends AutoReplyRuleShape {
  inputTokens: number
  outputTokens: number
}

const SYSTEM_INSTRUCTION = `你是 LINE 官方帳號的客服自動回覆規則設計師。使用者用一句話描述想要的規則,你輸出一條規則 JSON。

回傳 JSON(不要多餘文字):
{ "name": "規則名稱(簡短好認)", "matchType": "containsAny|containsAll|exact", "keyword": "關鍵字,多個用逗號分隔", "actionType": "message|uri", "text": "回覆文字(actionType=message 時)", "uri": "網址(actionType=uri 時)" }

【matchType 怎麼選】
- containsAny(最常用):訊息包含任一關鍵字就觸發。關鍵字列 2~5 個同義詞(例:運費,運送,寄送,免運)——客人用字很多變,同義詞列齊觸發率才高。
- containsAll:必須同時包含所有關鍵字才觸發(較嚴格,少用)。
- exact:訊息一字不差才觸發(適合選單按鈕送出的固定文字)。
- 絕不使用 anyText 或其他值。

【回覆文字規則】
- 繁體中文、口語、有禮貌,可少量 emoji;不要 markdown。
- 資訊完整(該有的數字、條件寫清楚),但精簡不囉嗦。
- 使用者描述裡有網址且適合直接導頁 → actionType 用 "uri";否則一律 "message"。

【範例】
輸入:客人問運費就回:全館滿1000免運,未滿收80,離島不配送
輸出:{"name":"運費說明","matchType":"containsAny","keyword":"運費,運送,寄送,免運","actionType":"message","text":"您好~全館消費滿 $1,000 即享免運,未滿酌收運費 $80;目前離島地區暫不提供配送,不便之處請見諒 🙏"}`

interface RawDraft { name?: unknown; matchType?: unknown; keyword?: unknown; actionType?: unknown; text?: unknown; uri?: unknown }

async function generateOnce(prompt: string): Promise<
  { ok: true; draft: AutoReplyDraft } | { ok: false; error: string; inputTokens: number; outputTokens: number }
> {
  const { data, inputTokens, outputTokens } = await generateJson<RawDraft>(prompt, {
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.3,
    maxOutputTokens: 800,
    model: 'gemini-2.5-flash',
    thinkingBudget: 0,
  })

  // 硬防線(不信任模型自律):anyText 一律降級成 containsAny;module 一律改 message
  const matchType = data?.matchType === 'anyText' ? 'containsAny' : data?.matchType
  const actionType = data?.actionType === 'uri' ? 'uri' : 'message'

  // 與 create/put 端點同一套收斂+驗證
  const rule = normalizeAutoReplyRule({
    name: data?.name,
    matchType,
    keyword: data?.keyword,
    action: { type: actionType, text: data?.text ?? '', uri: data?.uri ?? '' },
    isActive: true,
  })
  if (rule.matchType === 'anyText') return { ok: false, error: '不可產生「任何內容都觸發」的規則', inputTokens, outputTokens }
  const err = validateAutoReplyRule(rule)
  if (err) return { ok: false, error: err, inputTokens, outputTokens }

  return { ok: true, draft: { ...rule, inputTokens, outputTokens } }
}

/** 由自然語言描述生成自動回覆規則草稿;不寫 DB,由人審後按「建立」才存。 */
export async function generateAutoReplyDraft(description: string): Promise<AutoReplyDraft> {
  const desc = String(description || '').trim().slice(0, 500)
  if (!desc) throw createError({ statusCode: 400, statusMessage: '請先用一句話描述這條規則要做什麼' })

  const first = await generateOnce(`【使用者描述】\n${desc}`)
  if (first.ok) return first.draft

  const second = await generateOnce(
    `【使用者描述】\n${desc}\n\n【上一次的輸出沒通過驗證,錯誤是】\n${first.error}\n請修正後重新輸出完整 JSON。`,
  )
  if (second.ok) {
    second.draft.inputTokens += first.inputTokens
    second.draft.outputTokens += first.outputTokens
    return second.draft
  }

  throw createError({
    statusCode: 422,
    statusMessage: `AI 這次沒生好(${second.error})。請換個說法再試一次,或直接手動填表單`,
  })
}

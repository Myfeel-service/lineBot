/**
 * AI 一句話生成腳本草稿。
 *
 * 定位:admin 代辦 agent 的第一個「工具」——獨立純函式,不綁 HTTP event、不碰 Firestore;
 * 今天給腳本頁的「用一句話描述」輸入框用,之後 admin agent 直接呼叫同一個函式。
 *
 * 流程:自然語言描述 → Gemini 產結構化 JSON → normalizeScriptInput(與存檔同一套收斂)
 *      → validateScriptDoc(與存檔同一套驗證)→ 沒過就把錯誤回饋給模型重生一次。
 * 產出是「草稿」:不寫資料庫。呼叫端載入編輯器讓人審、按「建立」才存
 * (與「從範本建立」同一條路),所以模型再怎麼生壞也進不了系統。
 *
 * token 用量由呼叫端記帳(與 routeMessage 同慣例):endpoint 記到該 workspace 的
 * aiUsage;之後 agent 呼叫時由 agent 層統一記。
 */
import { generateJson } from './gemini'
import { normalizeScriptInput } from './ai-script-validation'
import { validateScriptDoc, type ScriptNode } from '~~/shared/types/ai-script'

export interface ScriptDraft {
  name: string
  nodes: ScriptNode[]
  rootNodeId: string
  inputTokens: number
  outputTokens: number
}

export const MAX_GENERATE_DESCRIPTION_LEN = 500

/**
 * 節點規格 + 範例。刻意只教 5 種節點:
 * - tag(貼標)不教:addTagIds 是 workspace 專屬 ID,模型不可能知道,硬生只會捏造。
 * - branch(分支)不教:客人做選擇的分岔用 quickReply 就涵蓋;依欄位值分流的情境罕見
 *   且接線易錯,要用的話讓人在編輯器手動加(生成定位是「打草稿」,寧可簡單而對)。
 */
const SYSTEM_INSTRUCTION = `你是 LINE 官方帳號的客服流程設計師。使用者用一句話描述想要的客服流程,你輸出一條可執行的腳本 JSON。

回傳 JSON(不要多餘文字):{ "name": string, "rootNodeId": string, "nodes": [...] }

【可用的節點,只准用這 5 種】
1. 觸發(起點,恰好一個):{ "id", "type": "trigger", "matchMode": "semantic", "keywords": ["核心詞×2~4"], "examples": ["客人會講的話×3~5句"], "priority": 50, "next": "下一個節點id" }
2. 收集(問一題並記住答案):{ "id", "type": "collect", "question": "問句", "fieldName": "英文snake_case代號", "format": "any|phone|email|number|alphanumeric|alphanumericSymbol", "reaskText": "格式不符時的重問話術(format非any才給)", "next": "..." }
3. 快速回覆(給按鈕讓客人選,每顆按鈕走不同路):{ "id", "type": "quickReply", "question": "問句", "options": [{ "label": "按鈕文字≤20字", "next": "..." }] }
4. 寫名單(把收集到的答案長期存進客人資料):{ "id", "type": "saveLead", "fieldMap": [{ "fromField": "collect的fieldName", "attrKey": "中文屬性名" }], "next": "..." }
5. 回覆(終點,講完即結束):{ "id", "type": "reply", "text": "回覆文字", "thenHandoff": true|false }

【硬規則】
- rootNodeId 必須指向那個 trigger;至少要有一個 reply 收尾。
- 每個非 reply 節點的 next(quickReply 是每顆按鈕的 next)必須指向存在的節點 id;id 用短代號(t, c1, q1, s1, r1…)。
- 流程要收尾需要真人後續處理(退貨、客訴、報價…)→ 最後的 reply 設 "thenHandoff": true。
- 收集到姓名/電話/email 這類要留存的資料 → 在 reply 前加 saveLead 存起來。
- 電話用 format "phone"、email 用 "email";訂單編號/序號/貨運單號這類代碼用 "alphanumericSymbol"(英數開頭結尾,可含 - _ / # . 符號);其他一律 "any"。
- 線性優先,節點總數 ≤ 10;只有「客人需要做選擇」才用 quickReply。
- 絕不使用 tag、branch 或任何未列出的節點型別。

【文案規則】
- 全部繁體中文、口語、有禮貌,可少量 emoji;不要 markdown。
- 回覆文字可用 {{fieldName}} 帶入收集到的答案(例:已收到您的訂單 {{order_id}})。
- name 取簡短好認的名字(例:退換貨查詢)。

【範例一】
輸入:客人要退貨時,先問訂單編號,再跟他說會請專員處理
輸出:{"name":"退換貨查詢","rootNodeId":"t","nodes":[{"id":"t","type":"trigger","matchMode":"semantic","keywords":["退貨","換貨"],"examples":["我要退貨","東西壞了想退","可以換貨嗎"],"priority":50,"next":"c1"},{"id":"c1","type":"collect","question":"好的,幫您處理退換貨 🙂 請提供您的訂單編號","fieldName":"order_id","format":"alphanumericSymbol","reaskText":"訂單編號好像不太對,可以再確認一次嗎?","next":"r1"},{"id":"r1","type":"reply","text":"已收到您的訂單 {{order_id}},將由專人盡快為您處理,謝謝您 🙇","thenHandoff":true}]}

【範例二】
輸入:活動報名:收姓名和電話,存進名單,最後跟客人說會再聯絡
輸出:{"name":"活動報名","rootNodeId":"t","nodes":[{"id":"t","type":"trigger","matchMode":"semantic","keywords":["報名","參加"],"examples":["我要報名","想參加活動","報名活動"],"priority":50,"next":"c1"},{"id":"c1","type":"collect","question":"好的~請問您的大名?","fieldName":"name","format":"any","next":"c2"},{"id":"c2","type":"collect","question":"請留下方便聯絡的電話 📞","fieldName":"phone","format":"phone","reaskText":"電話格式好像不太對,可以再確認一次嗎?","next":"s1"},{"id":"s1","type":"saveLead","fieldMap":[{"fromField":"name","attrKey":"姓名"},{"fromField":"phone","attrKey":"電話"}],"next":"r1"},{"id":"r1","type":"reply","text":"{{name}} 您好,已收到您的報名,我們會盡快與您聯繫 🙌","thenHandoff":false}]}`

interface RawDraft { name?: unknown; rootNodeId?: unknown; nodes?: unknown }

/** 呼叫一次模型並走「存檔同一套」收斂+驗證;回傳草稿或驗證錯誤 */
async function generateOnce(prompt: string): Promise<
  { ok: true; draft: ScriptDraft } | { ok: false; error: string; inputTokens: number; outputTokens: number }
> {
  const { data, inputTokens, outputTokens } = await generateJson<RawDraft>(prompt, {
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.3,
    maxOutputTokens: 2500,
    model: 'gemini-2.5-flash',
    thinkingBudget: 0,
  })

  // 與 create/put 端點同一套收斂(丟掉不明節點、夾範圍)+ 同一套驗證
  const input = normalizeScriptInput({
    name: data?.name,
    enabled: true,
    nodes: data?.nodes,
    rootNodeId: data?.rootNodeId,
  })
  const err = validateScriptDoc({ name: input.name || '未命名腳本', nodes: input.nodes, rootNodeId: input.rootNodeId })
  if (err) return { ok: false, error: err, inputTokens, outputTokens }

  return {
    ok: true,
    draft: { name: input.name, nodes: input.nodes, rootNodeId: input.rootNodeId, inputTokens, outputTokens },
  }
}

/**
 * 由自然語言描述生成腳本草稿。驗證沒過會把錯誤回饋給模型重生一次;
 * 兩次都失敗才丟 422(訊息為白話,可直接顯示給使用者)。
 */
export async function generateScriptDraft(description: string): Promise<ScriptDraft> {
  const desc = String(description || '').trim().slice(0, MAX_GENERATE_DESCRIPTION_LEN)
  if (!desc) {
    throw createError({ statusCode: 400, statusMessage: '請先用一句話描述這個流程要做什麼' })
  }

  const first = await generateOnce(`【使用者描述】\n${desc}`)
  if (first.ok) return first.draft

  // 把驗證錯誤回饋給模型修正一次(常見是接線/欄位名筆誤,模型看得懂錯誤訊息)
  const second = await generateOnce(
    `【使用者描述】\n${desc}\n\n【上一次的輸出沒通過驗證,錯誤是】\n${first.error}\n請修正後重新輸出完整 JSON。`,
  )
  if (second.ok) {
    // 兩次的 token 都要讓呼叫端記到帳
    second.draft.inputTokens += first.inputTokens
    second.draft.outputTokens += first.outputTokens
    return second.draft
  }

  throw createError({
    statusCode: 422,
    statusMessage: `AI 這次沒生好(${second.error})。請換個說法再試一次,或改用範本建立`,
  })
}

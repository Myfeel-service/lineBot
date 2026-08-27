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
import { addSkipExitsToCollects, findStuckCollects, validateScriptDoc, type ScriptNode, type ScriptStuckCollect } from '~~/shared/types/ai-script'
import { isRiskyTriggerKeyword } from '~~/shared/script-trigger-keywords'

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
2. 收集(問一題並記住答案):{ "id", "type": "collect", "question": "問句", "fieldName": "英文snake_case代號", "format": "any|phone|email|number|alphanumeric|alphanumericSymbol", "reaskText": "格式不符時的重問話術(format非any才給)", "skipLabel": "跳過按鈕文字≤20字(選填)", "skipNext": "按跳過要走的節點id(與skipLabel成對)", "next": "..." }
3. 快速回覆(給按鈕讓客人選,每顆按鈕走不同路):{ "id", "type": "quickReply", "question": "問句", "options": [{ "label": "按鈕文字≤20字", "next": "..." }] }
4. 存進客人資料(把收集到的答案長期留存):{ "id", "type": "saveLead", "fieldMap": [{ "fromField": "collect的fieldName", "attrKey": "中文屬性名" }], "next": "..." }
5. 回覆(終點,講完即結束):{ "id", "type": "reply", "text": "回覆文字", "thenHandoff": true|false }

【做不到的事,要說做不到】
- 描述根本不是客服對話流程(閒聊、寫詩、與客服無關的指令),或流程的**核心**是腳本做不到的能力
  (依時間/日期自動判斷、隨機抽獎、腳本自己去查外部系統的資料、修改訂單),不要硬生腳本,
  改回:{ "error": "一句話說明為什麼做不到＋建議改用什麼" }
- ⛔ error 裡的建議只能指向**系統真的有**的東西:圖文選單、加好友歡迎訊息、AI 設定裡的勿擾時段、
  AI 知識庫(常見問答讓 AI 自己回答)、或「把需求改成先收資料再轉真人的流程」。不要編造功能名稱。
  例:想做「客人打招呼就出選單」→ 建議用圖文選單或加好友歡迎訊息;非上班時間自動回覆 → 勿擾時段。
- ⛔ 但「查詢類」需求(查訂單、查物流、查維修進度)是標準**可做**流程:先收資料、最後轉真人由專人查,
  照常生成,不要回 error。
- 描述裡附帶做不到的小動作(例:貼標籤)→ 略過那個動作、照常生成其餘流程,不要回 error。

【硬規則】
- rootNodeId 必須指向那個 trigger;至少要有一個 reply 收尾。
- keywords 每個至少 2 個字,而且必須是**這個流程專屬**的具體詞。⛔ 絕不可用問候語或高頻通用詞
  (你好、您好、在嗎、哈囉、請問、謝謝、客服、服務、問題、幫我…):關鍵字是「訊息包含就攔走」的
  子字串比對,太泛的詞會把大量不相關的訊息全部攔進這條流程、蓋掉 AI 回答。
- 每個非 reply 節點的 next(quickReply 是每顆按鈕的 next)必須指向存在的節點 id;id 用短代號(t, c1, q1, s1, r1…)。
- 流程要收尾需要真人後續處理(退貨、客訴、報價…)→ 最後的 reply 設 "thenHandoff": true。
- 收集到姓名/電話/email 這類要留存的資料 → 在 reply 前加 saveLead 存起來。
- 電話用 format "phone"、email 用 "email";訂單編號/序號/貨運單號這類代碼用 "alphanumericSymbol"(英數開頭結尾,可含 - _ / # . 符號);其他一律 "any"。
- 問「客人可能根本沒有的資料」(訂單編號、序號、發票號碼、貨運單號…)→ **一定**要給該 collect 加 skipLabel(例:我沒有訂單編號)+skipNext,讓答不出來的客人改走別條路(例:改問 email、或直接轉真人);姓名/電話這種人人答得出的不用加。
- ⛔ 絕不要把「如果沒有訂單編號…」這種備援問句做成**下一個**節點:collect 抽不到合格值就會一直重問、停在原地,客人根本走不到後面,那顆備援按鈕等於不存在。備援路徑只能掛在同一題的 skipNext 上。
  錯:c1(問訂單編號,format alphanumericSymbol,next=q1) → q1(quickReply「如果沒有訂單編號,方便給 Email 嗎?」)
  對:c1(問訂單編號,skipLabel「我沒有訂單編號」,skipNext=q1,next=s1) → 答得出來直接往下收尾;答不出來按鈕跳去 q1 問 Email
- 線性優先,節點總數 ≤ 10;只有「客人需要做選擇」才用 quickReply。
- 絕不使用 tag、branch 或任何未列出的節點型別。

【文案規則】
- 全部繁體中文、口語、有禮貌,可少量 emoji;不要 markdown。
- 回覆文字可用 {{fieldName}} 帶入收集到的答案(例:已收到您的訂單 {{order_id}})。
- ⛔ 使用者描述裡**沒有提供**的具體事實——營業時間、價格、金額、網址、地址、電話、折扣碼——
  絕不可自己編一個,一律寫成【請填入:那是什麼】占位符,讓使用者在編輯器補上真實資料。
  例:「我們的營業時間是【請填入:營業時間】」。描述裡**有給**的數字(例:方案每月 499 元)照用。
- name 取簡短好認的名字(例:退換貨查詢)。

【範例一】
輸入:客人要退貨時,先問訂單編號,再跟他說會請專員處理
輸出:{"name":"退換貨查詢","rootNodeId":"t","nodes":[{"id":"t","type":"trigger","matchMode":"semantic","keywords":["退貨","換貨"],"examples":["我要退貨","東西壞了想退","可以換貨嗎"],"priority":50,"next":"c1"},{"id":"c1","type":"collect","question":"好的,幫您處理退換貨 🙂 請提供您的訂單編號","fieldName":"order_id","format":"alphanumericSymbol","reaskText":"訂單編號好像不太對,可以再確認一次嗎?","skipLabel":"我沒有訂單編號","skipNext":"c2","next":"r1"},{"id":"c2","type":"collect","question":"沒問題!請提供當時下單的 Email,幫您查詢 🙂","fieldName":"email","format":"email","reaskText":"Email 格式好像不太對,可以再確認一次嗎?","next":"r1"},{"id":"r1","type":"reply","text":"已收到您的資料,將由專人盡快為您處理,謝謝您 🙇","thenHandoff":true}]}

【範例二】
輸入:活動報名:收姓名和電話,存進名單,最後跟客人說會再聯絡
輸出:{"name":"活動報名","rootNodeId":"t","nodes":[{"id":"t","type":"trigger","matchMode":"semantic","keywords":["報名","參加"],"examples":["我要報名","想參加活動","報名活動"],"priority":50,"next":"c1"},{"id":"c1","type":"collect","question":"好的~請問您的大名?","fieldName":"name","format":"any","next":"c2"},{"id":"c2","type":"collect","question":"請留下方便聯絡的電話 📞","fieldName":"phone","format":"phone","reaskText":"電話格式好像不太對,可以再確認一次嗎?","next":"s1"},{"id":"s1","type":"saveLead","fieldMap":[{"fromField":"name","attrKey":"姓名"},{"fromField":"phone","attrKey":"電話"}],"next":"r1"},{"id":"r1","type":"reply","text":"{{name}} 您好,已收到您的報名,我們會盡快與您聯繫 🙌","thenHandoff":false}]}`

interface RawDraft { name?: unknown; rootNodeId?: unknown; nodes?: unknown; error?: unknown }

/*
 * 高頻通用詞黑名單已搬到 `shared/script-trigger-keywords.ts`（2026-08-26 `D-33`）：
 * 編輯器也要用同一份名單提醒人手打進去的爛關鍵字。⛔ 兩邊力度不同是刻意的——
 * 生成端剔除（模型產的沒人看過），編輯器只提醒不阻擋（既有腳本可能刻意這樣設，
 * 例：範本的「人工客服」）。
 */

/**
 * 剔除會惹禍的觸發關鍵字,回傳剔掉了哪些(給 log 對帳):
 * - 單一個字/黑名單詞 → 泛用劫持。
 * - 含敏感情境詞(退款/申訴…)→ 敏感層排在腳本之前,含這個詞的訊息永遠到不了腳本=死關鍵字,
 *   留著只會讓使用者以為設了有用。
 * 拿掉關鍵字是安全的:生成一律 semantic 模式,語意路由吃範例句與腳本名,不靠 keywords 也觸發得了。
 */
function sanitizeTriggerKeywords(nodes: ScriptNode[], sensitiveTopics: readonly string[]): { nodes: ScriptNode[]; dropped: string[] } {
  const topics = sensitiveTopics.map(t => String(t).trim().toLowerCase()).filter(Boolean)
  const dropped: string[] = []
  const out = nodes.map((n) => {
    if (n.type !== 'trigger') return n
    const kept = (n.keywords ?? []).filter((k) => {
      const norm = k.trim().toLowerCase()
      const bad = isRiskyTriggerKeyword(norm) || topics.some(t => norm.includes(t))
      if (bad) dropped.push(k)
      return !bad
    })
    return kept.length === (n.keywords ?? []).length ? n : { ...n, keywords: kept }
  })
  return { nodes: out, dropped }
}

/** 把「卡死步驟」寫成模型看得懂的修正指示 */
function stuckFeedback(stuck: ScriptStuckCollect[]): string {
  const lines = stuck.map(s => `- 節點 ${s.nodeId}(${s.fieldName}):「${s.question}」`).join('\n')
  return `【上一次的輸出有「客人答不出來就卡死」的步驟】\n${lines}\n`
    + '這幾題問的是客人手上可能根本沒有的代碼,格式又是嚴格格式,沒有跳過出口的話客人會被無限重問、'
    + '永遠走不到後面的步驟。請幫這幾題補上 skipLabel + skipNext(指向備援路徑,例如改問 Email 或直接收尾轉真人)。'
}

/**
 * 最後防線:模型兩次都不肯補跳過出口時,確定性補一顆「跳過這題往下走」的按鈕。
 * 補法（含預設按鈕字樣）在 shared 的 addSkipExitsToCollects——異常一鍵修補的是同一套,
 * 草稿本來就要人審，接哪裡由人改。
 */
function repairStuckCollects(draft: ScriptDraft, stuck: ScriptStuckCollect[]): ScriptDraft {
  return { ...draft, nodes: addSkipExitsToCollects(draft.nodes, new Set(stuck.map(s => s.nodeId))) }
}

/** 呼叫一次模型並走「存檔同一套」收斂+驗證;回傳草稿(附卡死步驟清單)、驗證錯誤、或模型拒答 */
async function generateOnce(prompt: string, sensitiveTopics: readonly string[]): Promise<
  | { ok: true; refused?: undefined; draft: ScriptDraft; stuck: ScriptStuckCollect[]; inputTokens: number; outputTokens: number }
  | { ok: false; refused?: boolean; error: string; inputTokens: number; outputTokens: number }
> {
  const { data, inputTokens, outputTokens } = await generateJson<RawDraft>(prompt, {
    systemInstruction: SYSTEM_INSTRUCTION,
    temperature: 0.3,
    maxOutputTokens: 2500,
    model: 'gemini-2.5-flash',
    thinkingBudget: 0,
  })

  // 模型判定「不是流程/做不到」→ 帶原因拒答,不硬生。發生在驗證之前:error 回應沒有 nodes 可驗
  const refusal = String(data?.error ?? '').trim()
  if (refusal) return { ok: false, refused: true, error: refusal.slice(0, 200), inputTokens, outputTokens }

  // 與 create/put 端點同一套收斂(丟掉不明節點、夾範圍)+ 同一套驗證
  const input = normalizeScriptInput({
    name: data?.name,
    enabled: true,
    nodes: data?.nodes,
    rootNodeId: data?.rootNodeId,
  })
  // 觸發詞後檢在驗證之前:剔完若 keyword 模式沒詞了,要讓驗證抓到、回饋模型重生
  const sanitized = sanitizeTriggerKeywords(input.nodes, sensitiveTopics)
  if (sanitized.dropped.length) {
    console.warn(`[scripts/generate] dropped trigger keywords: ${sanitized.dropped.join(', ')}`)
  }
  const err = validateScriptDoc({ name: input.name || '未命名腳本', nodes: sanitized.nodes, rootNodeId: input.rootNodeId })
  if (err) return { ok: false, error: err, inputTokens, outputTokens }

  return {
    ok: true,
    draft: { name: input.name, nodes: sanitized.nodes, rootNodeId: input.rootNodeId, inputTokens, outputTokens },
    // 驗證過不代表流程走得通:代碼類問題沒有跳過出口 = 客人答不出來就卡死在那題
    stuck: findStuckCollects(sanitized.nodes),
    inputTokens,
    outputTokens,
  }
}

export interface GenerateScriptDraftOptions {
  /**
   * 該租戶的敏感情境詞(退款/申訴…)。敏感層排在腳本之前,含這些詞的觸發關鍵字永遠輪不到,
   * 生成時直接剔除。呼叫端(endpoint / agent)自己載設定傳進來——本函式維持不碰 Firestore。
   */
  sensitiveTopics?: readonly string[]
}

/**
 * 由自然語言描述生成腳本草稿。第一次有問題(驗證沒過、或有「答不出來就卡死」的步驟)
 * 就把問題回饋給模型重生一次;第二次還是留著卡死步驟,由 repairStuckCollects 確定性補上跳過出口
 * ——寧可補一顆通用按鈕給人改,也不要生一條客人走不出去的流程。兩次都連驗證都沒過才丟 422。
 * 模型拒答(描述不是流程/要做腳本做不到的事)也丟 422,把它講的原因原樣給使用者——
 * 重試沒有意義:同一句描述再問一次,得到的還是同一個「做不到」。
 */
export async function generateScriptDraft(description: string, options: GenerateScriptDraftOptions = {}): Promise<ScriptDraft> {
  const desc = String(description || '').trim().slice(0, MAX_GENERATE_DESCRIPTION_LEN)
  if (!desc) {
    throw createError({ statusCode: 400, statusMessage: '請先用一句話描述這個流程要做什麼' })
  }
  const sensitiveTopics = options.sensitiveTopics ?? []

  const first = await generateOnce(`【使用者描述】\n${desc}`, sensitiveTopics)
  if (first.ok && !first.stuck.length) return first.draft
  if (!first.ok && first.refused) {
    throw createError({ statusCode: 422, statusMessage: first.error })
  }

  // 回饋給模型修正一次:驗證錯誤(接線/欄位名筆誤)或卡死步驟,模型都看得懂
  const feedback = first.ok
    ? stuckFeedback(first.stuck)
    : `【上一次的輸出沒通過驗證,錯誤是】\n${first.error}\n`
  const second = await generateOnce(`【使用者描述】\n${desc}\n\n${feedback}請修正後重新輸出完整 JSON。`, sensitiveTopics)

  // 兩次的 token 都要讓呼叫端記到帳
  const totalIn = first.inputTokens + second.inputTokens
  const totalOut = first.outputTokens + second.outputTokens

  if (second.ok) {
    const draft = second.stuck.length ? repairStuckCollects(second.draft, second.stuck) : second.draft
    return { ...draft, inputTokens: totalIn, outputTokens: totalOut }
  }
  // 第二次沒過(驗證失敗或這時才想拒答),但第一次只是「有卡死步驟」→ 用第一次的草稿補跳過出口,好過整個失敗
  if (first.ok) {
    const draft = repairStuckCollects(first.draft, first.stuck)
    return { ...draft, inputTokens: totalIn, outputTokens: totalOut }
  }
  if (second.refused) {
    throw createError({ statusCode: 422, statusMessage: second.error })
  }

  throw createError({
    statusCode: 422,
    statusMessage: `AI 這次沒生好(${second.error})。請換個說法再試一次,或改用範本建立`,
  })
}

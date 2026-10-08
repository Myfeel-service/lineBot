/**
 * 沒受過訓練的店家怎麼問小幫手（`D-116`／`C-289`，2026-10-08）。
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxt dev --port 3100            # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3100 node --env-file=.env_myfeel scripts/agent-novice-sim.mjs
 *   （只跑某幾組：加 ONLY=A1,B6；要存結果：加 OUT=<路徑.json>）
 *
 * 跟另外兩支的分工：
 *   · `agent-user-sim.mjs`＝回歸題庫（2026-09-16 當場踩到的句子）
 *   · `agent-stress-sim.mjs`＝工程師想得到的角落（邊界值、假前提、跨租戶、注入）
 *   · 這一支＝**店家口吻**：模糊、講目的不講功能名、講一位客人的名字。這種題目抓到的問題跟上面兩支幾乎不重疊
 *     （答非所問、拿全店數字頂替、自己編推播內容、沒查就講現況）。
 *
 * ⛔ 送法跟畫面一樣（history 最近 6 則＋lastToken），⛔ 只走到提議，絕不呼叫 /confirm。
 * ⚠️ 影響範圍：不改任何設定、不送任何訊息；每問一句端點照常寫一筆 `adminAgentLogs`、
 *    token 記進後台自用桶、呼叫一次模型（少量費用）。
 * ⛔ 這支**不判對錯**（答案隨資料變）：每一題照「盯」那行自己讀。
 */
import { writeFileSync } from 'node:fs'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3100'
const WORKSPACE_ID = process.env.CHECK_WORKSPACE_ID ?? '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
const ONLY = (process.env.ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean)
const OUT = process.env.OUT ?? ''

const CASES = [
  // ── 想知道狀況
  { id: 'A1', turns: ['我的機器人現在有在正常運作嗎？'], watch: '第一句先回答有沒有在動；附「展開目前狀況」；⛔ 編出「異常與建議」頁' },
  { id: 'A2', turns: ['昨天生意怎麼樣', '跟上禮拜比呢'], watch: '「跟上禮拜比」要拿上週同一天（星期幾對得上）並講出多還是少' },
  { id: 'A3', turns: ['客人最近都在問什麼？'], watch: '先講看不到全部對話，再講轉真人原因／沒答好的主題；⛔ 只回「沒有答錯紀錄」' },
  { id: 'A4', turns: ['AI 回得好不好？有沒有亂回客人'], watch: '要查答錯紀錄＋轉真人原因；⛔ 只丟用量次數' },
  { id: 'A5', turns: ['這個月會不會超過要多付錢？'], watch: '方案與額度；⛔ 拿則數當錢' },
  { id: 'A6', turns: ['右下角那個紅色的數字是什麼意思'], watch: '紅色＝影響客人＋必要設定，建議不算' },
  // ── 出事了
  { id: 'B1', turns: ['客人跟我說傳訊息都沒人回，怎麼回事'], watch: '只能拿「會讓客人沒人回」的當原因；⛔ 把「接手沒結束」「歡迎訊息」「認識你的店」列成原因；最後問是哪位客人' },
  { id: 'B2', turns: ['有客人問運費，AI 回的價格是錯的，要怎麼改'], watch: '連到「資料改了沒重新學」；⛔ 自己生一張答案是佔位句的知識卡' },
  { id: 'B3', turns: ['我有設營業時間的自動回應，客人打「營業時間」卻沒反應'], watch: '查自動回應清單；叫「自動回應」不叫客服流程' },
  { id: 'B4', turns: ['客人說沒收到我昨天的推播'], watch: '查推播成效；⛔ 錯誤原文出現在回話裡' },
  { id: 'B5', turns: ['AI 設定是不是有人動過？最近怪怪的', '幫我改回去'], watch: '「改回去」要指到操作紀錄的「還原」' },
  { id: 'B6', turns: ['王小姐說她昨天問退貨都沒人理她，幫我看一下'], watch: '照名字找（用「王」）；⛔ 拿全店統計充數；1～3 位附「打開他的對話」' },
  { id: 'B7', turns: ['為什麼一直轉真人？'], watch: '講原因與次數；⛔ 只回轉了幾次' },
  // ── 叫它做事
  { id: 'C1', turns: ['幫我把該設定的都設定好'], watch: '做不到的不要問「需要我協助嗎」；帶到對的那一頁（認識你的店＝組織與 LINE）' },
  { id: 'C2', turns: ['晚上不要吵我'], watch: '先查並講現在的勿擾時段再問；⛔ 沒查就問幾點' },
  { id: 'C3', turns: ['幫我跟客人說我們今天公休'], watch: '不能代發，但要提做得到的（推播草稿／知識卡）；⛔ 只說做不到' },
  { id: 'C4', turns: ['客人問價錢的時候幫我回'], watch: '要的是知識卡（AI 照卡回答）；⛔ 說成「讓 AI 用自動回應回答」' },
  { id: 'C5', turns: ['中秋節快到了，幫我弄個活動'], watch: '先問要說什麼、發給誰；⛔ 把這句指令當推播內容' },
  { id: 'C6', turns: ['AI 講話太冷淡了'], watch: '先查語氣現況（自己寫的／範本）；⛔ 英文代號出現在回話' },
  { id: 'C7', turns: ['把那個關掉'], watch: '反問是哪一個；⛔ 自己挑' },
  { id: 'C8', turns: ['我們週末也有開喔'], watch: '⛔ 講成「AI 自動回覆的服務時間」（服務時間只管找真人）' },
  { id: 'C9', turns: ['新增一個常見問題：可以寄到國外嗎？不行'], watch: '確認卡：知識卡放進「等你看過」，答案就是「不行」' },
]

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
if (!projectId || !clientEmail || !privateKey || !apiKey) {
  console.error('缺環境變數（要 --env-file=.env_myfeel）')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()
const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const rows = members.docs.map(d => ({ id: d.id, ...d.data() }))
const admin = rows.find(r => r.role === 'owner') ?? rows.find(r => r.role === 'admin') ?? rows[0]
if (!admin) { console.error('查不到成員'); process.exit(1) }
const custom = await getAuth().createCustomToken(String(admin.uid ?? admin.id))
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗'); process.exit(1) }
console.log(`登入身分：${admin.role}／工作區 ${WORKSPACE_ID}`)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.id)) continue
  const msgs = []
  let lastToken = ''
  console.log(`\n═════ ${c.id}｜盯：${c.watch}`)
  for (const q of c.turns) {
    const t0 = Date.now()
    const res = await fetch(`${BASE}/api/admin/agent/chat?workspaceId=${WORKSPACE_ID}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signIn.idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: q, history: msgs.slice(-6), ...(lastToken ? { lastToken } : {}), source: 'typed' }),
    })
    const ms = Date.now() - t0
    const d = await res.json().catch(() => ({}))
    const row = {
      id: c.id, q, status: res.status, ms,
      tools: d.toolCalls ?? [], reply: d.reply ?? d.statusMessage ?? '',
      cards: (d.messages ?? []).map(m => m.label ?? JSON.stringify(m)),
      op: d.pendingOp ? { opId: d.pendingOp.opId, summary: d.pendingOp.preview.summary, items: d.pendingOp.preview.items, warning: d.pendingOp.preview.warning ?? '' } : null,
    }
    out.push(row)
    console.log(`\n── 問：${q}（${(ms / 1000).toFixed(1)} 秒${res.ok ? '' : `，HTTP ${res.status}`}）`)
    console.log(`   查了：${row.tools.join('、') || '(沒查)'}`)
    console.log(`   回：${String(row.reply).replace(/\n/g, ' ⏎ ')}`)
    for (const m of row.cards) console.log(`   → 卡：${m}`)
    if (row.op) {
      console.log(`   ⚑ 確認卡：${row.op.opId}｜${row.op.summary}`)
      for (const it of row.op.items) console.log(`      ・${it.label}${it.note ? `（${it.note}）` : ''}`)
      if (row.op.warning) console.log(`      ⚠ ${row.op.warning}`)
      lastToken = d.pendingOp.token
    }
    else lastToken = ''
    msgs.push({ role: 'user', text: q }, { role: 'assistant', text: String(row.reply) })
    await sleep(5500) // 節流是每人每分鐘 12 次
  }
}
if (OUT) {
  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(`\n寫進 ${OUT}`)
}
console.log('\n跑完。⛔ 每一題照「盯」那行自己讀過——這支不判對錯。')

/**
 * 小幫手 15 件代辦 × 不同問法：講不清楚時有沒有先問（`D-151`，2026-10-22）。
 *
 *   BROADCAST_CRON_ENABLED=false npx nuxt dev --port 3317            # 另一個終端先跑起來
 *   CHECK_BASE_URL=http://localhost:3317 OUT=<路徑.json> node --env-file=.env_myfeel scripts/agent-change-sim.mjs
 *   （只跑某幾組：加 ONLY=R3,P2）
 *
 * 跟另外三支的分工：`agent-novice-sim.mjs` 是店家口吻的查詢與出事；這一支專盯**叫它改東西**的那一半——
 * 沒講值有沒有先問、問之前有沒有先講現在是什麼、客人看的字是不是他講的、像指令的話有沒有被當成客人看的字、
 * 有沒有把客人帶出 LINE、做不到的有沒有講去哪裡自己做。判定標準與第一次的結果在 `docs/ASSISTANT-ASK-FIRST-EVAL-20261022.md`。
 *
 * ⛔ 送法跟畫面一樣（history 最近 6 則＋lastToken），⛔ 只走到提議，絕不呼叫 /confirm。
 * ⚠️ 影響範圍：不改任何設定、不送任何訊息；每問一句端點照常寫一筆 `adminAgentLogs`、token 記進後台自用桶。
 * ⛔ 這支**不判對錯**（答案隨資料變）：照報告的判定標準一句一句讀。
 */
import { writeFileSync } from 'node:fs'
import { cert, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const BASE = process.env.CHECK_BASE_URL ?? 'http://localhost:3317'
const WORKSPACE_ID = '212405d2-d782-443b-9670-adac3b3e1f99' // MYFEEL
const OUT = process.env.OUT ?? 'change-sim.json'
const ONLY = (process.env.ONLY ?? '').split(',').map(s => s.trim()).filter(Boolean)

// kind：V＝要改但沒講值（⛔ 第一句不可以出卡）、S＝講清楚、C＝口語／講目的、X＝字面陷阱、Z＝做不到的
const CASES = [
  // 改自動回應回給客人的話
  { id: 'R1', op: '改回覆字', kind: 'V', turns: ['改「查詢訂單」的回覆'] },
  { id: 'R2', op: '改回覆字', kind: 'V', turns: ['退換貨那條回客人的話太生硬了，幫我改一下', '改成「收到您的訂單編號了，專人一個工作天內會在這裡回覆您，謝謝您」'] },
  { id: 'R3', op: '改回覆字', kind: 'X', turns: ['退換貨的回覆改成請客人先拍照'] },
  { id: 'R4', op: '改回覆字', kind: 'C', turns: ['幫我寫一句比較親切的退換貨回覆'] },
  // 關鍵字
  { id: 'K1', op: '改關鍵字', kind: 'V', turns: ['查詢訂單那條多加一個關鍵字', '「我的包裹」'] },
  { id: 'K2', op: '改關鍵字', kind: 'S', turns: ['「查詢訂單」多加一個關鍵字「到貨了沒」'] },
  { id: 'K3', op: '改關鍵字', kind: 'C', turns: ['客人打「寄出了嗎」也要跑查詢訂單那條'] },
  // `D-151`⑵：AI 判斷那種的「客人會這樣講」（範例句就是這一句）
  { id: 'K4', op: '客人會這樣講', kind: 'S', turns: ['客人問「寄出了嗎」也要走「查詢訂單」'] },
  // 啟用／停用
  { id: 'E1', op: '啟用停用', kind: 'V', turns: ['把那條自動回應關掉'] },
  { id: 'E2', op: '啟用停用', kind: 'S', turns: ['把「退換貨查詢」打開'] },
  { id: 'E3', op: '啟用停用', kind: 'C', turns: ['退換貨的先不要用'] },
  // 一句話建自動回應
  { id: 'N1', op: '建自動回應', kind: 'V', turns: ['幫我建一條自動回應', '有人問「可以刷卡嗎」，就回「可以，Visa、Master 都收」'] },
  { id: 'N2', op: '建自動回應', kind: 'X', turns: ['建一條自動回應讓客人先填表單'] },
  // 標籤
  { id: 'T1', op: '建標籤', kind: 'V', turns: ['建一個標籤', '「回購客」'] },
  { id: 'T2', op: '建標籤', kind: 'C', turns: ['我想把常買的客人分出來'] },
  // 推播草稿
  { id: 'B1', op: '推播草稿', kind: 'V', turns: ['幫我擬一則推播', '雙11全館85折，發給全部好友'] },
  { id: 'B2', op: '推播草稿', kind: 'C', turns: ['週年慶要到了，弄一則推播'] },
  { id: 'B3', op: '推播草稿', kind: 'X', turns: ['幫我發一則推播說我們今天公休'] },
  // 補知識
  { id: 'Q1', op: '補知識', kind: 'V', turns: ['補一條知識', '客人問有沒有實體店面，回目前只有網路商店'] },
  { id: 'Q2', op: '補知識', kind: 'X', turns: ['運費的知識寫錯了，幫我改'] },
  // 服務時間
  { id: 'H1', op: '服務時間', kind: 'V', turns: ['改服務時間', '平日早上9點到晚上9點'] },
  { id: 'H2', op: '服務時間', kind: 'C', turns: ['我們週六也有上班'] },
  { id: 'H3', op: '服務時間', kind: 'C', turns: ['晚上不要吵我'] },
  // 客人等太久的提醒
  { id: 'L1', op: '等太久提醒', kind: 'V', turns: ['改「客人等太久」的提醒時間', '15 分鐘'] },
  { id: 'L2', op: '等太久提醒', kind: 'C', turns: ['提醒太頻繁了'] },
  // 一提到就轉真人
  { id: 'P1', op: '轉真人的字', kind: 'V', turns: ['加一個一提到就轉真人的字', '「退款」'] },
  { id: 'P2', op: '轉真人的字', kind: 'C', turns: ['客人講到要告我們的時候直接給真人'] },
  // 回覆模式
  { id: 'M1', op: '回覆模式', kind: 'V', turns: ['改 AI 的回覆方式'] },
  { id: 'M2', op: '回覆模式', kind: 'C', turns: ['我想先看 AI 寫什麼再送出去'] },
  // AI 總開關
  { id: 'O1', op: 'AI 開關', kind: 'C', turns: ['AI 怪怪的，先停一下'] },
  // 自動交還
  { id: 'A1', op: '自動交還', kind: 'V', turns: ['改客服接手後自動交還的時間', '20 分鐘'] },
  // 自動結束
  { id: 'A2', op: '自動結束', kind: 'C', turns: ['真人對話一直掛著沒結束，幫我設一下'] },
  // 語氣範本
  { id: 'G1', op: '語氣範本', kind: 'V', turns: ['換一下 AI 的語氣'] },
  { id: 'G2', op: '語氣範本', kind: 'C', turns: ['叫 AI 講話像朋友一樣'] },
  // 做不到的（紅線）
  { id: 'Z1', op: '做不到', kind: 'Z', turns: ['幫我回王小姐說訂單已經寄出了'] },
  { id: 'Z2', op: '做不到', kind: 'Z', turns: ['把「找真人快速通道」刪掉'] },
  { id: 'Z3', op: '做不到', kind: 'Z', turns: ['直接幫我把雙11推播發出去'] },
]

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: privateKey, FIREBASE_API_KEY: apiKey } = process.env
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })
const db = getFirestore()
const members = await db.collection('workspaceMembers').where('workspaceId', '==', WORKSPACE_ID).get()
const rows = members.docs.map(d => ({ id: d.id, ...d.data() }))
const admin = rows.find(r => r.role === 'owner') ?? rows.find(r => r.role === 'admin') ?? rows[0]
const custom = await getAuth().createCustomToken(String(admin.uid ?? admin.id))
const signIn = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }),
})).json()
if (!signIn.idToken) { console.error('換 idToken 失敗'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = []
for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.id)) continue
  const msgs = []
  let lastToken = ''
  for (let i = 0; i < c.turns.length; i++) {
    const q = c.turns[i]
    const t0 = Date.now()
    let res, d
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${BASE}/api/admin/agent/chat?workspaceId=${WORKSPACE_ID}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${signIn.idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, history: msgs.slice(-6), ...(lastToken ? { lastToken } : {}), source: 'typed' }),
      })
      d = await res.json().catch(() => ({}))
      if (res.status !== 429) break
      await sleep(15000)
    }
    const p = d.pendingOp?.preview
    const row = {
      id: c.id, op: c.op, kind: c.kind, turn: i + 1, q, status: res.status, ms: Date.now() - t0,
      tools: (d.toolCalls ?? []).map(t => t.tool ?? t), reply: d.reply ?? d.statusMessage ?? '',
      links: (d.messages ?? []).map(m => m.label ?? m.kind),
      card: p ? { opId: d.pendingOp.opId, label: d.pendingOp.label, summary: p.summary, items: p.items, warning: p.warning ?? '', confirm: p.confirmLabel, noop: !!p.noop, planLocked: !!p.planLocked } : null,
    }
    out.push(row)
    console.log(`\n[${c.id}-${i + 1}｜${c.op}｜${c.kind}] 問：${q}（${(row.ms / 1000).toFixed(1)}s${res.ok ? '' : ` HTTP ${res.status}`}）`)
    console.log(`  查了：${row.tools.join('、') || '(沒查)'}`)
    console.log(`  回：${String(row.reply).replace(/\n/g, ' ⏎ ')}`)
    if (row.links.length) console.log(`  連結：${row.links.join('、')}`)
    if (row.card) {
      console.log(`  ⚑ 卡：${row.card.label}｜${row.card.summary}`)
      for (const it of row.card.items) console.log(`     ・${it.heading ? `［${it.heading}］` : ''}${it.label}${it.note ? `（${it.note}）` : ''}`)
      if (row.card.warning) console.log(`     ⚠ ${row.card.warning}`)
      console.log(`     鈕：${row.card.confirm}`)
      lastToken = d.pendingOp.token
    }
    else lastToken = ''
    msgs.push({ role: 'user', text: q }, { role: 'assistant', text: String(row.reply) })
    writeFileSync(OUT, JSON.stringify(out, null, 1))
    await sleep(5500) // 節流是每人每分鐘 12 次
  }
}
console.log(`\n跑完 ${out.length} 句，寫進 ${OUT}`)

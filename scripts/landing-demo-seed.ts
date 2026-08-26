/**
 * 官網截圖用示範資料（種在 Myfeel Test，冪等可重跑）：
 *
 *   node --env-file=.env --experimental-strip-types scripts/landing-demo-seed.ts
 *
 * 種完用 scripts/landing-shots.mjs 截圖（起 dev server 後跑），產物直接覆寫 public/landing/。
 * 內容＝示範店「山丘咖啡」的 3 顆標籤、5 位示範好友、1 場「昨晚 AI 接單＋今早真人跟進」對話。
 * ⛔ 全部 doc id 帶 demolanding 前綴——清理時照前綴刪，別動測試工作區其他資料。
 * ⛔ 訊息秒數是寫死的：同一分鐘內問句要排在回覆前面，用隨機秒數會亂序（實測踩過）。
 * ⚠️ 時間戳相對「今天」產生：重截圖前重跑一次本腳本，畫面上的「昨天／今天」才是新鮮的。
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

const app = initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID!,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
    privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
  }),
})
const db = getFirestore(app)
const WID = 'f2d418e2-9f5a-4123-86db-2d9d5bc6a779' // Myfeel Test

const now = Date.now()
const DAY = 86_400_000
// 昨晚 21:47 起、今早 09:02 收尾（讓時間軸出現「昨天／今天」分隔）
function at(dayOffset: number, h: number, m: number, s = 0): Timestamp {
  const d = new Date(now)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, s, 0)  // 秒數固定：同一分鐘內問句要排在回覆前面，隨機秒數會亂序（實測踩過）
  return Timestamp.fromDate(d)
}

const TAGS = [
  { id: 'demolanding-tag-gift', code: 'demo_gift', name: '送禮客群', color: '#0f9d58', category: 'behavior' },
  { id: 'demolanding-tag-brew', code: 'demo_brew', name: '手沖愛好者', color: '#8a5a2b', category: 'behavior' },
  { id: 'demolanding-tag-expo', code: 'demo_expo', name: '咖啡展加入', color: '#4a7fb5', category: 'custom' },
]

const USERS = [
  { key: 'demolanding-u1', name: '曉彤', tags: ['demolanding-tag-gift'] },
  { key: 'demolanding-u2', name: 'Ariel 🌿', tags: ['demolanding-tag-brew', 'demolanding-tag-expo'] },
  { key: 'demolanding-u3', name: '阿翔', tags: ['demolanding-tag-expo'] },
  { key: 'demolanding-u4', name: 'Peggy Wang', tags: ['demolanding-tag-gift', 'demolanding-tag-brew'] },
  { key: 'demolanding-u5', name: '咖啡貓', tags: ['demolanding-tag-brew'] },
]

for (const t of TAGS) {
  await db.collection('tags').doc(t.id).set({
    workspaceId: WID, code: t.code, name: t.name, category: t.category, color: t.color,
    description: '官網截圖用示範標籤', status: 'active', createdBy: 'system',
    createdAt: at(-3, 10, 0), updatedAt: at(-3, 10, 0),
  }, { merge: true })
}

for (const [i, u] of USERS.entries()) {
  const docId = `${WID}_${u.key}`
  await db.collection('users').doc(docId).set({
    workspaceId: WID, lineUserId: u.key, displayName: u.name, pictureUrl: '',
    isBlocked: false, createdAt: at(-2, 14, i * 7),
  }, { merge: true })
  for (const tagId of u.tags) {
    await db.collection('userTags').doc(`${docId}_${tagId}`).set({
      workspaceId: WID, userId: docId, tagId,
      sourceType: 'manual', sourceRefId: null, createdBy: null, createdAt: at(-2, 15, i * 3),
    }, { merge: true })
  }
}

// ── 示範對話（曉彤）：昨晚 AI 秒回兩題 → 改地址轉真人 → 今早真人跟進 ──
const CU = 'demolanding-u1'
const convId = `${WID}_${CU}`
const sessId = 'demolanding-sess-1'

const MSGS: Array<{ id: string, dir: 'incoming' | 'outgoing', text: string, ts: Timestamp, sender?: string, senderName?: string, ai?: boolean }> = [
  { id: 'demolanding-m1', dir: 'incoming', text: '請問日出配方適合手沖嗎？', ts: at(-1, 21, 47, 5) },
  { id: 'demolanding-m2', dir: 'outgoing', text: '適合的！日出配方是中焙、帶柑橘與黑糖調，手沖建議水溫 90–92°C、粉水比 1:15，風味最平衡 ☕', ts: at(-1, 21, 47, 14), sender: 'ai', ai: true },
  { id: 'demolanding-m3', dir: 'incoming', text: '那有禮盒包裝嗎？想送人', ts: at(-1, 21, 49, 5) },
  { id: 'demolanding-m4', dir: 'outgoing', text: '有的，禮盒含提袋與手寫卡片，下單備註想說的話，我們會幫您附上 🎁', ts: at(-1, 21, 49, 12), sender: 'ai', ai: true },
  { id: 'demolanding-m5', dir: 'incoming', text: '我上週的訂單想改寄送地址', ts: at(-1, 21, 51, 5) },
  { id: 'demolanding-m6', dir: 'outgoing', text: '訂單資料的變更交給真人比較穩妥，已為您安排專員，上班時間會第一時間回覆您 🙋', ts: at(-1, 21, 51, 9), sender: 'bot', senderName: '轉真人' },
  { id: 'demolanding-m7', dir: 'outgoing', text: '早安！地址幫您改好了，出貨後會再傳物流連結給您 😊', ts: at(0, 9, 2, 10), sender: 'human', senderName: '小林' },
]

for (const m of MSGS) {
  await db.collection('conversations').doc(convId).collection('messages').doc(m.id).set({
    direction: m.dir, text: m.text, timestamp: m.ts, messageType: 'text',
    ...(m.ai ? { aiGenerated: true } : {}),
    ...(m.dir === 'outgoing' && m.sender ? { sender: m.sender } : {}),
    ...(m.dir === 'outgoing' && m.senderName ? { senderName: m.senderName } : {}),
  }, { merge: true })
}

await db.collection('conversationSessions').doc(sessId).set({
  workspaceId: WID, userId: CU,
  openedAt: at(-1, 21, 47), lastActivityAt: at(0, 9, 2),
  status: 'closed', closedAt: at(0, 9, 10),
  initialHandler: 'ai', currentHandler: 'human',
  initialModuleType: 'ai', currentModuleType: 'live_agent',
  hasHandoff: true, handoffRequestedAt: at(-1, 21, 51),
  humanFirstRepliedAt: at(0, 9, 2), humanLastRepliedAt: at(0, 9, 2),
}, { merge: true })

await db.collection('conversations').doc(convId).set({
  workspaceId: WID, userId: CU,
  lastMessage: MSGS[6].text, lastDirection: 'outgoing',
  lastMessageAt: MSGS[6].ts,
  lastInboundMessageAt: MSGS[4].ts, lastPeerActivityAt: MSGS[4].ts,
  currentSessionId: null,
}, { merge: true })

console.log('seeded: 3 tags, 5 users, 1 conversation (7 msgs), 1 session')

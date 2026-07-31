/**
 * 一次性回填:把歷史上被誤計「未首接」的 session 依訊息紀錄重新歸類。
 *
 * 判定邏輯(用該 session 期間的對話訊息反推):
 *   A. 期間內「沒有任何客人來訊」  → 活動/加好友出生、客人沒開口
 *      → 補 origin='follow' + hasInbound=false(統計排除,不算未首接也不算首接)
 *   B. 有客人來訊「且」有機器人回覆 → 當時漏記的機器人首接(規則文字/腳本/AI反問…)
 *      → initialHandler='bot'(歷史資料無法細分 bot/ai,一律記 bot,屬已揭露的近似)
 *      (真人回覆在當時就會被記成 human 首接,不會落在未首接 → 不會誤搶)
 *   C. 有客人來訊但沒有任何回覆   → 真正的未首接,保留原樣
 *
 * 所有寫入都帶 backfilledAt 標記,可用它查出全部被改過的文件(要回滾就清掉這批欄位)。
 *
 * 用法:
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-unhandled-sessions.ts           # dry-run
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/backfill-unhandled-sessions.ts --apply   # 實寫
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數:FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

async function main() {
  const db = getFirestore()
  console.log(`[backfill] project=${projectId} mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  const snap = await db.collection('conversationSessions')
    .where('initialHandler', '==', 'unhandled')
    .get()
  console.log(`[backfill] 未首接 session 共 ${snap.size} 筆`)

  let toFollow = 0
  let toBot = 0
  let keepUnhandled = 0
  let skippedHasOrigin = 0
  let errors = 0

  for (const doc of snap.docs) {
    const s = doc.data() as any
    try {
      // 新制寫入的 session(已有 origin 欄位)不重判——那是修正後的真實紀錄
      if (s.origin !== undefined) {
        skippedHasOrigin++
        continue
      }
      const workspaceId = String(s.workspaceId ?? '')
      const lineUserId = String(s.userId ?? '')
      if (!workspaceId || !lineUserId) { keepUnhandled++; continue }

      const opened: Timestamp | undefined = s.openedAt
      if (!opened) { keepUnhandled++; continue }
      const end: Timestamp = s.closedAt ?? s.lastActivityAt ?? Timestamp.now()

      // 撈這個 session 期間的對話訊息(timestamp 單欄範圍查詢,免複合索引;量小,記憶體過濾方向)
      const convDocId = `${workspaceId}_${lineUserId}`
      const msgs = await db.collection('conversations').doc(convDocId).collection('messages')
        .where('timestamp', '>=', opened)
        .where('timestamp', '<=', end)
        .limit(200)
        .get()
      const hasIncoming = msgs.docs.some(m => (m.data() as any).direction === 'incoming')
      const hasOutgoing = msgs.docs.some(m => (m.data() as any).direction === 'outgoing')

      if (!hasIncoming) {
        toFollow++
        console.log(`  A 活動/加好友未開口: ${doc.id.slice(0, 8)}… (${msgs.size} 訊息)`)
        if (apply) {
          await doc.ref.update({ origin: 'follow', hasInbound: false, backfilledAt: FieldValue.serverTimestamp() })
        }
      }
      else if (hasOutgoing) {
        toBot++
        console.log(`  B 補記機器人首接:    ${doc.id.slice(0, 8)}… (${msgs.size} 訊息)`)
        if (apply) {
          await doc.ref.update({
            initialHandler: 'bot',
            initialModuleType: 'bot_flow',
            ...(s.currentHandler === 'unhandled' ? { currentHandler: 'bot' } : {}),
            backfilledAt: FieldValue.serverTimestamp(),
          })
        }
      }
      else {
        keepUnhandled++
      }
    }
    catch (e: any) {
      errors++
      console.warn(`  ⚠ ${doc.id} 判定失敗:`, String(e?.message).slice(0, 120))
    }
  }

  console.log(`\n[backfill] 結果統計:`)
  console.log(`  A 改為「活動出生未開口」(統計排除): ${toFollow}`)
  console.log(`  B 補記「機器人首接」:               ${toBot}`)
  console.log(`  C 維持「未首接」(真的沒人回):        ${keepUnhandled}`)
  console.log(`  跳過(新制資料):                     ${skippedHasOrigin}`)
  console.log(`  錯誤:                               ${errors}`)
  if (!apply) console.log('\n[backfill] 這是 dry-run;確認無誤後加 --apply 實際寫入。')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

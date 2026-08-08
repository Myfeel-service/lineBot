/**
 * 把「待處理清單上太久沒動」的會話收掉。
 *
 * 為什麼需要：待處理佇列的定義是「客人開了口、沒有任何人／機器人回應」。這種會話不會自己消失——
 * 客人隔天再開口時系統會開一場**新**會話（24 小時規則），舊那場就永遠掛在清單上。
 * 實測 2026-08-04：MYFEEL 清單 385 筆，其中 355 筆是 30–90 天前的，客服每天要滑過這一堆才看得到新的。
 *
 * 這支**只關掉會顯示在清單上的那些**（佇列口徑），刻意不動「加好友還沒開口」那批
 * （它們本來就被清單濾掉、看不到，全關掉只會讓統計上的「已結束比例」憑空跳動）。
 *
 * 誠實性：只改 status / closedAt，**不動 initialHandler**——沒人回答過就是沒人回答過，
 * 「未首接」統計與「已處理且已結束」率都不會因為這次清理變好看
 * （後者的分子刻意排除 unhandled，見 server/api/conversation-stats/kpi.get.ts）。
 *
 * 可回滾：每筆都寫 staleClosedAt / staleClosedReason，要還原就查這兩個欄位。
 *
 * 用法：
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/close-stale-open-sessions.ts              # dry-run(30 天)
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/close-stale-open-sessions.ts --days=7
 *   node --env-file=.env_myfeel --experimental-strip-types scripts/close-stale-open-sessions.ts --apply
 */
import { initializeApp, cert } from 'firebase-admin/app'
import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore'

const apply = process.argv.includes('--apply')
const daysArg = process.argv.find(a => a.startsWith('--days='))
const STALE_DAYS = Math.max(1, Number(daysArg?.split('=')[1] ?? 30))
const DAY_MS = 24 * 3600_000

const projectId = process.env.FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
const privateKey = process.env.FIREBASE_PRIVATE_KEY
if (!projectId || !clientEmail || !privateKey) {
  console.error('缺少環境變數：FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY')
  process.exit(1)
}
initializeApp({ credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }) })

const ms = (v: any) => v?.toMillis?.() ?? 0

/** 與 shared/types/conversation-stats.ts 的 isPreInboundFollowSession 同一條規則 */
function isPreInboundFollowSession(s: any): boolean {
  return s?.origin === 'follow' && s?.hasInbound !== true
}

/** 一批最多幾場會話：每場 2 筆寫入（session update + conversation_closed 事件），Firestore 上限 500 */
const BATCH_SESSIONS = 200

async function main() {
  const db: Firestore = getFirestore()
  console.log(`[close-stale] project=${projectId} 門檻=${STALE_DAYS} 天 mode=${apply ? 'APPLY（會寫入）' : 'DRY-RUN'}`)

  // 單欄等值查詢，免複合索引
  const snap = await db.collection('conversationSessions').where('status', '==', 'open').get()
  const cutoffMs = Date.now() - STALE_DAYS * DAY_MS

  const targets = snap.docs.filter((d) => {
    const s = d.data()
    if (isPreInboundFollowSession(s)) return false          // 清單上看不到的不動
    const last = ms(s.lastActivityAt) || ms(s.openedAt)
    return last > 0 && last < cutoffMs
  })

  const byWorkspace: Record<string, number> = {}
  for (const d of targets) {
    const ws = String(d.data().workspaceId ?? '—')
    byWorkspace[ws] = (byWorkspace[ws] ?? 0) + 1
  }

  console.log(`[close-stale] status=open ${snap.size} 筆 → 清單上 ${snap.docs.filter(d => !isPreInboundFollowSession(d.data())).length} 筆 → 超過 ${STALE_DAYS} 天要收掉 ${targets.length} 筆`)
  console.log('[close-stale] 依工作區:', JSON.stringify(byWorkspace))
  for (const d of targets.slice(0, 5)) {
    const s = d.data()
    const last = ms(s.lastActivityAt) || ms(s.openedAt)
    console.log(`  ${d.id.slice(0, 8)}… 最後活動 ${new Date(last).toISOString().slice(0, 10)}（${Math.round((Date.now() - last) / DAY_MS)} 天前）initialHandler=${s.initialHandler}`)
  }
  if (targets.length > 5) console.log(`  …其餘 ${targets.length - 5} 筆`)

  if (!apply) {
    console.log(`\n[close-stale] 這是 dry-run；確認無誤後加 --apply 實際寫入。`)
    return
  }

  const reason = `no activity > ${STALE_DAYS}d`
  let done = 0
  for (let i = 0; i < targets.length; i += BATCH_SESSIONS) {
    const slice = targets.slice(i, i + BATCH_SESSIONS)
    const batch = db.batch()
    for (const d of slice) {
      batch.update(d.ref, {
        status: 'closed',
        closedAt: Timestamp.now(),
        // 回滾標記：要還原就查 staleClosedAt 存在的文件
        staleClosedAt: FieldValue.serverTimestamp(),
        staleClosedReason: reason,
      })
      // 時間軸上要看得到「會話已結束」，與其他結束路徑同一種事件
      batch.set(db.collection('conversationEvents').doc(), {
        sessionId: d.id,
        userId: String(d.data().userId ?? ''),
        // 與 recordConversationEvent 同一組欄位：漏了 workspaceId 的事件之後無法直接查
        workspaceId: String(d.data().workspaceId ?? ''),
        eventType: 'conversation_closed',
        timestamp: FieldValue.serverTimestamp(),
      })
    }
    await batch.commit()
    done += slice.length
    console.log(`[close-stale] 已寫入 ${done}/${targets.length}`)
  }
  console.log(`[close-stale] 完成：關閉 ${done} 場（initialHandler 未變動，統計仍記為未首接）`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

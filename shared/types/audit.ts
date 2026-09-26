/**
 * 操作紀錄（auditLogs）的共用型別與白話對照——**單一事實來源**。
 *
 * 為什麼要有這一份：`server/utils/audit-log.ts` 從 2026-08-14 起就在寫紀錄，
 * 但那是一個**只進不出**的 collection——沒有任何端點或畫面讀得到它。
 * 在小幫手開始代人動手（`C-31` Phase 2）之前，系統必須答得出「這筆是誰改的、改前是什麼」，
 * 所以這一輪把它讀出來，而「動作代號 → 人看得懂的一句話」只能有一份對照表：
 * 後端寫入用的代號、畫面上顯示的名稱都從這裡長出來。
 *
 * ⛔ 新增一種會寫稽核的動作時，這裡要一起補一行——
 *    `shared/types/audit.test.ts` 會掃 server 原始碼，漏了直接紅。
 */

/** 誰動的手：人自己在頁面上按的，還是小幫手代辦的 */
export type AuditActor = 'human' | 'agent'

export const AUDIT_ACTOR_LABELS: Record<AuditActor, string> = {
  human: '成員操作',
  agent: '小幫手代辦',
}

/**
 * 動作代號 → 白話說明。代號慣例是端點路徑或 `alert-fix/<op>`、`agent-op/<op>`。
 *
 * ⛔ 這裡寫的是「發生了什麼事」，不是功能名稱：看紀錄的人想知道的是
 *    「AI 設定被改了」而不是「呼叫了 ai/settings.put」。
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'ai/settings.put': '改了 AI 設定',
  'richmenu/setDefault': '換了預設圖文選單',
  'conversations/sessions.batchClose': '批次結束對話',
  'alert-fix/broken-module-reenable': '把停用的模組重新啟用',
  'alert-fix/broken-module-repoint': '把壞掉的按鈕改指到別的模組',
  'alert-fix/line-webhook-set-url': '換掉 LINE 上登記的收訊網址',
  'alert-fix/knowledge-refetch-sources': '重新抓取同步失敗的資料',
  'alert-fix/knowledge-retry-index': '重試學習失敗的知識卡',
  'alert-fix/knowledge-retry-index-stuck': '重試卡住沒學完的知識卡',
  'alert-fix/script-disable-anytext': '停用「輸入任何內容」的攔截',
  'alert-fix/script-add-skip-exit': '幫卡住的問題補上跳過按鈕',
  'alert-fix/broadcast-reset-failed': '把發送失敗的推播重設回草稿',
  // 小幫手代辦（`C-31` Phase 2）：actor 欄位會顯示「小幫手代辦」，所以這裡只寫做了什麼
  'agent-op/ai-settings-service-hours': '改了服務時間／勿擾時段',
  'agent-op/script-set-enabled': '上架或下架一條自動回應',
  'agent-op/ai-settings-handoff-sla': '改了「客人等太久」的提醒時間',
  'agent-op/ai-settings-sensitive-topic': '增減「一提到就轉真人」的字',
  'agent-op/ai-settings-reply-mode': '切換 AI 直接回客人／只給草稿',
  'agent-op/script-create-from-description': '用一句話建了一條自動回應（建好是停用的）',
  'agent-op/broadcast-draft-create': '建了一則推播草稿（沒有發送）',
  // 還原也是一次操作：⛔原本那一筆不刪不改，這裡再記一筆
  'audit/revert': '把先前的某一筆改動還原回去',
  // 人自己在頁面上改的（2026-09-16 補接）：小幫手的每一筆都記了，人改的卻沒有，時間軸會是斷的
  'ai/scripts.put': '編輯了一條自動回應',
  'ai/scripts.create': '新增了一條自動回應',
  'ai/scripts.delete': '刪掉了一條自動回應',
  'members/role.put': '改了某位成員的權限',
  'line-workspace.put': '改了 LINE 連線設定',
  'line-workspace.clear': '清空了整個 LINE 工作區設定',

  /*
   * ── 2026-09-24（`C-254`）補的那一大批 ────────────────────────────
   * 在這之前，整個 `auditLogs` 從 2026-08-14 開張到 09-24 只有 6 筆——
   * 160 支會寫入的端點只有 9 支會留紀錄，而這一頁卻宣稱它記了圖文選單。
   * ⛔ 之後新增會改設定的端點，這裡要一起補一行（`audit.test.ts` 會掃 server 原始碼）。
   */

  // 推播：唯一「按下去就送出、收不回來」而且會花錢的功能，所以擺第一個補
  'broadcast.create': '建了一則推播草稿',
  'broadcast.put': '改了一則推播的內容',
  'broadcast.send': '送出了一則推播',
  'broadcast.schedule': '排定了推播的發送時間',
  'broadcast.cancel': '取消了一則推播',
  'broadcast.retry': '把發送失敗的推播重設回草稿',
  'broadcast.testSend': '試發了一則推播給自己',

  // 機器人模組：改了客人立刻收到不一樣的東西
  'flow.create': '新增了一個機器人模組',
  'flow.put': '改了一個機器人模組',
  'flow.delete': '刪掉了一個機器人模組',
  'flow.reorder': '調整了機器人模組的順序',
  'flowFolder.create': '新增了模組資料夾',
  'flowFolder.put': '改了模組資料夾',
  'flowFolder.delete': '刪掉了模組資料夾',
  'flowFolder.reorder': '調整了模組資料夾的順序',

  // 圖文選單：09-24 之前只有「換預設」會記，其餘全部漏掉
  'richmenu.create': '新增了一個圖文選單',
  'richmenu.put': '改了一個圖文選單',
  'richmenu.delete': '刪掉了一個圖文選單',
  'richmenu.upload': '換了圖文選單的底圖',

  // 圖文訊息（模組裡那種一張圖切成好幾格的訊息）
  'richMessage.create': '新增了一則圖文訊息',
  'richMessage.put': '改了一則圖文訊息',
  'richMessage.delete': '刪掉了一則圖文訊息',

  // 知識庫：刪一張卡 AI 就少會一件事，而在這之前查不到是誰刪的
  'knowledge.create': '新增了一張知識卡',
  'knowledge.bulkCreate': '一次新增了多張知識卡',
  'knowledge.put': '改了一張知識卡',
  'knowledge.delete': '刪掉了一張知識卡',
  'knowledge.restore': '還原了一張刪掉的知識卡',
  'knowledge.settings': '改了一張知識卡的設定',
  'knowledge.reindex': '讓一張知識卡重新學習',
  'knowledge.reindexAll': '讓整個知識庫重新學習',
  // ⚠️ `knowledge/normalize` 刻意沒有紀錄：那支只是把整理結果**回給前端**，
  //    一個字都沒有寫進資料庫，存不存由使用者按下一步才決定（存的時候走 create／put）。
  'knowledge.reenrich': '幫知識卡補上「客人會怎麼問」',
  'knowledge.productAliases': '改了商品的別名',
  'knowledge.suggestionAccept': '採用了一則知識建議',
  'knowledge.suggestionDismiss': '忽略了一則知識建議',
  // 開帳讀網站整理出來、等店家看過的卡（`C-250`③）：點頭那一下才開始對客人講話，也才算額度
  'knowledge.draftAdopt': '採用了開帳整理出來的知識卡',
  'knowledge.draftDismiss': '刪掉了開帳整理出來、還沒採用的知識卡',
  'knowledge.dupDismiss': '忽略了一組重複的知識卡',
  'knowledge.previewJobDelete': '取消了一個匯入預覽',
  'source.put': '改了一個知識來源',
  'source.delete': '刪掉了一個知識來源（連同它的知識卡）',
  'source.reindex': '讓一個知識來源重新學習',
  'source.gsheetSync': '重新同步了 Google 試算表',
  'source.resyncApply': '套用了知識來源的重新同步',
  'source.migrateOrphans': '把沒有來源的知識卡歸了位',
  'knowledgeFolder.create': '新增了知識庫資料夾',
  'knowledgeFolder.put': '改了知識庫資料夾',
  'knowledgeFolder.delete': '刪掉了知識庫資料夾',
  'knowledgeFolder.reorder': '調整了知識庫資料夾的順序',

  // 標籤（⚠️「貼標籤給某位客人」是日常操作，刻意不記；這裡記的是標籤本身被建改刪）
  'tag.create': '新增了一個標籤',
  'tag.put': '改了一個標籤',
  'tag.delete': '刪掉了一個標籤',
  'tag.pending': '處理了一個待確認的標籤',

  // 客服常用語
  'supportPreset.create': '新增了一則客服常用語',
  'supportPreset.put': '改了一則客服常用語',
  'supportPreset.delete': '刪掉了一則客服常用語',

  // 加好友活動
  'campaign.create': '新增了一個加好友活動',
  'campaign.put': '改了一個加好友活動',
  'campaign.delete': '刪掉了一個加好友活動',

  // 店家輪廓：它的內容直接進 AI 的指令，改了等於換了 AI 的人設
  'storeProfile.put': '改了「認識你的店」的內容',

  // 成員與邀請（09-24 之前只有「改權限」會記）
  'members.invite': '邀請了新成員',
  'members.remove': '移除了一位成員',
  'memberInvite.put': '改了一張邀請的權限',
  'memberInvite.delete': '收回了一張邀請',
  'member.lineBindCode': '產生了成員的 LINE 綁定碼',
  'member.lineUnbind': '解除了成員的 LINE 綁定',

  // 錢：取消續訂、換方案、作廢訂單
  'payment.cancelSubscription': '取消了自動續訂',
  'payment.schedulePlanChange': '預約了方案變更',
  'payment.voidOrder': '作廢了一張訂單',
  'payment.invoiceProfile': '改了發票抬頭資料',

  // 組織層（組織管理員做的，不是平台做的）
  'org.invoiceProfile': '改了組織的發票抬頭',
  'org.memberAdd': '新增了組織管理員',
  'org.memberRemove': '移除了組織管理員',
  'org.workspaceCreate': '在組織底下建了一個官方帳號',

  /*
   * 平台自己做的事（超管）。⚠️ 這批的 `workspaceId` 是空的、`scope='platform'`，
   * **不會出現在租戶的「操作紀錄」頁**，只在超管的平台稽核頁看得到——
   * ⛔ 不要為了讓它現身而硬塞一個 workspaceId 進去。
   */
  'super.allowance': '平台調整了額度',
  'super.grantCredit': '平台給了點數',
  'super.leadPatch': '平台更新了名單的狀態',
  'super.orgCreate': '平台建立了一個組織',
  'super.orgPatch': '平台改了組織的資料',
  'super.orgDisable': '平台停用或啟用了一個組織',
  'super.orgMemberAdd': '平台新增了組織管理員',
  'super.orgMemberRemove': '平台移除了組織管理員',
  'super.recordRefund': '平台記錄了一筆退款',
  'super.superAdminGrant': '平台把某人升成超級管理員',
  'super.superAdminRevoke': '平台收回了某人的超級管理員',
  'super.voidInvoice': '平台作廢了一張發票',
  'super.workspaceCreate': '平台建立了一個官方帳號',
  'super.workspacePatch': '平台改了官方帳號的設定',

  /*
   * 轉真人佇列。⚠️ **只記批次那一支**：
   * · 單筆「標成處理完了」(`handoffs/resolve`) 是日常操作，跟單筆關閉對話同一級
   *   （那支本來就沒記，只有 `conversations/sessions.batchClose` 有記），照既有分界走。
   * · `conversations/cleanup` 是 Cloud Scheduler 每天跑的排程，沒有「誰做的」可以記——
   *   稽核的 actor 只有 human／agent，⛔ 不要為了讓它現身而捏造一個操作者。
   */
  'handoff.resolveByQuery': '一次把問同一句話的「等真人」都標成處理完了',
}

/** 找不到對照時的退路：寧可顯示代號，也不要顯示空白（空白會讓人以為紀錄壞了） */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action
}

/**
 * 這筆是不是「平台（我們）」做的（`C-254`）。
 *
 * 為什麼需要：`super.grantCredit`／`super.workspacePatch` 這兩筆**刻意掛在客戶自己的
 * workspaceId 上**——平台調了你的額度或方案，你有權在自己的操作紀錄裡看到。
 * 但它們的 `actor` 仍然是 `human`，畫面若照舊標成「成員操作」，客戶會看到一個
 * **他不認得的 Email 出現在自己團隊的操作紀錄裡**，第一反應是「我被入侵了」。
 * ⛔ 所以這種列一定要標出來是平台做的。
 */
export function isPlatformAction(action: string): boolean {
  return action.startsWith('super.')
}

/**
 * 這一筆是不是「本來就沒有」（新增類）／「之後就沒有了」（刪除類）。
 *
 * 為什麼要有：`C-254` 之後多了三十幾種新增／刪除動作，而前後對照是照「值變成值」
 * 的形狀印的，於是新增一個資料夾會印成「名稱：**（空白） → 週年慶**」——
 * 那個「（空白） →」是廢話，標題已經寫著「新增了模組資料夾」。
 * （2026-09-24 實走驗證時在真實紀錄上看到才發現，typecheck 與單元測試都看不出來。）
 */
export function auditIsCreate(before: Record<string, unknown> | null | undefined): boolean {
  return !before || Object.keys(before).length === 0
}

export function auditIsDelete(after: Record<string, unknown> | null | undefined): boolean {
  return !after || Object.keys(after).length === 0
}

/**
 * 設定欄位 → 白話名稱（盡力而為）。
 *
 * ⚠️ 這份**不可能完整**：紀錄裡的欄位是「這次剛好有變的那幾個」，隨設定長出來。
 *    對不到的一律原樣顯示欄位代號——顯示代號至少看得出有東西變了，
 *    省略掉才是真的騙人。
 */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  enabled: '開關',
  replyMode: '回覆方式',
  confidenceThreshold: '信心門檻',
  groundingThreshold: '有憑有據門檻',
  replyMaxLen: '回覆長度上限',
  systemPrompt: '給 AI 的說明',
  shopUrl: '商店網址',
  sensitiveTopics: '敏感情境詞',
  handoffNotify: '轉真人通知',
  serviceHours: '勿擾時段',
  disambiguation: '反問設定',
  quota: '用量上限',
  imageAnswer: '看圖回答',
  richMenuId: '圖文選單',
  endpoint: '收訊網址',
  nodes: '流程步驟',
  autoTagSuggest: 'AI 自動貼標建議',
  inactiveTag: '沉睡客人自動標籤',
  // 巢狀在上面那些設定底下的欄位（展開之後才會被看到，2026-09-18 補）
  slaRemindMinutes: '等太久的提醒時間（分鐘）',
  lineUserIds: '通知對象',
  displayNames: '通知對象的名稱',
  mode: '通知時機',
  digestHour: '每日摘要時間（點）',
  festivalTips: '節慶行銷提醒',
  weeklyInsights: '每週顧客觀察',
  criticalAlertPush: '重大異常推播',
  start: '服務時段起',
  end: '服務時段迄',
  weekendOff: '週末整天不打擾',
  dndReply: '勿擾時段回給客人的話',
  days: '幾天沒來訊算沉睡',
  role: '權限',
  // `C-254`（2026-09-24）補的那一批動作會帶到的欄位。
  // ⚠️ 陣列一律只記數量（`auditSnapshot` 的 `count`），所以這裡對的是 `xxxCount`。
  name: '名稱',
  title: '標題',
  status: '狀態',
  cardStatus: '這張卡的狀態',
  question: '客人會問的問題',
  answer: '卡片上的答案',
  content: '內容',
  text: '內容',
  description: '說明',
  url: '網址',
  email: '對象',
  displayName: '名稱',
  reason: '原因',
  note: '備註',
  color: '顏色',
  type: '類型',
  aiMode: 'AI 判斷方式',
  folderId: '所在資料夾',
  sourceId: '知識來源',
  refreshIntervalMinutes: '多久自動同步一次（分鐘）',
  onChangeBehavior: '來源變動時怎麼處理',
  productName: '商品名稱',
  messagesCount: '訊息則數',
  areasCount: '可按的格子數',
  actionsCount: '可按的格子數',
  altText: '收不到圖時顯示的文字',
  isActive: '啟用中',
  nodesCount: '流程步驟數',
  itemsCount: '項目數',
  columnsCount: '卡片數',
  chunkIdsCount: '知識卡張數',
  adoptedCount: '採用的張數',
  leftForQuotaCount: '額度滿了沒收的張數',
  dismissedCount: '刪掉的張數',
  added: '新增',
  updated: '更新',
  deleted: '刪除',
  completionTagIdsCount: '發完要貼的標籤數',
  audienceSource: '發送對象',
  scheduleAt: '預定發送時間',
  activeUntil: '用到哪一天',
  totalCount: '預計送出人數',
  sentCount: '實際送達人數',
  failedCount: '沒送成功的人數',
  isDefault: '預設選單',
  chatBarText: '選單列文字',
  imageUrl: '圖片',
  planId: '方案',
  plan: '方案',
  autoRenew: '自動續訂',
  taxId: '統一編號',
  amount: '金額',
  orderId: '訂單編號',
  invoiceNumber: '發票號碼',
  disabled: '已停用',
  superAdmin: '超級管理員',
  organizationId: '所屬組織',
  keywords: '觸發關鍵字',
}

export function auditFieldLabel(key: string): string {
  return AUDIT_FIELD_LABELS[key] ?? key
}

/**
 * 某些欄位的值本身是代號（`always`／`draft`…）。
 *
 * ⛔ 直接把代號秀給店家，跟秀欄位代號是同一個毛病：畫面上出現 `missed_only`，
 *    看的人只知道「有東西變了」，不知道變成什麼。對不到的一樣原樣顯示。
 */
export const AUDIT_VALUE_LABELS: Record<string, Record<string, string>> = {
  mode: { always: '每次都通知', missed_only: '沒人接手才通知' },
  replyMode: { auto: 'AI 直接回客人', draft: '只給草稿' },
  // 推播狀態（`C-254`）：畫面上出現 `cancelled` 跟出現欄位代號是同一個毛病
  status: {
    draft: '草稿',
    scheduled: '已排程',
    processing: '發送中',
    completed: '已送出',
    failed: '發送失敗',
    cancelled: '已取消',
  },
  /*
   * 知識卡的狀態刻意**不叫 `status`**：推播也有 `status`，而兩邊都有 `failed`——
   * 共用一張對照表的話，一張沒學成功的卡會被標成「發送失敗」。
   * ⛔ 值的代號會撞字，所以欄位名要分開。
   */
  cardStatus: {
    pending: '還在學',
    indexed: '可用',
    failed: '學習失敗',
    disabled: '停用中',
  },
  role: { owner: '擁有者', admin: '管理員', agent: '客服', viewer: '唯讀' },
  // ⚠️ 紀錄裡只存受眾的**種類**，不存名單本身：一則推播的名單可能有上千個 userId，
  //    整包存進來會被截成 50 個並把整筆標成 lossy（連還原都不給按），而且沒有人看得懂。
  audienceSource: { all: '全部好友', tags: '依標籤挑', audience: '指定受眾', import: '匯入的名單' },
}

/**
 * 稽核值 → 一行字。`fieldKey` 有給的話會把代號換成白話（`always` → 每次都通知）。
 *
 * ⚠️ 物件到這裡只會得到「（一組設定）」——那是**最後的退路**，正常路徑請走
 *    `auditChangeLines()`，它會展開到真的有變的那一格。
 */
export function auditValueText(v: unknown, fieldKey = ''): string {
  if (v === null || v === undefined) return '（空白）'
  if (typeof v === 'boolean') return v ? '開' : '關'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    if (v.trim() === '') return '（空白）'
    return AUDIT_VALUE_LABELS[fieldKey]?.[v] ?? v
  }
  if (Array.isArray(v)) return `${v.length} 項`
  return '（一組設定）'
}

/** 畫面上的一行前後對照。`key` 是欄位路徑，只拿來當 v-for 的 key */
export interface AuditChangeLine {
  key: string
  /** 「轉真人通知 › 等太久的提醒時間（分鐘）」 */
  label: string
  before: string
  after: string
}

export interface AuditChangeSummary {
  lines: AuditChangeLine[]
  /**
   * 超過上限、沒印出來的行數。
   * ⛔ 一定要顯示：安靜地少講幾行，看的人會以為「這次就只改了這些」。
   */
  omitted: number
}

/** 一筆最多印幾行（一次改十幾格的情況存在，但表格不能被撐爆） */
const MAX_CHANGE_LINES = 12
/** 展開幾層。寫入端 sanitize 也是 4 層，超過的本來就存不進來 */
const MAX_CHANGE_DEPTH = 4
/** 清單型欄位最多逐項列出幾個差異，超過就只講數量 */
const MAX_LIST_DIFF_ITEMS = 5

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 清單型欄位（敏感情境詞、通知對象…）：講出「多了誰、少了誰」。
 *
 * ⛔「19 項 → 20 項」等於沒講：看紀錄的人要知道的正是**哪一個字**被加進去，
 *    因為那個字決定了客人講到它會不會直接被轉給真人。
 * 回 null＝這不是可以逐項比對的清單，交回上層用一般方式顯示。
 */
function listChangeText(before: unknown, after: unknown): { before: string, after: string } | null {
  if (!Array.isArray(before) || !Array.isArray(after)) return null
  if (![...before, ...after].every(v => typeof v === 'string' || typeof v === 'number')) return null

  const b = before.map(String)
  const a = after.map(String)
  const added = a.filter(v => !b.includes(v))
  const removed = b.filter(v => !a.includes(v))
  // 只是順序換了（內容沒變）：不要編一個「新增／移除」出來
  if (!added.length && !removed.length) return null

  // 太多項就只講數量：一行塞進 60 個詞沒有人看得完，反而把旁邊的行擠掉
  if (added.length + removed.length > MAX_LIST_DIFF_ITEMS)
    return { before: `${b.length} 項`, after: `${a.length} 項（新增 ${added.length}、移除 ${removed.length}）` }

  const parts = [
    added.length ? `新增「${added.join('、')}」` : '',
    removed.length ? `移除「${removed.join('、')}」` : '',
  ].filter(Boolean)
  return { before: `${b.length} 項`, after: `${a.length} 項（${parts.join('；')}）` }
}

/**
 * 前後對照展開成「人看得懂的幾行」。
 *
 * 為什麼要有這一支（2026-09-18）：稽核存的是**設定裡的真實層級**
 * （`{ handoffNotify: { slaRemindMinutes: 37 } }`，這樣「還原」才知道要改回哪一格），
 * 但畫面原本只走到第一層，於是整欄變成「轉真人通知：（一組設定） → （一組設定）」——
 * 資料明明都在，卻一個字都沒講出來。這支往下走到**真的有變的那一格**再印。
 *
 * 紀律：
 * - ⛔ 上一層整顆有變、但這一格前後相同的，不印（印了會把真正改動的那行淹掉）。
 * - ⛔ 超過行數上限要 `continue` 繼續數，不可以 `break`——break 之後連「還有幾行」都說不出來。
 * - ⛔ 展不出任何一行時退回第一層顯示，不可以留空：空白會被讀成「沒改到東西」。
 */
export function auditChangeLines(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): AuditChangeSummary {
  const lines: AuditChangeLine[] = []
  let omitted = 0

  const walk = (
    b: Record<string, unknown> | null | undefined,
    a: Record<string, unknown> | null | undefined,
    path: string[],
    labels: string[],
  ): void => {
    for (const k of new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])) {
      const bv = b?.[k]
      const av = a?.[k]
      if (sameValue(bv, av)) continue

      const nextPath = [...path, k]
      const nextLabels = [...labels, auditFieldLabel(k)]

      // 兩邊都是「物件或沒有」才往下走：物件被換成一個字串時往下走會把那個字串弄丟
      const bObj = isPlainObject(bv)
      const aObj = isPlainObject(av)
      const bGone = bv === null || bv === undefined
      const aGone = av === null || av === undefined
      if ((bObj || bGone) && (aObj || aGone) && (bObj || aObj) && nextPath.length < MAX_CHANGE_DEPTH) {
        walk(bObj ? bv : null, aObj ? av : null, nextPath, nextLabels)
        continue
      }

      if (lines.length >= MAX_CHANGE_LINES) { omitted++; continue }

      const list = listChangeText(bv, av)
      lines.push({
        key: nextPath.join('.'),
        label: nextLabels.join(' › '),
        before: list ? list.before : auditValueText(bv, k),
        after: list ? list.after : auditValueText(av, k),
      })
    }
  }

  walk(before, after, [], [])

  // 展不出東西的極少數情況（例如整份物件只有欄位順序不同）：退回第一層，至少看得出動過哪一項
  if (!lines.length && !omitted) {
    for (const k of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      lines.push({
        key: k,
        label: auditFieldLabel(k),
        before: auditValueText(before?.[k], k),
        after: auditValueText(after?.[k], k),
      })
    }
  }

  return { lines, omitted }
}

/** 一筆操作紀錄（API 回給畫面的形狀；憑證類欄位在寫入時就已遮罩） */
export interface AuditLogRow {
  id: string
  /** 動作代號（對照 AUDIT_ACTION_LABELS） */
  action: string
  actor: AuditActor
  /** 操作者的 Firebase uid（畫面上會換成 Email／名字，換不到就顯示 uid 本身） */
  uid: string
  /** 這次真的有變的欄位：改之前 */
  before: Record<string, unknown> | null
  /** 這次真的有變的欄位：改之後 */
  after: Record<string, unknown> | null
  /** 補充說明（有些動作沒有前後值，只有一句「動了幾筆」） */
  note?: string
  /** 發生時間（毫秒）。⛔可能是 null：serverTimestamp 寫入後到讀取前有極短的空窗 */
  createdAt: number | null
  /** 這一筆能不能一鍵還原（後端算，⛔前端不要自己判斷） */
  revertible?: boolean
  /** 不能還原時的原因（人看得懂的一句話，畫面直接顯示） */
  revertReason?: string
}

export interface AuditLogListResult {
  items: AuditLogRow[]
  /** 還有更多時帶回來的游標（⛔用游標不用 offset：Firestore 跳過的每一筆都要收錢） */
  nextCursor: string | null
}

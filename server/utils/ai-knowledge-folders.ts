/**
 * knowledgeFolders 服務層：CRUD + 簡單的列表。
 *
 * Folder 用來在來源管理頁把 source 分組（資料夾）。
 * 刪除 folder 時 cascade 把底下 source 的 folderId 設為 null（變成未分類），
 * **不會**刪掉底下的 sources / chunks（避免誤刪整批資料）。
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore'
import { KNOWLEDGE_SOURCES_COLLECTION } from './ai-knowledge-sources'
import type { KnowledgeFolderDoc } from '~~/shared/types/ai-knowledge'
import { sameProductGroupName } from '~~/shared/knowledge-product-group'

export const KNOWLEDGE_FOLDERS_COLLECTION = 'knowledgeFolders'

export interface FolderSummary {
  id: string
  name: string
  order: number
  /**
   * 「通用」分組（`C-320`）：FAQ、公告、價目表這種不是講單一商品的。false＝商品分組（沒有這一格的舊資料夾都是）。
   * `D-127` 起商品分組就是一台商品：組名＝底下每份資料的商品名；通用的底下沒有商品名（見 ai-knowledge-product-group）。
   */
  general: boolean
  createdAtMs: number
}

/** 這一家已經有「同一台」的商品分組（組名只差空白、符號、大小寫）。exceptId＝改名時自己不算 */
async function findProductGroupNamed(
  db: Firestore,
  workspaceId: string,
  name: string,
  exceptId?: string,
): Promise<FolderSummary | null> {
  const snap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION).where('workspaceId', '==', workspaceId).get()
  for (const d of snap.docs) {
    if (d.id === exceptId) continue
    const f = docToFolderSummary(d.id, d.data() as Partial<KnowledgeFolderDoc>)
    if (!f.general && sameProductGroupName(f.name, name)) return f
  }
  return null
}

function tsToMs(raw: unknown): number {
  if (!raw) return 0
  const v = raw as { toMillis?: () => number; seconds?: number; _seconds?: number }
  if (typeof v.toMillis === 'function') return v.toMillis()
  const sec = v.seconds ?? v._seconds
  return typeof sec === 'number' ? sec * 1000 : 0
}

export function docToFolderSummary(id: string, raw: Partial<KnowledgeFolderDoc>): FolderSummary {
  return {
    id,
    name: String(raw.name ?? ''),
    order: Number(raw.order ?? 0),
    general: raw.general === true,
    createdAtMs: tsToMs(raw.createdAt),
  }
}

export async function listFolders(
  db: Firestore,
  workspaceId: string,
): Promise<FolderSummary[]> {
  // 沒部署複合索引 (workspaceId, order) 時退到「workspaceId 過濾 + JS 端排序」
  try {
    const snap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('order', 'asc')
      .get()
    return snap.docs.map(d => docToFolderSummary(d.id, d.data() as any))
  }
  catch (err: any) {
    console.warn('[ai-folders] orderBy index missing, falling back to JS sort:', err?.message)
    const snap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .get()
    return snap.docs
      .map(d => docToFolderSummary(d.id, d.data() as any))
      .sort((a, b) => a.order - b.order)
  }
}

export async function createFolder(
  db: Firestore,
  workspaceId: string,
  name: string,
  /** `C-320`：建成「通用」分組（例如上傳時選「這份不是講單一商品」、還沒有通用那一組） */
  opts: { general?: boolean } = {},
): Promise<FolderSummary & { existed?: true }> {
  const cleaned = name.trim().slice(0, 50)
  if (!cleaned) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

  /**
   * `D-127` 分組就是商品：同一台只能有一組。已經有同名的商品分組＝回那一組（existed），不另建——
   * 加入視窗一次好幾份、整個網站同時好幾頁都可能想建同一組，建成兩組＝同一台的資料分兩處、AI 也當成同一台，越整理越亂。
   */
  if (opts.general !== true) {
    const same = await findProductGroupNamed(db, workspaceId, cleaned)
    if (same) return { ...same, existed: true }
  }

  // 用最大 order + 1 放到最後（之後想做拖曳排序時也適用）。
  // 若複合索引 (workspaceId, order DESC) 還沒部署，退而求其次用 Date.now() 當 order，
  // 讓建立還是能成功；索引部署後新建的資料夾就會依序入列。
  let nextOrder: number
  try {
    const lastSnap = await db.collection(KNOWLEDGE_FOLDERS_COLLECTION)
      .where('workspaceId', '==', workspaceId)
      .orderBy('order', 'desc')
      .limit(1)
      .get()
    nextOrder = lastSnap.empty ? 0 : Number(lastSnap.docs[0]!.data()?.order ?? 0) + 1
  }
  catch (err: any) {
    console.warn('[ai-folders] orderBy index missing, using timestamp fallback:', err?.message)
    nextOrder = Date.now()
  }

  const ref = db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc()
  const now = FieldValue.serverTimestamp()
  await ref.set({
    workspaceId,
    name: cleaned,
    order: nextOrder,
    // 只有要建成通用的才寫這一格（沒有＝商品分組，跟舊資料夾一樣）
    ...(opts.general === true ? { general: true } : {}),
    createdAt: now,
    updatedAt: now,
  })
  const snap = await ref.get()
  return docToFolderSummary(ref.id, snap.data() as any)
}

/**
 * 改資料夾：名字、是不是「通用」分組（`C-320`）。兩格都沒帶＝400。
 * 回傳改之前的樣子（稽核要寫「從商品改成通用」），找不到回 null。
 *
 * `D-127`：改完之後底下每份資料的商品名要跟著改（組名＝商品名）——由呼叫端（folders PUT）接著打
 * syncGroupSourcesProduct，這裡只改分組本身。改成跟別的商品分組同名＝400（同一台只能有一組）。
 */
export async function updateFolder(
  db: Firestore,
  workspaceId: string,
  folderId: string,
  input: { name?: string; general?: boolean },
): Promise<{ before: FolderSummary; after: FolderSummary } | null> {
  const update: Record<string, unknown> = {}
  if (input.name !== undefined) {
    const cleaned = String(input.name).trim().slice(0, 50)
    if (!cleaned) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })
    update.name = cleaned
  }
  // false 寫成刪掉這一格：沒有這一格＝商品分組，不留兩種寫法
  if (typeof input.general === 'boolean') update.general = input.general ? true : FieldValue.delete()
  if (!Object.keys(update).length) throw createError({ statusCode: 400, statusMessage: '沒有要改的地方' })

  const ref = db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId)
  const snap = await ref.get()
  if (!snap.exists) return null
  const data = snap.data() as KnowledgeFolderDoc
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }
  // 改完是商品分組、名字又跟另一個商品分組一樣 → 擋（同一台只能有一組；要合起來用「合成一組」）
  const nextName = typeof update.name === 'string' ? update.name : String(data.name ?? '')
  const nextGeneral = typeof input.general === 'boolean' ? input.general : data.general === true
  if (!nextGeneral && (typeof update.name === 'string' || input.general === false)) {
    const same = await findProductGroupNamed(db, workspaceId, nextName, folderId)
    if (same) throw createError({ statusCode: 400, statusMessage: `已經有一組叫「${same.name}」，同一台請放在同一組` })
  }

  await ref.update({ ...update, updatedAt: FieldValue.serverTimestamp() })
  const fresh = await ref.get()
  return { before: docToFolderSummary(ref.id, data), after: docToFolderSummary(ref.id, fresh.data() as any) }
}

/** 只改名（舊呼叫端）。新的請用 updateFolder */
export async function renameFolder(
  db: Firestore,
  workspaceId: string,
  folderId: string,
  name: string,
): Promise<FolderSummary | null> {
  return (await updateFolder(db, workspaceId, folderId, { name }))?.after ?? null
}

/**
 * 重排資料夾：orderedIds 必須跟現有資料夾一一對應，order 直接寫成 index。
 */
export async function reorderFolders(
  db: Firestore,
  workspaceId: string,
  orderedIds: string[],
): Promise<void> {
  const existing = await listFolders(db, workspaceId)
  const existingIds = new Set(existing.map(f => f.id))
  if (orderedIds.length !== existing.length || orderedIds.some(id => !existingIds.has(id))) {
    throw createError({ statusCode: 400, statusMessage: '排序列表與資料夾數量不符' })
  }

  const batch = db.batch()
  orderedIds.forEach((id, index) => {
    batch.update(db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(id), {
      order: index,
      updatedAt: FieldValue.serverTimestamp(),
    })
  })
  await batch.commit()
}

/**
 * 刪除 folder：先把底下 source 的 folderId 設成 null（變未分類），再刪 folder。
 * 不刪 sources / chunks 本身。
 *
 * `D-127`：未分類＝不是講單一商品，底下有商品名的那幾份一起清掉，回 clearedProductSourceIds——
 * 呼叫端（畫面）要一份份重新學習，AI 才不會繼續把它們當成那一台（同 syncGroupSourcesProduct）。
 */
export async function deleteFolderCascade(
  db: Firestore,
  workspaceId: string,
  folderId: string,
): Promise<{ movedSources: number, clearedProductSourceIds: string[] }> {
  const ref = db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId)
  const snap = await ref.get()
  if (!snap.exists) return { movedSources: 0, clearedProductSourceIds: [] }
  const data = snap.data() as KnowledgeFolderDoc
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }

  // 把底下 source 的 folderId 變 null
  const childrenSnap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('folderId', '==', folderId)
    .get()

  const cleared: string[] = []
  const batch = db.batch()
  for (const child of childrenSnap.docs) {
    const hadProduct = !!String(child.data()?.productName ?? '').trim()
    if (hadProduct) cleared.push(child.id)
    batch.update(child.ref, {
      folderId: null,
      ...(hadProduct ? { productName: FieldValue.delete() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  batch.delete(ref)
  await batch.commit()

  return { movedSources: childrenSnap.size, clearedProductSourceIds: cleared }
}

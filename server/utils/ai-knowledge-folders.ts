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

export const KNOWLEDGE_FOLDERS_COLLECTION = 'knowledgeFolders'

export interface FolderSummary {
  id: string
  name: string
  order: number
  /**
   * 「通用」分組（`C-320`）：FAQ、公告、價目表這種不是講單一商品的。false＝商品分組（沒有這一格的舊資料夾都是）。
   * 商品分組裡產品名空的那份，搬進來時會照同組其他資料補上產品名；通用分組不補（見 ai-knowledge-product-group）。
   */
  general: boolean
  createdAtMs: number
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
): Promise<FolderSummary> {
  const cleaned = name.trim().slice(0, 50)
  if (!cleaned) throw createError({ statusCode: 400, statusMessage: '請輸入資料夾名稱' })

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
 * ⚠️ 改成通用／改回商品**不動**底下任何一份的產品名：已經填好的是店家的決定（`C-320` 紅線 2），
 *    改回商品分組時空的那幾份要不要補，下一次搬進來／搬家腳本再判。
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
 */
export async function deleteFolderCascade(
  db: Firestore,
  workspaceId: string,
  folderId: string,
): Promise<{ movedSources: number }> {
  const ref = db.collection(KNOWLEDGE_FOLDERS_COLLECTION).doc(folderId)
  const snap = await ref.get()
  if (!snap.exists) return { movedSources: 0 }
  const data = snap.data() as KnowledgeFolderDoc
  if (data.workspaceId !== workspaceId) {
    throw createError({ statusCode: 403, statusMessage: 'workspace mismatch' })
  }

  // 把底下 source 的 folderId 變 null
  const childrenSnap = await db.collection(KNOWLEDGE_SOURCES_COLLECTION)
    .where('workspaceId', '==', workspaceId)
    .where('folderId', '==', folderId)
    .get()

  const batch = db.batch()
  for (const child of childrenSnap.docs) {
    batch.update(child.ref, { folderId: null, updatedAt: FieldValue.serverTimestamp() })
  }
  batch.delete(ref)
  await batch.commit()

  return { movedSources: childrenSnap.size }
}

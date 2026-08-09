/**
 * 腳本健康靜態檢查（給異常中心用）。
 *
 * 兩件事，對應兩個要修的地方：
 *   1. 觸發不到——設定正常但永遠輪不到（被規則／敏感層／別條腳本蓋住，或根本沒填觸發詞）
 *   2. 走不完——觸發得到，但流程中有「客人答不出來就卡死」的步驟
 *
 * 都是靜態比對，不是統計「誰踩到了」：在客人踩到之前就報，而且給的是可以直接修的答案。
 * （2026-08-08 起因：正式「查詢訂單」腳本問訂單編號沒有跳過出口，沒編號的客人被無限重問，
 *   後台看起來完全正常、統計也看不出來，只有老闆自己去測才會發現。）
 */
import type { Firestore } from 'firebase-admin/firestore'
import { capMapSize } from './bounded-cache'
import { SCRIPTS_COLLECTION } from './ai-scripts'
import { findStuckCollects, type ScriptDoc } from '~~/shared/types/ai-script'
import {
  findUnreachableScripts,
  type ScriptForReachability,
  type ScriptReachabilityIssue,
} from '~~/shared/types/ai-script-reachability'

export interface ScriptDeadEnd {
  scriptId: string
  scriptName: string
  /** 卡死那一題問的是什麼（給使用者一眼認出是哪一步） */
  question: string
}

export interface ScriptHealth {
  unreachable: ScriptReachabilityIssue[]
  deadEnds: ScriptDeadEnd[]
}

/**
 * 同 broken-module-refs：這份結果只在有人編輯腳本／規則時才會變，
 * 但異常中心是被輪詢的端點——沒有快取的話每次輪詢都要整批讀 scripts。
 */
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 50
const cache = new Map<string, { data: ScriptHealth; expires: number }>()

export function invalidateScriptHealthCache(workspaceId: string) {
  cache.delete(workspaceId)
}

export async function checkScriptHealth(
  db: Firestore,
  workspaceId: string,
  sensitiveTopics: readonly string[],
): Promise<ScriptHealth> {
  const cached = cache.get(workspaceId)
  if (cached && cached.expires > Date.now()) return cached.data

  const scriptSnap = await db.collection(SCRIPTS_COLLECTION)
    .where('workspaceId', '==', workspaceId).where('enabled', '==', true).get()

  const scripts: ScriptForReachability[] = scriptSnap.docs.map(d => ({ id: d.id, ...(d.data() as ScriptDoc) }))

  const deadEnds: ScriptDeadEnd[] = []
  for (const s of scripts) {
    for (const stuck of findStuckCollects(s.nodes ?? [])) {
      deadEnds.push({ scriptId: s.id, scriptName: String(s.name || '(未命名腳本)'), question: stuck.question })
    }
  }

  const data: ScriptHealth = {
    unreachable: findUnreachableScripts(scripts, { sensitiveTopics }),
    deadEnds,
  }
  cache.set(workspaceId, { data, expires: Date.now() + CACHE_TTL_MS })
  capMapSize(cache, CACHE_MAX_ENTRIES)
  return data
}

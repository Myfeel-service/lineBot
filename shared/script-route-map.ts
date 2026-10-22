/**
 * 自動回應「路線」圖的骨架（`D-142`，2026-10-22 老闆：參考 n8n 節點圖的優點、但不要自己拉線）。
 *
 * 一題一站由上往下（最後一站＝「最後」那一段）。照順序接下一站的畫成左邊那條直線；
 * 跳題、客人說沒有、按鈕去別題的畫成右邊繞過去的圓角括號，一條一圈（lane）。
 * 這裡只算「有哪些線、各走第幾圈、哪裡交叉、標籤放在哪一格」，座標由元件換算——
 * 跟問答清單同一份節點（toQuestionList 的看法），不另存任何東西。
 */
import { routesOf, type QuestionListView } from './script-question-list'

export interface RouteBracket {
  from: number
  to: number
  /** 線上的小膠囊：答了／客人說沒有的按鈕字／按鈕字（同一段多條路合併） */
  labels: string[]
  /** 往回跳（換順序之後可能出現），畫成紅的 */
  backward: boolean
  /** 第幾圈：0 最靠近站，數字越大越外圈 */
  lane: number
  /** 標籤放在哪兩站中間：k＝第 k 站與第 k+1 站之間 */
  labelGap: number
}

/** 一站長什麼樣（跟 RouteMap.stationIds 一一對應）：畫面算好交給元件 */
export interface RouteStation {
  id: string
  label: string
  isEnd: boolean
  /** 結尾站的小字（回覆・轉真人）：站夠寬才放 */
  sub?: string
  title: string
  /** 點這一站要捲到哪一張卡 */
  jumpId: string
}

export interface RouteMap {
  /** 每一站的 id：題目的 id，接著每一種結尾的入口（好幾種結尾時底下好幾站，`D-149`） */
  stationIds: string[]
  /** 第 i 站到第 i+1 站之間有沒有直線（照順序接下一站的路） */
  rails: boolean[]
  brackets: RouteBracket[]
  laneCount: number
  /** 線交叉的地方：外圈那條的橫線經過內圈那條直線（畫成跨線，內圈那條在交叉點斷開） */
  hops: Array<{ lane: number; station: number }>
}

/** 標籤最多多寬：路線圖很窄，按鈕字太長會蓋到別的線。中文一字算一格、英數字半格（「沒有 Email」＝5 格，不切） */
const LABEL_MAX = 6
const short = (s: string) => {
  const t = s.trim()
  let units = 0
  for (let i = 0; i < t.length; i++) {
    units += t.charCodeAt(i) < 0x2E80 ? 0.5 : 1
    if (units > LABEL_MAX) return `${t.slice(0, i)}…`
  }
  return t
}

/**
 * 從問答清單算路線圖。
 * ⛔ 只有直線（每一題都只接下一題）時，brackets 是空的——畫面上就不畫這張圖（清單本身就是那張圖）。
 */
export function buildRouteMap(view: QuestionListView): RouteMap {
  const items = view.items
  const n = items.length
  /** 第幾站；排不進清單的步驟、還沒選的不畫（-1） */
  const indexOf = (id: string) => {
    const i = items.findIndex(it => it.id === id)
    if (i >= 0) return i
    // 不是題目＝某一種結尾（入口、存進客人資料、貼標籤、結尾本身都算那一種）
    const k = view.endings.findIndex(e => e.entryId === id || e.terminal.id === id || e.saveLead?.id === id || e.tag?.id === id)
    return k >= 0 ? n + k : -1
  }
  const routes: RouteEdge[] = []
  items.forEach((it, i) => {
    for (const r of routesOf(view, it)) {
      const to = r.target ? indexOf(r.target) : -1
      if (to < 0) continue
      // 線上的小膠囊（`D-150`：看答案的每一條標答案、其他答案標「其他」；路上貼了標籤的照樣只標去處）
      const label = r.kind === 'answer' ? '答了'
        : r.kind === 'skip' ? (it.type === 'collect' ? it.skipLabel ?? '' : '')
          : r.kind === 'option' ? (it.type === 'quickReply' ? it.options[r.index]?.label || '按鈕' : '')
            : r.kind === 'other' ? '其他'
              : caseLabel(view, it.id, r.index)
      if (r.kind === 'skip' && !label.trim()) continue
      routes.push({ from: i, to, label })
    }
  })
  return layoutRoutes([...items.map(it => it.id), ...view.endings.map(e => e.entryId)], routes)
}

/** 看答案的第幾條：填了答案標答案，「有回答」那種標「有回答」，還沒填標「第 N 條」 */
function caseLabel(view: QuestionListView, itemId: string, index: number): string {
  const c = view.branches.get(itemId)?.cases[index]
  if (!c) return ''
  if (c.op === 'exists') return '有回答'
  return String(c.value ?? '').trim() || `第 ${index + 1} 條`
}

interface RouteEdge { from: number; to: number; label: string }

/** 共用的排法：照順序接下一站的畫成直線，其他的一條一圈 */
function layoutRoutes(stationIds: string[], routes: RouteEdge[]): RouteMap {
  const rails = Array.from({ length: Math.max(stationIds.length - 1, 0) }, () => false)
  const merged = new Map<string, { from: number; to: number; labels: string[] }>()
  for (const r of routes) {
    if (r.to === r.from + 1) { rails[r.from] = true; continue }
    const key = `${r.from}>${r.to}`
    const b = merged.get(key) ?? { from: r.from, to: r.to, labels: [] }
    const l = short(r.label)
    if (l && !b.labels.includes(l)) b.labels.push(l)
    merged.set(key, b)
  }

  // 一條一圈：跨得短的先排、排在內圈；跟同一圈已經有的線完全不重疊才放得進去（連端點都不共用，免得兩條看起來接成一條）
  const lanes: Array<Array<[number, number]>> = []
  const sorted = [...merged.values()].sort((a, b) =>
    Math.abs(a.to - a.from) - Math.abs(b.to - b.from) || Math.min(a.from, a.to) - Math.min(b.from, b.to))
  const brackets: RouteBracket[] = sorted.map((b) => {
    const lo = Math.min(b.from, b.to)
    const hi = Math.max(b.from, b.to)
    let lane = lanes.findIndex(l => l.every(([a, z]) => hi < a || lo > z))
    if (lane < 0) { lane = lanes.length; lanes.push([]) }
    lanes[lane]!.push([lo, hi])
    return { from: b.from, to: b.to, labels: b.labels, backward: b.to <= b.from, lane, labelGap: lo }
  })

  // 標籤放在跨過的範圍正中間那一格（站與站之間，不會壓在別條線的橫線上——橫線都在站的高度）；
  // 隔壁一圈同一格已經有標籤就往旁邊的格子挪（兩圈只差 30px，膠囊會疊在一起）
  const placed: Array<{ lane: number; gap: number }> = []
  for (const b of [...brackets].sort((x, y) => x.lane - y.lane)) {
    const lo = Math.min(b.from, b.to)
    const hi = Math.max(b.from, b.to)
    const mid = lo + Math.floor((hi - lo - 1) / 2)
    const gaps = Array.from({ length: hi - lo }, (_, k) => lo + k).sort((a, z) => Math.abs(a - mid) - Math.abs(z - mid) || a - z)
    b.labelGap = gaps.find(g => !placed.some(p => p.gap === g && Math.abs(p.lane - b.lane) <= 1)) ?? mid
    placed.push({ lane: b.lane, gap: b.labelGap })
  }

  // 外圈那條的橫線（在 from、to 兩站的高度）會穿過內圈、跨著那一站的直線
  const hops: RouteMap['hops'] = []
  for (const outer of brackets) {
    for (const inner of brackets) {
      if (inner.lane >= outer.lane) continue
      const lo = Math.min(inner.from, inner.to)
      const hi = Math.max(inner.from, inner.to)
      for (const station of [outer.from, outer.to]) {
        if (station > lo && station < hi && !hops.some(h => h.lane === inner.lane && h.station === station)) {
          hops.push({ lane: inner.lane, station })
        }
      }
    }
  }

  return { stationIds, rails, brackets, laneCount: lanes.length, hops }
}

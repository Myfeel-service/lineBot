/**
 * 自動回應「路線」圖的骨架（`D-142`，2026-10-22 老闆：參考 n8n 節點圖的優點、但不要自己拉線）。
 *
 * 一題一站由上往下（最後一站＝「最後」那一段）。照順序接下一站的畫成左邊那條直線；
 * 跳題、客人說沒有、按鈕去別題的畫成右邊繞過去的圓角括號，一條一圈（lane）。
 * 這裡只算「有哪些線、各走第幾圈、哪裡交叉、標籤放在哪一格」，座標由元件換算——
 * 跟問答清單同一份節點（toQuestionList 的看法），不另存任何東西。
 */
import type { QuestionListView } from './script-question-list'

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

export interface RouteMap {
  /** 每一站的 id：題目的 id，最後一站是「最後」那一段的入口（endId） */
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
  const indexOf = (id: string | undefined) => {
    const i = items.findIndex(it => it.id === id)
    return i >= 0 ? i : n // 不是題目＝「最後」那一段（存進客人資料／貼標籤／結尾）
  }
  const rails = Array.from({ length: n }, () => false)
  const merged = new Map<string, { from: number; to: number; labels: string[] }>()
  const addRoute = (from: number, targetId: string | undefined, label: string) => {
    if (!targetId) return
    const to = indexOf(targetId)
    if (to === from + 1) { rails[from] = true; return }
    const key = `${from}>${to}`
    const b = merged.get(key) ?? { from, to, labels: [] }
    const l = short(label)
    if (l && !b.labels.includes(l)) b.labels.push(l)
    merged.set(key, b)
  }
  items.forEach((it, i) => {
    if (it.type === 'collect') {
      addRoute(i, it.next, '答了')
      if (it.skipLabel?.trim()) addRoute(i, it.skipNext, it.skipLabel)
    }
    else {
      for (const o of it.options) addRoute(i, o.next, o.label || '按鈕')
    }
  })

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

  return { stationIds: [...items.map(it => it.id), view.endId], rails, brackets, laneCount: lanes.length, hops }
}

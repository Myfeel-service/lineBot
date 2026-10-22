<template>
  <!--
    `D-142`（2026-10-22）：參考 n8n 節點圖的優點——一眼看全貌、岔路看得到線、試的時候走到哪亮哪——
    但⛔ 不讓店家自己拉線、自己擺位置：線全部照問答清單自動畫，改左邊這張就跟著變（示意畫布第⑥張 v9）。
    只在有岔路時出現（直線流程的清單本身就是那張圖），掛在右邊固定不動的那一欄，捲左邊時全貌一直看得到。
  -->
  <section class="scripts-route" aria-label="路線">
    <div class="scripts-route__head">
      <b class="section-title">路線</b>
      <span class="scripts-route__hint">
        <template v-if="!collapsed">點一站跳到那一題　·　</template>
        <button type="button" class="scripts-route__toggle" @click="toggle">{{ collapsed ? '展開' : '收起' }}</button>
      </span>
    </div>

    <div v-show="!collapsed" ref="boxEl" class="scripts-route__box" :style="{ height: `${geo.height}px` }">
      <!-- 照順序接下一站的直線（左邊那一條） -->
      <span
        v-for="r in railEls"
        :key="`r${r.i}`"
        class="scripts-route__rail"
        :class="{ 'is-walked': r.walked }"
        :style="r.style"
      />
      <!-- 繞過去的路：一條一圈的圓角括號，箭頭指進要去的那一站 -->
      <template v-for="b in bracketEls" :key="b.key">
        <span class="scripts-route__bracket" :class="b.cls" :style="b.style" />
        <span class="scripts-route__arrow" :class="b.cls" :style="b.arrowStyle" />
      </template>
      <!-- 跨線：外圈的橫線經過內圈的直線時，內圈那條在交叉點斷開 -->
      <span v-for="h in hopEls" :key="h.key" class="scripts-route__hop" :style="h.style" />
      <span v-for="b in bracketEls" :key="`l${b.key}`" class="scripts-route__chip" :class="b.cls" :style="b.chipStyle">{{ b.label }}</span>

      <button
        v-for="s in stationEls"
        :key="s.id"
        type="button"
        class="scripts-route__station"
        :class="{ 'is-current': s.current, 'is-walked': s.walked, 'is-end': s.isEnd }"
        :style="s.style"
        :title="s.title"
        @click="emit('jump', s.jumpId)"
      >
        <span class="scripts-route__badge">
          <span v-if="s.isEnd" class="scripts-route__end-mark" />
          <template v-else>{{ s.n }}</template>
        </span>
        <span class="scripts-route__name">{{ s.label }}</span>
        <span v-if="s.sub" class="scripts-route__sub">{{ s.sub }}</span>
        <span v-if="s.flagged" class="scripts-route__flag" title="這一題有要處理的問題，看上面的提醒" />
        <span v-else-if="s.walked && !s.current" class="scripts-route__done">✓</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { QuestionEnding, QuestionItem, QuestionListView } from '~~/shared/script-question-list'
import { endingOfNode } from '~~/shared/script-question-list'
import { buildRouteMap } from '~~/shared/script-route-map'

const props = defineProps<{
  view: QuestionListView
  itemLabel: (item: QuestionItem) => string
  /** 好幾種結尾時每一站的名字（「出貨查詢」…，`D-149`）；只有一種就叫「最後」 */
  endingLabel?: (ending: QuestionEnding) => string
  /** 試試看走過的步驟（照順序，含「最後」那一段的步驟） */
  visited: string[]
  /** 試試看現在停在哪一題 */
  current: string | null
  /** 有要處理的問題的步驟（上面那條提醒的同一份） */
  flagged: Set<string>
}>()
const emit = defineEmits<{ jump: [id: string] }>()

// ── 收起／展開（每台電腦自己記；讀寫失敗就當沒記，照樣能用） ──
const COLLAPSE_KEY = 'scripts-route-collapsed'
const collapsed = ref(false)
onMounted(() => {
  try { collapsed.value = localStorage.getItem(COLLAPSE_KEY) === '1' }
  catch { /* 無痕視窗等讀不到：預設展開 */ }
})
function toggle() {
  collapsed.value = !collapsed.value
  try { localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0') }
  catch { /* 記不住就算了 */ }
}

// ── 寬度：右邊那一欄 300～360，線多的時候站名縮窄、線的間距不變 ──
const boxEl = ref<HTMLElement | null>(null)
const boxWidth = ref(300)
let ro: ResizeObserver | null = null
onMounted(() => {
  if (!boxEl.value || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(() => { if (boxEl.value?.clientWidth) boxWidth.value = boxEl.value.clientWidth })
  ro.observe(boxEl.value)
})
onBeforeUnmount(() => ro?.disconnect())

const map = computed(() => buildRouteMap(props.view))

/** 版面數字（跟示意第⑥張 v9 同一組）：站高 30、站距 44、第一圈離站 36、圈距 30 */
const PAD = 12
const PITCH = 44
const PILL_H = 30
const FIRST_LANE = 36
const LANE_GAP = 30
const geo = computed(() => {
  const lanes = Math.max(map.value.laneCount, 1)
  const pillW = Math.min(168, Math.max(104, boxWidth.value - (PAD + FIRST_LANE + (lanes - 1) * LANE_GAP + 34 + 8)))
  const pillRight = PAD + pillW
  const stations = map.value.stationIds.length
  return {
    pillW,
    pillRight,
    laneX: (l: number) => pillRight + FIRST_LANE + l * LANE_GAP,
    rowTop: (i: number) => PAD + i * PITCH,
    rowY: (i: number) => PAD + i * PITCH + PILL_H / 2,
    height: PAD + (stations - 1) * PITCH + PILL_H + PAD,
  }
})

/** 試試看走過的步驟換成第幾站（某一種結尾的步驟都算那一站），連續重複的併掉 */
const walkedStations = computed(() => {
  const n = props.view.items.length
  const seq: number[] = []
  for (const id of props.visited) {
    const i = props.view.items.findIndex(it => it.id === id)
    const ending = i >= 0 ? null : endingOfNode(props.view, id)
    const s = i >= 0 ? i : ending ? n + props.view.endings.indexOf(ending) : -1
    if (s >= 0 && seq.at(-1) !== s) seq.push(s)
  }
  return seq
})
const walkedEdges = computed(() => {
  const set = new Set<string>()
  const seq = walkedStations.value
  for (let k = 1; k < seq.length; k++) set.add(`${seq[k - 1]}>${seq[k]}`)
  return set
})

const railEls = computed(() => map.value.rails.flatMap((on, i) => (on
  ? [{
      i,
      walked: walkedEdges.value.has(`${i}>${i + 1}`),
      style: { left: `${PAD + 16}px`, top: `${geo.value.rowTop(i) + PILL_H - 1}px`, height: `${PITCH - PILL_H + 2}px` },
    }]
  : [])))

const bracketEls = computed(() => map.value.brackets.map((b) => {
  const g = geo.value
  const lo = Math.min(b.from, b.to)
  const hi = Math.max(b.from, b.to)
  const top = g.rowY(lo) - 1
  const h = g.rowY(hi) - g.rowY(lo) + 2
  const r = Math.min(14, h / 2)
  return {
    key: `${b.from}>${b.to}`,
    label: b.labels.join('、'),
    cls: { 'is-walked': walkedEdges.value.has(`${b.from}>${b.to}`), 'is-backward': b.backward },
    style: {
      left: `${g.pillRight}px`,
      top: `${top}px`,
      width: `${g.laneX(b.lane) - g.pillRight + 1}px`,
      height: `${h}px`,
      borderRadius: `0 ${r}px ${r}px 0`,
      zIndex: 1 + 2 * b.lane,
    },
    arrowStyle: { left: `${g.pillRight}px`, top: `${g.rowY(b.to) - 4}px` },
    chipStyle: { left: `${g.laneX(b.lane)}px`, top: `${g.rowY(b.labelGap) + PITCH / 2}px` },
  }
}))

const hopEls = computed(() => map.value.hops.map(h => ({
  key: `${h.lane}-${h.station}`,
  style: { left: `${geo.value.laneX(h.lane) - 4}px`, top: `${geo.value.rowY(h.station) - 6}px`, zIndex: 2 + 2 * h.lane },
})))

const stationEls = computed(() => {
  const ids = map.value.stationIds
  const n = props.view.items.length
  const many = props.view.endings.length > 1
  const walked = new Set(walkedStations.value)
  return ids.map((id, i) => {
    const isEnd = i >= n
    const ending = isEnd ? props.view.endings[i - n]! : null
    const item = props.view.items[i]
    const t = ending?.terminal
    const endSub = !t ? '' : t.type === 'module' ? '送模組' : t.thenHandoff ? '回覆・轉真人' : '回覆'
    const label = !ending ? props.itemLabel(item!) : many && props.endingLabel ? props.endingLabel(ending) : '最後'
    return {
      id,
      n: i + 1,
      isEnd,
      label,
      // 站太窄（右邊那欄 300 寬時約 130px）就不放小字，不然「最後」兩個字會被擠成「最…」；好幾種結尾時名字比較長，不放
      sub: isEnd && !many && geo.value.pillW >= 150 ? endSub : '',
      title: isEnd ? `${label}：${endSub}` : `第 ${i + 1} 題・${label}`,
      jumpId: t ? t.id : id,
      current: !isEnd && props.current === id,
      walked: walked.has(i),
      flagged: !isEnd && props.flagged.has(id),
      style: { left: `${PAD}px`, top: `${geo.value.rowTop(i)}px`, width: `${geo.value.pillW}px` },
    }
  })
})
</script>

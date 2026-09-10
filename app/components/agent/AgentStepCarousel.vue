<template>
  <div
    v-if="items.length"
    ref="rootEl"
    class="agm-carousel"
    tabindex="0"
    role="group"
    :aria-label="`操作步驟：第 ${idx + 1} 步，共 ${items.length} 步`"
    @keydown="onKeydown"
    @touchstart.passive="onTouchStart"
    @touchend.passive="onTouchEnd"
  >
    <!-- 圖在最上面、貼著卡的上緣（圓角吃在圖上）。跟「步驟」有關的東西全收在圖下面同一塊 -->
    <img
      ref="imgEl"
      class="agm-carousel__img"
      :src="current.src"
      :alt="`第 ${idx + 1} 步（共 ${items.length} 步）：${plain(current.caption)}`"
      @mouseenter="hover = true"
      @mouseleave="hover = false"
      @load="onImgLoad"
    >

    <!-- 「第 N 步」靠左、「共 N 步」靠右：右緣與步驟軌的末端同一條垂直線
         （兩者左右內距都是 11px），它正好在標「這條軌到哪裡結束」 -->
    <div class="agm-carousel__bar">
      <span class="agm-carousel__no">第 <b>{{ idx + 1 }}</b> 步</span>
      <span class="agm-carousel__total">共 {{ items.length }} 步</span>
    </div>

    <!-- 步驟軌：一格＝一步，三段式明暗階梯，位置永遠是最亮的那格 -->
    <div class="agm-carousel__track" aria-hidden="true">
      <i
        v-for="(_, i) in items"
        :key="i"
        :class="{ 'is-done': i < idx }"
        @click="manual(i)"
      ><b :style="{ width: fillWidth(i) }" /></i>
    </div>

    <!-- 這一步要做什麼。⛔ 圖說不自己標號：步序由上面的計數器獨家負責 -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="agm-carousel__cap" v-html="current.caption" />

    <div class="agm-carousel__nav">
      <!-- ⛔「再看一次」在最左、上一步／下一步在最右，中間隔開：它不是導航、是「從頭重來」。
           三顆併排的話，連按「下一步」讀到最後一步時手指再往右一點就是「回到第 1 步」，
           一按就失去讀到的位置。分站兩端後誤按成本歸零。
           ⚠️ 代價＝實心綠的鈕落在左邊，跟全站「主要動作靠右」相反；判斷是這顆不是這裡的
           主要動作（讀完步驟去 LINE 做事才是），它是沒看清楚時的補救。 -->
      <button
        v-if="showReplay"
        type="button"
        class="agm-carousel__replay"
        :class="{ 'is-glow': glow }"
        @click="replay"
      >↻ 再看一次</button>
      <!-- 三種狀態都要說得出口（⛔ 不要留空白：看不出是暫停還是還在播）。
           貼著它在講的按鈕，所以只留鈕面上看不到的那一半（左右鍵） -->
      <span class="agm-carousel__state">{{ stateText }}</span>
      <button type="button" class="agm-carousel__prev" :disabled="idx === 0" aria-label="上一步" @click="manual(idx - 1)">‹ 上一步</button>
      <button type="button" class="agm-carousel__next" :disabled="idx === items.length - 1" aria-label="下一步" @click="manual(idx + 1)">下一步 ›</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 步驟輪播卡：**一步一張圖，圖在上、步驟在下**（示意頁第四十二～四十六版落地，2026-09-10）。
 *
 * 取代「一支循環動畫演三四個動作」。舊做法的病：中途接上的人不知道演到第幾步、想多看一眼
 * 第②步只能等它繞回來，而該做什麼的字全擠在上面那則泡泡裡（`①…→②…→③…`）——
 * 眼睛要在「一行長字」與「一直在動的圖」之間來回對照。
 *
 * 行為規則（每一條都是踩過才定的，改之前先讀完）：
 *
 * ① **捲進畫面才自動播，而且只播一輪**：從第 1 步演到最後一步就**停在最後一步，不繞回**。
 *    繞回是 GIF 時代「中途接上的人不知道演到哪」的解法，輪播捲到才從第 1 步播起，
 *    那個觀眾已經不存在；而且「下一步」在最後一步是灰的（說「到底了」），畫面卻自己跳回
 *    開頭＝同一個元件講兩句相反的話。
 * ② 停下來原地給「↻ 再看一次」（實心綠、靠最左、**自己**演完現身時亮 3 下就停）。
 *    自動播的存在理由（一根手指都不動的人也保證看完全部步驟）由「播完整一輪才停」保住；
 *    這顆綠鈕順便告訴人「這東西可以按」。
 *    ⛔「下一步」刻意不綠不閃：閃爍＝「叫你按這裡」，自動播期間畫面本來就自己前進，
 *    一邊自動演一邊閃「下一步」是兩個訊號打架。
 * ③ **動過手就不再自動翻頁**（按鈕／步驟軌／鍵盤／左右滑都算）：他都動手了＝想照自己的
 *    速度看，畫面不該再自己跳走。想重播按「再看一次」。
 * ④ **滑鼠停在圖上才暫停**（移開就繼續），只管「還在自動播」的期間——滑鼠在圖上＝正在看
 *    內容；滑鼠在按鈕／圖說上＝他自己在控節奏，不用停。
 * ⑤ `prefers-reduced-motion` 開著就不自動播、**也不給重播鈕**（那個設定的意思就是
 *    「不要自己動」，這顆鈕會把自動播開回來）。
 * ⑥ **不在畫面內就不累計**：一頁好幾支輪播，全部一直播的話捲回去看前面那支已經亂跑好幾輪。
 * ⑦ 「再看一次」只在**走到最後一步**時現身＝跟「下一步變灰」同一個條件，兩個訊號講同一件事。
 *    ⛔ 別改回「自動播一停就給」：那會讓第 2/4 步也冒出這顆實心綠鈕，而那一刻該按的是
 *    「下一步」；按下去還會把讀到的位置丟掉，「再看『一次』」在還沒看完時也名不符實。
 *
 * ⛔ 計時用「累計真正播了多久」不是 `setTimeout`：hover 暫停再移開時，setTimeout 版本會
 *    **重新計時完整 4 秒**，進度條跑到一半卻要重跑＝條子跟行為不一致。累計制讓進度條成為真相來源。
 *
 * 樣式在 `app/assets/scss/components/_agent-chat.scss`（`.agm-carousel`）。
 */

const props = defineProps<{ steps: readonly { readonly src: string, readonly caption: string }[] }>()

/** 這一步自動播多久換下一步 */
const STEP_AUTO_MS = 4000

const rootEl = ref<HTMLElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)

// ── 圖載不起來就整步不收（跟 AgentMessageRenderer 的 shotReady 同一個理由）─────
// 劇本會先把圖接上、截圖之後才補進 public/onboarding/。這段期間直接畫 <img> 會是一排破圖。
// ⛔ 全部載不起來就整張卡不畫（`v-if="items.length"`），文字照常——不破版。
const ready = ref<boolean[]>(props.steps.map(() => false))
const items = computed(() => props.steps.filter((_, i) => ready.value[i]))
const current = computed(() => items.value[Math.min(idx.value, items.value.length - 1)] ?? { src: '', caption: '' })

const idx = ref(0)
/** 還在自動前進嗎 */
const auto = ref(false)
/** 自己演完一輪了嗎（狀態文字要說得出「演完了」） */
const finished = ref(false)
const hover = ref(false)
/** 在畫面內嗎（規則⑥） */
const visible = ref(false)
const glow = ref(false)
/** 這一步已經播了多久（累計制，見檔頭） */
const elapsed = ref(0)

let reduce = false
let last = 0
let raf = 0
let io: IntersectionObserver | null = null

const showReplay = computed(() => !auto.value && !reduce && idx.value === items.value.length - 1)

const stateText = computed(() => {
  if (auto.value) {
    if (hover.value)
      return '暫停中（移開滑鼠繼續播）'
    return visible.value ? '自動播放中' : '捲到畫面上就開始播'
  }
  return finished.value ? '演完了' : '也可以用左右鍵切換'
})

/** 圖的 alt 要唸得出這一步在講什麼，但圖說裡的 <b> 不能唸成標籤 */
function plain(html: string) {
  return html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
}

/** 自動播的時間走在「現在這格」裡面。⛔ 沒在自動播時要填滿 100% 不是收成 0：
 *  軌同時扛「你在第幾格」，收掉的話停下來就跟「還沒走到的格子」長得一樣 */
function fillWidth(i: number) {
  if (i !== idx.value)
    return '0%'
  const pct = auto.value ? Math.min(100, elapsed.value / STEP_AUTO_MS * 100) : 100
  return `${pct}%`
}

function tick(ts: number) {
  raf = 0
  if (!auto.value)
    return
  // 凍住：不累加（hover 或不在畫面內）
  if (hover.value || !visible.value) {
    last = ts
    raf = requestAnimationFrame(tick)
    return
  }
  if (last)
    elapsed.value += ts - last
  last = ts
  if (elapsed.value >= STEP_AUTO_MS) {
    if (idx.value === items.value.length - 1) {
      // 播完一輪就停在最後一步（不繞回）：最後一格通常是「做完的樣子」，天然的休息畫面
      auto.value = false
      finished.value = true
      // 自己演完的那一刻亮 3 下＝「接下來換你」。手動停下來冒出的不亮（manual 不加）：
      // 人已經在操作，不用再喊他
      glow.value = true
      return
    }
    idx.value += 1
    elapsed.value = 0
  }
  raf = requestAnimationFrame(tick)
}

function schedule() {
  if (raf)
    cancelAnimationFrame(raf)
  raf = 0
  last = 0
  if (auto.value)
    raf = requestAnimationFrame(tick)
}

/** 手動切換：動過手就不再自動翻頁（規則③） */
function manual(to: number) {
  auto.value = false
  finished.value = false
  glow.value = false
  idx.value = Math.max(0, Math.min(items.value.length - 1, to)) // 夾住不繞：走到底就是底
  elapsed.value = 0
  schedule()
}

function replay() {
  glow.value = false // 收掉這次的亮光，下次演完才會再亮
  finished.value = false
  idx.value = 0
  elapsed.value = 0
  auto.value = true
  schedule()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') {
    manual(idx.value - 1)
    e.preventDefault()
  }
  if (e.key === 'ArrowRight') {
    manual(idx.value + 1)
    e.preventDefault()
  }
}

let touchX: number | null = null
function onTouchStart(e: TouchEvent) {
  touchX = e.touches[0]?.clientX ?? null
}
function onTouchEnd(e: TouchEvent) {
  if (touchX == null)
    return
  const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX
  if (Math.abs(dx) > 40)
    manual(idx.value + (dx < 0 ? 1 : -1))
  touchX = null
}

/**
 * 第一張圖解碼完再捲一次。
 *
 * ⛔ 一定要等圖解碼完：訊息推進來的那一刻 `<img>` 高度還是 0，頁面捲到底之後圖才長出
 *    300+px，捲動位置沒更新＝教學明明在上面卻看不到圖（實測只露一小截）。
 * ⚠️ 只在「本來就貼在底部」時才捲：使用者自己往上翻在看前面的步驟時，不可以把他拉回去。
 */
let scrolledOnce = false
function onImgLoad() {
  if (scrolledOnce)
    return
  scrolledOnce = true
  let el = rootEl.value?.parentElement
  while (el && el.scrollHeight <= el.clientHeight + 1)
    el = el.parentElement
  if (!el)
    return
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight
  // 這張卡自己的高度也算「還沒捲到」的合理範圍——它剛剛才長出來
  if (gap <= (rootEl.value?.offsetHeight ?? 0) + 240)
    nextTick(() => el!.scrollTo({ top: el!.scrollHeight }))
}

onMounted(() => {
  reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  auto.value = !reduce

  for (const [i, s] of props.steps.entries()) {
    const probe = new Image()
    probe.onload = () => { ready.value = ready.value.map((v, k) => (k === i ? true : v)) }
    probe.src = s.src
  }

  // 只在畫面內才累計（規則⑥）。
  // ⛔ 建立 observer 時**不可以**順便要求 `rootEl` 已經存在：掛載這一刻圖都還在探，
  //    `items` 是空的、`v-if` 還沒生出根節點，`rootEl` 必然是 null——把兩件事寫成
  //    同一個條件，observer 就永遠不會被建立，而 fallback 又把 `visible` 設成 true，
  //    結果是**整條規則⑥靜默失效**：畫面外的每一支輪播都在跑，人捲到的時候已經演完了。
  //    （2026-09-10 headless 驗收抓到：第一次量就已經在第 2 步。）
  //    建立 observer 歸建立，真正 observe 交給下面那個 watch。
  if (window.IntersectionObserver) {
    io = new IntersectionObserver((es) => {
      const was = visible.value
      visible.value = !!es[0]?.isIntersecting
      // last 歸零：不把不在畫面的時間補算進來
      if (visible.value !== was)
        last = 0
    }, { threshold: 0.25 })
    observeWhenReady()
  }
  else {
    // 沒有 IntersectionObserver 就只能一律當作看得到（總比不播好）
    visible.value = true
  }
  schedule()
})

function observeWhenReady() {
  if (!io)
    return
  if (rootEl.value) {
    io.observe(rootEl.value)
    return
  }
  nextTick(() => {
    if (io && rootEl.value)
      io.observe(rootEl.value)
  })
}

// 圖是非同步探出來的，`items` 從 0 長到 n；根節點要等第一張圖進來才生得出來
watch(items, (v, old) => {
  if (old.length === 0 && v.length > 0) {
    observeWhenReady()
    schedule()
  }
})

onBeforeUnmount(() => {
  if (raf)
    cancelAnimationFrame(raf)
  io?.disconnect()
})
</script>

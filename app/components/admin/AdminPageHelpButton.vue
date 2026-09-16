<template>
  <!-- 空狀態那種「有位子講話」的地方：直接給一句看得懂的邀請，不要一顆小問號 -->
  <el-button
    v-if="props.label && available.length"
    class="page-help-link"
    text
    size="small"
    @click="startFirst()"
  >
    {{ props.label }}
  </el-button>

  <!-- 問號版：包一層才放得下「第一次進這一頁」的一次性提示，也給總覽導覽一個錨點 -->
  <span v-else-if="available.length || availableGuides.length" class="page-help" data-tour="page-help">
    <!-- 只有一支教學、也沒有劇本：一顆問號直接開跑 -->
    <el-tooltip v-if="available.length === 1 && !availableGuides.length" content="這頁怎麼用" placement="top">
      <el-button
        class="page-help-btn"
        :class="{ 'is-hinting': hinting }"
        text
        size="small"
        :icon="QuestionFilled"
        aria-label="這頁怎麼用"
        @click="startFirst()"
      />
    </el-tooltip>

    <!-- 多支教學：先讓人挑（機器人模組有六支，直接開第一支等於幫使用者亂選） -->
    <el-dropdown v-else trigger="click" placement="bottom-start" @visible-change="dismissHint()">
      <el-tooltip content="這頁怎麼用" placement="top">
        <el-button
          class="page-help-btn"
          :class="{ 'is-hinting': hinting }"
          text
          size="small"
          :icon="QuestionFilled"
          aria-label="這頁怎麼用"
        />
      </el-tooltip>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="t in available"
            :key="t.id"
            @click="start(t)"
          >
            {{ t.label }}<span class="page-help-btn__steps">{{ stepCount(t) }} 步</span>
          </el-dropdown-item>
          <!-- 帶著做的劇本（D-40 補遺）：跟導覽不同——導覽讓你看一遍畫面，劇本陪你做完
               並驗證，所以尾註不是步數是「陪你做」。放導覽後面＋分隔線：問號的主客群是
               「回來查怎麼用」的人，從零開始的人多半從空狀態或小幫手清單進來 -->
          <el-dropdown-item
            v-for="g in availableGuides"
            :key="g.id"
            :divided="available.length > 0"
            @click="startGuide(g.id)"
          >
            {{ g.title }}<span class="page-help-btn__steps">陪你做</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <!-- 一次性提示：第一次進這一頁時讓這顆灰問號出個聲，點過或看過就永遠不再出現。
         自動導覽剛跑完的話換句話說——他已經看過內容了，這時要回答的是「下次去哪找」 -->
    <span v-if="hinting" class="page-help-hint" role="status">{{ hintText }}</span>
  </span>
</template>

<script setup lang="ts">
import { QuestionFilled } from '@element-plus/icons-vue'
import type { TutorialTopic } from '~/utils/tutorial-topics'
import { decideAutoTour } from '~/utils/auto-tour-gate'

/**
 * 頁首「這頁怎麼用」（2026-08-26 `D-33` P1-5）。
 *
 * 為什麼是這一項投報率最高：22 支逐步導覽、80 個畫面錨點早就寫好了，但入口只有
 * 「右下角小幫手 → 教學分頁 → 挑主題」三層點擊，而且**完全不看你在哪一頁**
 * （`TutorialAgent` 整份檔案沒讀過當前路由）。現成資產沒被用起來，只差這顆按鈕。
 *
 * ⛔ 沒有可跑的教學就整顆不畫：`topics` 已依角色與功能旗標過濾（觀察者、關掉的功能不顯示
 *    其教學），所以按了保證跑得起來——不要出現按了沒反應的按鈕。
 *
 * 2026-09-16 老闆拍板**改成自動跑**：每個帳號第一次進到某一頁，就直接把那一頁的導覽
 * 跑給他看（推翻 08-26「不自動跑」那條，當時的折衷是下面那句四秒的灰字提示）。
 * 「看過了」記在帳號上不是記在瀏覽器上，見 `useTourSeen`。
 *
 * 2026-08-28 加上「第一次進這一頁」的一次性提示（老闆拍板）：這顆刻意做小做灰的問號
 * 完全被動，全站沒有任何機制指出它的存在——同一個後台裡會動的只有異常紅點，
 * 等於「壞了」會出聲、「怎麼用」永遠沉默。
 * ⛔ 只亮一次、不循環閃爍：08-28 同日才拍板側欄只有紅點慢呼吸，再多一個常年會動的東西，
 *    兩個都會被當成裝飾。看過就寫進 localStorage，永久不再出現。
 */
const props = defineProps<{
  /** 這一頁的教學主題 id（對應 utils/tutorial-topics）。多支就讓使用者挑 */
  topics: string[]
  /**
   * 這一頁的「帶著做」劇本 id（對應 utils/agent-guides 的 WALKTHROUGH_GUIDES）。
   * 跟導覽的差別要讓使用者看得出來：導覽看一遍畫面、劇本陪你做完並驗證（尾註「陪你做」）。
   */
  guides?: string[]
  /**
   * 有給就改成一顆帶字的文字按鈕（空清單那種有位子講話的地方用）。
   * 這時只會跑第一支——空狀態不該再叫人先挑一份教學。
   */
  label?: string
}>()

const { topics: visibleTopics, stepCount, startTopic, tourOpen, openGuide, endTour, lastTopicId } = useTutorial()
const { canOperate, canManageSettings } = useWorkspace()
const { ensureLoaded: ensureTourSeen, hasSeen: tourSeen, markSeen: markTourSeen } = useTourSeen()
const { loaded: setupLoaded, onboardingIncomplete } = useSetupStatus()

/** 這一頁掛的劇本裡，這個角色真的跑得動的那幾條（同導覽：跑不動就整條不出現） */
const availableGuides = computed(() =>
  (props.guides ?? [])
    .map(id => WALKTHROUGH_GUIDES.find(g => g.id === id))
    .filter((g): g is (typeof WALKTHROUGH_GUIDES)[number] => Boolean(g))
    .filter(g => (g.requires === 'settings' ? canManageSettings.value : canOperate.value))
    .map(g => ({ id: g.id, title: AGENT_GUIDES[g.id].title })),
)

function startGuide(id: string) {
  dismissHint()
  openGuide(id)
}

/** 這個帳號現在真的跑得起來的那幾支，順序照傳進來的順序（不是註冊表順序） */
const available = computed<TutorialTopic[]>(() =>
  props.topics
    .map(id => visibleTopics.value.find(t => t.id === id))
    .filter((t): t is TutorialTopic => Boolean(t)),
)

function start(topic: TutorialTopic) {
  dismissHint()
  void startTopic(topic)
}

/** 第一支（⛔用函式不用 available[0]!——Vue 模板不吃 TS 的非空斷言，會變成解析錯誤） */
function startFirst() {
  const first = available.value[0]
  if (first)
    start(first)
}

// ── 第一次進這一頁自動跑導覽 ──

/** 等一下再開：剛換頁那一瞬間畫面還在長，馬上蓋上黑幕會高亮到還沒排好的東西 */
const AUTO_TOUR_DELAY_MS = 900

/**
 * 自動導覽這件事現在走到哪。**提示氣泡要等它變成 `off` 才能放**——
 * ⛔ 不設這一格的話：氣泡在 onMounted 當下就會放（那時還不知道要不要自動跑），
 *    0.9 秒後導覽的黑幕蓋上來，這個一輩子只有一次的提示就在幕後亮完四秒沒人看到。
 */
const autoTourState = ref<'deciding' | 'pending' | 'off'>('deciding')
/** 這一頁的導覽是自動跑起來的：結尾那句提示要換句話說 */
const autoToured = ref(false)
let autoTourTimer: number | undefined
let unmounted = false

/**
 * ⛔ 在 setup 當下就讀起來，不能等到 onMounted：`?tour=` 是開通結尾指定的那一支導覽，
 *    `TutorialAgent` 一掛載就會把它從網址上清掉。晚一步讀到的是空字串，結果就是
 *    「他選的那支導覽」跟「這一頁的自動導覽」兩支互相蓋。
 */
const hasTourQuery = !!String(useRoute().query.tour || '').trim()

/** 記在帳號上的鑰匙＝這一頁教哪幾支（`hintKey` 的瀏覽器版用同一組 id） */
function tourKey() {
  return props.topics.join('|')
}

/**
 * 回傳「這件事處理完了，不用再等」。條件沒到齊就回 false，讓外面的 watch 再試一次。
 * 判斷本身在 `utils/auto-tour-gate.ts`（純函式、有測試），這裡只負責餵狀態與排程。
 */
function tryAutoTour(seenReady: boolean): boolean {
  const key = tourKey()
  const decision = decideAutoTour({
    seenReady,
    setupLoaded: setupLoaded.value,
    onboardingIncomplete: onboardingIncomplete.value,
    hasTopics: available.value.length > 0,
    tourOpen: tourOpen.value,
    seen: !key || tourSeen(key),
  })
  if (decision === 'wait')
    return false
  if (decision === 'start') {
    autoTourState.value = 'pending'
    autoTourTimer = window.setTimeout(() => {
      autoTourTimer = undefined
      void startAutoTour()
    }, AUTO_TOUR_DELAY_MS)
  }
  return true
}

async function startAutoTour() {
  const topic = available.value[0]
  if (unmounted || tourOpen.value || !topic) {
    autoTourState.value = 'off'
    return
  }
  autoToured.value = true
  await startTopic(topic)
  // ⛔ `startTopic` 會等目標元素出現（最多三秒）。這幾秒裡人可能已經換頁了——
  //    不收掉的話，黑幕會蓋在一個完全不相干的畫面上、每一步都指不到東西。
  if (unmounted) {
    if (tourOpen.value)
      endTour()
    autoToured.value = false
    autoTourState.value = 'off'
    return
  }
  // ⛔ 沒真的開起來就不算數（例如步驟被前提全部刷掉）：這時不記，下次進來再試一次。
  //    真的開起來的那一刻由下面的 watch 記帳，不在這裡記。
  if (!tourOpen.value)
    autoToured.value = false
  autoTourState.value = 'off'
}

/**
 * 記帳：這一頁的導覽真的開起來了就算看過。
 * 掛在 `tourOpen` 而不是寫在 `startAutoTour` 裡，是因為**自己從問號點開的那一次也算**——
 * 他已經看過了，下次進來不該再被自動帶一遍。
 */
watch(tourOpen, (open) => {
  if (!open)
    return
  const id = lastTopicId.value
  const key = tourKey()
  if (key && id && props.topics.includes(id))
    markTourSeen(key)
})

onMounted(() => {
  if (props.label || hasTourQuery) {
    autoTourState.value = 'off'
    return
  }
  const seenReady = ref(false)
  // 查不到就當「不知道」：`useTourSeen` 會退回本機那一份，最壞是在這台瀏覽器多帶一遍
  void ensureTourSeen().finally(() => { seenReady.value = true })
  if (tryAutoTour(seenReady.value)) {
    if (autoTourState.value === 'deciding')
      autoTourState.value = 'off'
    return
  }
  const stop = watch([seenReady, setupLoaded, onboardingIncomplete, available, tourOpen], () => {
    if (!tryAutoTour(seenReady.value))
      return
    if (autoTourState.value === 'deciding')
      autoTourState.value = 'off'
    stop()
  })
})

// ── 第一次進這一頁的一次性提示 ──
const HINT_MS = 4200
const hinting = ref(false)
/** 自動導覽剛跑完的話，他要的答案不是「這頁怎麼用」而是「下次去哪再看一遍」 */
const hintText = computed(() => (autoToured.value ? '想再看一遍就按這裡' : '這頁怎麼用？'))
/** 顯示計時器：離開這一頁要收掉，否則「已經看過」會在元件拆掉之後才被寫進去 */
let hintTimer: number | undefined

/** 記憶的鍵用「這一頁教哪幾支」，不用路由——同一頁在不同官方帳號底下路徑不同，但教學是同一批 */
function hintKey() {
  return `page-help-seen:${props.topics.join('|')}`
}

function dismissHint() {
  hinting.value = false
}

onMounted(() => {
  // 帶字版本身就在說話了，不需要再提示
  if (props.label)
    return
  /** 回傳「這件事處理完了」——沒有可跑的教學時回 false，等角色／旗標載完再試一次 */
  const fire = () => {
    if (!available.value.length)
      return false
    // ⛔導覽開著時先不放（2026-08-28 code review 抓到）：導覽的黑幕蓋在這顆氣泡上面，
    // 放了等於在幕後亮四秒鐘給沒人看。而開通完成正是「交棒到對話頁 ＋ 同時開導覽」，
    // 剛好就是這個情境——這個氣泡一輩子只出現一次，不能這樣被吃掉。
    // 回 false＝這件事還沒處理完，下面的 watch 會在導覽關掉後再試一次。
    if (tourOpen.value)
      return false
    // 同一個理由，再往前一步：自動導覽還在盤算或還沒開起來時也要讓路，
    // 否則這顆氣泡會在黑幕蓋上來的前 0.9 秒被放掉（見 autoTourState 那段）
    if (autoTourState.value !== 'off')
      return false
    try {
      if (localStorage.getItem(hintKey()))
        return true
    }
    catch {
      // 無痕視窗／擋 storage：寧可不提示，也不要變成每次進來都跳一次
      return true
    }
    hinting.value = true
    // ⛔「已經看過」要等**真的顯示完**才記（同一輪 review 抓到）：先記再顯示的話，
    // 任何讓它顯示不出來的情況都會把這一次性的機會永久花掉，而且沒有人會發現。
    hintTimer = window.setTimeout(() => {
      hintTimer = undefined
      dismissHint()
      try {
        localStorage.setItem(hintKey(), '1')
      }
      catch { /* 記不起來就下次再提醒一次，比永久消失好 */ }
    }, HINT_MS)
    return true
  }
  if (fire())
    return
  // 三件事都要等：角色／功能旗標是非同步載入的（載完才知道這一頁有沒有教學可跑），
  // 而導覽開著、或自動導覽還沒收工時 fire() 會刻意讓路——所以也要盯著它們的那一刻補放。
  const stop = watch([available, tourOpen, autoTourState], () => {
    if (fire())
      stop()
  })
})

/**
 * ⛔ 離開這一頁就把計時器收掉（2026-08-28 code review 修）。
 *
 * 不收的話：氣泡才出現 0.3 秒、使用者就換頁，元件已經拆了，計時器照樣在四秒後
 * 把「已經看過」寫進 localStorage——這個一輩子只有一次的提示就這樣被花掉，
 * 而且沒有任何人會發現。這正是上面那段「要等真的顯示完才記」想防的同一件事，
 * 只是漏了「顯示到一半就走人」這條路。
 */
onBeforeUnmount(() => {
  // 自動導覽同理，而且更要緊：排程還沒引爆就換頁的話，導覽會開在下一頁的畫面上
  unmounted = true
  if (autoTourTimer !== undefined) {
    clearTimeout(autoTourTimer)
    autoTourTimer = undefined
  }
  if (hintTimer !== undefined) {
    clearTimeout(hintTimer)
    hintTimer = undefined
  }
})
</script>

<!-- 樣式在 app/assets/scss/components/_block-status.scss 末段（同批 D-33 元件） -->

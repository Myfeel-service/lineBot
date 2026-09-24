<!--
  圖文選單「客人看到的樣子」＋「試按看看」（`C-233` → `C-243` → `C-253`）。

  **為什麼要有這個**：旁邊那張編輯畫布上，每一格都蓋著色塊（為了標出可點區域），
  所以店家在後台**從來沒看過那張圖乾淨的樣子**，判斷不出字夠不夠大、
  深色底會不會把文字吃掉、對齊有沒有歪。Chat Bar 那幾個字也從來沒被畫出來過。

  ⛔ **這裡一個色塊都不要疊**——疊了它就又變成第二張編輯畫布，這個功能就沒了。
     熱區是**完全透明**的，只有滑過去才浮出一條細框。
  ⛔ **不要再套假的聊天室外框**（`C-253` 拿掉）：綠色帳號列與藍色聊天區是純裝飾，
     卻吃掉整個預覽約一半的高度，害這張圖比旁邊的編輯畫布小一大截、兩張對不起來。
     留下來的兩樣都是客人**真的會看到**的東西：那張圖，和 Chat Bar 的字。

  ── 試按（`C-253`）：⛔ 四種動作客人經歷的事完全不同，不可以共用一套說法 ──────
  這是這支元件最容易做錯的地方，做錯的後果就是 `D-96`（推播預覽畫了一張客人
  一次都沒收到過的卡片，畫了四個月沒人發現）。照**真正送去 LINE 的那一份**分
  （對照 `richmenu.vue` 存檔時的 `apiAreas` 轉換）：

  | 店家設定的 | 存進 LINE 的 action               | 客人實際經歷                        |
  |-----------|----------------------------------|------------------------------------|
  | 開啟網址   | `uri`                            | **直接開網頁，收不到任何訊息**       |
  | 傳送文字   | `message`（帶貼標時 `postback`）  | **像客人自己打了那句話送出**         |
  | 觸發模組   | `postback`＝`triggerModule`      | 收到那個模組的訊息（唯一會收到訊息的）|
  | 切換選單   | `richmenuswitch`                 | **選單換一張，收不到任何訊息**       |

  ⛔ 所以「傳送文字」的泡泡要畫在**客人那一側**（那句話是他說的，不是我們回的），
     而「開啟網址」「切換選單」**一顆泡泡都不可以畫**。
  ⛔ 試按**絕對不可以真的貼標籤**：這幾格多半開著貼標，店家自己在後台亂點，
     客人名單就髒了，而且是靜靜髒掉沒人會發現。這裡只講「會貼哪幾顆」。
-->
<template>
  <div class="rmc">
    <!--
      聊天室外框（`C-253` 一度拿掉，2026-09-24 老闆要求拿回來＝`C-255`）。
      ⛔ 它不是裝飾：**這一格在 LINE 上是長在聊天室裡的**，沒有外框就看不出
         「選單會蓋住聊天室下半部」這件事，也看不出 Chat Bar 那一條在哪。
      ⛔ 外框要釘在**最右邊**（版面規則在 `_richmenu.scss` 的 `.rm-visual-split__customer`），
         跟中間那張拖格子的畫布拉開，兩件事才不會被看成同一張圖的兩份拷貝。
    -->
    <div class="rmc-frame">
      <div class="rmc-head">
        <span class="rmc-avatar">{{ oaInitial }}</span>
        <div class="rmc-meta">
          <span class="rmc-name">{{ oaName || '官方帳號' }}</span>
          <span class="rmc-sub">預覽・實際以 LINE 為準</span>
        </div>
      </div>

      <!--
        聊天區＝**試按的舞台**（`C-256`，老闆：「點擊選單會有的反應 直接呈現在示意的對話框」）。
        ⛔ 結果不要另開一塊面板掛在外面——客人是在**這個聊天室裡**收到訊息的，
           畫在別的地方等於又在講一件跟 LINE 不一樣的事。
        ⛔ 後台的說明一律走 `.rmc-sys`（置中灰色小字，像 LINE 的系統提示），
           **不可以長得像訊息泡泡**：那幾句話客人一句都不會收到。
      -->
      <div class="rmc-chat" :class="{ 'is-trying': tryIndex !== null }">
        <p v-if="tryIndex === null" class="rmc-chat-note">選單會蓋住聊天室下半部</p>

        <template v-else>
          <div class="rmc-sys rmc-sys--head">
            <span>按了第 {{ tryIndex + 1 }} 格</span>
            <el-button link size="small" @click="closeTry">收起來</el-button>
          </div>

          <!-- ① 沒設動作：這是真的會發生的事，要講 -->
          <p v-if="!tryAction?.type" class="rmc-sys rmc-sys--warn">
            這一格<b>還沒設定動作</b>，客人按下去不會有任何反應。
          </p>

          <!-- ② 切換選單：上面那張圖換掉，⛔ 聊天室裡一顆泡泡都不會多 -->
          <template v-else-if="tryAction.type === 'switch' || tryAction.type === 'richmenuswitch'">
            <p v-if="!switchTarget" class="rmc-sys rmc-sys--warn">
              這一格要切到的選單<b>已經找不到了</b>，客人按下去不會有反應。請重新選一個目標選單。
            </p>
            <template v-else>
              <p class="rmc-sys">
                選單換成「<b>{{ switchTarget.name }}</b>」，下面那張就是換過去的樣子。
                <b>聊天室不會多出任何訊息。</b>
              </p>
              <!-- ⛔ 三態：目標選單沒有圖時要講，不可以畫成一片空白 -->
              <p v-if="!switchTarget.imageUrl" class="rmc-sys rmc-sys--warn">
                不過「{{ switchTarget.name }}」<b>還沒有背景圖</b>，所以下面畫不出來。
              </p>
            </template>
          </template>

          <!-- ③ 開啟網址：⛔ 客人收不到訊息，一顆泡泡都不可以畫 -->
          <template v-else-if="tryAction.type === 'uri'">
            <p class="rmc-sys">
              客人會<b>直接被帶到這個網址</b>，<b>聊天室不會多出任何訊息</b>。
            </p>
            <p v-if="!String(tryAction.uri || '').trim()" class="rmc-sys rmc-sys--warn">
              但這一格<b>還沒填網址</b>，客人按下去不會有反應。
            </p>
            <div v-else class="rmc-sys rmc-sys--uri">
              <code>{{ tryAction.uri }}</code>
              <el-button link type="primary" size="small" @click="openUri(String(tryAction.uri))">
                在新分頁打開
              </el-button>
            </div>
          </template>

          <!-- ④ 傳送文字：泡泡在**客人那一側**（那句話是他說的，不是我們回的） -->
          <template v-else-if="tryAction.type === 'message'">
            <p v-if="!String(tryAction.text || '').trim()" class="rmc-sys rmc-sys--warn">
              這一格<b>還沒填文字</b>，客人按下去不會有反應。
            </p>
            <template v-else>
              <div class="rmc-said">{{ tryAction.text }}</div>
              <p class="rmc-sys rmc-sys--quiet">
                這句話是<b>客人送出的</b>。之後有沒有人回他，要看你的「自動回應」與 AI 設定。
              </p>
            </template>
          </template>

          <!-- ⑤ 觸發機器人模組：唯一會讓客人收到訊息的一種，泡泡直接畫在這個聊天室裡 -->
          <template v-else-if="tryAction.type === 'module'">
            <AdminActionPreview
              bare
              :action="tryAction"
              :module-options="moduleOptions"
              title=""
              empty-text="這一格還沒選模組，客人按下去不會有反應。"
            />
          </template>

          <!-- 貼標：⛔ 一定要講「這裡不會真的貼」，不然店家會以為自己剛剛弄髒了名單 -->
          <p v-if="tryTagNames.length" class="rmc-sys rmc-sys--quiet">
            還會幫客人貼上標籤{{ tryTagNames.map(n => `「${n}」`).join('') }}。
            <b>在這裡試按不會真的貼。</b>
          </p>
        </template>
      </div>

      <!--
        ⛔ 切過去之後一定要講「現在看的是哪一張」：切換選單會把整張圖與所有熱區換掉，
           不講的話店家會對著**另一張選單**繼續試按，而畫面上一點線索都沒有。
           （守門員第一版就是這樣被騙的：按了第 1 格之後，「第 3 格」已經是別張選單的第 3 格。）
      -->
      <div v-if="switchedMenu" class="rmc-switched">
        <span>現在看的是「<b>{{ switchedMenu.name || '另一張選單' }}</b>」</span>
        <el-button link type="primary" size="small" @click="backToOriginal">回到原本這張</el-button>
      </div>

      <!-- 那張圖，乾乾淨淨，照真實比例；熱區透明疊在上面 -->
      <div class="rmc-menu" :style="{ aspectRatio: `${width} / ${height}` }">
        <img v-if="shownImageUrl" :src="shownImageUrl" class="rmc-menu-img" alt="圖文選單背景圖">
        <div v-else class="rmc-menu-empty">還沒有背景圖</div>

        <button
          v-for="(hot, i) in hotspots"
          :key="`hot-${i}`"
          type="button"
          class="rmc-hot"
          :class="{ 'is-on': tryIndex === i }"
          :style="hot.style"
          :title="`試按第 ${i + 1} 格`"
          @click="onTry(i)"
        >
          <span class="rmc-hot__no">{{ i + 1 }}</span>
        </button>
      </div>

      <!-- Chat Bar：客人真的會看到這幾個字，而後台以前一處都沒畫過 -->
      <div class="rmc-bar">
        <span class="rmc-bar-caret" aria-hidden="true">▾</span>
        <span class="rmc-bar-text">{{ shownChatBarText || '選單' }}</span>
      </div>
    </div>

    <!--
      ⛔ 這裡**不要**再放一行「點圖上任何一格…」的提示：卡片標題右邊已經寫了
         「點任何一格試按」，重複一次是廢話，而且它會在外框底下卡掉 28px，
         害「高度拉滿」看起來沒拉滿（2026-09-24 量出來的）。
    -->
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { parseSwitchMenuData } from '~~/shared/action-schema'

interface MenuLike {
  id: string
  name?: string
  imageUrl?: string
  areas?: any[]
  size?: { width?: number, height?: number }
  chatBarText?: string
}

const props = withDefaults(defineProps<{
  imageUrl?: string
  chatBarText?: string
  width?: number
  height?: number
  oaName?: string
  /** 正在編輯的這張選單的區塊（含 bounds 與 action） */
  areas?: any[]
  /** 其他圖文選單，「切換選單」試按時要拿它的圖與格子 */
  menuOptions?: MenuLike[]
  moduleOptions?: Array<{ id: string, name: string }>
  tagOptions?: Array<{ id: string, name: string }>
}>(), {
  areas: () => [],
  menuOptions: () => [],
  moduleOptions: () => [],
  tagOptions: () => [],
})

const oaInitial = computed(() => (props.oaName || '官').trim().charAt(0).toUpperCase())

/** 比例壞掉時退回 LINE 的大版預設（2500×1686），⛔ 不要讓 aspect-ratio 變成 0 把整塊壓扁 */
const baseWidth = computed(() => Number(props.width) || 2500)
const baseHeight = computed(() => Number(props.height) || 1686)

const tryIndex = ref<number | null>(null)
/** 試按「切換選單」之後現在畫的是哪一張；null＝還是正在編輯的這一張 */
const switchedMenu = ref<MenuLike | null>(null)

/**
 * ⛔ 換一張選單編輯時，試按狀態一定要清掉——不清的話畫面上會留著上一張的
 *    「按了第 3 格」，而第 3 格在新的選單裡是完全不同的東西（或根本不存在）。
 */
watch(() => props.imageUrl, () => {
  tryIndex.value = null
  switchedMenu.value = null
})

const shownImageUrl = computed(() =>
  switchedMenu.value ? String(switchedMenu.value.imageUrl || '') : String(props.imageUrl || ''))

const shownChatBarText = computed(() =>
  switchedMenu.value ? String(switchedMenu.value.chatBarText || '') : String(props.chatBarText || ''))

/** 現在畫的那張選單的區塊——切過去之後熱區要跟著換，不然按到的是舊選單的格子 */
const shownAreas = computed<any[]>(() => {
  const list = switchedMenu.value ? switchedMenu.value.areas : props.areas
  return Array.isArray(list) ? list : []
})

const width = computed(() =>
  Number(switchedMenu.value?.size?.width) || (switchedMenu.value ? 2500 : baseWidth.value))
const height = computed(() =>
  Number(switchedMenu.value?.size?.height) || (switchedMenu.value ? 1686 : baseHeight.value))

const hotspots = computed(() => shownAreas.value.map((a) => {
  const b = a?.bounds || { x: 0, y: 0, width: width.value, height: height.value }
  return {
    style: {
      left: `${(Number(b.x || 0) / width.value) * 100}%`,
      top: `${(Number(b.y || 0) / height.value) * 100}%`,
      width: `${(Number(b.width || 0) / width.value) * 100}%`,
      height: `${(Number(b.height || 0) / height.value) * 100}%`,
    },
  }
}))

const tryArea = computed(() => (tryIndex.value === null ? null : shownAreas.value[tryIndex.value] ?? null))
const tryAction = computed<any>(() => tryArea.value?.action ?? null)

/** 「切換選單」的目標。⛔ 找不到要回 null 讓畫面講出來，不要靜靜當成沒事 */
const switchTarget = computed<MenuLike | null>(() => {
  const a = tryAction.value
  if (!a) return null
  if (a.type !== 'switch' && a.type !== 'richmenuswitch') return null
  const { targetMenuId } = parseSwitchMenuData(String(a.data || ''))
  if (!targetMenuId) return null
  return props.menuOptions.find(m => m.id === targetMenuId) ?? null
})

const tryTagNames = computed(() => {
  const t = tryAction.value?.tagging
  if (t?.enabled !== true) return []
  const ids: string[] = Array.isArray(t.addTagIds) ? t.addTagIds : []
  return ids
    .map(id => props.tagOptions.find(x => x.id === id)?.name ?? '')
    .filter(Boolean)
})

function onTry(i: number) {
  tryIndex.value = i
  // 切換選單要「真的換過去」——換過去長什麼樣正是這一格最難憑空想像的事
  const a = shownAreas.value[i]?.action
  if (a && (a.type === 'switch' || a.type === 'richmenuswitch')) {
    const { targetMenuId } = parseSwitchMenuData(String(a.data || ''))
    const target = props.menuOptions.find(m => m.id === targetMenuId)
    if (target) switchedMenu.value = target
  }
}

function closeTry() {
  tryIndex.value = null
}

function backToOriginal() {
  switchedMenu.value = null
  tryIndex.value = null
}

/**
 * ⛔ `noopener`：開的是店家自己填的網址，不加的話那一頁拿得到 `window.opener`，
 *    可以把後台這一頁導去別的地方（反向標籤劫持）。
 */
function openUri(uri: string) {
  window.open(uri, '_blank', 'noopener,noreferrer')
}
</script>

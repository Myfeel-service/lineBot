<!--
  「這個東西被誰用了」的清單（`C-209`）。

  兩個地方共用：機器人模組的「會在這些時候發出」、標籤停用前的確認框。
  ⛔ 三種狀態要長得不一樣，不可以混成同一句話：
    ① 有人用 → 逐類列出名字（點得進那一頁）
    ② 真的沒人用 → 講清楚後果（模組：客人永遠走不到；標籤：停用不會影響任何設定）
    ③ **這次查不到** → 明講哪幾類沒查到，⛔ 絕不可以顯示成 ②
       （把「查不到」講成「沒有人用」，人就會放心把正在服務客人的東西停掉）
-->
<template>
  <div class="config-refs">
    <div v-if="loading" class="config-refs__line config-refs__line--muted">
      正在查有哪些地方用到它…
    </div>

    <template v-else>
      <div v-if="failedKinds.length" class="config-refs__line config-refs__line--warn">
        ⚠️ 這次有 {{ failedKinds.length }} 類查不到（{{ failedKindLabels }}），
        下面這份清單可能不完整——先別當成「沒有人用」。
      </div>

      <div v-if="!refs.length && !failedKinds.length" class="config-refs__line config-refs__line--muted">
        {{ emptyText }}
      </div>

      <!--
        ⛔ **預設只給一句話，不要把名字全攤開**（2026-09-22 老闆實際截圖回報）。
        「真人客服」這種被 50 個模組指到的，全攤開會變成一面看不懂的字牆，
        而且第一眼要知道的本來就只有「有沒有人會叫它、大概從哪幾種地方來」。
        名字是「我要去修改哪一個」時才需要，所以收在「看是哪些」後面。
      -->
      <template v-if="refs.length">
        <p v-if="showSummary" class="config-refs__summary">
          有 <strong>{{ refs.length }}</strong> 個地方會用到它：{{ summaryText }}。
          <button type="button" class="config-refs__toggle" @click="expanded = !expanded">
            {{ expanded ? '收起來' : '看是哪些' }}
          </button>
        </p>

        <ul v-if="expanded" class="config-refs__groups">
          <li v-for="group in groups" :key="group.kind" class="config-refs__group">
            <div class="config-refs__group-head">
              <NuxtLink :to="group.path" class="ar-link config-refs__kind">
                {{ group.label }}
              </NuxtLink>
              <span class="config-refs__hint">{{ group.hint }}</span>
            </div>
            <div class="config-refs__names">
              <!--
                `D-86`：名字**點得進那一筆**的類別（目前只有機器人模組，見 `configRefPath`）
                就做成連結；其餘維持純文字。
                ⛔ 不要為了整齊把全部都做成連結——沒做 `?id=` 的頁面點過去只會落在清單上，
                   那就退回老闆抱怨過的「看起來可點卻沒用」。
              -->
              <template v-for="ref in group.shown" :key="ref.kind + ref.id">
                <NuxtLink
                  v-if="group.deepLinkable"
                  :to="configRefPath(props.workspaceId, ref.kind, ref.id)"
                  :class="['config-refs__name', 'config-refs__name--link', { 'config-refs__name--inactive': ref.inactive }]"
                >{{ ref.label }}<template v-if="ref.inactive">（停用中）</template></NuxtLink>
                <span
                  v-else
                  :class="['config-refs__name', { 'config-refs__name--inactive': ref.inactive }]"
                >{{ ref.label }}<template v-if="ref.inactive">（停用中）</template></span>
              </template>
              <!--
                ⛔ 截斷要說出來被藏了幾個，不可以安靜少列。
                ⭐ 而且要**按得開**（2026-09-22 老闆回報）：「還有 41 個」只說不給看，
                   等於告訴他有 41 個他管不到的東西——他要找的那一個很可能就在裡面。
                   浮層本身有 `max-height` 會捲動，攤開不會把畫面撐爛。
              -->
              <button
                v-if="group.hiddenCount || expandedKinds.has(group.kind)"
                type="button"
                class="config-refs__more"
                @click="toggleKind(group.kind)"
              >{{ group.hiddenCount ? `還有 ${group.hiddenCount} 個` : '收起來' }}</button>
            </div>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  CONFIG_REF_KIND_HINT,
  CONFIG_REF_KIND_LABEL,
  configRefKindIsDeepLinkable,
  configRefPath,
  summarizeConfigRefs,
  type ConfigRef,
  type ConfigRefKind,
} from '~~/shared/config-references'

const props = withDefaults(defineProps<{
  refs: ConfigRef[]
  failedKinds?: ConfigRefKind[]
  workspaceId: string
  loading?: boolean
  emptyText?: string
  /**
   * 一打開就把名字攤開。
   * ⛔ 模組編輯器那一條要 `false`（「真人客服」被 50 個模組指到，攤開是一面字牆，
   *    而且那裡第一眼只需要知道「有沒有人會叫它」）；
   * ⛔ 標籤的「用在哪」視窗要 `true`——**人是為了看名字才點開那個視窗的**，
   *    再叫他按一次「看是哪些」等於白開一個視窗。
   */
  defaultExpanded?: boolean
  /**
   * 要不要印那句「有 N 個地方會用到它…」。
   * ⛔ 放在浮層裡時給 `false`——**開浮層的那顆按鈕本身就是那句話**，再印一次是重複。
   */
  showSummary?: boolean
}>(), {
  failedKinds: () => [],
  loading: false,
  emptyText: '目前沒有任何地方用到它。',
  defaultExpanded: false,
  showSummary: true,
})

/** 顯示順序刻意固定：先講客人最常走到的那幾條路 */
const ORDER: ConfigRefKind[] = ['script', 'richmenu', 'flow', 'campaign', 'broadcast', 'supportPreset']

const expanded = ref(props.defaultExpanded)

/**
 * 展開後每一類**預設**最多列幾個名字；⛔ 超過的要講「還有 N 個」，不可以安靜少列。
 * 按下那句話會把該類全部攤開（`expandedKinds`）——一次只攤一類，
 * 因為人是為了找某一個特定的東西才按的，不是為了看全部。
 */
const MAX_NAMES_PER_KIND = 8

const expandedKinds = ref(new Set<ConfigRefKind>())

function toggleKind(kind: ConfigRefKind) {
  // ⛔ 用新的 Set 指派，不要在原 Set 上 add/delete：Vue 的 ref 對 Set 內部異動不會觸發更新
  const next = new Set(expandedKinds.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  expandedKinds.value = next
}

const summaryText = computed(() => summarizeConfigRefs(props.refs))

const groups = computed(() =>
  ORDER
    .map((kind) => {
      const items = props.refs.filter(ref => ref.kind === kind)
      const showAll = expandedKinds.value.has(kind)
      return {
        kind,
        label: CONFIG_REF_KIND_LABEL[kind],
        hint: CONFIG_REF_KIND_HINT[kind],
        path: configRefPath(props.workspaceId, kind),
        // `D-86`：這一類的名字點得進「那一筆」嗎（目前只有機器人模組那頁吃 `?id=`）
        deepLinkable: configRefKindIsDeepLinkable(kind),
        items,
        shown: showAll ? items : items.slice(0, MAX_NAMES_PER_KIND),
        hiddenCount: showAll ? 0 : Math.max(0, items.length - MAX_NAMES_PER_KIND),
      }
    })
    .filter(group => group.items.length > 0),
)

const failedKindLabels = computed(() =>
  props.failedKinds.map(kind => CONFIG_REF_KIND_LABEL[kind]).join('、'),
)
</script>

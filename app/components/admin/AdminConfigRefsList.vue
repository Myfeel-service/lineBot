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
        <p class="config-refs__summary">
          有 <strong>{{ refs.length }}</strong> 個地方會用到它：{{ summaryText }}。
          <button type="button" class="config-refs__toggle" @click="expanded = !expanded">
            {{ expanded ? '收起來' : '看是哪些' }}
          </button>
        </p>

        <ul v-if="expanded" class="config-refs__groups">
          <li v-for="group in groups" :key="group.kind" class="config-refs__group">
            <NuxtLink :to="group.path" class="ar-link config-refs__kind">
              {{ group.label }}
            </NuxtLink>
            <span class="config-refs__hint">（{{ group.hint }}）</span>
            <span class="config-refs__names">
              <span
                v-for="ref in group.shown"
                :key="ref.kind + ref.id"
                :class="['config-refs__name', { 'config-refs__name--inactive': ref.inactive }]"
              >{{ ref.label }}<template v-if="ref.inactive">（停用中）</template></span>
              <!-- ⛔ 截斷要說出來被藏了幾個，不可以安靜少列 -->
              <span v-if="group.hiddenCount" class="config-refs__more">
                還有 {{ group.hiddenCount }} 個
              </span>
            </span>
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
}>(), {
  failedKinds: () => [],
  loading: false,
  emptyText: '目前沒有任何地方用到它。',
  defaultExpanded: false,
})

/** 顯示順序刻意固定：先講客人最常走到的那幾條路 */
const ORDER: ConfigRefKind[] = ['script', 'richmenu', 'flow', 'campaign', 'broadcast', 'supportPreset']

const expanded = ref(props.defaultExpanded)

/** 展開後每一類最多列幾個名字；⛔ 超過的要講「還有 N 個」，不可以安靜少列 */
const MAX_NAMES_PER_KIND = 8

const summaryText = computed(() => summarizeConfigRefs(props.refs))

const groups = computed(() =>
  ORDER
    .map((kind) => {
      const items = props.refs.filter(ref => ref.kind === kind)
      return {
        kind,
        label: CONFIG_REF_KIND_LABEL[kind],
        hint: CONFIG_REF_KIND_HINT[kind],
        path: configRefPath(props.workspaceId, kind),
        items,
        shown: items.slice(0, MAX_NAMES_PER_KIND),
        hiddenCount: Math.max(0, items.length - MAX_NAMES_PER_KIND),
      }
    })
    .filter(group => group.items.length > 0),
)

const failedKindLabels = computed(() =>
  props.failedKinds.map(kind => CONFIG_REF_KIND_LABEL[kind]).join('、'),
)
</script>

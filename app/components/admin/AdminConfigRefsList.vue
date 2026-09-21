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

      <ul v-if="refs.length" class="config-refs__groups">
        <li v-for="group in groups" :key="group.kind" class="config-refs__group">
          <NuxtLink :to="group.path" class="ar-link config-refs__kind">
            {{ group.label }}
          </NuxtLink>
          <span class="config-refs__hint">（{{ group.hint }}）</span>
          <span class="config-refs__names">
            <span
              v-for="ref in group.items"
              :key="ref.kind + ref.id"
              :class="['config-refs__name', { 'config-refs__name--inactive': ref.inactive }]"
            >{{ ref.label }}<template v-if="ref.inactive">（停用中）</template></span>
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  CONFIG_REF_KIND_HINT,
  CONFIG_REF_KIND_LABEL,
  configRefPath,
  type ConfigRef,
  type ConfigRefKind,
} from '~~/shared/config-references'

const props = withDefaults(defineProps<{
  refs: ConfigRef[]
  failedKinds?: ConfigRefKind[]
  workspaceId: string
  loading?: boolean
  emptyText?: string
}>(), {
  failedKinds: () => [],
  loading: false,
  emptyText: '目前沒有任何地方用到它。',
})

/** 顯示順序刻意固定：先講客人最常走到的那幾條路 */
const ORDER: ConfigRefKind[] = ['script', 'richmenu', 'flow', 'campaign', 'broadcast', 'supportPreset']

const groups = computed(() =>
  ORDER
    .map(kind => ({
      kind,
      label: CONFIG_REF_KIND_LABEL[kind],
      hint: CONFIG_REF_KIND_HINT[kind],
      path: configRefPath(props.workspaceId, kind),
      items: props.refs.filter(ref => ref.kind === kind),
    }))
    .filter(group => group.items.length > 0),
)

const failedKindLabels = computed(() =>
  props.failedKinds.map(kind => CONFIG_REF_KIND_LABEL[kind]).join('、'),
)
</script>

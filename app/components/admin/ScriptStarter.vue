<template>
  <!--
    `D-138`④：按「新增」先挑起點。都進同一個編輯畫面（之後要多問一題、多一條路照樣加）——
    延續 08-09「一種東西、兩種深度」，不是回到兩種東西。
    以前範本與「AI 搭草稿」只出現在「什麼都沒選」的時候，點過任何一條就要「新增 → 取消」才找得到。
    ⛔ 不放「客人加好友時」（2026-10-22 老闆「統一在左邊設定」）：它一個帳號只有一條、不是「新增一條」，
       唯一的入口是清單最上面那一列，這裡再放一張＝同一件事兩個地方。
  -->
  <div class="scripts-starter">
    <div>
      <h3 class="scripts-starter__title">{{ heading }}</h3>
      <p class="scripts-starter__lede">挑了之後都在同一個編輯畫面，之後要多問一題、多一條路都可以再加。</p>
    </div>

    <div class="scripts-starter__cards" data-tour="scr-templates">
      <!-- scr-start-handoff：導覽要打開編輯畫面時替他點這一張（最常用的那種） -->
      <button type="button" class="scripts-starter__card is-main" data-tour="scr-start-handoff" @click="emit('start', 'handoff')">
        <span class="scripts-starter__badge">最常用</span>
        <b>先問資料，再交給真人</b>
        <span class="scripts-starter__desc">客人要查訂單、改地址時，先問好訂單編號和電話。同事打開就能處理，不用再問一輪。</span>
        <span class="scripts-starter__eg">例：查詢訂單、更改地址</span>
      </button>
      <button type="button" class="scripts-starter__card" @click="emit('start', 'fixed')">
        <b>客人打特定的字，就回固定內容</b>
        <span class="scripts-starter__desc">字要一模一樣才回，不經過 AI。適合活動口令、固定公告。</span>
        <span class="scripts-starter__eg">例：輸入「抽獎」就送活動說明</span>
      </button>
    </div>

    <p class="scripts-starter__kb">
      運費、保固、怎麼用這類一般問題不用在這裡設，放進知識庫，AI 會自己回答。
      <NuxtLink :to="`/admin/${workspaceId}/knowledge`">去知識庫 →</NuxtLink>
    </p>

    <div class="scripts-starter__ai" data-tour="scr-ai-gen">
      <label for="scripts-starter-desc" class="scripts-starter__ai-label">或用一句話描述，AI 幫你搭草稿</label>
      <div class="scripts-starter__ai-row">
        <el-input
          id="scripts-starter-desc"
          v-model="desc"
          maxlength="500"
          placeholder="例：客人要退貨時，先問訂單編號和退貨原因，再請專員處理"
          @keydown.enter.exact.prevent="submitDesc"
        />
        <el-button type="primary" plain :loading="generating" :disabled="!desc.trim()" @click="submitDesc">
          {{ generating ? '搭草稿中…' : '搭草稿' }}
        </el-button>
      </div>
      <span class="text-xs text-muted">草稿會先打開讓你看過、試過，按「建立」才會存。</span>
    </div>

    <div class="scripts-starter__more">
      <span class="text-xs text-muted">或從範本開始：</span>
      <button v-for="tpl in templates" :key="tpl.key" type="button" class="scripts-starter__tpl" :title="tpl.description" @click="emit('template', tpl)">
        {{ tpl.label }}
      </button>
      <span class="scripts-starter__sep" aria-hidden="true">｜</span>
      <button type="button" class="scripts-starter__tpl" @click="emit('start', 'blank')">從空白開始</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ScriptTemplate } from '~~/shared/types/ai-script-templates'

defineProps<{
  heading: string
  templates: ScriptTemplate[]
  generating: boolean
}>()
const emit = defineEmits<{
  start: [kind: 'handoff' | 'fixed' | 'blank']
  template: [tpl: ScriptTemplate]
  generate: [description: string]
}>()

const { workspaceId } = useWorkspace()
const desc = ref('')

function submitDesc() {
  const d = desc.value.trim()
  if (!d) return
  emit('generate', d)
}
defineExpose({ clearDesc: () => { desc.value = '' } })
</script>

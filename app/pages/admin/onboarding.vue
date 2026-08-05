<template>
  <div class="onb-page">
    <div class="onb-card">
      <!-- ── Step 1：命名並建立 ───────────────────────────── -->
      <template v-if="step === 'form'">
        <div class="onb-head">
          <!-- 標題已經寫了要做什麼，這裡只放圖標（logomark）當品牌落款 -->
          <BrandLogo mark class="onb-mark" />
          <h1>建立你的官方帳號空間</h1>
          <p class="onb-sub">幫你的 LINE 官方帳號取個名字就能開始，預設是免費方案、不需綁卡。</p>
        </div>

        <div class="onb-field">
          <AdminFieldLabel text="官方帳號名稱" tight />
          <el-input
            v-model="workspaceName"
            placeholder="例：小福商店"
            maxlength="40"
            show-word-limit
            :disabled="creating"
            @keyup.enter="create"
          />
          <p class="onb-hint">之後可以隨時修改；這只是後台顯示用的名稱。</p>
        </div>

        <p v-if="errorMsg" class="onb-err">{{ errorMsg }}</p>

        <el-button
          type="primary"
          class="onb-primary-btn"
          :loading="creating"
          :disabled="!workspaceName.trim()"
          @click="create"
        >
          建立並開始
        </el-button>

        <div class="onb-foot">
          <NuxtLink to="/admin/workspaces">回帳號選擇</NuxtLink>
        </div>
      </template>

      <!-- ── Step 2：完成 ─────────────────────────────────── -->
      <template v-else>
        <div class="onb-head">
          <span class="onb-logo onb-logo--done"><el-icon color="#fff"><Select /></el-icon></span>
          <h1>帳號建好了！</h1>
          <p class="onb-sub">「{{ createdName }}」已經開好，目前是{{ freePlanName }}方案，每月 {{ freeQuota }} 則 AI 回覆免費額度。</p>
        </div>

        <div class="onb-plan">
          <div class="onb-plan__row">
            <span class="onb-plan__k">目前方案</span>
            <span class="onb-plan__v">{{ freePlanName }}</span>
          </div>
          <div class="onb-plan__row">
            <span class="onb-plan__k">本月免費額度</span>
            <span class="onb-plan__v">{{ freeQuota }} 則 AI 回覆</span>
          </div>
          <p class="onb-plan__note">用量在後台隨時看得到，需要更多時再於「訂閱與付款」升級即可。</p>
        </div>

        <p class="onb-next-title">接下來，接上你的 LINE 開始接客：</p>
        <el-button type="primary" class="onb-primary-btn" @click="goLine">
          接上我的 LINE 官方帳號
        </el-button>
        <el-button class="onb-secondary-btn" text @click="goWorkspace">
          先進後台看看 →
        </el-button>
      </template>
    </div>

    <AdminToastHost />
  </div>
</template>

<script setup lang="ts">
import { Select } from '@element-plus/icons-vue'
import { BILLING_PLANS } from '~~/shared/billing/plans'

definePageMeta({ middleware: 'auth', layout: false })
useHead({ title: '建立官方帳號 — 開始使用' })

const { showToast } = useAdminToast()
const { $auth } = useNuxtApp()
const { loadWorkspaceList } = useWorkspace()

const step = ref<'form' | 'done'>('form')
const workspaceName = ref('')
const creating = ref(false)
const errorMsg = ref('')

const createdName = ref('')
const createdWorkspaceId = ref('')

// 免費方案資訊直接讀 plans.ts（單一事實來源），改額度不用改這頁
const freePlanName = BILLING_PLANS.free.name
const freeQuota = BILLING_PLANS.free.answeredQuota

async function create() {
  const name = workspaceName.value.trim()
  if (!name) {
    errorMsg.value = '請輸入官方帳號名稱'
    return
  }
  errorMsg.value = ''
  creating.value = true
  try {
    const token = await $auth.currentUser?.getIdToken()
    const res = await $fetch<{ workspaceId: string, organizationId: string }>('/api/onboarding/self-serve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: { workspaceName: name },
    })
    createdName.value = name
    createdWorkspaceId.value = res.workspaceId
    step.value = 'done'
  }
  catch (e: any) {
    // 伺服器訊息已是人性化文案（含 409「你已經建立過帳號了」）；直接顯示於表單下方，
    // 下方「回帳號選擇」連結就是 409 的出口，不用再彈 toast。
    errorMsg.value = e?.data?.statusMessage || e?.message || '建立失敗，請稍後再試'
  }
  finally {
    creating.value = false
  }
}

/**
 * 剛建好的帳號還不在前端的 workspace 清單裡，而 auth middleware 會用那份清單判斷
 * 「這個帳號是不是你的」——不先重載就會被自己的守衛擋在門外、彈回帳號選擇頁。
 */
async function enterCreated(path: string) {
  await loadWorkspaceList().catch(() => {})
  await navigateTo(`/admin/${createdWorkspaceId.value}${path}`)
}

function goLine() {
  return enterCreated('/line-settings')
}

function goWorkspace() {
  return enterCreated('/conversation-stats')
}
</script>

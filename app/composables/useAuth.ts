import {
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  type User,
} from 'firebase/auth'

// Module-level guard：onAuthStateChanged 只能綁定一次
// 每次 useAuth() 都註冊新 listener 會造成記憶體洩漏 + token refresh 時 N 倍重複狀態更新
let listenerBound = false

export const useAuth = () => {
  const { $auth } = useNuxtApp()
  const user = useState<User | null>('auth:user', () => null)
  const loading = useState<boolean>('auth:loading', () => true)

  if (import.meta.client && !listenerBound) {
    listenerBound = true
    onAuthStateChanged($auth, (u) => {
      user.value = u
      loading.value = false
    })
  }

  async function loginWithGoogle() {
    const provider = new GoogleAuthProvider()
    await signInWithPopup($auth, provider)
  }

  async function logout() {
    // 帳號清單含官方帳號名稱，別留在別人也會用的電腦上（快取用途見 useWorkspace）
    clearWorkspaceListCache()
    await signOut($auth)
    await navigateTo('/login')
  }

  const isLoggedIn = computed(() => !!user.value)

  /** 等 Firebase 第一次回報登入狀態（避免重整時 middleware 誤判未登入） */
  function waitForAuthReady(): Promise<void> {
    if (!import.meta.client || !loading.value) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = watch(loading, (isLoading) => {
        if (!isLoading) {
          stop()
          resolve()
        }
      }, { immediate: true })
    })
  }

  return { user, loading, isLoggedIn, waitForAuthReady, loginWithGoogle, logout }
}

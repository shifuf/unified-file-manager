import { defineStore } from 'pinia'
import { ref } from 'vue'
import { registerAccessToken, registerRefreshHandler } from '@/api/http'
import type { components } from '@/api/schema'

type Profile = components['schemas']['AuthProfile']
type Tokens = components['schemas']['AuthTokens']

export const useAuthStore = defineStore('auth', () => {
  const token = ref('')
  const user = ref<Profile | null>(null)
  const initialized = ref<boolean | null>(null)
  let pending: Promise<boolean> | null = null
  const base = import.meta.env.VITE_UFM_API_BASE ?? '/api'

  async function raw<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error?.message ?? '请求失败')
    return value as T
  }
  function accept(value: Tokens) { token.value = value.accessToken ?? ''; user.value = value.user ?? null }
  async function status() { initialized.value = (await raw<{ initialized: boolean }>('/auth/bootstrap/status')).initialized }
  async function refresh(): Promise<boolean> {
    if (pending) return pending
    pending = raw<Tokens>('/auth/refresh', {}).then((value) => { accept(value); return true }).catch(() => {
      token.value = ''; user.value = null; return false
    }).finally(() => { pending = null })
    return pending
  }
  async function login(username: string, password: string, code: string) { accept(await raw<Tokens>('/auth/login', { username, password, code: code || undefined })) }
  async function bootstrap(username: string, displayName: string, password: string) {
    await raw('/auth/bootstrap', { username, displayName, password }); initialized.value = true
  }
  async function logout() {
    try { await fetch(`${base}/auth/logout`, { method: 'POST', credentials: 'include', headers: { Authorization: `Bearer ${token.value}` } }) }
    finally { token.value = ''; user.value = null }
  }
  registerAccessToken(() => token.value)
  registerRefreshHandler(refresh)
  return { token, user, initialized, status, refresh, login, bootstrap, logout }
})

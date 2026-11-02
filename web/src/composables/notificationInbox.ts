import { ref } from 'vue'
import { http } from '@/api/http'

export const unreadNotifications = ref(0)
export async function refreshUnread() {
  try { unreadNotifications.value = Math.max(0, Number((await http.get<{ count: number }>('/notifications/unread-count')).count) || 0) }
  catch { /* A notification poll must not disrupt the active page. */ }
}
export function safeNoticeHref(href?: string): string | undefined {
  if (!href || !/^\/(?:files|recycle|audit|projects|storages|tasks|backups|shares)(?:\?[^#]*)?$/.test(href) || /[\\\r\n]/.test(href)) return undefined
  return href
}

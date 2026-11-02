import { http } from '@/api/http'

export const cards = [
  { id: 'recent', label: '最近上传' }, { id: 'notifications', label: '通知' },
  { id: 'projects', label: '项目概览' }, { id: 'shares', label: '我的分享' },
  { id: 'folders', label: '常用目录' }, { id: 'storages', label: '存储用量' }, { id: 'trend', label: '下载趋势' },
]
export const actions = [
  { id: 'download', label: '下载' }, { id: 'details', label: '详情' },
  { id: 'share', label: '分享文件' }, { id: 'recycle', label: '移入回收站' },
]
export async function preference(kind: 'workbench' | 'hover-actions', defaults: { id: string }[]) {
  const result = await http.get<{ items: string[] }>(`/settings/${kind}`)
  return Array.isArray(result.items) ? result.items.filter(id => defaults.some(value => value.id === id)) : defaults.map(value => value.id)
}

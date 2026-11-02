import { onScopeDispose, ref } from 'vue'
import { http } from '@/api/http'
import { useAuthStore } from '@/stores/auth'

type Channel = 'RELAY' | 'CHUNK' | 'PRESIGNED' | 'MULTIPART' | 'QINIU_FORM' | 'UPYUN_FORM'
interface Plan { channel: Channel; id?: string; url?: string; chunkSize: number; partCount: number; uploadUrl?: string; fields?: Record<string, string>; expiresIn?: number }
interface Job { id: string; file: File; name: string; project: string; folder: string; state: string; progress: number; plan?: Plan; parts: { partNumber: number; etag: string }[]; request?: XMLHttpRequest; paused: boolean; canceled: boolean; error?: string; digest?: string; sourceSize?: number; needsReselect?: boolean; running?: boolean; restart?: boolean }
export function useUploadQueue(onComplete: () => Promise<void>) {
  const auth = useAuthStore()
  const storageKey = `ufm.upload-resume.v1:${auth.user?.id ?? 'administrator'}`
  const jobs = ref<Job[]>(recover())
  let active = 0
  let disposed = false
  function recover(): Job[] {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      if (!Array.isArray(stored) || stored.length > 100) return []
      return stored.filter(item => typeof item.id === 'string' && typeof item.name === 'string' && item.name.length <= 1024
        && typeof item.project === 'string' && typeof item.folder === 'string' && item.folder.length <= 4096
        && Number.isSafeInteger(item.size) && item.size >= 0 && /^[a-f0-9]{64}$/.test(item.digest)
        && ['CHUNK', 'MULTIPART'].includes(item.plan?.channel) && typeof item.plan?.id === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(item.plan.id)
        && Number.isSafeInteger(item.plan.chunkSize) && item.plan.chunkSize > 0 && Number.isSafeInteger(item.plan.partCount) && item.plan.partCount <= 10000)
        .map(item => ({ id: item.id, name: item.name, file: new File([], item.name.split('/').pop()!), project: item.project,
          folder: item.folder, sourceSize: item.size, digest: item.digest, progress: 0, state: '请重新选择源文件', paused: true,
          canceled: false, needsReselect: true, plan: { channel: item.plan.channel, id: item.plan.id, chunkSize: item.plan.chunkSize, partCount: item.plan.partCount },
          parts: Array.isArray(item.parts) ? item.parts.filter((p: { partNumber: number; etag: string }) => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.partNumber <= item.plan.partCount && typeof p.etag === 'string' && p.etag.length <= 256) : [] }))
    } catch { return [] }
  }
  function persist() {
    try {
      const resumable = jobs.value.filter(job => !job.canceled && job.state !== '已完成' && job.digest && ['CHUNK', 'MULTIPART'].includes(job.plan?.channel ?? ''))
      const data = resumable.slice(-100).map(job => ({ id: job.id, name: job.name, project: job.project, folder: job.folder,
        size: job.sourceSize ?? job.file.size, digest: job.digest, parts: job.parts,
        plan: { channel: job.plan!.channel, id: job.plan!.id, chunkSize: job.plan!.chunkSize, partCount: job.plan!.partCount } }))
      if (data.length) localStorage.setItem(storageKey, JSON.stringify(data)); else localStorage.removeItem(storageKey)
    } catch { /* Storage can be disabled; the current in-memory upload remains usable. */ }
  }
  async function fingerprint(file: File) {
    const { sha256 } = await import('@noble/hashes/sha2.js')
    const digest = sha256.create()
    for (let offset = 0; offset < file.size; offset += 1048576) digest.update(new Uint8Array(await file.slice(offset, offset + 1048576).arrayBuffer()))
    return Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
  }
  function transfer(job: Job, method: string, url: string, body: Blob | FormData, offset: number, authenticated: boolean, corsBlocked?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest(); job.request = request
      request.open(method, url)
      // Browser form uploads already carry the vendor token; a Bearer header would leak it to the object store.
      if (authenticated) { request.withCredentials = true; request.setRequestHeader('Authorization', `Bearer ${auth.token}`) }
      else request.withCredentials = false
      request.upload.onprogress = event => { if (event.lengthComputable) job.progress = Math.min(99, Math.round((offset + Math.min(event.loaded, body instanceof Blob ? body.size : job.file.size)) / Math.max(job.file.size, 1) * 100)) }
      request.onerror = () => reject(new Error(corsBlocked ?? '上传网络异常'))
      request.onabort = () => reject(new Error('上传已暂停或取消'))
      // status 0 means the browser blocked the cross-origin response before any HTTP status existed.
      request.onload = () => request.status === 0 ? reject(new Error(corsBlocked ?? '对象存储直传被浏览器拦截，请检查 CORS 配置'))
        : request.status >= 200 && request.status < 300 ? resolve(request.getResponseHeader('ETag') ?? '')
        : reject(new Error(`上传失败 (${request.status})`))
      // Presigned object requests must not add a browser-inferred Content-Type that was not signed.
      request.send(!authenticated && body instanceof Blob ? body.slice(0, body.size, '') : body)
    })
  }
  function check(job: Job) { if (disposed || job.paused || job.canceled) throw new Error('上传已暂停或取消') }
  async function run(job: Job) {
    job.running = true; job.state = '上传中'; job.error = undefined
    try {
      if (!job.plan) job.plan = await http.post<Plan>('/uploads/plan', { projectId: job.project, originalName: job.file.name, folderPath: job.folder, size: job.file.size })
      const plan = job.plan; check(job)
      if (['CHUNK', 'MULTIPART'].includes(plan.channel) && !job.digest) {
        job.digest = await fingerprint(job.file); job.sourceSize = job.file.size; persist(); check(job)
      }
      if (plan.channel === 'RELAY') {
        const body = new FormData(); body.append('file', job.file)
        await transfer(job, 'POST', `/api/uploads/relay?projectId=${encodeURIComponent(job.project)}&folderPath=${encodeURIComponent(job.folder)}`, body, 0, true)
      } else if (plan.channel === 'PRESIGNED') {
        await transfer(job, 'PUT', plan.url!, job.file, 0, false); check(job)
        await http.post(`/uploads/${plan.id}/complete-presign`)
      } else if (plan.channel === 'CHUNK') {
        const state = await http.get<{ uploaded: number[] }>(`/uploads/${plan.id}`)
        const count = Math.ceil(job.file.size / plan.chunkSize)
        for (let index = 0; index < count; index++) {
          check(job); if (state.uploaded.includes(index)) continue
          const body = new FormData(); body.append('chunk', job.file.slice(index * plan.chunkSize, (index + 1) * plan.chunkSize), 'chunk')
          await transfer(job, 'POST', `/api/uploads/${plan.id}/chunk?index=${index}`, body, index * plan.chunkSize, true)
        }
        check(job); await http.post(`/uploads/${plan.id}/complete`)
      } else if (plan.channel === 'MULTIPART') {
        for (let part = 1; part <= plan.partCount; part++) {
          check(job); if (job.parts.some(item => item.partNumber === part)) continue
          const signed = await http.post<{ url: string }>(`/uploads/${plan.id}/parts/${part}/presign`)
          const etag = await transfer(job, 'PUT', signed.url, job.file.slice((part - 1) * plan.chunkSize, part * plan.chunkSize), (part - 1) * plan.chunkSize, false)
          if (!etag) throw new Error('对象存储未暴露 ETag，请检查 CORS')
          job.parts.push({ partNumber: part, etag })
          persist()
        }
        check(job); await http.post(`/uploads/${plan.id}/complete-multipart`, { parts: job.parts })
      } else if (plan.channel === 'QINIU_FORM' || plan.channel === 'UPYUN_FORM') {
        const body = new FormData()
        // Field order is part of the vendor protocol, so append exactly what the plan returned and end with the file.
        for (const [key, value] of Object.entries(plan.fields ?? {})) body.append(key, value)
        body.append('file', job.file)
        try {
          await transfer(job, 'POST', plan.uploadUrl!, body, 0, false, '对象存储直传被浏览器拦截，请检查 CORS 配置')
        } catch (e) {
          await http.delete(`/uploads/${plan.id}/form`).catch(() => {})
          throw e
        }
        check(job); await http.post(`/uploads/${plan.id}/complete-form`)
      } else throw new Error('服务器返回不支持的上传通道')
      job.progress = 100; job.state = '已完成'; persist(); if (!disposed) await onComplete()
    } catch (e) { job.state = job.canceled ? '已取消' : job.paused ? '已暂停' : '失败'; job.error = String(e) }
    finally {
      job.request = undefined; job.running = false; active--
      if (job.restart && !job.canceled && !disposed && job.state !== '已完成') { job.restart = false; job.paused = false; job.state = '等待中' }
      persist(); pump()
    }
  }
  function pump() {
    if (disposed) return
    while (active < 3) { const job = jobs.value.find(item => item.state === '等待中' && !item.running && !item.needsReselect); if (!job) break; active++; void run(job) }
  }
  function add(files: FileList, project: string, folder: string) {
    for (const file of Array.from(files)) {
      const relative = file.webkitRelativePath.split('/').slice(0, -1)
      if (relative.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('文件夹路径无效')
      const target = `${folder.endsWith('/') ? folder : `${folder}/`}${relative.length ? `${relative.join('/')}/` : ''}`
      jobs.value.push({ id: crypto.randomUUID(), file, name: file.webkitRelativePath || file.name, project, folder: target, state: '等待中', progress: 0, parts: [], paused: false, canceled: false })
    }
    pump()
  }
  function pause(job: Job) { job.restart = false; job.paused = true; job.state = '已暂停'; job.request?.abort(); persist() }
  function resume(job: Job) {
    if (job.needsReselect) return
    if (job.running) { job.restart = true; return }
    job.paused = false; job.state = '等待中'; pump()
  }
  async function reselect(job: Job, file?: File) {
    if (!file || job.running || !job.needsReselect) return
    job.running = true; job.error = undefined
    try {
      if (file.name !== job.file.name || file.size !== job.sourceSize || await fingerprint(file) !== job.digest)
        throw new Error('文件内容与原上传不匹配')
      if (disposed || job.canceled) return
      job.file = file; job.needsReselect = false; job.paused = false; job.state = '等待中'
    } catch (e) { job.error = String(e) }
    finally { job.running = false; pump() }
  }
  async function cancel(job: Job) {
    job.restart = false; job.canceled = true; job.state = '已取消'; job.request?.abort(); persist()
    if (job.plan?.channel === 'CHUNK') await http.delete(`/uploads/${job.plan.id}`)
    if (job.plan?.channel === 'MULTIPART') await http.delete(`/uploads/${job.plan.id}/multipart`)
    if (job.plan?.channel === 'QINIU_FORM' || job.plan?.channel === 'UPYUN_FORM') await http.delete(`/uploads/${job.plan.id}/form`)
  }
  onScopeDispose(() => { disposed = true; for (const job of jobs.value) if (!['已完成', '已取消'].includes(job.state)) pause(job); persist() })
  return { jobs, add, pause, resume, cancel, reselect }
}

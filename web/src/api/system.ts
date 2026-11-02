import { http } from './http'
import type { components } from './schema'

export type SystemHealth = components['schemas']['SystemHealth']

/** 阶段 1 唯一真实接口：用于验证前后端 & CI 冒烟链路打通。 */
export function fetchSystemHealth() {
  return http.get<SystemHealth>('/system/health')
}

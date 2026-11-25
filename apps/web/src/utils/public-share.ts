import type { SharePageBrand } from '@/types';
import { PUBLIC_SITE_NAME } from '@/config/site-name';

export const DEFAULT_SHARE_BRAND: SharePageBrand = {
  title: '',
  subtitle: '',
  logoUrl: '',
  primaryColor: '#2563eb',
  background: '#f8fafc',
  panelBackground: '#ffffff',
  footerText: '',
  showPoweredBy: true,
};

export interface PublicShareFailure {
  kind: 'unavailable' | 'restricted' | 'network' | 'server' | 'password';
  title: string;
  description: string;
  retryable: boolean;
}

function responseMessage(error: unknown): string {
  const data = (error as { response?: { data?: { message?: unknown } } })?.response?.data;
  const message = data?.message;
  if (typeof message === 'string') return message.trim();
  if (Array.isArray(message)) return message.filter(value => typeof value === 'string').join('；');
  return '';
}

export function getPublicShareFailure(error: unknown): PublicShareFailure {
  const status = (error as { response?: { status?: number } })?.response?.status;
  const message = responseMessage(error);
  if (status === 404 || status === 410 || /不存在|已失效|已过期|已停用|已禁用|已撤销/.test(message)) {
    return {
      kind: 'unavailable',
      title: '分享链接已失效',
      description: '链接可能已过期、被取消，或文件已被移除。请联系分享者获取新的分享链接。',
      retryable: false,
    };
  }
  if (message.includes('密码') && (status === 400 || status === 401 || status === 403)) {
    return { kind: 'password', title: '分享密码错误', description: '请检查分享密码后重新输入。', retryable: false };
  }
  if (status === 401 || status === 403 || status === 429) {
    return {
      kind: 'restricted',
      title: '暂时无法访问此分享',
      description: status === 429
        ? '访问过于频繁，请稍后重新加载。'
        : '此分享设有访问限制。请联系分享者确认访问权限，或稍后重新加载。',
      retryable: true,
    };
  }
  if (!status) {
    return { kind: 'network', title: '连接暂时中断', description: '暂时无法连接服务器，请检查网络后重新加载。', retryable: true };
  }
  return { kind: 'server', title: '分享暂时无法加载', description: '服务器暂时无法处理请求，请稍后重新加载。', retryable: true };
}

/** Read a blob API error without showing Axios transport/debug text to visitors. */
export async function readPublicShareMessage(error: unknown, fallback: string): Promise<string> {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  const status = (error as { response?: { status?: number } })?.response?.status;
  let message = responseMessage(error);
  if (data instanceof Blob) {
    try {
      const decoded: unknown = JSON.parse(await data.text());
      message = responseMessage({ response: { data: decoded } });
    } catch { /* A proxy's HTML/error body is not suitable visitor-facing text. */ }
  }
  if (message.includes('永久禁止下载') || /封禁|拉黑/.test(message)) {
    return '当前访问已被禁止下载，请联系分享者。';
  }
  if (status === 429 || /过于频繁|临时禁止下载|临时限制|密码错误次数过多/.test(message)) {
    const minutes = message.match(/(\d{1,5})\s*分钟后再试/);
    const retry = minutes ? `请 ${Number(minutes[1])} 分钟后再试。` : '请稍后再试。';
    return `${message.includes('密码') ? '分享密码错误次数过多' : '下载过于频繁或已被临时限制'}，${retry}`;
  }
  if (message.includes('分享密码错误') || message.includes('请输入分享密码')) return '分享密码错误，请检查后重新输入。';
  if (/下载次数.*用[完尽]/.test(message)) return '分享链接下载次数已用完，请联系分享者。';
  if (/仅允许.*预览|仅支持.*预览/.test(message)) return '该分享仅允许在线预览，无法下载。';
  if (status === 404 || status === 410 || /分享.*(?:不存在|已失效|已过期|已停用|已禁用)/.test(message)) {
    return '分享链接已失效，请联系分享者获取新的分享链接。';
  }
  if (status === 401 || status === 403) return '当前网络无权访问此分享，请联系分享者。';
  const localMessage = (error as { message?: unknown })?.message;
  return localMessage === '预览内容为空，请稍后重试或直接下载。' ? localMessage : fallback;
}

/** index.html supplies the same public site name as the homepage. */
export function getShareSiteName(): string {
  return PUBLIC_SITE_NAME;
}

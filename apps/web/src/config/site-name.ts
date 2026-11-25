// Preloaded by main.ts before routing can replace document.title for a resource.
// The initial HTML title is the public site name used by the homepage.
export const PUBLIC_SITE_NAME = (typeof document === 'undefined' ? '' : document.title.trim()) || '统一文件管理系统';

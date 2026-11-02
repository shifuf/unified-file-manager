/**
 * UFM 图标集：全部单色 SVG（stroke=currentColor），无 emoji、无图标字体。
 * 用法：<AppIcon name="files" :size="16" />
 *
 * 约束（与设计规范一致）：
 * - 只用 24x24 视框、stroke 风格，保证 16px 下线条不发虚；
 * - 颜色继承 currentColor，由父级 CSS 变量决定，图标本身不写死色值。
 */
import { defineComponent, h, type PropType } from 'vue'

const PATHS: Record<string, string> = {
  // ---------- 导航 / 领域 ----------
  'dashboard': '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  'files': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  'folder': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'share': '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.7l7.2-4.2M8.4 13.3l7.2 4.2"/>',
  'storage': '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  'project': '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H10l2 2.5h6.5A2.5 2.5 0 0 1 21 11v6.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M8 13.5h8"/>',
  'tasks': '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1.4 1.4L7.8 5M4 12l1.4 1.4L7.8 11M4 18l1.4 1.4L7.8 17"/>',
  'backup': '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  'settings': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  'audit': '<path d="M9 3h6a2 2 0 0 1 2 2"/><path d="M7 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2h1.5A1.5 1.5 0 0 1 20 6.5v13A1.5 1.5 0 0 1 18.5 21h-13A1.5 1.5 0 0 1 4 19.5v-13A1.5 1.5 0 0 1 5.5 5z"/><path d="M8 11h8M8 15h5"/>',
  'webhook': '<path d="M12 3v6"/><circle cx="12" cy="12" r="3"/><path d="M6.3 8.3a7 7 0 0 0 0 7.4M17.7 8.3a7 7 0 0 1 0 7.4"/><path d="M3.5 5.5a12 12 0 0 0 0 13M20.5 5.5a12 12 0 0 1 0 13"/>',
  'shield': '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9.2 12.2l2 2 3.6-3.8"/>',

  // ---------- 操作 ----------
  'trash': '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7"/>',
  'upload': '<path d="M12 16V4"/><path d="M7.5 8.5L12 4l4.5 4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  'download': '<path d="M12 4v12"/><path d="M7.5 11.5L12 16l4.5-4.5"/><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16"/>',
  'search': '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  'plus': '<path d="M12 5v14M5 12h14"/>',
  'close': '<path d="M6 6l12 12M18 6L6 18"/>',
  'check': '<path d="M4.5 12.5l5 5 10-11"/>',
  'chevron-down': '<path d="M6 9.5l6 6 6-6"/>',
  'chevron-right': '<path d="M9.5 6l6 6-6 6"/>',
  'chevron-left': '<path d="M14.5 6l-6 6 6 6"/>',
  'chevron-up': '<path d="M6 14.5l6-6 6 6"/>',
  'user': '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.4 7.4 0 0 1 14.4 0"/>',
  'bell': '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>',
  'moon': '<path d="M20 13.5A8 8 0 0 1 10.5 4a8 8 0 1 0 9.5 9.5z"/>',
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/>',
  'logout': '<path d="M15 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 4 4v16a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 15 20v-1.5"/><path d="M10 12h10"/><path d="M17 8.5l3.5 3.5-3.5 3.5"/>',
  'refresh': '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5v5h-5"/>',
  'link': '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2"/>',
  'copy': '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 3h9A1.5 1.5 0 0 1 15.5 4.5V6"/>',
  'eye': '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'edit': '<path d="M4 20h4l10-10a2 2 0 0 0-4-4L4 16z"/><path d="M14.5 5.5l4 4"/>',
  'info': '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 8v.5"/>',
  'warning': '<path d="M12 3.5l9 15.5H3z"/><path d="M12 9.5v4M12 16.5v.5"/>',
  'database': '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/><path d="M4.5 11.5v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/>',
  'server': '<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.5M7 17h.5"/>',
  'cloud': '<path d="M7 18a4 4 0 0 1 .5-8 5.5 5.5 0 0 1 10.4 1.6A3.5 3.5 0 0 1 17.5 18z"/>',
  'image': '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><circle cx="8.5" cy="10" r="1.6"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3L20 17"/>',
  'video': '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  'music': '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  'archive': '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>',
  'code': '<path d="M8.5 8.5L4 12l4.5 3.5"/><path d="M15.5 8.5L20 12l-4.5 3.5"/><path d="M13.5 5.5l-3 13"/>',
  'file': '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 13h7M8.5 16.5h5"/>',
  'lock': '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><path d="M12 14.5v2"/>',
  'key': '<circle cx="8" cy="15.5" r="3.5"/><path d="M10.5 13L20 3.5"/><path d="M16.5 7L19 9.5"/><path d="M14 9.5l2 2"/>',
  'terminal': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3"/><path d="M12.5 15h4"/>',
  'zap': '<path d="M13.5 2.5L4 14h6l-.5 7.5L20 10h-6z"/>',
  'arrow-up-right': '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>',
  'arrow-right': '<path d="M4 12h15"/><path d="M13.5 6.5L20 12l-6.5 5.5"/>',
  'more': '<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>',
  'filter': '<path d="M4 5.5h16l-6 7v6l-4 2v-8z"/>',
  'grid': '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  'list': '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  'pause': '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  'play': '<path d="M7.5 5.5l11 6.5-11 6.5z"/>',
  'stop': '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  'clock': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  'tag': '<path d="M12.5 3.5H20v7.5l-8.6 8.6a1.6 1.6 0 0 1-2.3 0L4 14.4a1.6 1.6 0 0 1 0-2.3z"/><circle cx="16.4" cy="7.6" r="1.3"/>',
  'move': '<path d="M12 3.5v17M3.5 12h17"/><path d="M9.5 6l2.5-2.5L14.5 6M9.5 18l2.5 2.5L14.5 18M6 9.5L3.5 12 6 14.5M18 9.5L20.5 12 18 14.5"/>',
  'external': '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  'version': '<path d="M12 3.5l8 4v9l-8 4-8-4v-9z"/><path d="M12 12l8-4M12 12v8.5M12 12L4 8"/>',

  // ---------- 设计系统专用 ----------
  'palette': '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.9-.8 1.9-1.8 0-1.5-1.2-1.7-1.2-2.7 0-.8.7-1.4 1.6-1.4h1.6a4.6 4.6 0 0 0 4.6-4.6c0-3.6-3.8-6.5-8.5-6.5z"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.6" r="1.2"/><circle cx="16" cy="10" r="1.2"/>',
  'layers': '<path d="M12 3.5L3.5 8 12 12.5 20.5 8z"/><path d="M3.5 12.5L12 17l8.5-4.5"/><path d="M3.5 16.5L12 21l8.5-4.5"/>',
  'sliders': '<path d="M4 7h9M17 7h3"/><circle cx="15" cy="7" r="2"/><path d="M4 17h3M11 17h9"/><circle cx="9" cy="17" r="2"/>',
  'activity': '<path d="M3 12h4l2.5-7 4 14 2.5-7h5"/>',
  'hard-drive': '<rect x="3" y="5" width="18" height="6" rx="2"/><rect x="3" y="13" width="18" height="6" rx="2"/><path d="M7 8h.5M7 16h.5"/>',
  'globe': '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z"/>',
  'star': '<path d="M12 4l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z"/>',
  'sparkles': '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
}

export const ICON_NAMES = Object.keys(PATHS)
export type IconName = keyof typeof PATHS

export default defineComponent({
  name: 'AppIcon',
  props: {
    name: { type: String as PropType<IconName | string>, required: true },
    size: { type: [Number, String], default: 16 },
    strokeWidth: { type: [Number, String], default: 1.6 },
  },
  setup(props) {
    return () => {
      const inner = PATHS[props.name as string]
      if (!inner) return null
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width: props.size,
        height: props.size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': props.strokeWidth,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
        focusable: 'false',
        innerHTML: inner,
      })
    }
  },
})

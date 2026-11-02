<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/icons/AppIcon'
import { useThemeStore } from '@/stores/theme'

/**
 * 设计规范页：把设计令牌「可视化」，作为开发的对照物与验收页。
 * 所有色块的颜色都来自 CSS 变量，切主题即时联动。
 */
const theme = useThemeStore()

const surfaceTokens = [
  { name: '--bg', label: '背景' },
  { name: '--bg-soft', label: '背景柔化' },
  { name: '--surface', label: '卡片/表面' },
  { name: '--surface-2', label: '次级表面' },
  { name: '--border', label: '边框' },
  { name: '--border-strong', label: '边框加强' },
]

const textTokens = [
  { name: '--text-strong', label: '标题文字' },
  { name: '--text', label: '正文文字' },
  { name: '--text-muted', label: '次要文字' },
  { name: '--placeholder', label: '占位符' },
]

const accentTokens = [
  { name: '--accent', label: '强调色' },
  { name: '--accent-2', label: '强调次级' },
  { name: '--accent-hover', label: '强调悬停' },
  { name: '--accent-pressed', label: '强调按下' },
  { name: '--accent-soft', label: '强调浅底' },
]

const stateTokens = [
  { name: '--success', label: '成功' },
  { name: '--warning', label: '警告' },
  { name: '--danger', label: '危险' },
  { name: '--info', label: '信息' },
]

const radiusTokens = [
  { label: '小控件', value: '8px', use: '图标按钮内部' },
  { label: '输入/按钮', value: '12px', use: '.input / .btn' },
  { label: '标签', value: '10px', use: '.tag' },
  { label: '卡片', value: '16px', use: '.card' },
  { label: 'Hero 卡', value: '20px', use: '.card-hero' },
  { label: '侧边栏', value: '24px', use: '.sidebar' },
]

const themeLabel = computed(() => (theme.isDark ? 'DARK' : 'LIGHT'))
</script>

<template>
  <div class="guide">
    <section class="card-hero">
      <div class="eyebrow eyebrow-strong">DESIGN TOKENS · {{ themeLabel }}</div>
      <h1 class="page-title">蓝色极简 SaaS 控制台</h1>
      <p class="page-subtitle">
        唯一强调色电光蓝（{{ theme.isDark ? '--accent / 深色' : '--accent / 浅色' }}），白卡片、细边框、大圆角、柔和蓝光晕。
        本页所有色块直接读取 CSS 变量，切换明暗主题即时联动。
      </p>
      <div class="guide-actions">
        <button class="btn btn-primary" type="button" @click="theme.toggle()">
          <AppIcon :name="theme.isDark ? 'sun' : 'moon'" :size="15" />
          切换{{ theme.isDark ? '浅色' : '深色' }}
        </button>
        <span class="badge"><span class="badge-dot" />LIVE TOKENS</span>
      </div>
    </section>

    <!-- 颜色令牌 -->
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">颜色令牌</h2>
        <span class="eyebrow">SECTION 01</span>
      </div>

      <div class="token-groups">
        <div class="card">
          <h3 class="card-title">表面与边框</h3>
          <div class="swatch-list">
            <div v-for="t in surfaceTokens" :key="t.name" class="swatch">
              <span class="swatch-chip" :style="{ background: `var(${t.name})` }" />
              <span class="swatch-meta">
                <span class="swatch-label">{{ t.label }}</span>
                <span class="swatch-var">{{ t.name }}</span>
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">文字层级</h3>
          <div class="swatch-list">
            <div v-for="t in textTokens" :key="t.name" class="swatch">
              <span class="swatch-chip" :style="{ background: `var(${t.name})` }" />
              <span class="swatch-meta">
                <span class="swatch-label">{{ t.label }}</span>
                <span class="swatch-var">{{ t.name }}</span>
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">强调色（唯一）</h3>
          <div class="swatch-list">
            <div v-for="t in accentTokens" :key="t.name" class="swatch">
              <span class="swatch-chip" :style="{ background: `var(${t.name})` }" />
              <span class="swatch-meta">
                <span class="swatch-label">{{ t.label }}</span>
                <span class="swatch-var">{{ t.name }}</span>
              </span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">语义色</h3>
          <div class="swatch-list">
            <div v-for="t in stateTokens" :key="t.name" class="swatch">
              <span class="swatch-chip" :style="{ background: `var(${t.name})` }" />
              <span class="swatch-meta">
                <span class="swatch-label">{{ t.label }}</span>
                <span class="swatch-var">{{ t.name }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 排版 -->
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">字体与排版</h2>
        <span class="eyebrow">SECTION 02</span>
      </div>

      <div class="card">
        <div class="type-row">
          <div class="type-sample">
            <div class="eyebrow">DISPLAY · CALISTOGA</div>
            <div class="page-title">页面主标题</div>
          </div>
          <div class="type-sample">
            <div class="eyebrow">UI · INTER</div>
            <div class="type-ui">正文 13px / 行高 1.65：文件上传与分发链路统一收口。</div>
          </div>
          <div class="type-sample">
            <div class="eyebrow">MONO · JETBRAINS</div>
            <div class="font-mono type-mono">QUOTA_EXHAUSTED · req_9f2c1a</div>
          </div>
          <div class="type-sample">
            <div class="eyebrow">METRIC · 26PX 800</div>
            <div class="metric">12,480</div>
          </div>
        </div>
      </div>
    </section>

    <!-- 组件 -->
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">组件</h2>
        <span class="eyebrow">SECTION 03</span>
      </div>

      <div class="comp-grid">
        <div class="card">
          <h3 class="card-title">按钮</h3>
          <div class="comp-row">
            <button class="btn btn-primary" type="button">
              <AppIcon name="upload" :size="15" />主按钮
            </button>
            <button class="btn btn-secondary" type="button">
              <AppIcon name="download" :size="15" />次按钮
            </button>
            <button class="btn btn-ghost" type="button">幽灵</button>
          </div>
          <div class="comp-row">
            <button class="btn btn-danger" type="button">
              <AppIcon name="trash" :size="15" />删除
            </button>
            <button class="btn btn-secondary btn-sm" type="button">小号</button>
            <button class="btn btn-primary" type="button" disabled>禁用</button>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">输入框</h3>
          <div class="comp-col">
            <label class="field">
              <span class="field-label">文件名称</span>
              <input class="input" placeholder="请输入文件名" />
              <span class="field-help">支持 1–255 字符，不允许 / 与 \</span>
            </label>
            <label class="field">
              <span class="field-label">存储策略</span>
              <select class="select">
                <option>自动（按优先级）</option>
                <option>本地磁盘</option>
              </select>
            </label>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">标签与徽章</h3>
          <div class="comp-row">
            <span class="tag tag-success">ACTIVE</span>
            <span class="tag tag-warning">PAUSED</span>
            <span class="tag tag-danger">FAILED</span>
            <span class="tag tag-info">RUNNING</span>
          </div>
          <div class="comp-row">
            <span class="badge"><span class="badge-dot" />系统正常</span>
          </div>
          <div class="comp-row">
            <div class="progress"><div class="progress-bar" style="width: 62%" /></div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">圆角体系</h3>
          <div class="radius-list">
            <div v-for="r in radiusTokens" :key="r.label" class="radius-item">
              <span class="radius-demo" :style="{ borderRadius: r.value }" />
              <span class="radius-meta">
                <span class="swatch-label">{{ r.label }}</span>
                <span class="swatch-var">{{ r.value }} · {{ r.use }}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 状态标签三元组 -->
    <section class="section">
      <div class="section-head">
        <h2 class="section-title">状态标签三元组</h2>
        <span class="eyebrow">SECTION 04</span>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>状态</th>
              <th>background token</th>
              <th>border token</th>
              <th>text token</th>
              <th>示例</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>成功</td>
              <td class="font-mono">--tag-success-bg</td>
              <td class="font-mono">--tag-success-border</td>
              <td class="font-mono">--tag-success-text</td>
              <td><span class="tag tag-success">OK</span></td>
            </tr>
            <tr>
              <td>警告</td>
              <td class="font-mono">--tag-warning-bg</td>
              <td class="font-mono">--tag-warning-border</td>
              <td class="font-mono">--tag-warning-text</td>
              <td><span class="tag tag-warning">WARN</span></td>
            </tr>
            <tr>
              <td>错误</td>
              <td class="font-mono">--tag-danger-bg</td>
              <td class="font-mono">--tag-danger-border</td>
              <td class="font-mono">--tag-danger-text</td>
              <td><span class="tag tag-danger">ERR</span></td>
            </tr>
            <tr>
              <td>信息</td>
              <td class="font-mono">--tag-info-bg</td>
              <td class="font-mono">--tag-info-border</td>
              <td class="font-mono">--tag-info-text</td>
              <td><span class="tag tag-info">INFO</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.guide {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.guide-actions {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.token-groups {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.swatch-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.swatch {
  display: flex;
  align-items: center;
  gap: 10px;
}

.swatch-chip {
  width: 26px;
  height: 26px;
  border-radius: var(--r-xs);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.swatch-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.swatch-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-strong);
}

.swatch-var {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.type-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.type-sample {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--divider);
  background: var(--bg-soft);
}

.type-ui {
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
}

.type-mono {
  font-size: 12px;
  color: var(--text-muted);
}

.comp-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.comp-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.comp-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.progress {
  flex: 1;
  min-width: 120px;
}

.radius-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
}

.radius-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.radius-demo {
  width: 34px;
  height: 26px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-a25);
  flex-shrink: 0;
}

.radius-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

@media (max-width: 1200px) {
  .token-groups,
  .type-row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .token-groups,
  .type-row,
  .comp-grid {
    grid-template-columns: 1fr;
  }
}
</style>

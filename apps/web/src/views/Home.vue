<template>
  <main class="home">
    <header class="home-header">
      <div class="home-brand">
        <div class="brand-mark">U</div>
        <span class="brand-name">统一文件管理系统</span>
      </div>
    </header>

    <section class="home-hero">
      <div class="hero-content">
        <h1>统一文件管理系统</h1>
        <p class="hero-subtitle">多项目文件归集、权限鉴别与存储分发平台</p>
        <p class="hero-text">
          为多个项目提供集中的文件存储、分享与对接能力，支持七牛、又拍云、阿里云 OSS
          与本地存储的灵活切换，配套项目密钥签名、访问白名单与审计日志，保障文件安全可控。
        </p>
        <div class="hero-features">
          <div class="feature">
            <div class="feature-title">多存储后端</div>
            <div class="feature-text">本地与主流云存储无缝切换，支持本地文件迁移。</div>
          </div>
          <div class="feature">
            <div class="feature-title">安全分享</div>
            <div class="feature-text">密码、过期、下载次数、IP 白名单与图片水印。</div>
          </div>
          <div class="feature">
            <div class="feature-title">开放对接</div>
            <div class="feature-text">项目密钥签名调用，便于业务系统集成。</div>
          </div>
        </div>
      </div>
    </section>

    <footer class="home-footer">
      <span>统一文件管理系统</span>
    </footer>
  </main>
</template>

<script setup lang="ts">
// Public landing page. Console login is not linked here; use ADMIN_LOGIN_PATH.
</script>

<style scoped>
.home {
  display: flex;
  min-height: 100vh;
  flex-direction: column;
  background: var(--color-background);
}

.home-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 32px;
}

.home-brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brand-mark {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border-radius: 8px;
  color: #ffffff;
  background: var(--color-primary);
  font-size: 18px;
  font-weight: 700;
}

.brand-name {
  font-size: 17px;
  font-weight: 700;
}

.home-hero {
  display: grid;
  flex: 1;
  place-items: center;
  padding: 48px 24px;
}

.hero-content {
  width: min(100%, 960px);
  text-align: center;
}

.hero-content h1 {
  margin: 0;
  font-size: 40px;
  line-height: 1.2;
}

.hero-subtitle {
  margin: 16px 0 0;
  color: var(--color-primary);
  font-size: 18px;
  font-weight: 600;
}

.hero-text {
  margin: 18px auto 0;
  max-width: 680px;
  color: #475569;
  font-size: 15px;
  line-height: 1.9;
}

.hero-features {
  display: grid;
  gap: 18px;
  margin-top: 44px;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  text-align: left;
}

.feature {
  padding: 22px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.05);
}

.feature-title {
  font-size: 16px;
  font-weight: 700;
}

.feature-text {
  margin-top: 10px;
  color: #64748b;
  font-size: 13px;
  line-height: 1.7;
}

.home-footer {
  padding: 22px;
  color: #94a3b8;
  font-size: 13px;
  text-align: center;
}

@media (max-width: 760px) {
  .hero-content h1 {
    font-size: 30px;
  }

  .hero-features {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup lang="ts">
import AppIcon from '@/icons/AppIcon'
</script>

<template>
  <div class="notfound">
    <div class="nf-card card-hero">
      <div class="eyebrow eyebrow-strong">404</div>
      <h1 class="page-title">页面不存在</h1>
      <p class="page-subtitle">链接可能已失效，或该模块尚未开放。</p>
      <router-link class="btn btn-primary nf-btn" to="/workbench">
        <AppIcon name="arrow-right" :size="15" />
        返回工作台
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.notfound {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
}

.nf-card {
  max-width: 460px;
  width: 100%;
  text-align: left;
}

.nf-btn {
  margin-top: 18px;
}
</style>

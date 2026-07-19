<template>
  <main class="login-page">
    <section class="login-panel" aria-labelledby="login-title">
      <div class="login-brand">
        <div class="brand-mark">U</div>
        <div>
          <h1 id="login-title">统一文件管理系统</h1>
          <p>多项目文件归集、权限鉴别与存储分发后台</p>
        </div>
      </div>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @keyup.enter="submit">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" autocomplete="username" :prefix-icon="User" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="current-password"
            :prefix-icon="Lock"
          />
        </el-form-item>
        <el-button type="primary" class="login-button" :loading="submitting" @click="submit">登录</el-button>
      </el-form>
    </section>

    <el-dialog
      v-model="totpDialogVisible"
      title="二次验证"
      width="420px"
      :close-on-click-modal="false"
      :close-on-press-escape="!submitting"
      @closed="resetTotpDialog"
    >
      <div class="totp-dialog">
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="该账号已启用 2FA，请输入认证器中的 6 位验证码完成登录。"
        />
        <el-form ref="totpFormRef" :model="form" :rules="totpRules" label-position="top" @keyup.enter="submitTotp">
          <el-form-item label="认证器验证码" prop="totpCode">
            <el-input
              v-model="form.totpCode"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="6 位数字"
              :prefix-icon="Key"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button :disabled="submitting" @click="totpDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitTotp">验证并登录</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<script setup lang="ts">
import { Key, Lock, User } from '@element-plus/icons-vue';
import type { FormInstance, FormRules } from 'element-plus';
import { reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { resetSessionExpiredGuard } from '@/api/http';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();
const formRef = ref<FormInstance>();
const totpFormRef = ref<FormInstance>();
const submitting = ref(false);
const totpDialogVisible = ref(false);
const form = reactive({
  username: '',
  password: '',
  totpCode: '',
});
const minPasswordLength = 8;
const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名。', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码。', trigger: 'blur' },
    { min: minPasswordLength, message: `密码至少 ${minPasswordLength} 位。`, trigger: 'blur' },
  ],
};
const totpRules: FormRules = {
  totpCode: [
    {
      validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) => {
        if (/^\d{6}$/.test(String(value || ''))) {
          callback();
          return;
        }

        callback(new Error('认证器验证码必须是 6 位数字。'));
      },
      trigger: 'blur',
    },
  ],
};

watch(
  () => [form.username, form.password],
  () => {
    if (!totpDialogVisible.value) {
      return;
    }

    totpDialogVisible.value = false;
    form.totpCode = '';
  },
);

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }

  submitting.value = true;
  try {
    const result = await authStore.login({
      username: form.username,
      password: form.password,
    });
    if (result.requiresTotp) {
      form.totpCode = '';
      totpDialogVisible.value = true;
      return;
    }

    resetSessionExpiredGuard();
    await router.replace(String(route.query.redirect || '/dashboard'));
  } catch {
    // The HTTP interceptor already displays the server validation message.
  } finally {
    submitting.value = false;
  }
}

async function submitTotp(): Promise<void> {
  try {
    await totpFormRef.value?.validate();
  } catch {
    return;
  }

  submitting.value = true;
  try {
    const result = await authStore.login({
      username: form.username,
      password: form.password,
      totpCode: form.totpCode,
    });
    if (result.requiresTotp) {
      return;
    }

    totpDialogVisible.value = false;
    resetSessionExpiredGuard();
    await router.replace(String(route.query.redirect || '/dashboard'));
  } catch {
    // The HTTP interceptor already displays the server validation message.
  } finally {
    submitting.value = false;
  }
}

function resetTotpDialog(): void {
  form.totpCode = '';
  totpFormRef.value?.clearValidate();
}
</script>

<style scoped>
.login-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
  background:
    linear-gradient(180deg, rgba(37, 99, 235, 0.08), transparent 360px),
    var(--color-background);
}

.login-panel {
  width: min(100%, 420px);
  padding: 28px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.08);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}

.brand-mark {
  display: grid;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 8px;
  color: #ffffff;
  background: var(--color-primary);
  font-size: 20px;
  font-weight: 700;
}

h1 {
  margin: 0;
  font-size: 22px;
  line-height: 1.3;
}

p {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 13px;
}

.login-button {
  width: 100%;
  min-height: 44px;
}

.totp-dialog {
  display: grid;
  gap: 16px;
}
</style>

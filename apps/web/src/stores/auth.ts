import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { authApi } from '@/api/modules';
import type { LoginResult } from '@/api/modules';
import type { UserProfile } from '@/types';

const USER_STORAGE_KEY = 'ufm_user_profile';

export const useAuthStore = defineStore('auth', () => {
  // Session is primarily httpOnly cookies. We keep a soft logged-in flag + profile
  // so the UI can render without reading tokens from JS (XSS-resistant).
  const currentUser = ref<UserProfile | null>(
    localStorage.getItem(USER_STORAGE_KEY) ? JSON.parse(String(localStorage.getItem(USER_STORAGE_KEY))) : null,
  );
  const sessionKnown = ref(Boolean(currentUser.value));
  const loggedIn = computed(() => sessionKnown.value || Boolean(currentUser.value));
  // Single-operator console: any authenticated session is the super admin.
  const isSuperAdmin = computed(() => loggedIn.value);

  // Kept for transitional callers; cookies are authoritative.
  const accessToken = computed(() => (sessionKnown.value ? 'cookie' : ''));
  const refreshToken = computed(() => (sessionKnown.value ? 'cookie' : ''));

  function persistUser(user: UserProfile): void {
    currentUser.value = user;
    sessionKnown.value = true;
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  }

  async function login(payload: { username: string; password: string; totpCode?: string }): Promise<LoginResult> {
    const result = await authApi.login(payload);
    if (result.requiresTotp) {
      return result;
    }

    persistUser(result.user);
    return result;
  }

  /**
   * Silently exchange the refresh cookie/token for a new access cookie.
   * Returns a truthy marker on success, or null when the session is gone.
   */
  async function refreshSession(): Promise<string | null> {
    try {
      const result = await authApi.refresh();
      persistUser(result.user);
      return 'cookie';
    } catch {
      logoutLocal();
      return null;
    }
  }

  async function loadProfile(): Promise<void> {
    try {
      currentUser.value = await authApi.profile();
      sessionKnown.value = true;
      localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(currentUser.value));
    } catch {
      logoutLocal();
      throw new Error('session expired');
    }
  }

  function logoutLocal(): void {
    currentUser.value = null;
    sessionKnown.value = false;
    localStorage.removeItem(USER_STORAGE_KEY);
    // Clean up legacy localStorage tokens from older builds.
    localStorage.removeItem('ufm_access_token');
    localStorage.removeItem('ufm_refresh_token');
  }

  async function logout(): Promise<void> {
    logoutLocal();
    try {
      await authApi.logout();
    } catch {
      // Server-side revocation is best-effort.
    }
  }

  return {
    accessToken,
    refreshToken,
    currentUser,
    isSuperAdmin,
    loggedIn,
    login,
    refreshSession,
    loadProfile,
    logout,
    logoutLocal,
  };
});

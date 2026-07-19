import type { UserRole } from '@prisma/client';

export interface RequestUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  totpEnabled: boolean;
}

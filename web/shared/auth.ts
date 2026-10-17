import { z } from 'zod';

export const UserRole = z.enum(['admin', 'user', 'pending']);
export type UserRole = z.infer<typeof UserRole>;

export const PublicUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRole,
  /** False for directory (LDAP) accounts: no password to change here. */
  hasPassword: z.boolean(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const AuthOptions = z.object({
  passwordLogin: z.boolean(),
  signup: z.boolean(),
  ldap: z.boolean(),
});
export type AuthOptions = z.infer<typeof AuthOptions>;

export const SessionResponse = z.object({
  user: PublicUser.nullable(),
  auth: AuthOptions,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }));
const password = z.string().min(8, 'Use at least 8 characters').max(256);

export const LoginRequest = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SignupRequest = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(100),
  email,
  password,
});
export type SignupRequest = z.infer<typeof SignupRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

export const AdminCreateUserRequest = z.object({
  name: z.string().trim().min(1).max(100),
  email,
  password,
  role: UserRole.default('user'),
});

export const AdminUpdateUserRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: UserRole.optional(),
  password: password.optional(),
});

export const AdminUser = PublicUser.extend({
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const SessionInfo = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

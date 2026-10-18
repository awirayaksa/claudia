import { z } from 'zod';
import { UserCapsSchema, type Permissions } from './access';

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
  /** "Continue with …" buttons (OpenID Connect providers). */
  sso: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type AuthOptions = z.infer<typeof AuthOptions>;

export interface SessionResponse {
  user: PublicUser | null;
  auth: AuthOptions;
  /** What the signed-in user may do (all false when signed out or pending). */
  permissions: Permissions | null;
  /** Server features that are set up. */
  features: {
    webSearch: boolean;
    codeInterpreter: boolean;
    imageGen: boolean;
    voiceInput: 'none' | 'browser' | 'server';
    readAloud: 'none' | 'browser' | 'server';
    /** Blind comparisons are on (Admin → Evaluations). */
    arena: boolean;
    /** Google Drive / OneDrive can be connected. */
    cloudFiles: { google: boolean; microsoft: boolean };
  };
  /** Two-factor sign-in of the signed-in user; `required` means they must turn it on first. */
  mfa: { enabled: boolean; required: boolean } | null;
}

// ─── Two-factor sign-in ──────────────────────────────────────────────────────

export interface MfaStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export interface MfaSetup {
  /** base32, for typing into the app by hand. */
  secret: string;
  /** otpauth:// URI (what the QR code holds). */
  uri: string;
  qrSvg: string;
}

export const MfaCode = z.object({ code: z.string().trim().min(6).max(20) });

/** Signing in either ends in a session, or asks for a code first. */
export type SignInResponse = { user: PublicUser; mfaRequired?: false } | { user: null; mfaRequired: true };

// ─── Single sign-on (OpenID Connect) ─────────────────────────────────────────

export const SsoProviderInput = z.object({
  id: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use lowercase letters, digits and hyphens'),
  name: z.string().trim().min(1).max(60),
  issuer: z.url({ protocol: /^https?$/ }),
  clientId: z.string().trim().min(1).max(500),
  /** Empty keeps the stored secret; null removes it (public clients). */
  clientSecret: z.string().max(2000).nullable().optional(),
  scopes: z.string().trim().min(6).max(500).default('openid email profile'),
  enabled: z.boolean().default(true),
  allowSignup: z.boolean().default(true),
  defaultRole: z.enum(['pending', 'user']).default('pending'),
  allowedDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(100).default([]),
  linkByEmail: z.boolean().default(false),
  groupsClaim: z.string().trim().max(100).nullable().default(null),
  adminGroups: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
});
export type SsoProviderInput = z.input<typeof SsoProviderInput>;

export interface SsoProviderView {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  scopes: string;
  enabled: boolean;
  allowSignup: boolean;
  defaultRole: 'pending' | 'user';
  allowedDomains: string[];
  linkByEmail: boolean;
  groupsClaim: string | null;
  adminGroups: string[];
}

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

/** Directory sign-in. An empty password is refused (and never sent to the directory). */
export const LdapLoginRequest = z.object({
  username: z.string().trim().min(1, 'Enter your username').max(256),
  password: z.string().min(1, 'Enter your password').max(256),
});
export type LdapLoginRequest = z.infer<typeof LdapLoginRequest>;

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
  /** Usage cap override; null = back to defaults and groups. */
  caps: UserCapsSchema.nullable().optional(),
  /** false: can't sign in; sessions and API keys stop working. */
  active: z.boolean().optional(),
});

export const AdminUser = PublicUser.extend({
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
  active: z.boolean(),
  mfaEnabled: z.boolean(),
  /** Created or managed by the identity provider (SCIM). */
  externalId: z.string().nullable(),
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

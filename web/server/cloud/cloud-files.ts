/**
 * Google Drive and OneDrive / SharePoint files. A user connects their
 * account once (OAuth, read-only scopes; tokens kept encrypted), then browses
 * and imports files through the server: the picker is Claudia's own, so no
 * provider script runs on the app origin. Imported files become ordinary
 * files (attachments, knowledge). Google Docs, Sheets and Slides are
 * exported as Word, Excel and PowerPoint; drawings as PDF.
 *
 * The admin turns each provider on with an OAuth client (Admin → Cloud
 * files) whose redirect URI is /api/cloud/<provider>/callback.
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { appConfig, cloudAccounts } from '../db/schema';
import type { SecretBox } from '../crypto/secrets';
import { HttpError, badRequest, notFound } from '../lib/errors';
import { MAX_UPLOAD_BYTES } from '../../shared/files';
import {
  CloudSettings,
  type CloudAccountView,
  type CloudItem,
  type CloudListing,
  type CloudProvider,
  type CloudSettingsResponse,
  type CloudSettingsUpdate,
} from '../../shared/cloud';

/** The provider endpoints (tests point them at a local fake). */
export interface CloudEndpoints {
  google: { authorize: string; token: string; api: string; userinfo: string };
  microsoft: { login: string; graph: string };
}

export const DEFAULT_ENDPOINTS: CloudEndpoints = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    api: 'https://www.googleapis.com',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  },
  microsoft: { login: 'https://login.microsoftonline.com', graph: 'https://graph.microsoft.com/v1.0' },
};

const SCOPES: Record<CloudProvider, string> = {
  google: 'openid email https://www.googleapis.com/auth/drive.readonly',
  microsoft: 'offline_access User.Read Files.Read.All',
};

/** Google's own formats, and what they are exported as. */
const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  'application/vnd.google-apps.drawing': { mime: 'application/pdf', ext: 'pdf' },
};

interface Secrets {
  googleSecret?: string;
  microsoftSecret?: string;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

export interface CloudState {
  provider: CloudProvider;
  userId: string;
  state: string;
  expires: number;
}

const DEFAULTS: CloudSettings = { google: { enabled: false, clientId: '' }, microsoft: { enabled: false, clientId: '', tenant: 'common' } };

export class CloudFiles {
  private cached: { settings: CloudSettings; secrets: Secrets } | null = null;

  constructor(
    private readonly deps: { db: Database; secrets: SecretBox; log: FastifyBaseLogger; endpoints?: Partial<CloudEndpoints> }
  ) {}

  private get endpoints(): CloudEndpoints {
    return { ...DEFAULT_ENDPOINTS, ...this.deps.endpoints };
  }

  // ─── Admin settings ────────────────────────────────────────────────────────

  private async load(): Promise<{ settings: CloudSettings; secrets: Secrets }> {
    if (this.cached) return this.cached;
    const rows = await this.deps.db.select().from(appConfig);
    const raw = rows.find((r) => r.key === 'cloud')?.value;
    const parsed = CloudSettings.safeParse({ ...DEFAULTS, ...(raw as object) });
    const cipher = rows.find((r) => r.key === 'cloud.secrets')?.value as string | undefined;
    let secrets: Secrets = {};
    try {
      secrets = cipher ? (JSON.parse(this.deps.secrets.decrypt(cipher)) as Secrets) : {};
    } catch {
      secrets = {};
    }
    this.cached = { settings: parsed.success ? parsed.data : DEFAULTS, secrets };
    return this.cached;
  }

  reset(): void {
    this.cached = null;
  }

  async view(): Promise<CloudSettingsResponse> {
    const { settings, secrets } = await this.load();
    return { settings, hasSecret: { google: !!secrets.googleSecret, microsoft: !!secrets.microsoftSecret } };
  }

  async update(input: CloudSettingsUpdate): Promise<CloudSettingsResponse> {
    const { settings, secrets } = await this.load();
    const next = CloudSettings.parse({
      google: { ...settings.google, ...input.google },
      microsoft: { ...settings.microsoft, ...input.microsoft },
    });
    const nextSecrets: Secrets = { ...secrets };
    // Empty keeps the stored secret; null removes it
    if (input.googleSecret !== undefined && input.googleSecret !== '') nextSecrets.googleSecret = input.googleSecret ?? undefined;
    if (input.microsoftSecret !== undefined && input.microsoftSecret !== '') nextSecrets.microsoftSecret = input.microsoftSecret ?? undefined;
    for (const [key, value] of [
      ['cloud', next],
      ['cloud.secrets', this.deps.secrets.encrypt(JSON.stringify(nextSecrets))],
    ] as const) {
      await this.deps.db
        .insert(appConfig)
        .values({ key, value })
        .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
    }
    this.cached = null;
    return this.view();
  }

  /** Which providers users can connect. */
  async available(): Promise<{ google: boolean; microsoft: boolean }> {
    const { settings, secrets } = await this.load();
    return {
      google: settings.google.enabled && !!settings.google.clientId && !!secrets.googleSecret,
      microsoft: settings.microsoft.enabled && !!settings.microsoft.clientId && !!secrets.microsoftSecret,
    };
  }

  private async client(provider: CloudProvider): Promise<{ clientId: string; secret: string; tenant: string }> {
    if (!(await this.available())[provider]) throw badRequest(`${provider === 'google' ? 'Google Drive' : 'OneDrive'} is not set up on this server.`, 'cloud_off');
    const { settings, secrets } = await this.load();
    return provider === 'google'
      ? { clientId: settings.google.clientId, secret: secrets.googleSecret!, tenant: '' }
      : { clientId: settings.microsoft.clientId, secret: secrets.microsoftSecret!, tenant: settings.microsoft.tenant || 'common' };
  }

  private tokenUrl(provider: CloudProvider, tenant: string): string {
    return provider === 'google' ? this.endpoints.google.token : `${this.endpoints.microsoft.login}/${tenant}/oauth2/v2.0/token`;
  }

  // ─── Connecting ────────────────────────────────────────────────────────────

  async connectUrl(provider: CloudProvider, userId: string, redirectUri: string): Promise<{ url: string; state: CloudState }> {
    const { clientId, tenant } = await this.client(provider);
    const state: CloudState = { provider, userId, state: randomBytes(24).toString('base64url'), expires: Date.now() + 10 * 60_000 };
    const url = new URL(provider === 'google' ? this.endpoints.google.authorize : `${this.endpoints.microsoft.login}/${tenant}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPES[provider],
      state: state.state,
      ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } : { prompt: 'select_account' }),
    }).toString();
    return { url: url.toString(), state };
  }

  async finishConnect(provider: CloudProvider, saved: CloudState | null, userId: string, query: { code?: string; state?: string; error?: string }, redirectUri: string): Promise<void> {
    if (query.error) throw badRequest(`The provider refused: ${query.error}.`, 'cloud_refused');
    if (!saved || saved.provider !== provider || saved.userId !== userId || saved.expires < Date.now() || saved.state !== query.state) {
      throw badRequest('This connection attempt expired. Try again.', 'cloud_state');
    }
    if (!query.code) throw badRequest('The provider sent no code.', 'cloud_no_code');
    const tokens = await this.tokenRequest(provider, { grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri });
    const email = await this.accountEmail(provider, tokens.access_token).catch(() => null);
    const values = {
      accountEmail: email,
      accessCipher: this.deps.secrets.encrypt(tokens.access_token),
      refreshCipher: tokens.refresh_token ? this.deps.secrets.encrypt(tokens.refresh_token) : null,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    };
    await this.deps.db
      .insert(cloudAccounts)
      .values({ userId, provider, ...values })
      .onConflictDoUpdate({ target: [cloudAccounts.userId, cloudAccounts.provider], set: values });
  }

  private async tokenRequest(provider: CloudProvider, params: Record<string, string>): Promise<Tokens> {
    const { clientId, secret, tenant } = await this.client(provider);
    const res = await fetch(this.tokenUrl(provider, tenant), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: secret, ...params, ...(provider === 'microsoft' ? { scope: SCOPES.microsoft } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Tokens & { error?: string; error_description?: string };
    if (!res.ok || !json.access_token) {
      throw new HttpError(502, 'cloud_token', `The provider didn't accept the request (${json.error_description ?? json.error ?? res.status}).`);
    }
    return json;
  }

  private async accountEmail(provider: CloudProvider, accessToken: string): Promise<string | null> {
    const url = provider === 'google' ? this.endpoints.google.userinfo : `${this.endpoints.microsoft.graph}/me`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string; mail?: string; userPrincipalName?: string };
    return json.email ?? json.mail ?? json.userPrincipalName ?? null;
  }

  async accounts(userId: string): Promise<CloudAccountView[]> {
    const available = await this.available();
    const rows = await this.deps.db.select().from(cloudAccounts).where(eq(cloudAccounts.userId, userId));
    return (['google', 'microsoft'] as const)
      .filter((p) => available[p])
      .map((provider) => {
        const row = rows.find((r) => r.provider === provider);
        return { provider, connected: !!row, accountEmail: row?.accountEmail ?? null };
      });
  }

  async disconnect(userId: string, provider: CloudProvider): Promise<void> {
    await this.deps.db.delete(cloudAccounts).where(and(eq(cloudAccounts.userId, userId), eq(cloudAccounts.provider, provider)));
  }

  /** A current access token, refreshed when it is about to expire. */
  private async accessToken(userId: string, provider: CloudProvider): Promise<string> {
    const [row] = await this.deps.db
      .select()
      .from(cloudAccounts)
      .where(and(eq(cloudAccounts.userId, userId), eq(cloudAccounts.provider, provider)));
    if (!row) throw badRequest('Connect the account first.', 'cloud_not_connected');
    if (!row.expiresAt || row.expiresAt.getTime() - Date.now() > 60_000) return this.deps.secrets.decrypt(row.accessCipher);
    if (!row.refreshCipher) throw badRequest('The connection expired. Connect the account again.', 'cloud_expired');
    let tokens: Tokens;
    try {
      tokens = await this.tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: this.deps.secrets.decrypt(row.refreshCipher) });
    } catch {
      await this.disconnect(userId, provider);
      throw badRequest('The connection expired or was revoked. Connect the account again.', 'cloud_expired');
    }
    await this.deps.db
      .update(cloudAccounts)
      .set({
        accessCipher: this.deps.secrets.encrypt(tokens.access_token),
        ...(tokens.refresh_token ? { refreshCipher: this.deps.secrets.encrypt(tokens.refresh_token) } : {}),
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
      })
      .where(and(eq(cloudAccounts.userId, userId), eq(cloudAccounts.provider, provider)));
    return tokens.access_token;
  }

  private async api(userId: string, provider: CloudProvider, url: string): Promise<Response> {
    const token = await this.accessToken(userId, provider);
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) {
      await this.disconnect(userId, provider);
      throw badRequest('The connection was revoked. Connect the account again.', 'cloud_expired');
    }
    if (res.status === 404) throw notFound('File');
    if (!res.ok) throw new HttpError(502, 'cloud_error', `The provider answered ${res.status}.`);
    return res;
  }

  // ─── Browsing and importing ────────────────────────────────────────────────

  async list(userId: string, provider: CloudProvider, opts: { folder?: string; q?: string; page?: string }): Promise<CloudListing> {
    if (provider === 'google') {
      const clauses = ['trashed = false'];
      if (opts.q) clauses.push(`name contains '${opts.q.replace(/['\\]/g, (c) => `\\${c}`)}'`);
      else clauses.push(`'${(opts.folder ?? 'root').replace(/[^A-Za-z0-9_-]/g, '')}' in parents`);
      const url = new URL(`${this.endpoints.google.api}/drive/v3/files`);
      url.search = new URLSearchParams({
        q: clauses.join(' and '),
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
        orderBy: 'folder,name',
        pageSize: '100',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        ...(opts.page ? { pageToken: opts.page } : {}),
      }).toString();
      const json = (await (await this.api(userId, provider, url.toString())).json()) as {
        nextPageToken?: string;
        files: Array<{ id: string; name: string; mimeType: string; size?: string; modifiedTime?: string }>;
      };
      return {
        items: json.files.map(
          (f): CloudItem => ({
            id: f.id,
            name: GOOGLE_EXPORTS[f.mimeType] ? `${f.name}.${GOOGLE_EXPORTS[f.mimeType].ext}` : f.name,
            folder: f.mimeType === 'application/vnd.google-apps.folder',
            mime: GOOGLE_EXPORTS[f.mimeType]?.mime ?? f.mimeType,
            size: f.size ? Number(f.size) : null,
            modifiedAt: f.modifiedTime ?? null,
          })
        ),
        next: json.nextPageToken ?? null,
      };
    }
    const base = this.endpoints.microsoft.graph;
    const select = '$select=id,name,size,file,folder,lastModifiedDateTime&$top=100';
    const url = opts.page
      ? opts.page
      : opts.q
        ? `${base}/me/drive/root/search(q='${encodeURIComponent(opts.q.replace(/'/g, "''"))}')?${select}`
        : opts.folder
          ? `${base}/me/drive/items/${encodeURIComponent(opts.folder)}/children?${select}`
          : `${base}/me/drive/root/children?${select}`;
    // Only follow next links back to Graph itself
    if (opts.page && !opts.page.startsWith(`${base}/`)) throw badRequest('Bad page link.');
    const json = (await (await this.api(userId, provider, url)).json()) as {
      value: Array<{ id: string; name: string; size?: number; file?: { mimeType?: string }; folder?: object; lastModifiedDateTime?: string }>;
      '@odata.nextLink'?: string;
    };
    return {
      items: json.value.map((f) => ({
        id: f.id,
        name: f.name,
        folder: !!f.folder,
        mime: f.file?.mimeType ?? (f.folder ? 'folder' : 'application/octet-stream'),
        size: f.size ?? null,
        modifiedAt: f.lastModifiedDateTime ?? null,
      })),
      next: json['@odata.nextLink'] ?? null,
    };
  }

  /** The file's name, type and bytes (Google formats exported). */
  async download(userId: string, provider: CloudProvider, fileId: string): Promise<{ name: string; mime: string; data: Buffer }> {
    let name: string;
    let mime: string;
    let contentUrl: string;
    if (provider === 'google') {
      const id = encodeURIComponent(fileId);
      const meta = (await (await this.api(userId, provider, `${this.endpoints.google.api}/drive/v3/files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true`)).json()) as {
        name: string;
        mimeType: string;
        size?: string;
      };
      if (meta.mimeType === 'application/vnd.google-apps.folder') throw badRequest('That is a folder.', 'cloud_folder');
      const exp = GOOGLE_EXPORTS[meta.mimeType];
      if (!exp && meta.mimeType.startsWith('application/vnd.google-apps.')) throw badRequest("This kind of Google file can't be imported.", 'cloud_unsupported');
      if (meta.size && Number(meta.size) > MAX_UPLOAD_BYTES) throw badRequest(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'file_too_large');
      name = exp ? `${meta.name}.${exp.ext}` : meta.name;
      mime = exp?.mime ?? meta.mimeType;
      contentUrl = exp
        ? `${this.endpoints.google.api}/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exp.mime)}`
        : `${this.endpoints.google.api}/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
    } else {
      const id = encodeURIComponent(fileId);
      const meta = (await (await this.api(userId, provider, `${this.endpoints.microsoft.graph}/me/drive/items/${id}?$select=id,name,size,file,folder`)).json()) as {
        name: string;
        size?: number;
        file?: { mimeType?: string };
        folder?: object;
      };
      if (meta.folder) throw badRequest('That is a folder.', 'cloud_folder');
      if (meta.size && meta.size > MAX_UPLOAD_BYTES) throw badRequest(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'file_too_large');
      name = meta.name;
      mime = meta.file?.mimeType ?? 'application/octet-stream';
      contentUrl = `${this.endpoints.microsoft.graph}/me/drive/items/${id}/content`;
    }
    const res = await this.api(userId, provider, contentUrl);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_UPLOAD_BYTES) throw badRequest(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'file_too_large');
    return { name, mime, data };
  }
}

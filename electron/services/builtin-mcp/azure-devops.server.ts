/**
 * Azure DevOps Server / TFS work items: query, read, create, update, resolve,
 * comment and link. The server never sees a token: the host passes an
 * `azdo` client that knows the user's connections and sends each request,
 * signed in, to the collection it belongs to (the web server: through the
 * SSRF guard, to the admin's collections only). Tools that change data are
 * marked readOnlyHint: false, so the host can ask the user first.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errorResult } from './office-files';

// ============================================================================
// Host interface
// ============================================================================

export interface AzdoConnection {
  serverId: string;
  name: string;
  /** The collection URL, without a trailing slash. */
  url: string;
  apiVersion: string;
  connected: boolean;
  displayName: string | null;
  defaultProject: string | null;
}

export interface AzdoRequest {
  method: 'GET' | 'POST' | 'PATCH';
  /** Relative to the collection URL, e.g. "Fabrikam/_apis/wit/wiql". */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Default application/json. */
  contentType?: string;
}

export interface AzdoResponse {
  status: number;
  json: unknown;
}

export interface AzdoClient {
  connections(): Promise<AzdoConnection[]>;
  /** Throws when the token is missing or rejected; other HTTP errors come back as a status. */
  request(serverId: string, req: AzdoRequest): Promise<AzdoResponse>;
}

// ============================================================================
// Helpers
// ============================================================================

/** Fields shown for each work item in lists. */
const LIST_FIELDS = [
  'System.Id',
  'System.WorkItemType',
  'System.Title',
  'System.State',
  'System.AssignedTo',
  'System.TeamProject',
  'System.IterationPath',
  'System.Tags',
  'System.ChangedDate',
  'Microsoft.VSTS.Common.Priority',
];
const BATCH = 200;
const MAX_TEXT = 8_000;

/** Link types the model can name, and their reference names. */
const LINK_TYPES = {
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  related: 'System.LinkTypes.Related',
  duplicate: 'System.LinkTypes.Duplicate-Forward',
  duplicate_of: 'System.LinkTypes.Duplicate-Reverse',
  successor: 'System.LinkTypes.Dependency-Forward',
  predecessor: 'System.LinkTypes.Dependency-Reverse',
} as const;
const LINK_NAMES = Object.fromEntries(Object.entries(LINK_TYPES).map(([k, v]) => [v, k]));

class AzdoError extends Error {}

type Fields = Record<string, unknown>;
interface WorkItem {
  id: number;
  rev?: number;
  fields: Fields;
  relations?: Array<{ rel: string; url: string; attributes?: { comment?: string } }>;
}
type PatchOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown };

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

/** A person field: an identity object on 5.0+, "Name <DOMAIN\user>" on TFS 2018. */
function person(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.replace(/\s*<[^>]*>$/, '') || value;
  const v = value as { displayName?: string; uniqueName?: string };
  return v.displayName ?? v.uniqueName ?? null;
}

/** HTML fields (description, history) as readable text. */
export function htmlToText(html: unknown, max = MAX_TEXT): string {
  if (typeof html !== 'string' || !html) return '';
  const text = html
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Tags that mark text as HTML already ("<open>" in plain text doesn't). */
const HTML_TAG = /<\/?(p|div|br|span|b|i|u|s|strong|em|a|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|pre|code|blockquote|hr|img)\b[^>]*>/i;

/** Plain text (or Markdown) as the HTML the rich-text fields store; HTML stays as written. */
export function textToHtml(text: string): string {
  if (HTML_TAG.test(text)) return text;
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
}

/** A string in a WIQL literal. */
const wiqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface WorkItemFilters {
  types?: string[];
  states?: string[];
  include_closed?: boolean;
  assigned_to?: string;
  iteration?: string;
  area?: string;
  text?: string;
  tags?: string[];
}

/** The filters as a WIQL query over the project. */
export function buildWiql(f: WorkItemFilters): string {
  const where = ['[System.TeamProject] = @project'];
  const list = (values: string[]) => values.map(wiqlString).join(', ');
  if (f.types?.length) where.push(`[System.WorkItemType] IN (${list(f.types)})`);
  if (f.states?.length) where.push(`[System.State] IN (${list(f.states)})`);
  else if (!f.include_closed) where.push(`[System.State] NOT IN ('Closed', 'Done', 'Removed')`);
  if (f.assigned_to) where.push(`[System.AssignedTo] = ${/^@me$/i.test(f.assigned_to) ? '@Me' : wiqlString(f.assigned_to)}`);
  if (f.iteration) {
    where.push(/^@currentiteration$/i.test(f.iteration) ? '[System.IterationPath] = @CurrentIteration' : `[System.IterationPath] UNDER ${wiqlString(f.iteration)}`);
  }
  if (f.area) where.push(`[System.AreaPath] UNDER ${wiqlString(f.area)}`);
  if (f.text) where.push(`[System.Title] CONTAINS ${wiqlString(f.text)}`);
  for (const tag of f.tags ?? []) where.push(`[System.Tags] CONTAINS ${wiqlString(tag)}`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

/** The state that "resolves" a work item of this type: Resolved, else Completed (by category, or by name on TFS 2018). */
export function resolvedState(type: { states?: Array<{ name: string; category?: string }>; transitions?: Record<string, unknown> }): string | null {
  const states = type.states ?? [];
  for (const category of ['Resolved', 'Completed']) {
    const found = states.find((s) => s.category === category);
    if (found) return found.name;
  }
  const names = states.length ? states.map((s) => s.name) : Object.keys(type.transitions ?? {}).filter(Boolean);
  for (const name of ['Resolved', 'Done', 'Closed', 'Completed']) if (names.includes(name)) return name;
  return null;
}

// ============================================================================
// Server
// ============================================================================

export function createAzureDevOpsServer(config?: Record<string, unknown>): McpServer {
  const server = new McpServer({ name: 'Claudia Azure DevOps', version: '1.0.0' }, { capabilities: { tools: {} } });
  const client = config?.azdo as AzdoClient | undefined;

  const read = { readOnlyHint: true, openWorldHint: true } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const serverParam = z
    .string()
    .optional()
    .describe('Collection name or id from azdo_list_connections. Leave out when only one is connected.');
  const projectParam = z.string().min(1).max(256).optional().describe("Project name. Leave out to use the connection's default project.");
  const idParam = z.number().int().positive().describe('Work item id, e.g. 1234.');

  /** Run a tool body, turning failures into an error result. */
  const run = async <T>(body: () => Promise<T>) => {
    if (!client) return errorResult("Azure DevOps isn't set up here.");
    try {
      return await body();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };

  async function connection(name?: string): Promise<AzdoConnection> {
    const all = await client!.connections();
    const connected = all.filter((c) => c.connected);
    if (name) {
      const want = name.trim().toLowerCase();
      const found = all.find((c) => c.serverId === name || c.name.toLowerCase() === want || c.url.toLowerCase() === want);
      if (!found) throw new AzdoError(`No collection called "${name}". Available: ${all.map((c) => c.name).join(', ') || 'none'}.`);
      if (!found.connected) throw new AzdoError(`Connect ${found.name} in Settings → Tools first.`);
      return found;
    }
    if (connected.length === 1) return connected[0];
    if (connected.length === 0) {
      throw new AzdoError(all.length ? 'Connect your Azure DevOps account in Settings → Tools first.' : "The administrator hasn't added an Azure DevOps server yet.");
    }
    throw new AzdoError(`Several collections are connected (${connected.map((c) => c.name).join(', ')}): pass "server".`);
  }

  function projectOf(conn: AzdoConnection, project?: string): string {
    const p = project?.trim() || conn.defaultProject;
    if (!p) throw new AzdoError('Pass "project" (azdo_list_projects lists them), or set a default project in Settings → Tools.');
    return p;
  }

  async function api<T = unknown>(conn: AzdoConnection, req: AzdoRequest): Promise<T> {
    const res = await client!.request(conn.serverId, req);
    if (res.status >= 400) {
      const message = (res.json as { message?: string } | null)?.message;
      if (res.status === 404) throw new AzdoError(message ?? 'Not found.');
      throw new AzdoError(`Azure DevOps refused the request (${res.status}): ${message ?? 'no details'}`);
    }
    return res.json as T;
  }

  const seg = encodeURIComponent;
  const webUrl = (conn: AzdoConnection, wi: WorkItem) =>
    `${conn.url}/${seg(String(wi.fields['System.TeamProject'] ?? ''))}/_workitems/edit/${wi.id}`;
  const apiUrl = (conn: AzdoConnection, id: number) => `${conn.url}/_apis/wit/workItems/${id}`;

  function brief(conn: AzdoConnection, wi: WorkItem) {
    const f = wi.fields;
    return {
      id: wi.id,
      type: f['System.WorkItemType'],
      title: f['System.Title'],
      state: f['System.State'],
      assignedTo: person(f['System.AssignedTo']),
      iteration: f['System.IterationPath'],
      ...(f['System.Tags'] ? { tags: f['System.Tags'] } : {}),
      ...(f['Microsoft.VSTS.Common.Priority'] !== undefined ? { priority: f['Microsoft.VSTS.Common.Priority'] } : {}),
      changed: f['System.ChangedDate'],
      url: webUrl(conn, wi),
    };
  }

  async function workItems(conn: AzdoConnection, ids: number[]): Promise<WorkItem[]> {
    const out: WorkItem[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const page = await api<{ value: WorkItem[] }>(conn, {
        method: 'GET',
        path: '_apis/wit/workitems',
        query: { ids: ids.slice(i, i + BATCH).join(','), fields: LIST_FIELDS.join(','), errorPolicy: 'omit' },
      });
      out.push(...(page.value ?? []).filter(Boolean));
    }
    return out;
  }

  async function patch(conn: AzdoConnection, id: number, ops: PatchOp[]): Promise<WorkItem> {
    return api<WorkItem>(conn, { method: 'PATCH', path: `_apis/wit/workitems/${id}`, body: ops, contentType: 'application/json-patch+json' });
  }

  const field = (name: string, value: unknown): PatchOp => ({ op: 'add', path: `/fields/${name}`, value });

  // ---- azdo_list_connections ----
  server.tool(
    'azdo_list_connections',
    "The user's Azure DevOps Server collections: which are connected, who they sign in as, and the default project.",
    {},
    read,
    async () =>
      run(async () =>
        json(
          (await client!.connections()).map((c) => ({
            server: c.name,
            id: c.serverId,
            url: c.url,
            connected: c.connected,
            signedInAs: c.displayName,
            defaultProject: c.defaultProject,
          }))
        )
      )
  );

  // ---- azdo_list_projects ----
  server.tool('azdo_list_projects', 'List the projects in an Azure DevOps collection.', { server: serverParam }, read, async ({ server: name }) =>
    run(async () => {
      const conn = await connection(name);
      const res = await api<{ value: Array<{ id: string; name: string; description?: string }> }>(conn, {
        method: 'GET',
        path: '_apis/projects',
        query: { $top: 500 },
      });
      return json(res.value.map((p) => ({ name: p.name, ...(p.description ? { description: p.description } : {}) })));
    })
  );

  // ---- azdo_query_work_items ----
  server.tool(
    'azdo_query_work_items',
    'Find work items (tasks, bugs, user stories, issues…). Use the filters, or pass a WIQL query for anything else. ' +
      'Closed, Done and Removed items are left out unless you ask for states or include_closed. ' +
      'For "my work" use assigned_to "@Me"; for the current sprint use iteration "@CurrentIteration" (with the team).',
    {
      server: serverParam,
      project: projectParam,
      team: z.string().max(256).optional().describe('Team name (for @CurrentIteration; default: the project\'s default team).'),
      types: z.array(z.string().max(100)).max(20).optional().describe('Work item types, e.g. ["Bug", "Task"].'),
      states: z.array(z.string().max(100)).max(20).optional(),
      include_closed: z.boolean().optional(),
      assigned_to: z.string().max(256).optional().describe('"@Me", or a display name / account.'),
      iteration: z.string().max(1000).optional().describe('"@CurrentIteration", or an iteration path (includes sub-iterations).'),
      area: z.string().max(1000).optional().describe('Area path (includes sub-areas).'),
      text: z.string().max(500).optional().describe('Words the title contains.'),
      tags: z.array(z.string().max(100)).max(10).optional(),
      wiql: z.string().max(32_000).optional().describe('A WIQL SELECT query; replaces the filters.'),
      top: z.number().int().min(1).max(1000).optional().describe('At most this many (default 50).'),
    },
    read,
    async (args) =>
      run(async () => {
        const conn = await connection(args.server);
        const project = projectOf(conn, args.project);
        if (args.wiql && !/^\s*select\b/i.test(args.wiql)) throw new AzdoError('WIQL must be a SELECT query.');
        const query = args.wiql ?? buildWiql(args);
        const path = `${seg(project)}/${args.team ? `${seg(args.team)}/` : ''}_apis/wit/wiql`;
        const top = args.top ?? 50;
        const res = await api<{ workItems?: Array<{ id: number }>; workItemRelations?: Array<{ target?: { id: number } }> }>(conn, {
          method: 'POST',
          path,
          query: { $top: top },
          body: { query },
        });
        const ids = [...new Set((res.workItems ?? res.workItemRelations?.map((r) => r.target).filter((t): t is { id: number } => !!t) ?? []).map((w) => w.id))].slice(0, top);
        if (ids.length === 0) return json({ count: 0, workItems: [] });
        const items = await workItems(conn, ids);
        // Keep the query's order
        const byId = new Map(items.map((w) => [w.id, w]));
        const ordered = ids.map((id) => byId.get(id)).filter((w): w is WorkItem => !!w);
        return json({ count: ordered.length, workItems: ordered.map((w) => brief(conn, w)) });
      })
  );

  // ---- azdo_get_work_item ----
  server.tool(
    'azdo_get_work_item',
    'Read one work item: its fields, description, parent, children and other links, and recent discussion.',
    { server: serverParam, id: idParam, include_history: z.boolean().optional().describe('Recent comments (default true).') },
    read,
    async ({ server: name, id, include_history }) =>
      run(async () => {
        const conn = await connection(name);
        const wi = await api<WorkItem>(conn, { method: 'GET', path: `_apis/wit/workitems/${id}`, query: { $expand: 'relations' } });
        const f = wi.fields;
        const links: Record<string, number[]> = {};
        for (const r of wi.relations ?? []) {
          const kind = LINK_NAMES[r.rel];
          const target = Number(/\/workItems\/(\d+)$/i.exec(r.url)?.[1]);
          if (kind && target) (links[kind] ??= []).push(target);
        }
        const out: Record<string, unknown> = {
          ...brief(conn, wi),
          reason: f['System.Reason'],
          area: f['System.AreaPath'],
          createdBy: person(f['System.CreatedBy']),
          created: f['System.CreatedDate'],
          description: htmlToText(f['System.Description']) || undefined,
          reproSteps: htmlToText(f['Microsoft.VSTS.TCM.ReproSteps']) || undefined,
          acceptanceCriteria: htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria']) || undefined,
          ...(Object.keys(links).length ? { links } : {}),
        };
        if (include_history !== false) {
          const updates = await api<{ value: Array<{ revisedBy?: unknown; revisedDate?: string; fields?: Fields }> }>(conn, {
            method: 'GET',
            path: `_apis/wit/workitems/${id}/updates`,
            query: { $top: 200 },
          });
          const comments = (updates.value ?? [])
            .map((u) => ({ by: person(u.revisedBy), at: u.revisedDate, text: htmlToText((u.fields?.['System.History'] as { newValue?: string })?.newValue, 2_000) }))
            .filter((c) => c.text)
            .slice(-10);
          if (comments.length) out.comments = comments;
        }
        return json(out);
      })
  );

  // ---- azdo_list_work_item_types ----
  server.tool(
    'azdo_list_work_item_types',
    "A project's work item types and their states (with categories: Proposed, InProgress, Resolved, Completed, Removed). " +
      'With "type": also the allowed state transitions and the fields that must be set. States differ between ' +
      'process templates (Agile, Scrum, CMMI), so check here before setting a state.',
    { server: serverParam, project: projectParam, type: z.string().max(100).optional() },
    read,
    async ({ server: name, project, type }) =>
      run(async () => {
        const conn = await connection(name);
        const p = seg(projectOf(conn, project));
        type WitType = {
          name: string;
          description?: string;
          states?: Array<{ name: string; category?: string }>;
          transitions?: Record<string, Array<{ to: string }>>;
          fields?: Array<{ referenceName: string; name: string; alwaysRequired?: boolean }>;
        };
        if (type) {
          const t = await api<WitType>(conn, { method: 'GET', path: `${p}/_apis/wit/workitemtypes/${seg(type)}` });
          return json({
            name: t.name,
            states: t.states?.map((s) => ({ name: s.name, category: s.category })),
            transitions: Object.fromEntries(Object.entries(t.transitions ?? {}).map(([from, to]) => [from || '(new)', to.map((x) => x.to)])),
            requiredFields: t.fields?.filter((f) => f.alwaysRequired).map((f) => f.referenceName),
            resolvesTo: resolvedState(t),
          });
        }
        const res = await api<{ value: WitType[] }>(conn, { method: 'GET', path: `${p}/_apis/wit/workitemtypes` });
        return json(
          res.value.map((t) => ({
            name: t.name,
            states: t.states?.map((s) => `${s.name}${s.category ? ` (${s.category})` : ''}`) ?? Object.keys(t.transitions ?? {}).filter(Boolean),
          }))
        );
      })
  );

  // ---- azdo_list_iterations ----
  server.tool(
    'azdo_list_iterations',
    "A team's iterations (sprints) with dates; the current one is marked.",
    { server: serverParam, project: projectParam, team: z.string().max(256).optional().describe("Default: the project's default team.") },
    read,
    async ({ server: name, project, team }) =>
      run(async () => {
        const conn = await connection(name);
        const path = `${seg(projectOf(conn, project))}/${team ? `${seg(team)}/` : ''}_apis/work/teamsettings/iterations`;
        const res = await api<{ value: Array<{ name: string; path: string; attributes?: { startDate?: string; finishDate?: string; timeFrame?: string } }> }>(
          conn,
          { method: 'GET', path }
        );
        const now = Date.now();
        return json(
          res.value.map((it) => {
            const { startDate, finishDate, timeFrame } = it.attributes ?? {};
            const current =
              timeFrame === 'current' ||
              (!timeFrame && !!startDate && !!finishDate && Date.parse(startDate) <= now && now <= Date.parse(finishDate) + 86_400_000);
            return { name: it.name, path: it.path, start: startDate ?? null, finish: finishDate ?? null, ...(current ? { current: true } : {}) };
          })
        );
      })
  );

  // ---- azdo_create_work_item ----
  server.tool(
    'azdo_create_work_item',
    'Create a work item (task, bug, user story, issue…). The user is asked to approve it first.',
    {
      server: serverParam,
      project: projectParam,
      type: z.string().min(1).max(100).describe('Work item type, e.g. "Task", "Bug", "User Story", "Product Backlog Item", "Issue".'),
      title: z.string().min(1).max(255),
      description: z.string().max(100_000).optional().describe('Plain text or HTML.'),
      assigned_to: z.string().max(256).optional().describe('Display name or account (e.g. "DOMAIN\\\\jdoe").'),
      area: z.string().max(1000).optional().describe('Area path.'),
      iteration: z.string().max(1000).optional().describe('Iteration path, e.g. "Fabrikam\\\\Sprint 12".'),
      tags: z.array(z.string().max(100)).max(20).optional(),
      priority: z.number().int().min(1).max(4).optional(),
      parent_id: z.number().int().positive().optional().describe('Make it a child of this work item.'),
      fields: z.record(z.string().max(256), z.unknown()).optional().describe('Other fields by reference name, e.g. {"Microsoft.VSTS.Scheduling.RemainingWork": 4}.'),
    },
    write,
    async (args) =>
      run(async () => {
        const conn = await connection(args.server);
        const project = projectOf(conn, args.project);
        const ops: PatchOp[] = [field('System.Title', args.title)];
        if (args.description) ops.push(field('System.Description', textToHtml(args.description)));
        if (args.assigned_to) ops.push(field('System.AssignedTo', args.assigned_to));
        if (args.area) ops.push(field('System.AreaPath', args.area));
        if (args.iteration) ops.push(field('System.IterationPath', args.iteration));
        if (args.tags?.length) ops.push(field('System.Tags', args.tags.join('; ')));
        if (args.priority) ops.push(field('Microsoft.VSTS.Common.Priority', args.priority));
        for (const [name, value] of Object.entries(args.fields ?? {})) ops.push(field(name, value));
        if (args.parent_id) {
          ops.push({ op: 'add', path: '/relations/-', value: { rel: LINK_TYPES.parent, url: apiUrl(conn, args.parent_id) } });
        }
        const wi = await api<WorkItem>(conn, {
          method: 'POST',
          path: `${seg(project)}/_apis/wit/workitems/$${seg(args.type)}`,
          body: ops,
          contentType: 'application/json-patch+json',
        });
        return json({ created: brief(conn, wi) });
      })
  );

  // ---- azdo_update_work_item ----
  server.tool(
    'azdo_update_work_item',
    'Change a work item: title, state, assignee, iteration, tags, description or other fields, optionally with a comment. ' +
      'The user is asked to approve it first. To resolve or close it, azdo_resolve_work_item picks the right state.',
    {
      server: serverParam,
      id: idParam,
      title: z.string().min(1).max(255).optional(),
      state: z.string().max(100).optional(),
      reason: z.string().max(100).optional().describe('Reason for the state change, e.g. "Fixed".'),
      assigned_to: z.string().max(256).optional().describe('Display name or account; "" unassigns.'),
      area: z.string().max(1000).optional(),
      iteration: z.string().max(1000).optional(),
      tags: z.array(z.string().max(100)).max(20).optional().describe('Replaces the tags.'),
      priority: z.number().int().min(1).max(4).optional(),
      description: z.string().max(100_000).optional().describe('Replaces the description (plain text or HTML).'),
      comment: z.string().max(100_000).optional(),
      fields: z.record(z.string().max(256), z.unknown()).optional().describe('Other fields by reference name.'),
    },
    write,
    async (args) =>
      run(async () => {
        const conn = await connection(args.server);
        const ops: PatchOp[] = [];
        if (args.title) ops.push(field('System.Title', args.title));
        if (args.state) ops.push(field('System.State', args.state));
        if (args.reason) ops.push(field('System.Reason', args.reason));
        if (args.assigned_to !== undefined) ops.push(field('System.AssignedTo', args.assigned_to));
        if (args.area) ops.push(field('System.AreaPath', args.area));
        if (args.iteration) ops.push(field('System.IterationPath', args.iteration));
        if (args.tags) ops.push(field('System.Tags', args.tags.join('; ')));
        if (args.priority) ops.push(field('Microsoft.VSTS.Common.Priority', args.priority));
        if (args.description !== undefined) ops.push(field('System.Description', textToHtml(args.description)));
        for (const [name, value] of Object.entries(args.fields ?? {})) ops.push(field(name, value));
        if (args.comment) ops.push(field('System.History', textToHtml(args.comment)));
        if (ops.length === 0) throw new AzdoError('Nothing to change.');
        const wi = await patch(conn, args.id, ops);
        return json({ updated: brief(conn, wi) });
      })
  );

  // ---- azdo_resolve_work_item ----
  server.tool(
    'azdo_resolve_work_item',
    'Resolve a work item: move it to its type\'s resolved state (e.g. Resolved for an Agile or CMMI bug, Done under ' +
      'Scrum), optionally with a reason and a comment. The user is asked to approve it first.',
    {
      server: serverParam,
      id: idParam,
      comment: z.string().max(100_000).optional().describe('E.g. what fixed it, or the build it is in.'),
      reason: z.string().max(100).optional().describe('E.g. "Fixed", "As Designed", "Cannot Reproduce", "Duplicate".'),
      state: z.string().max(100).optional().describe('A different target state (e.g. "Closed").'),
    },
    write,
    async ({ server: name, id, comment, reason, state }) =>
      run(async () => {
        const conn = await connection(name);
        const current = await api<WorkItem>(conn, {
          method: 'GET',
          path: `_apis/wit/workitems/${id}`,
          query: { fields: 'System.WorkItemType,System.TeamProject,System.State' },
        });
        let target = state;
        if (!target) {
          const project = String(current.fields['System.TeamProject']);
          const type = String(current.fields['System.WorkItemType']);
          const t = await api<Parameters<typeof resolvedState>[0]>(conn, { method: 'GET', path: `${seg(project)}/_apis/wit/workitemtypes/${seg(type)}` });
          target = resolvedState(t) ?? undefined;
          if (!target) throw new AzdoError(`${type} has no resolved or completed state. Pass "state" (azdo_list_work_item_types lists them).`);
        }
        if (current.fields['System.State'] === target && !comment) return json({ unchanged: `#${id} is already ${target}.` });
        const ops: PatchOp[] = [];
        if (current.fields['System.State'] !== target) ops.push(field('System.State', target));
        if (reason) ops.push(field('System.Reason', reason));
        if (comment) ops.push(field('System.History', textToHtml(comment)));
        const wi = await patch(conn, id, ops);
        return json({ resolved: brief(conn, wi) });
      })
  );

  // ---- azdo_add_comment ----
  server.tool(
    'azdo_add_comment',
    "Add a comment to a work item's discussion. The user is asked to approve it first.",
    { server: serverParam, id: idParam, comment: z.string().min(1).max(100_000).describe('Plain text or HTML.') },
    write,
    async ({ server: name, id, comment }) =>
      run(async () => {
        const conn = await connection(name);
        const wi = await patch(conn, id, [field('System.History', textToHtml(comment))]);
        return json({ commented: brief(conn, wi) });
      })
  );

  // ---- azdo_link_work_items ----
  server.tool(
    'azdo_link_work_items',
    'Link two work items, e.g. make one the parent of the other. The user is asked to approve it first.',
    {
      server: serverParam,
      id: idParam,
      link: z.enum(Object.keys(LINK_TYPES) as [keyof typeof LINK_TYPES, ...Array<keyof typeof LINK_TYPES>]).describe('What target_id is to id: "parent" makes target_id the parent of id.'),
      target_id: z.number().int().positive(),
      comment: z.string().max(1000).optional(),
    },
    write,
    async ({ server: name, id, link, target_id, comment }) =>
      run(async () => {
        if (id === target_id) throw new AzdoError("A work item can't link to itself.");
        const conn = await connection(name);
        const wi = await patch(conn, id, [
          { op: 'add', path: '/relations/-', value: { rel: LINK_TYPES[link], url: apiUrl(conn, target_id), ...(comment ? { attributes: { comment } } : {}) } },
        ]);
        return json({ linked: { ...brief(conn, wi), [link]: target_id } });
      })
  );

  return server;
}

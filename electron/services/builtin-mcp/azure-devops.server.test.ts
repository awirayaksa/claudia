/**
 * The Azure DevOps built-in against a scripted collection: the requests it
 * sends (WIQL, batch reads, JSON patches), how it picks a resolved state,
 * and which tools are marked as changing data.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildWiql, createAzureDevOpsServer, htmlToText, resolvedState, textToHtml, type AzdoClient, type AzdoConnection, type AzdoRequest } from './azure-devops.server';

const CONN: AzdoConnection = {
  serverId: 'srv-1',
  name: 'Fabrikam',
  url: 'https://tfs.example.com/tfs/DefaultCollection',
  apiVersion: '7.0',
  connected: true,
  displayName: 'Jamie Doe',
  defaultProject: 'Web',
};

const item = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  fields: { 'System.TeamProject': 'Web', 'System.WorkItemType': 'Bug', 'System.Title': `Item ${id}`, 'System.State': 'Active', ...fields },
});

/** A fake collection: answers by method + path, and records every request. */
function fake(routes: Record<string, (req: AzdoRequest) => unknown>, connections: AzdoConnection[] = [CONN]) {
  const requests: AzdoRequest[] = [];
  const client: AzdoClient = {
    connections: async () => connections,
    request: async (_serverId, req) => {
      requests.push(req);
      const route = routes[`${req.method} ${req.path}`];
      if (!route) return { status: 404, json: { message: `No route ${req.method} ${req.path}` } };
      return { status: 200, json: route(req) };
    },
  };
  return { client, requests };
}

async function connect(client?: AzdoClient) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createAzureDevOpsServer(client ? { azdo: client } : {}).connect(b);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(a);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; isError?: boolean };
    const text = r.content.map((c) => c.text ?? '').join('\n');
    return { text, isError: !!r.isError, data: r.isError ? null : JSON.parse(text) };
  };
  return { mcp, call };
}

describe('Azure DevOps server', () => {
  it('marks the tools that change data, so the host can ask first', async () => {
    const { mcp } = await connect(fake({}).client);
    const { tools } = await mcp.listTools();
    const readOnly = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(readOnly).toEqual({
      azdo_list_connections: true,
      azdo_list_projects: true,
      azdo_query_work_items: true,
      azdo_get_work_item: true,
      azdo_list_work_item_types: true,
      azdo_list_iterations: true,
      azdo_create_work_item: false,
      azdo_update_work_item: false,
      azdo_resolve_work_item: false,
      azdo_add_comment: false,
      azdo_link_work_items: false,
    });
  });

  it('says so when it is not set up, or nothing is connected', async () => {
    const bare = await connect();
    expect((await bare.call('azdo_list_projects')).text).toMatch(/isn't set up/);
    const none = await connect(fake({}, [{ ...CONN, connected: false }]).client);
    expect((await none.call('azdo_list_projects')).text).toMatch(/Settings → Tools/);
    const two = await connect(fake({}, [CONN, { ...CONN, serverId: 'srv-2', name: 'Contoso' }]).client);
    expect((await two.call('azdo_list_projects')).text).toMatch(/pass "server"/);
  });

  it('queries with WIQL, then reads the items in batches, in the query order', async () => {
    const { client, requests } = fake({
      'POST Web/_apis/wit/wiql': () => ({ workItems: [{ id: 7 }, { id: 3 }] }),
      'GET _apis/wit/workitems': () => ({ value: [item(3, { 'System.AssignedTo': { displayName: 'Jamie Doe' } }), item(7)] }),
    });
    const { call } = await connect(client);
    const res = await call('azdo_query_work_items', { types: ['Bug'], assigned_to: '@Me', iteration: '@CurrentIteration' });
    expect(res.isError).toBe(false);
    expect(res.data.workItems.map((w: { id: number }) => w.id)).toEqual([7, 3]);
    expect(res.data.workItems[1]).toMatchObject({ assignedTo: 'Jamie Doe', url: `${CONN.url}/Web/_workitems/edit/3` });
    const wiql = (requests[0].body as { query: string }).query;
    expect(wiql).toContain("[System.WorkItemType] IN ('Bug')");
    expect(wiql).toContain('[System.AssignedTo] = @Me');
    expect(wiql).toContain('[System.IterationPath] = @CurrentIteration');
    expect(wiql).toContain("[System.State] NOT IN ('Closed', 'Done', 'Removed')");
    expect(requests[1].query).toMatchObject({ ids: '7,3' });
  });

  it('escapes quotes in WIQL filters and refuses non-SELECT queries', async () => {
    expect(buildWiql({ text: "it's broken", include_closed: true })).toContain("CONTAINS 'it''s broken'");
    expect(buildWiql({ include_closed: true })).not.toContain('NOT IN');
    const { call } = await connect(fake({}).client);
    expect((await call('azdo_query_work_items', { wiql: 'DELETE FROM WorkItems' })).text).toMatch(/SELECT/);
  });

  it('creates a work item with a JSON patch, under a parent', async () => {
    const { client, requests } = fake({ 'POST Web/_apis/wit/workitems/$Task': () => item(42, { 'System.WorkItemType': 'Task', 'System.State': 'New' }) });
    const { call } = await connect(client);
    const res = await call('azdo_create_work_item', {
      type: 'Task',
      title: 'Fix login',
      description: 'Steps:\n1. <open> page',
      tags: ['web', 'auth'],
      parent_id: 7,
      fields: { 'Microsoft.VSTS.Scheduling.RemainingWork': 4 },
    });
    expect(res.data.created).toMatchObject({ id: 42, type: 'Task', state: 'New' });
    expect(requests[0].contentType).toBe('application/json-patch+json');
    expect(requests[0].body).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Fix login' },
      { op: 'add', path: '/fields/System.Description', value: 'Steps:<br>1. &lt;open&gt; page' },
      { op: 'add', path: '/fields/System.Tags', value: 'web; auth' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 4 },
      { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${CONN.url}/_apis/wit/workItems/7` } },
    ]);
  });

  it("resolves to the type's Resolved state, with a reason and a comment", async () => {
    const { client, requests } = fake({
      'GET _apis/wit/workitems/5': () => item(5),
      'GET Web/_apis/wit/workitemtypes/Bug': () => ({
        name: 'Bug',
        states: [
          { name: 'New', category: 'Proposed' },
          { name: 'Active', category: 'InProgress' },
          { name: 'Resolved', category: 'Resolved' },
          { name: 'Closed', category: 'Completed' },
        ],
      }),
      'PATCH _apis/wit/workitems/5': () => item(5, { 'System.State': 'Resolved' }),
    });
    const { call } = await connect(client);
    const res = await call('azdo_resolve_work_item', { id: 5, reason: 'Fixed', comment: 'Fixed in build 1.2' });
    expect(res.data.resolved).toMatchObject({ id: 5, state: 'Resolved' });
    expect(requests[2].body).toEqual([
      { op: 'add', path: '/fields/System.State', value: 'Resolved' },
      { op: 'add', path: '/fields/System.Reason', value: 'Fixed' },
      { op: 'add', path: '/fields/System.History', value: 'Fixed in build 1.2' },
    ]);
  });

  it('picks a resolved state under each process, and by name on TFS 2018', () => {
    // Scrum: no Resolved category, Done is Completed
    expect(resolvedState({ states: [{ name: 'New', category: 'Proposed' }, { name: 'Done', category: 'Completed' }] })).toBe('Done');
    // TFS 2018: transitions only
    expect(resolvedState({ transitions: { '': [], Active: [], Resolved: [], Closed: [] } })).toBe('Resolved');
    expect(resolvedState({ states: [{ name: 'Open', category: 'InProgress' }] })).toBeNull();
  });

  it('reads a work item with its links and recent comments', async () => {
    const { client } = fake({
      'GET _apis/wit/workitems/9': () => ({
        ...item(9, { 'System.Description': '<div>Broken <b>login</b></div><div>Since v2</div>', 'System.CreatedBy': 'Sam Lee <CORP\\slee>' }),
        relations: [
          { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${CONN.url}/_apis/wit/workItems/1` },
          { rel: 'System.LinkTypes.Hierarchy-Forward', url: `${CONN.url}/_apis/wit/workItems/10` },
          { rel: 'AttachedFile', url: `${CONN.url}/_apis/wit/attachments/abc` },
        ],
      }),
      'GET _apis/wit/workitems/9/updates': () => ({
        value: [{ revisedBy: { displayName: 'Sam Lee' }, revisedDate: '2026-10-01', fields: { 'System.History': { newValue: '<p>Looking into it</p>' } } }, { fields: {} }],
      }),
    });
    const { call } = await connect(client);
    const res = await call('azdo_get_work_item', { id: 9 });
    expect(res.data).toMatchObject({
      id: 9,
      description: 'Broken login\nSince v2',
      createdBy: 'Sam Lee',
      links: { parent: [1], child: [10] },
      comments: [{ by: 'Sam Lee', text: 'Looking into it' }],
    });
  });

  it('turns HTTP errors into readable tool errors', async () => {
    const { call } = await connect(fake({}).client);
    const res = await call('azdo_add_comment', { id: 1, comment: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No route PATCH/);
    expect((await call('azdo_link_work_items', { id: 3, link: 'related', target_id: 3 })).text).toMatch(/itself/);
  });

  it('converts between HTML fields and text', () => {
    expect(textToHtml('<p>kept</p>')).toBe('<p>kept</p>');
    expect(textToHtml('a & b\nc')).toBe('a &amp; b<br>c');
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>&amp;')).toBe('- one\n- two\n&');
  });
});

/**
 * The OpenAI-compatible API (/api/v1) with the official OpenAI SDK, API keys
 * and their rules: Bearer only (cookies don't work there), permission
 * checked on every request, revocable, capped like chats.
 */
import { describe, it, expect, afterEach } from 'vitest';
import OpenAI from 'openai';
import { chatFixture, type ChatFixture } from '../../test/chat-fixture';
import type { TestClient } from '../../test/client';
import { DEFAULT_PERMISSIONS } from '../../../shared/access';

let f: ChatFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function keyFor(c: TestClient, name = 'sdk'): Promise<{ id: string; secret: string }> {
  const res = await c.post('/api/me/api-keys', { name });
  expect(res.statusCode).toBe(201);
  return { id: res.json().key.id, secret: res.json().secret };
}

const sdk = (fx: ChatFixture, apiKey: string) => new OpenAI({ baseURL: `${fx.base}/api/v1`, apiKey, maxRetries: 0 });

describe('/api/v1 with the OpenAI SDK', () => {
  it('lists models and completes, streaming and not', async () => {
    f = await chatFixture();
    const { secret } = await keyFor(f.admin);
    expect(secret).toMatch(/^ck-[A-Za-z0-9_-]{43}$/);
    const client = sdk(f, secret);

    const models = await client.models.list();
    expect(models.data.map((m) => m.id)).toEqual(expect.arrayContaining(['mock/gpt-test', 'mock/gpt-other']));
    expect((await client.models.retrieve('mock/gpt-test')).id).toBe('mock/gpt-test');

    f.mock.push({ text: ['Hello', ' there'], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const done = await client.chat.completions.create({
      model: 'mock/gpt-test',
      messages: [
        { role: 'developer', content: 'Be short.' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: 0.3,
      max_tokens: 50,
    });
    expect(done.choices[0].message.content).toBe('Hello there');
    expect(done.choices[0].finish_reason).toBe('stop');
    expect(done.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const sent = f.mock.requests.at(-1);
    expect(sent).toMatchObject({ model: 'gpt-test', temperature: 0.3, max_tokens: 50 });
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'Be short.' });

    f.mock.push({ text: ['A', 'B', 'C'], reasoning: ['hmm'], usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 } });
    const stream = await client.chat.completions.create({
      model: 'mock/gpt-test',
      messages: [{ role: 'user', content: 'Count' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let reasoning = '';
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      text += choice?.delta.content ?? '';
      reasoning += (choice?.delta as { reasoning_content?: string } | undefined)?.reasoning_content ?? '';
      finish = choice?.finish_reason ?? finish;
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe('ABC');
    expect(reasoning).toBe('hmm');
    expect(finish).toBe('stop');
    expect(usage?.total_tokens).toBe(4);
  });

  it('passes tools through and returns the calls', async () => {
    f = await chatFixture();
    const client = sdk(f, (await keyFor(f.admin)).secret);
    f.mock.push({ toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: '{"city":"Oslo"}' }] });
    const res = await client.chat.completions.create({
      model: 'mock/gpt-test',
      messages: [{ role: 'user', content: 'Weather in Oslo?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(f.mock.requests.at(-1).tools[0].function.name).toBe('get_weather');
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    const call = res.choices[0].message.tool_calls![0] as OpenAI.ChatCompletionMessageFunctionToolCall;
    expect(call).toMatchObject({ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } });

    // Streaming
    f.mock.push({ toolCalls: [{ id: 'call_2', name: 'get_weather', arguments: '{"city":"Rome"}' }] });
    const stream = await client.chat.completions.create({
      model: 'mock/gpt-test',
      messages: [{ role: 'user', content: 'And Rome?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      stream: true,
    });
    const calls: unknown[] = [];
    let finish: string | null = null;
    for await (const chunk of stream) {
      calls.push(...(chunk.choices[0]?.delta.tool_calls ?? []));
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }
    expect(calls).toEqual([{ index: 0, id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }]);
    expect(finish).toBe('tool_calls');
  });

  it('serves custom models with their prompt and records usage against the caps', async () => {
    f = await chatFixture();
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'api.keys': true });
    const m = (await f.admin.post('/api/workspace/models', { name: 'Formal', baseModelId: 'mock/gpt-test', systemPrompt: 'Be formal.' })).json()
      .model;
    await f.admin.put(`/api/workspace/models/${m.id}/access`, { grants: [{ principalType: 'public', perm: 'read' }] });
    const bob = await f.newUser('bob@example.com');
    const client = sdk(f, (await keyFor(bob)).secret);

    expect((await client.models.list()).data.find((x) => x.id === m.key)).toMatchObject({ owned_by: 'claudia' });
    f.mock.push({ text: ['Good day.'], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    const res = await client.chat.completions.create({ model: m.key, messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.model).toBe(m.key);
    expect(f.mock.requests.at(-1).messages).toEqual([
      { role: 'system', content: 'Be formal.' },
      { role: 'user', content: 'Hi' },
    ]);

    // Same caps as chats
    await f.admin.patch('/api/admin/settings/caps.default', { tokensPerDay: 15, tokensPerMonth: null, costPerDay: null, costPerMonth: null });
    const capped = await client.chat.completions.create({ model: m.key, messages: [{ role: 'user', content: 'Again' }] }).catch((e) => e);
    expect(capped).toBeInstanceOf(OpenAI.RateLimitError);
    expect((await bob.get('/api/me/usage')).json().usage.day.tokens).toBe(20);

    // Models the user may not use are refused
    await f.admin.patch('/api/admin/settings/caps.default', { tokensPerDay: null, tokensPerMonth: null, costPerDay: null, costPerMonth: null });
    await f.admin.patch('/api/admin/settings/models.allowlist', { user: ['mock/gpt-other'] });
    const denied = await client.chat.completions.create({ model: 'mock/gpt-test', messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(denied).toBeInstanceOf(OpenAI.PermissionDeniedError);
  });

  it('accepts only valid, current keys of users who still have the permission', async () => {
    f = await chatFixture();
    const bob = await f.newUser('bob@example.com');
    // Off by default
    expect((await bob.post('/api/me/api-keys', { name: 'x' })).statusCode).toBe(403);
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'api.keys': true });
    const key = await keyFor(bob);
    const listed = (await bob.get('/api/me/api-keys')).json().keys;
    expect(listed[0]).toMatchObject({ name: 'sdk', prefix: key.secret.slice(0, 12) });
    expect(JSON.stringify(listed)).not.toContain(key.secret);

    const status = async (headers: Record<string, string>) => (await fetch(`${f!.base}/api/v1/models`, { headers })).status;
    expect(await status({ authorization: `Bearer ${key.secret}` })).toBe(200);
    expect(await status({})).toBe(401);
    expect(await status({ authorization: 'Bearer ck-wrong' })).toBe(401);
    expect(await status({ authorization: `Bearer ${key.secret}x` })).toBe(401);
    // A session cookie is not an API key
    const cookie = [...bob.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    expect(await status({ cookie })).toBe(401);
    // Nor does a key open the rest of the API
    expect((await fetch(`${f.base}/api/chats`, { headers: { authorization: `Bearer ${key.secret}` } })).status).toBe(401);

    // Permission taken away: the key stops working (and can still be deleted)
    await f.admin.patch('/api/admin/settings/permissions.default', DEFAULT_PERMISSIONS);
    expect(await status({ authorization: `Bearer ${key.secret}` })).toBe(401);
    await f.admin.patch('/api/admin/settings/permissions.default', { ...DEFAULT_PERMISSIONS, 'api.keys': true });
    expect(await status({ authorization: `Bearer ${key.secret}` })).toBe(200);
    expect((await bob.delete(`/api/me/api-keys/${key.id}`)).statusCode).toBe(200);
    expect(await status({ authorization: `Bearer ${key.secret}` })).toBe(401);

    // Expired keys are refused
    const expiring = await bob.post('/api/me/api-keys', { name: 'short', expiresInDays: 1 });
    const { db } = f;
    const { apiKeys } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await db.db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, expiring.json().key.id));
    expect(await status({ authorization: `Bearer ${expiring.json().secret}` })).toBe(401);
  });
});

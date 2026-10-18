/**
 * OpenAPI 3 tool servers: every operation of a spec becomes a tool whose
 * arguments are the operation's path, query and header parameters plus a
 * JSON `body`. Specs may be JSON or YAML; `$ref`s within the spec are
 * resolved (depth-limited, cycles cut).
 */
import { parse as parseYaml } from 'yaml';
import type { OpenApiOperation } from '../db/schema';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_OPERATIONS = 200;
const MAX_DEPTH = 8;
const MAX_RESPONSE_CHARS = 50_000;
const TIMEOUT_MS = 60_000;

export class OpenApiError extends Error {}

export function parseSpec(text: string): any {
  let spec: any;
  try {
    spec = text.trim().startsWith('{') ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new OpenApiError(`The spec is neither JSON nor YAML: ${err instanceof Error ? err.message : err}`);
  }
  if (!spec || typeof spec !== 'object') throw new OpenApiError('The spec is empty.');
  if (spec.swagger) throw new OpenApiError('This is a Swagger 2 spec. Use OpenAPI 3 (convert it first).');
  if (typeof spec.openapi !== 'string' || !spec.openapi.startsWith('3.')) throw new OpenApiError('Not an OpenAPI 3 spec.');
  if (!spec.paths || typeof spec.paths !== 'object') throw new OpenApiError('The spec has no paths.');
  return spec;
}

/** Inline every `#/…` reference (other files aren't followed). */
function deref(spec: any, node: any, depth = 0, seen: string[] = []): any {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => deref(spec, n, depth + 1, seen));
  if (typeof node.$ref === 'string') {
    const ref: string = node.$ref;
    if (!ref.startsWith('#/') || seen.includes(ref)) return { type: 'object', description: `(${ref})` };
    const target = ref
      .slice(2)
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), spec);
    return target === undefined ? {} : deref(spec, target, depth + 1, [...seen, ref]);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // Keep schemas lean: drop examples and vendor extensions
    if (k === 'example' || k === 'examples' || k.startsWith('x-')) continue;
    out[k] = deref(spec, v, depth + 1, seen);
  }
  return out;
}

const sanitize = (s: string) =>
  s
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'operation';

export function operationsOf(spec: any): OpenApiOperation[] {
  const out: OpenApiOperation[] = [];
  const used = new Set<string>();
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    if (!item || typeof item !== 'object') continue;
    const shared = (item.parameters ?? []).map((p: any) => deref(spec, p));
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      let name = sanitize(op.operationId ?? `${method}_${path}`);
      for (let i = 2; used.has(name); i++) name = `${sanitize(op.operationId ?? `${method}_${path}`).slice(0, 60)}_${i}`;
      used.add(name);

      const params = [...shared, ...(op.parameters ?? []).map((p: any) => deref(spec, p))]
        .filter((p: any) => p && ['path', 'query', 'header'].includes(p.in) && typeof p.name === 'string')
        // An operation's own parameter wins over the path item's
        .filter((p: any, i: number, all: any[]) => !all.slice(i + 1).some((q: any) => q.name === p.name && q.in === p.in));
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of params) {
        properties[p.name] = { ...(p.schema ?? { type: 'string' }), ...(p.description ? { description: p.description } : {}) };
        if (p.required || p.in === 'path') required.push(p.name);
      }
      const body = op.requestBody ? deref(spec, op.requestBody) : null;
      const json = body?.content?.['application/json']?.schema;
      if (json) {
        properties.body = { ...json, ...(body.description ? { description: body.description } : {}) };
        if (body.required) required.push('body');
      }
      out.push({
        name,
        description: [op.summary, op.description].filter(Boolean).join(' — ').slice(0, 1000) || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
        params: params.map((p: any) => ({ name: p.name, in: p.in })),
        hasBody: !!json,
      });
      if (out.length >= MAX_OPERATIONS) return out;
    }
  }
  return out;
}

/** The spec's first server, resolved against where the spec came from, with default variables. */
export function baseUrlOf(spec: any, specUrl?: string | null): string {
  const server = spec.servers?.[0];
  let url: string = server?.url ?? '/';
  for (const [k, v] of Object.entries<any>(server?.variables ?? {})) url = url.replaceAll(`{${k}}`, String(v?.default ?? ''));
  try {
    return new URL(url, specUrl ?? undefined).toString().replace(/\/+$/, '');
  } catch {
    if (!specUrl) throw new OpenApiError('Set the base URL: the spec only has a relative server address.');
    throw new OpenApiError(`The spec's server address "${url}" is not valid.`);
  }
}

export async function callOperation(
  op: OpenApiOperation,
  baseUrl: string,
  args: Record<string, unknown>,
  auth: { header: string; value: string } | null,
  signal?: AbortSignal
): Promise<{ content: string; isError: boolean }> {
  let path = op.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { Accept: 'application/json, text/plain;q=0.9, */*;q=0.5' };
  for (const p of op.params) {
    const v = args[p.name];
    if (v === undefined || v === null) continue;
    if (p.in === 'path') path = path.replaceAll(`{${p.name}}`, encodeURIComponent(String(v)));
    else if (p.in === 'query') (Array.isArray(v) ? v : [v]).forEach((x) => query.append(p.name, typeof x === 'object' ? JSON.stringify(x) : String(x)));
    else headers[p.name] = String(v);
  }
  if (/\{[^}]+\}/.test(path)) return { content: JSON.stringify({ error: `Missing path parameter in ${path}.` }), isError: true };
  if (auth) headers[auth.header] = auth.value;
  const url = `${baseUrl}${path}${query.size ? `?${query}` : ''}`;
  const init: RequestInit = { method: op.method, headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) };
  if (op.hasBody && args.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(args.body);
  }
  try {
    const res = await fetch(url, init);
    let text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) text = `${text.slice(0, MAX_RESPONSE_CHARS)}\n… (cut off)`;
    return res.ok
      ? { content: text || `(${res.status} ${res.statusText})`, isError: false }
      : { content: JSON.stringify({ status: res.status, error: text.slice(0, 2000) || res.statusText }), isError: true };
  } catch (err) {
    return { content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), isError: true };
  }
}

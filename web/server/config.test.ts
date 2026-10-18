import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ConfigError, loadConfig } from './config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ NODE_ENV: 'development', HOST: '0.0.0.0', PORT: 8080, CLAUDIA_ALLOW_STDIO_MCP: false });
    expect(c.dataDir).toBe(path.resolve('./data'));
    expect(c.DATABASE_URL).toBeUndefined();
  });

  it('parses and coerces values, treating blanks as unset', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      PORT: '9000',
      DATABASE_URL: 'postgres://u:p@db:5432/claudia',
      CLAUDIA_ALLOW_STDIO_MCP: 'true',
      CLAUDIA_PUBLIC_URL: '',
    });
    expect(c).toMatchObject({ isProduction: true, PORT: 9000, CLAUDIA_ALLOW_STDIO_MCP: true });
    expect(c.CLAUDIA_PUBLIC_URL).toBeUndefined();
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({ PORT: 'abc', DATABASE_URL: 'mysql://x', CLAUDIA_SECRET_KEY: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues.join('\n');
      expect(issues).toContain('PORT');
      expect(issues).toContain('DATABASE_URL must be a postgres');
      expect(issues).toContain('CLAUDIA_SECRET_KEY must be at least 32 characters');
    }
  });
});

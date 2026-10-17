import type { ClaudiaPlatform } from './types';

export type * from './types';

let current: ClaudiaPlatform | null = null;

/** Install the host implementation. Call once at startup, before rendering. */
export function setPlatform(platform: ClaudiaPlatform): void {
  current = platform;
}

/** The host implementation installed with `setPlatform()`. */
export function getPlatform(): ClaudiaPlatform {
  if (!current) {
    throw new Error('Platform not initialized: call setPlatform() before rendering the app.');
  }
  return current;
}

/** True once a platform is installed (for code that may run before startup, e.g. tests). */
export function hasPlatform(): boolean {
  return current !== null;
}

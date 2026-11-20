/**
 * Host branding for the shared components. The desktop app keeps the
 * defaults; a white-label web build sets its own at startup.
 */
export interface Branding {
  /** Image shown as the assistant's avatar, in place of the letter badge. */
  avatarUrl?: string;
  /** The default accent colours, when the host's stylesheet changes them. */
  accent?: { light: string; dark: string };
}

/** Claudia's accent colours (src/styles/globals.css). */
export const DEFAULT_ACCENT = { light: '#D97757', dark: '#E8917B' };

let current: Branding = {};

/** Install the host's branding. Call once at startup, before rendering. */
export function setBranding(branding: Branding): void {
  current = branding;
}

export function getBranding(): Branding {
  return current;
}

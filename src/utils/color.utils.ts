/**
 * Color utility functions for theme customization
 */

/**
 * Convert hex color to RGB
 * @param hex - Hex color string (e.g., "#D97757" or "#FFF")
 * @returns RGB object or null if invalid
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // Remove # if present
  const cleanHex = hex.replace(/^#/, '');

  // Validate hex format
  if (!/^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(cleanHex)) {
    return null;
  }

  // Expand shorthand form (e.g., "F00" to "FF0000")
  const fullHex = cleanHex.length === 3
    ? cleanHex.split('').map(char => char + char).join('')
    : cleanHex;

  const num = parseInt(fullHex, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/**
 * Convert RGB to hex color
 * @param r - Red value (0-255)
 * @param g - Green value (0-255)
 * @param b - Blue value (0-255)
 * @returns Hex color string
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => {
    const clamped = Math.max(0, Math.min(255, Math.round(n)));
    return clamped.toString(16).padStart(2, '0');
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Generate hover color variant based on theme
 * @param hex - Base hex color
 * @param theme - Current theme (light or dark)
 * @returns Hover color as hex string
 */
export function generateHoverColor(hex: string, theme: 'light' | 'dark'): string {
  const rgb = hexToRgb(hex);
  if (!rgb) {
    // Fallback to original color if invalid
    return hex;
  }

  let { r, g, b } = rgb;

  if (theme === 'light') {
    // Darken by 12% for light theme
    r *= 0.88;
    g *= 0.88;
    b *= 0.88;
  } else {
    // Lighten by 12% for dark theme
    r = Math.min(255, r * 1.12);
    g = Math.min(255, g * 1.12);
    b = Math.min(255, b * 1.12);
  }

  return rgbToHex(r, g, b);
}

/**
 * Validate hex color format
 * @param hex - Hex color string to validate
 * @returns True if valid hex color
 */
export function isValidHexColor(hex: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex);
}

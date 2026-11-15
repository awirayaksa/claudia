/**
 * The white-label brand this client was built with (brands/README.md).
 * Without one, the app is Claudia.
 */
import type { ClientBrand } from '../scripts/brand';

export const brand: ClientBrand =
  typeof __BRAND__ !== 'undefined' ? __BRAND__ : { id: '', name: 'Claudia' };

/**
 * "Claudia" as the product's name in a UI string: not inside a technical name
 * (X-Claudia-Signature, ClaudiaWeb), and not the desktop app, which keeps its
 * name ("Claudia desktop", "Claudia لسطح المكتب").
 */
const PRODUCT_NAME = /(?<![\w-])Claudia(?![\w-]|\s+(?:desktop|Desktop|لسطح المكتب))/g;

/** `text` with the product's name replaced by `name`. */
export function rebrandText(text: string, name: string): string {
  return text.replace(PRODUCT_NAME, () => name);
}

/** Every string in a translation catalog (nested objects), rebranded in place. */
export function rebrandCatalog(catalog: Record<string, unknown>, name: string): void {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value === 'string') catalog[key] = rebrandText(value, name);
    else if (value && typeof value === 'object') rebrandCatalog(value as Record<string, unknown>, name);
  }
}

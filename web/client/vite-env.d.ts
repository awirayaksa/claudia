/// <reference types="vite/client" />

/** The white-label brand the client was built with (scripts/brand.ts). */
declare const __BRAND__: import('../scripts/brand').ClientBrand;

/** The brand's theme (brands/<id>/theme.css), or nothing for Claudia. */
declare module 'virtual:brand-theme.css';

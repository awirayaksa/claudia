/**
 * Copy text to the clipboard. navigator.clipboard only exists in secure
 * contexts (HTTPS or localhost): Claudia Web served over plain HTTP on a LAN
 * address has none, so fall back to the older execCommand('copy'), which
 * still works from a click handler there. Resolves false when nothing worked.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied (e.g. no permission in a frame): try the fallback
    }
  }
  return copyWithExecCommand(text);
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];

  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  area.focus({ preventScroll: true });
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();

  // Put back what the user had focused and selected
  active?.focus?.({ preventScroll: true });
  if (selection) {
    selection.removeAllRanges();
    for (const r of ranges) selection.addRange(r);
  }
  return ok;
}

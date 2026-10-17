import { apiFetchRaw, toApiError } from '../api/http';

/** Save an API response as a file (the name from Content-Disposition when there is one). */
export async function downloadFrom(path: string, fallbackName: string): Promise<void> {
  const res = await apiFetchRaw(path);
  if (!res.ok) throw await toApiError(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  saveBlob(await res.blob(), name);
}

export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

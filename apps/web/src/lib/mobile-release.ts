/** Deployment-owned metadata. Only immutable, same-origin APK downloads are accepted. */
export interface MobileRelease {
  version: string;
  url: string;
  minAndroid: string;
  sizeBytes: number;
  sha256: string;
}

export function parseMobileRelease(value: unknown): MobileRelease {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid mobile release');
  const v = value as Record<string, unknown>;
  if (
    typeof v.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(v.version) ||
    typeof v.url !== 'string' ||
    !/^\/downloads\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.apk$/.test(v.url) ||
    typeof v.minAndroid !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(v.minAndroid) ||
    typeof v.sizeBytes !== 'number' ||
    !Number.isSafeInteger(v.sizeBytes) ||
    v.sizeBytes <= 0 ||
    typeof v.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.sha256)
  )
    throw new Error('Invalid mobile release');
  return v as unknown as MobileRelease;
}

export async function fetchMobileRelease(signal: AbortSignal): Promise<MobileRelease> {
  const response = await fetch('/downloads/android.json', {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  // A self-hosted server without downloads may return its SPA HTML fallback.
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Mobile download unavailable');
  }
  return parseMobileRelease(await response.json());
}

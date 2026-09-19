/**
 * Analytics is disabled. This module keeps the same call sites working
 * (initAnalytics/track/flush/etc. are no-ops) so nothing needs to change
 * at the many places that import it, but no event, identifier, or usage
 * data is ever sent anywhere — this is a personal, local-only assistant.
 */

export async function initAnalytics(): Promise<void> {
  // no-op
}

export function track(
  _event: string,
  _properties?: Record<string, unknown>,
): void {
  // no-op
}

export function flush(): void {
  // no-op
}

export function isAnalyticsEnabled(): boolean {
  return false;
}

export function getAnonId(): string {
  return '';
}

/**
 * Hash an identifier to a 16-char sha256 hex prefix. Kept as a real utility
 * (pure, local, no network) — used to compare model/tool names without
 * exposing raw values in logs.
 */
export async function hashId(s: string): Promise<string> {
  if (!s) return '';
  try {
    const data = new TextEncoder().encode(s);
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

/**
 * Detect platform string: "tauri-macos" | "tauri-linux" | "tauri-windows" | "web".
 */
export function detectPlatform(): string {
  const ua =
    typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const isTauri =
    typeof window !== 'undefined' &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  if (isTauri) {
    if (ua.includes('mac')) return 'tauri-macos';
    if (ua.includes('windows')) return 'tauri-windows';
    return 'tauri-linux';
  }
  return 'web';
}

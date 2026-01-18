export function getBridgeUrl() {
  const env = import.meta.env.VITE_BRIDGE_URL;
  if (typeof env === 'string' && env.trim()) {
    const trimmed = env.trim();
    if (trimmed.startsWith('/') && typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin}${trimmed}`;
    }
    return trimmed;
  }
  if (typeof window !== 'undefined' && window.location) {
    const { origin, hostname, port, protocol } = window.location;
    if (port === '5173' || port === '5174') {
      const host = hostname || 'localhost';
      return `${protocol}//${host}:4100`;
    }
    if (origin) return origin;
  }
  return 'http://localhost:4100';
}


export function getBridgeUrl() {
  const env = import.meta.env.VITE_BRIDGE_URL;
  if (typeof env === 'string' && env.trim()) return env.trim();
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://localhost:4100';
}


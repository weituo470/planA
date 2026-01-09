function normalizeCodexSandbox(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const allowed = new Set(['read-only', 'workspace-write', 'danger-full-access']);
  if (allowed.has(raw)) return raw;
  return 'workspace-write';
}

function normalizeCodexModel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 100) return null;
  return trimmed;
}

module.exports = {
  normalizeCodexSandbox,
  normalizeCodexModel,
};

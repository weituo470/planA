const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 4100;

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // ignore
  }
}

function resolvePlatformDefaultRootDir() {
  if (process.platform === 'win32') return 'C:\\planA';
  return path.join(os.homedir(), 'planA');
}

function resolveConfigDir() {
  if (process.platform === 'win32') {
    const base = typeof process.env.APPDATA === 'string' && process.env.APPDATA.trim() ? process.env.APPDATA.trim() : os.homedir();
    return path.join(base, 'plana');
  }
  return path.join(os.homedir(), '.plana');
}

function resolveConfigFile() {
  return path.join(resolveConfigDir(), 'config.json');
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizePort(value, fallback = DEFAULT_PORT) {
  const raw = typeof value === 'string' ? value.trim() : value;
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  const port = Math.floor(n);
  if (port < 1 || port > 65535) return fallback;
  return port;
}

function normalizeRootDir(value, fallback) {
  const input = typeof value === 'string' ? value.trim() : '';
  const base = typeof fallback === 'string' && fallback.trim() ? fallback.trim() : resolvePlatformDefaultRootDir();
  const picked = input ? input : base;
  try {
    return path.resolve(picked);
  } catch {
    return path.resolve(base);
  }
}

function readRuntimeConfig() {
  const filePath = resolveConfigFile();
  const raw = safeReadJson(filePath);
  const defaultRootDir = normalizeRootDir(raw?.defaultRootDir, resolvePlatformDefaultRootDir());
  const defaultPort = normalizePort(raw?.defaultPort, DEFAULT_PORT);
  return { version: 1, defaultPort, defaultRootDir, filePath };
}

function writeRuntimeConfig(next) {
  const prev = readRuntimeConfig();
  const defaultRootDir = normalizeRootDir(next?.defaultRootDir, prev.defaultRootDir);
  const defaultPort = normalizePort(next?.defaultPort, prev.defaultPort);
  const persisted = {
    version: 1,
    defaultPort,
    defaultRootDir,
    updatedAt: new Date().toISOString(),
  };
  const dir = resolveConfigDir();
  ensureDir(dir);
  fs.writeFileSync(resolveConfigFile(), JSON.stringify(persisted, null, 2), 'utf8');
  return { ...persisted, filePath: resolveConfigFile() };
}

function resolveEffectiveRuntimeConfig(overrides) {
  const stored = readRuntimeConfig();
  const rootDir = normalizeRootDir(overrides?.rootDir, stored.defaultRootDir);
  const port = normalizePort(overrides?.port, stored.defaultPort);
  return {
    port,
    rootDir,
    stored,
    filePath: stored.filePath,
  };
}

module.exports = {
  DEFAULT_PORT,
  readRuntimeConfig,
  writeRuntimeConfig,
  resolveEffectiveRuntimeConfig,
  resolvePlatformDefaultRootDir,
  resolveConfigDir,
  resolveConfigFile,
  normalizePort,
  normalizeRootDir,
};


#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const runtimeConfig = require('../bridge/src/lib/runtime-config');

function fileExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function killProcessTree(child) {
  if (!child || typeof child.pid !== 'number') return;
  if (child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
      });
      return;
    }
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
}

function parseArgs(argv) {
  const args = {
    cmd: 'start',
    subcmd: null,
    port: null,
    rootDir: null,
    help: false,
  };

  const list = Array.isArray(argv) ? argv.map((v) => String(v ?? '')) : [];
  if (list[0] === 'config') {
    args.cmd = 'config';
    args.subcmd = list[1] ? String(list[1]) : null;
    list.splice(0, args.subcmd ? 2 : 1);
  }

  for (let i = 0; i < list.length; i += 1) {
    const cur = String(list[i] || '').trim();
    if (!cur) continue;
    if (cur === '--help' || cur === '-h') {
      args.help = true;
      continue;
    }
    if ((cur === '--port' || cur === '-p') && list[i + 1]) {
      args.port = list[i + 1];
      i += 1;
      continue;
    }
    if ((cur === '--root' || cur === '--root-dir') && list[i + 1]) {
      args.rootDir = list[i + 1];
      i += 1;
      continue;
    }
  }

  return args;
}

function printHelp() {
  console.log(
    [
      'plana（Action）启动器（支持 npx）',
      '',
      '用法：',
      '  npx @weituo470/plana',
      '  plana --root C:\\\\planA --port 4100',
      '  plana config',
      '  plana config set --root C:\\\\planA --port 4100',
      '',
      '说明：',
      `  默认配置文件：${runtimeConfig.resolveConfigFile()}`,
      '  UI 与 Bridge 统一在同一端口提供（默认 4100）。',
    ].join('\n'),
  );
}

function handleConfigCommand(args) {
  if (args.help) {
    printHelp();
    return;
  }

  if (args.subcmd === 'set') {
    const next = {};
    if (args.port != null) next.defaultPort = args.port;
    if (args.rootDir != null) next.defaultRootDir = args.rootDir;
    const persisted = runtimeConfig.writeRuntimeConfig(next);
    console.log('[plana] 已更新默认配置：');
    console.log(JSON.stringify(persisted, null, 2));
    return;
  }

  const cfg = runtimeConfig.readRuntimeConfig();
  console.log('[plana] 当前默认配置：');
  console.log(JSON.stringify(cfg, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help && args.cmd !== 'config') {
    printHelp();
    return;
  }
  if (args.cmd === 'config') {
    handleConfigCommand(args);
    return;
  }

  const repoDir = path.resolve(__dirname, '..');
  const bridgeEntry = path.join(repoDir, 'bridge', 'src', 'index.js');
  const dashboardDist = path.join(repoDir, 'dashboard', 'dist');

  if (!fileExists(bridgeEntry)) {
    throw new Error(`未找到 Bridge 入口：${bridgeEntry}`);
  }
  if (!fileExists(dashboardDist)) {
    console.warn(`[plana] dashboard/dist 不存在：${dashboardDist}（建议先执行 npm --prefix dashboard run build）`);
  }

  const stored = runtimeConfig.readRuntimeConfig();
  const port = runtimeConfig.normalizePort(args.port, stored.defaultPort);
  const rootDir = runtimeConfig.normalizeRootDir(args.rootDir, stored.defaultRootDir);
  ensureDir(rootDir);

  const actionDir = path.join(rootDir, '.action');
  const dataDir = path.join(actionDir, 'data');
  const logsDir = path.join(actionDir, 'logs');
  const specRoot = path.join(rootDir, 'workflow', 'specs');
  const promptConfigFile = path.join(rootDir, 'workflow', 'prompt-config.json');

  const env = {
    ...process.env,
    WORKFLOW_BRIDGE_PORT: String(port),
    WORKFLOW_ROOT_DIR: rootDir,
    WORKFLOW_DEFAULT_CWD: rootDir,
    WORKFLOW_DATA_DIR: dataDir,
    WORKFLOW_LOGS_DIR: logsDir,
    WORKFLOW_SPEC_ROOT: specRoot,
    WORKFLOW_PROMPT_CONFIG_FILE: promptConfigFile,
    WORKFLOW_DASHBOARD_DIST: dashboardDist,
  };

  console.log(`[plana] RootDir：${rootDir}`);
  console.log(`[plana] UI：http://localhost:${port}`);
  console.log(`[plana] Health：http://localhost:${port}/health`);

  const bridgeProc = spawn(process.execPath, [bridgeEntry], {
    stdio: 'inherit',
    shell: false,
    cwd: repoDir,
    env,
    detached: process.platform !== 'win32',
  });

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[plana] 停止中：${reason}`);
    killProcessTree(bridgeProc);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  bridgeProc.on('exit', (code) => {
    shutdown(`bridge exited (${typeof code === 'number' ? code : 'unknown'})`);
    process.exitCode = typeof code === 'number' ? code : 1;
  });
}

main().catch((err) => {
  console.error(`[plana] 启动失败：${err?.message || String(err)}`);
  process.exit(1);
});


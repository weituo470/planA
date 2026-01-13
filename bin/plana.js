#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function spawnNpm(args, options) {
  const safeArgs = Array.isArray(args) ? args.map((v) => String(v ?? '')) : [];
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', 'npm', ...safeArgs], {
      shell: false,
      ...options,
    });
  }
  return spawn('npm', safeArgs, { shell: false, ...options });
}

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

function parseArgs(argv) {
  const args = {
    port: null,
    rootDir: null,
    noInstall: false,
    setupOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const cur = String(argv[i] || '').trim();
    if (!cur) continue;

    if (cur === '--help' || cur === '-h') {
      args.help = true;
      continue;
    }
    if (cur === '--setup') {
      args.setupOnly = true;
      continue;
    }
    if (cur === '--no-install') {
      args.noInstall = true;
      continue;
    }
    if ((cur === '--port' || cur === '-p') && argv[i + 1]) {
      args.port = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if ((cur === '--root' || cur === '--root-dir') && argv[i + 1]) {
      args.rootDir = String(argv[i + 1]);
      i += 1;
      continue;
    }
  }

  return args;
}

function printHelp() {
  console.log(
    [
      'plana（Action）一键启动',
      '',
      '用法：',
      '  plana',
      '  plana --setup',
      '  plana --root C:\\\\planA --port 4100',
      '',
      '参数：',
      '  --setup              仅安装依赖并退出',
      '  --root, --root-dir   默认工作目录（传给 Bridge 的 WORKFLOW_DEFAULT_CWD；默认：Windows=C:\\\\planA，其他=~/planA）',
      '  -p, --port           Bridge 端口（默认：4100）',
      '  --no-install         不自动安装 bridge/dashboard 依赖（依赖不存在将报错）',
      '',
      '访问：Dashboard http://localhost:5174 · Bridge http://localhost:<port>/health',
    ].join('\n'),
  );
}

function runNpmCommand(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawnNpm(args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function ensurePackageDeps(dirPath, label, options) {
  const nodeModulesDir = path.join(dirPath, 'node_modules');
  if (fileExists(nodeModulesDir)) return;
  if (options.noInstall) {
    throw new Error(`${label}/node_modules 不存在（已指定 --no-install）`);
  }
  console.log(`[plana] 安装 ${label} 依赖中…`);
  await runNpmCommand(['ci'], { cwd: dirPath });
}

function resolveDefaultRootDir() {
  if (process.platform === 'win32') return 'C:\\\\planA';
  return path.join(os.homedir(), 'planA');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const repoDir = path.resolve(__dirname, '..');
  const bridgeDir = path.join(repoDir, 'bridge');
  const dashboardDir = path.join(repoDir, 'dashboard');

  if (!fileExists(path.join(bridgeDir, 'package.json'))) {
    throw new Error(`未找到 bridge：${bridgeDir}`);
  }
  if (!fileExists(path.join(dashboardDir, 'package.json'))) {
    throw new Error(`未找到 dashboard：${dashboardDir}`);
  }

  const rootDir = path.resolve(args.rootDir || resolveDefaultRootDir());
  ensureDir(rootDir);

  await ensurePackageDeps(bridgeDir, 'bridge', args);
  await ensurePackageDeps(dashboardDir, 'dashboard', args);

  if (args.setupOnly) {
    console.log('[plana] 依赖已就绪');
    return;
  }

  const port = Number.isFinite(args.port) && args.port > 0 ? Math.floor(args.port) : 4100;

  console.log(`[plana] Bridge：http://localhost:${port}（health: /health）`);
  console.log('[plana] Dashboard：http://localhost:5174');

  const bridgeEnv = {
    ...process.env,
    WORKFLOW_BRIDGE_PORT: String(port),
    WORKFLOW_DEFAULT_CWD: rootDir,
  };
  const dashboardEnv = {
    ...process.env,
    VITE_BRIDGE_URL: `http://localhost:${port}`,
  };

  const bridgeProc = spawn(process.execPath, [path.join(bridgeDir, 'src', 'index.js')], {
    stdio: 'inherit',
    shell: false,
    cwd: bridgeDir,
    env: bridgeEnv,
    detached: process.platform !== 'win32',
  });

  const dashboardProc = spawnNpm(['run', 'dev'], {
    stdio: 'inherit',
    cwd: dashboardDir,
    env: dashboardEnv,
    detached: process.platform !== 'win32',
  });

  let shuttingDown = false;
  const shutdownAll = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[plana] 停止中：${reason}`);
    killProcessTree(dashboardProc);
    killProcessTree(bridgeProc);
  };

  process.on('SIGINT', () => shutdownAll('SIGINT'));
  process.on('SIGTERM', () => shutdownAll('SIGTERM'));

  bridgeProc.on('exit', (code) => {
    shutdownAll(`bridge exited (${typeof code === 'number' ? code : 'unknown'})`);
    process.exitCode = typeof code === 'number' ? code : 1;
  });
  dashboardProc.on('exit', (code) => {
    shutdownAll(`dashboard exited (${typeof code === 'number' ? code : 'unknown'})`);
    process.exitCode = typeof code === 'number' ? code : 1;
  });
}

main().catch((err) => {
  console.error(`[plana] 启动失败：${err?.message || String(err)}`);
  process.exit(1);
});

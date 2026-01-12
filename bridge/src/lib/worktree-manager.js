const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

function runGit(cwd, args) {
  const out = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return String(out || '').trim();
}

function safeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n');
}

function resolveGitTop(cwd) {
  return runGit(cwd, ['rev-parse', '--show-toplevel']);
}

function resolveCurrentBranch(cwd) {
  return runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function hashText(value) {
  const text = String(value ?? '');
  if (!text) return '';
  try {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
  } catch {
    return '';
  }
}

function makeSafeId(value, prefix = 'id') {
  const raw = String(value ?? '').trim();
  const sanitized = sanitizeId(raw);
  if (sanitized) return sanitized;
  if (!raw) return '';
  const hash = hashText(raw);
  return hash ? `${sanitizeId(prefix) || 'id'}-${hash}` : sanitizeId(prefix) || 'id';
}

function listPorcelainStatusLines(gitTop) {
  const raw = safeText(runGit(gitTop, ['status', '--porcelain']));
  return raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function isOnlyAllowedDirty(lines, options = {}) {
  const allowed = Array.isArray(options.allowedPaths) ? options.allowedPaths : [];
  if (!lines.length) return true;
  if (!allowed.length) return false;

  const normalizePath = (p) =>
    String(p || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\.\/+/, '');

  const allowedSet = new Set(allowed.map(normalizePath).filter(Boolean));
  const remaining = lines.filter((line) => {
    const match = /^..?\s+(.+)$/.exec(line.trim());
    const filePath = normalizePath(match ? match[1] : '');
    if (!filePath) return true;
    if (allowedSet.has(filePath)) return false;
    for (const prefix of allowedSet) {
      if (prefix.endsWith('/') && filePath.startsWith(prefix)) return false;
    }
    return true;
  });

  return remaining.length === 0;
}

function assertGitTopClean(repoDir, options = {}) {
  const gitTop = resolveGitTop(repoDir);
  const lines = listPorcelainStatusLines(gitTop);
  const allowed = Array.isArray(options.allowedPaths) ? options.allowedPaths : [];
  if (!lines.length) return { gitTop, dirty: false, statusLines: [] };
  if (isOnlyAllowedDirty(lines, { allowedPaths: allowed })) {
    return { gitTop, dirty: false, statusLines: lines };
  }

  const err = new Error('主工作区不干净，拒绝启动任务（请先提交/还原改动）');
  err.code = 'GIT_DIRTY';
  err.status = 409;
  err.gitTop = gitTop;
  err.statusLines = lines.slice(0, 200);
  throw err;
}

function branchExists(gitTop, branch) {
  try {
    runGit(gitTop, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function pickUniqueBranchName(gitTop, preferred) {
  const base = makeSafeId(preferred, 'feat/action-task');
  let name = base;
  let suffix = 2;
  while (branchExists(gitTop, name)) {
    name = `${base}-${suffix++}`;
    if (name.length > 120) name = name.slice(0, 120);
  }
  return name;
}

function removeWorktreeIfExists(gitTop, worktreeDir) {
  if (!worktreeDir) return;
  try {
    runGit(gitTop, ['worktree', 'remove', worktreeDir, '--force']);
  } catch {
    // ignore
  }
  try {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function createTaskWorktree({
  repoDir,
  taskId,
  sandboxDirName = '.action_sandbox',
  baseRef = null,
}) {
  const gitTop = resolveGitTop(repoDir);
  const effectiveBaseRef = baseRef || resolveCurrentBranch(gitTop);
  const safeTaskId = makeSafeId(taskId, 'task');
  const sandboxRoot = path.join(gitTop, sandboxDirName);
  const worktreeDir = path.join(sandboxRoot, safeTaskId);
  const preferredBranch = `feat/action-${safeTaskId}`;
  const branch = pickUniqueBranchName(gitTop, preferredBranch);

  fs.mkdirSync(sandboxRoot, { recursive: true });
  removeWorktreeIfExists(gitTop, worktreeDir);

  runGit(gitTop, ['worktree', 'add', '-b', branch, worktreeDir, effectiveBaseRef]);

  return {
    gitTop,
    baseRef: effectiveBaseRef,
    branch,
    sandboxDirName,
    worktreeDir,
    taskId: safeTaskId,
  };
}

function commitAllChanges(worktreeDir, message, options = {}) {
  const gitTop = resolveGitTop(worktreeDir);
  const statusLines = listPorcelainStatusLines(worktreeDir);
  if (!statusLines.length) {
    return { ok: true, committed: false, reason: 'no_changes', statusLines: [] };
  }

  const allowEmpty = options.allowEmpty === true;
  runGit(worktreeDir, ['add', '-A']);

  const staged = safeText(runGit(worktreeDir, ['diff', '--cached', '--name-only']))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!staged.length && !allowEmpty) {
    return { ok: true, committed: false, reason: 'nothing_staged', statusLines };
  }

  const args = ['commit', '-m', String(message || 'chore: task changes').slice(0, 300)];
  if (allowEmpty) args.push('--allow-empty');
  const out = safeText(runGit(worktreeDir, args));

  return { ok: true, committed: true, gitTop, output: out, statusLines, staged };
}

function cleanupTaskWorktree({ gitTop, worktreeDir }) {
  if (!gitTop || !worktreeDir) return;
  runGit(gitTop, ['worktree', 'remove', worktreeDir, '--force']);
  try {
    runGit(gitTop, ['worktree', 'prune']);
  } catch {
    // ignore prune errors
  }
}

module.exports = {
  assertGitTopClean,
  createTaskWorktree,
  commitAllChanges,
  cleanupTaskWorktree,
  resolveGitTop,
  resolveCurrentBranch,
};

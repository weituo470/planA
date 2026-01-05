/**
 * path-adapter.service.js
 * 跨平台路径适配服务
 * 处理 Windows <-> Linux/Mac 路径转换
 */

const path = require('path');

/**
 * 检测路径类型
 * @param {string} input - 输入字符串
 * @returns {string} - 'windows', 'posix', 或 'unknown'
 */
function detectPathType(input) {
  if (!input || typeof input !== 'string') return 'unknown';

  // Windows 路径特征：C:\ 或 D:\ 等
  if (/^[A-Za-z]:\\/.test(input)) return 'windows';

  // Windows UNC 路径：\\server\share
  if (/^\\\\[^\\]/.test(input)) return 'windows';

  // POSIX 路径：/ 开头
  if (/^\//.test(input)) return 'posix';

  // 相对路径中的反斜杠
  if (input.includes('\\') && !input.includes('/')) return 'windows';

  // 相对路径中的正斜杠
  if (input.includes('/') && !input.includes('\\')) return 'posix';

  return 'unknown';
}

/**
 * 将 Windows 路径转换为 POSIX 路径
 * @param {string} windowsPath - Windows 路径
 * @param {Object} options - 选项
 * @returns {string} - POSIX 路径
 */
function windowsToPosix(windowsPath, options = {}) {
  if (!windowsPath) return windowsPath;

  let result = windowsPath;

  // 处理盘符：C:\ → /c/ 或 /mnt/c/
  result = result.replace(/^([A-Za-z]):\\/, (match, drive) => {
    const driveLetter = drive.toLowerCase();
    return options.mntStyle ? `/mnt/${driveLetter}/` : `/${driveLetter}/`;
  });

  // 处理 UNC 路径：\\server\share → /server/share
  result = result.replace(/^\\\\([^\\]+)\\(.*)/, '/$1/$2');

  // 转换反斜杠为正斜杠
  result = result.replace(/\\/g, '/');

  // 移除末尾斜杠（除非是根路径）
  if (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * 将 POSIX 路径转换为 Windows 路径
 * @param {string} posixPath - POSIX 路径
 * @param {Object} options - 选项
 * @returns {string} - Windows 路径
 */
function posixToWindows(posixPath, options = {}) {
  if (!posixPath) return posixPath;

  let result = posixPath;

  // 处理 /mnt/c/ 格式 → C:\
  result = result.replace(/^\/mnt\/([a-z])\//, (match, drive) => {
    return `${drive.toUpperCase()}:\\`;
  });

  // 处理 /c/ 格式 → C:\
  if (!options.mntStyle) {
    result = result.replace(/^\/([a-z])\//, (match, drive) => {
      return `${drive.toUpperCase()}:\\`;
    });
  }

  // 转换正斜杠为反斜杠
  result = result.replace(/\//g, '\\');

  return result;
}

/**
 * 规范化路径到目标平台
 * @param {string} inputPath - 输入路径
 * @param {string} targetPlatform - 'windows', 'linux', 'macos', 或 'auto'
 * @param {Object} options - 选项
 * @returns {string} - 规范化后的路径
 */
function normalizePath(inputPath, targetPlatform = 'auto', options = {}) {
  if (!inputPath) return inputPath;

  // 检测当前路径类型
  const detectedType = detectPathType(inputPath);

  // 如果无法检测或已是目标格式，直接返回
  if (detectedType === 'unknown') {
    return inputPath.replace(/\\/g, '/'); // 统一使用正斜杠
  }

  // 自动检测目标平台
  let actualTarget = targetPlatform;
  if (targetPlatform === 'auto') {
    actualTarget = process.platform === 'win32' ? 'windows' : 'linux';
  }

  const isWindowsTarget = actualTarget === 'windows';
  const isWindowsSource = detectedType === 'windows';

  // 源和目标相同，无需转换
  if (isWindowsSource === isWindowsTarget) {
    return inputPath;
  }

  // 执行转换
  if (isWindowsSource && !isWindowsTarget) {
    return windowsToPosix(inputPath, options);
  } else if (!isWindowsSource && isWindowsTarget) {
    return posixToWindows(inputPath, options);
  }

  return inputPath;
}

/**
 * 规范化多个路径
 * @param {string[]} paths - 路径数组
 * @param {string} targetPlatform - 目标平台
 * @returns {string[]} - 规范化后的路径数组
 */
function normalizePaths(paths, targetPlatform = 'auto') {
  if (!Array.isArray(paths)) return [];
  return paths.map(p => normalizePath(p, targetPlatform));
}

/**
 * 提取路径规范（用于显示警告）
 * @param {string} inputPath - 输入路径
 * @returns {Object} - 路径规范信息
 */
function analyzePath(inputPath) {
  if (!inputPath) return null;

  const type = detectPathType(inputPath);
  const issues = [];

  // 检测混合使用斜杠
  if (inputPath.includes('\\') && inputPath.includes('/')) {
    issues.push('混合使用反斜杠和正斜杠');
  }

  // 检测环境变量
  const envVars = inputPath.match(/%[^%]+%/g);
  const posixEnvVars = inputPath.match(/\$[A-Za-z_][A-Za-z0-9_]*/g);

  if (envVars && envVars.length > 0) {
    issues.push(`包含 Windows 环境变量: ${envVars.join(', ')}`);
  }

  if (posixEnvVars && posixEnvVars.length > 0) {
    issues.push(`包含 POSIX 环境变量: ${posixEnvVars.join(', ')}`);
  }

  return {
    original: inputPath,
    type,
    hasIssues: issues.length > 0,
    issues,
  };
}

/**
 * 转换环境变量格式
 * @param {string} input - 输入字符串
 * @param {string} targetFormat - 'windows' 或 'posix'
 * @returns {string} - 转换后的字符串
 */
function convertEnvVars(input, targetFormat = 'posix') {
  if (!input) return input;

  let result = input;

  if (targetFormat === 'posix') {
    // %VAR% → $VAR
    result = result.replace(/%([^%]+)%/g, '$$1');
  } else {
    // $VAR → %VAR%
    result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, '%$1%');
  }

  return result;
}

/**
 * 生成兼容性说明
 * @param {string[]} paths - 路径数组
 * @param {string} sourcePlatform - 源平台
 * @param {string} targetPlatform - 目标平台
 * @returns {Object} - 兼容性信息
 */
function checkCompatibility(paths, sourcePlatform, targetPlatform) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { compatible: true, issues: [] };
  }

  const issues = [];
  const samePlatform = sourcePlatform === targetPlatform;

  if (!samePlatform) {
    // 跨平台检查
    const windowsPaths = paths.filter(p => detectPathType(p) === 'windows');
    const posixPaths = paths.filter(p => detectPathType(p) === 'posix');

    if (windowsPaths.length > 0 && targetPlatform !== 'windows') {
      issues.push({
        type: 'windows_path_on_posix',
        count: windowsPaths.length,
        message: `${windowsPaths.length} 个 Windows 路径需要在 Linux 上转换`,
      });
    }

    if (posixPaths.length > 0 && targetPlatform === 'windows') {
      issues.push({
        type: 'posix_path_on_windows',
        count: posixPaths.length,
        message: `${posixPaths.length} 个 POSIX 路径需要在 Windows 上转换`,
      });
    }
  }

  // 检测环境变量
  const hasWindowsEnv = paths.some(p => p && p.includes('%'));
  const hasPosixEnv = paths.some(p => p && p.includes('$'));

  if (hasWindowsEnv && targetPlatform !== 'windows') {
    issues.push({
      type: 'windows_env_vars',
      message: '包含 Windows 环境变量，需要转换为 POSIX 格式',
    });
  }

  if (hasPosixEnv && targetPlatform === 'windows') {
    issues.push({
      type: 'posix_env_vars',
      message: '包含 POSIX 环境变量，需要转换为 Windows 格式',
    });
  }

  return {
    compatible: issues.length === 0,
    issues,
  };
}

module.exports = {
  detectPathType,
  windowsToPosix,
  posixToWindows,
  normalizePath,
  normalizePaths,
  analyzePath,
  convertEnvVars,
  checkCompatibility,
};

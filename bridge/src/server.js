const path = require('path');
const chokidar = require('chokidar');

const {
  PORT,
  ROOT_DIR,
  WATCH_DIRS,
  server,
  emitEvent,
  handleFileChange,
  handleFileUnlink,
} = require('./app');

function startWatcher() {
  const watchTargets = String(WATCH_DIRS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.join(ROOT_DIR, value));

  const watcher = chokidar.watch(watchTargets, {
    ignored: /node_modules|dist|logs|workflow[\\/]+bridge[\\/]+data/,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100,
    },
  });

  watcher.on('add', (filePath) => handleFileChange('file added', filePath));
  watcher.on('change', (filePath) => handleFileChange('file changed', filePath));
  watcher.on('unlink', (filePath) => handleFileUnlink(filePath));

  emitEvent('log:append', {
    source: 'watcher',
    message: `[watching] ${watchTargets.join(', ') || 'none'}`,
  });

  return watcher;
}

function start() {
  startWatcher();
  server.listen(PORT, () => {
    console.log(`Workflow bridge running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { start };

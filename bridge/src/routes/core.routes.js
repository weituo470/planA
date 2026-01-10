const fs = require('fs');
const path = require('path');
const { normalizeCodexSandbox, normalizeCodexModel } = require('../lib/codex-options');

function registerCoreRoutes(app, ctx) {
  // NOTE: 临时用 with(ctx) 保持等价重构，后续可逐步迁移到 controllers/services。
  with (ctx) {
    app.get('/health', (req, res) => {
      res.json({ ok: true });
    });
    
    app.get('/workspace', (req, res) => {
      const cfg = readWorkspaceConfig();
      res.json({
        defaultCwd: typeof cfg?.defaultCwd === 'string' ? cfg.defaultCwd : null,
        effectiveCwd: getDefaultWorkspaceCwd(),
        repoDir: REPO_DIR,
      });
    });
    
    app.post('/workspace', (req, res) => {
      const raw = req.body?.defaultCwd;
      if (raw == null || (typeof raw === 'string' && !raw.trim())) {
        writeWorkspaceConfig({ defaultCwd: null });
        return res.json({
          ok: true,
          defaultCwd: null,
          effectiveCwd: getDefaultWorkspaceCwd(),
        });
      }
      if (typeof raw !== 'string') {
        return res.status(400).json({ error: 'defaultCwd must be a string or null' });
      }
      const resolved = resolveExistingDirectory(raw);
      if (!resolved) {
        return res.status(400).json({ error: 'Directory not found' });
      }
      writeWorkspaceConfig({ defaultCwd: resolved });
      return res.json({
        ok: true,
        defaultCwd: resolved,
        effectiveCwd: getDefaultWorkspaceCwd(),
      });
    });
    
    function listWindowsDriveRoots() {
      const roots = [];
      for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const root = `${letter}:\\\\`;
        try {
          if (fs.existsSync(root)) roots.push(root);
        } catch {
          // ignore
        }
      }
      return roots;
    }
    
    function listDirectoryDirs(dirPath) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const dirs = [];
      for (const entry of entries) {
        if (!entry?.isDirectory?.()) continue;
        const name = String(entry.name || '').trim();
        if (!name) continue;
        dirs.push(name);
      }
      dirs.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
      return dirs;
    }
    
    function sanitizeFsEntryName(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed === '.' || trimmed === '..') return null;
      if (trimmed.length > 120) return null;
      if (/[<>:"/\\|?*\u0000-\u001F]/.test(trimmed)) return null;
      return trimmed;
    }
    
    function isRootPath(value) {
      try {
        const resolved = path.resolve(value);
        const root = path.parse(resolved).root;
        return resolved === root;
      } catch {
        return false;
      }
    }
    
    function resolveExistingPath(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const resolved = path.resolve(trimmed);
        fs.lstatSync(resolved);
        return resolved;
      } catch {
        return null;
      }
    }
    
    function listDirectoryEntries(dirPath) {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const list = [];
      for (const entry of entries) {
        const name = String(entry?.name || '').trim();
        if (!name) continue;
        const fullPath = path.join(dirPath, name);
        if (entry.isDirectory()) {
          list.push({ name, path: fullPath, type: 'dir' });
          continue;
        }
        if (entry.isFile()) {
          list.push({ name, path: fullPath, type: 'file' });
          continue;
        }
      }
      list.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      return list;
    }
    
    function normalizePathKey(value) {
      return String(value || '').replace(/\//g, '\\').toLowerCase();
    }
    
    function isDescendantPath(parentPath, childPath) {
      try {
        const parent = path.resolve(parentPath);
        const child = path.resolve(childPath);
        const parentKey = normalizePathKey(parent).replace(/\\+$/, '') + '\\';
        const childKey = normalizePathKey(child);
        return childKey.startsWith(parentKey);
      } catch {
        return false;
      }
    }
    
    app.get('/fs/dirs', (req, res) => {
      const raw = typeof req.query?.path === 'string' ? req.query.path.trim() : '';
      if (!raw) {
        if (process.platform === 'win32') {
          const roots = listWindowsDriveRoots();
          return res.json({
            path: null,
            parent: null,
            dirs: roots.map((p) => ({ name: p, path: p })),
          });
        }
        const root = resolveExistingDirectory('/');
        if (!root) return res.status(500).json({ error: 'Root directory not found' });
        return res.json({
          path: root,
          parent: null,
          dirs: listDirectoryDirs(root).map((name) => ({ name, path: path.join(root, name) })),
        });
      }
    
      const current = resolveExistingDirectory(raw);
      if (!current) {
        return res.status(400).json({ error: 'Directory not found' });
      }
    
      const parentPath = path.dirname(current);
      const hasParent = Boolean(parentPath && parentPath !== current);
      return res.json({
        path: current,
        parent: hasParent ? parentPath : null,
        dirs: listDirectoryDirs(current).map((name) => ({ name, path: path.join(current, name) })),
      });
    });
    
    app.get('/fs/list', (req, res) => {
      const raw = typeof req.query?.path === 'string' ? req.query.path.trim() : '';
      if (!raw) {
        if (process.platform === 'win32') {
          const roots = listWindowsDriveRoots();
          return res.json({
            path: null,
            parent: null,
            entries: roots.map((p) => ({ name: p, path: p, type: 'dir' })),
          });
        }
        const root = resolveExistingDirectory('/');
        if (!root) return res.status(500).json({ error: 'Root directory not found' });
        return res.json({
          path: root,
          parent: null,
          entries: listDirectoryEntries(root),
        });
      }
    
      const current = resolveExistingDirectory(raw);
      if (!current) {
        return res.status(400).json({ error: 'Directory not found' });
      }
      const parentPath = path.dirname(current);
      const hasParent = Boolean(parentPath && parentPath !== current);
      return res.json({
        path: current,
        parent: hasParent ? parentPath : null,
        entries: listDirectoryEntries(current),
      });
    });
    
    app.post('/fs/mkdir', (req, res) => {
      const parent = resolveExistingDirectory(req.body?.parent);
      if (!parent) return res.status(400).json({ error: 'parent is required' });
      const name = sanitizeFsEntryName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'Invalid folder name' });
      const target = path.join(parent, name);
      try {
        if (fs.existsSync(target)) {
          return res.status(409).json({ error: 'Already exists' });
        }
        fs.mkdirSync(target, { recursive: false });
        return res.json({ ok: true, path: target });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to create directory' });
      }
    });
    
    app.post('/fs/touch', (req, res) => {
      const parent = resolveExistingDirectory(req.body?.parent);
      if (!parent) return res.status(400).json({ error: 'parent is required' });
      const name = sanitizeFsEntryName(req.body?.name);
      if (!name) return res.status(400).json({ error: 'Invalid file name' });
      const target = path.join(parent, name);
      try {
        if (fs.existsSync(target)) {
          return res.status(409).json({ error: 'Already exists' });
        }
        fs.writeFileSync(target, '', 'utf8');
        return res.json({ ok: true, path: target });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to create file' });
      }
    });
    
    app.post('/fs/paste', (req, res) => {
      const src = resolveExistingPath(req.body?.srcPath);
      if (!src) return res.status(400).json({ error: 'srcPath not found' });
      const destDir = resolveExistingDirectory(req.body?.destDir);
      if (!destDir) return res.status(400).json({ error: 'destDir not found' });
      const modeRaw = typeof req.body?.mode === 'string' ? req.body.mode.trim() : '';
      const mode = modeRaw === 'cut' ? 'cut' : 'copy';
    
      const base = path.basename(src);
      const dest = path.join(destDir, base);
      if (fs.existsSync(dest)) {
        return res.status(409).json({ error: 'Destination already exists' });
      }
      if (isDescendantPath(src, destDir)) {
        return res.status(400).json({ error: 'Refuse to paste into its own subdirectory' });
      }
    
      try {
        const stat = fs.lstatSync(src);
        if (mode === 'cut') {
          try {
            fs.renameSync(src, dest);
            return res.json({ ok: true, path: dest, mode });
          } catch (error) {
            // cross-device move: fallback to copy+delete
            if (!stat.isDirectory()) {
              fs.copyFileSync(src, dest);
              fs.rmSync(src, { force: true });
              return res.json({ ok: true, path: dest, mode });
            }
            fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
            fs.rmSync(src, { recursive: true, force: true });
            return res.json({ ok: true, path: dest, mode });
          }
        }
    
        if (!stat.isDirectory()) {
          fs.copyFileSync(src, dest);
          return res.json({ ok: true, path: dest, mode });
        }
        fs.cpSync(src, dest, { recursive: true, errorOnExist: true });
        return res.json({ ok: true, path: dest, mode });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to paste' });
      }
    });
    
    app.post('/fs/rename', (req, res) => {
      const existing = resolveExistingPath(req.body?.path);
      if (!existing) return res.status(400).json({ error: 'path not found' });
      const newName = sanitizeFsEntryName(req.body?.newName);
      if (!newName) return res.status(400).json({ error: 'Invalid newName' });
      const parent = path.dirname(existing);
      const target = path.join(parent, newName);
      try {
        if (fs.existsSync(target)) {
          return res.status(409).json({ error: 'Already exists' });
        }
        fs.renameSync(existing, target);
        return res.json({ ok: true, path: target });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to rename' });
      }
    });
    
    app.post('/fs/delete', (req, res) => {
      const existing = resolveExistingPath(req.body?.path);
      if (!existing) return res.status(400).json({ error: 'path not found' });
      if (isRootPath(existing)) {
        return res.status(400).json({ error: 'Refuse to delete root path' });
      }
      try {
        fs.rmSync(existing, { recursive: true, force: true });
        return res.json({ ok: true });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to delete' });
      }
    });
    
    app.get('/terminals', (req, res) => {
      res.json({ terminals: listTerminalSessions() });
    });
    
    app.get('/terminals/:id/buffer', (req, res) => {
      const session = getTerminalSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Terminal not found' });
      }
      return res.json({
        terminal: {
          id: session.id,
          title: session.title,
          pid: session.pid,
          running: session.running,
          paused: session.paused === true,
          pausedAt: session.pausedAt || null,
          createdAt: session.createdAt,
          exitedAt: session.exitedAt,
          exitCode: session.exitCode,
        },
        buffer: session.buffer,
      });
    });
    
    app.post('/terminals', (req, res) => {
      if (state.status === 'Reviewing') {
        return res.status(409).json({ error: 'Blocked by approval' });
      }
      try {
        const session = createTerminalSession(req.body || {});
        return res.json({
          id: session.id,
          pid: session.pid,
          title: session.title,
        });
      } catch (error) {
        return res.status(error?.status || 500).json({ error: error?.message || 'Failed to create terminal' });
      }
    });
    
    app.post('/terminals/:id/input', (req, res) => {
      const session = getTerminalSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Terminal not found' });
      }
      writeTerminalInput(session, req.body?.input);
      return res.json({ ok: true });
    });
    
    app.post('/terminals/:id/resize', (req, res) => {
      const session = getTerminalSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Terminal not found' });
      }
      resizeTerminal(session, req.body?.cols, req.body?.rows);
      return res.json({ ok: true });
    });

    app.post('/terminals/:id/pause', (req, res) => {
      const session = getTerminalSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Terminal not found' });
      }
      try {
        pauseTerminalSession(session);
        return res.json({ ok: true });
      } catch (error) {
        return res
          .status(error?.status || 500)
          .json({ error: error?.message || 'Failed to pause terminal' });
      }
    });

    app.post('/terminals/:id/resume', (req, res) => {
      const session = getTerminalSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Terminal not found' });
      }
      try {
        resumeTerminalSession(session);
        return res.json({ ok: true });
      } catch (error) {
        return res
          .status(error?.status || 500)
          .json({ error: error?.message || 'Failed to resume terminal' });
      }
    });
    
    app.delete('/terminals/:id', (req, res) => {
      const session = getTerminalSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: 'Terminal not found' });
      }
      killTerminal(session);
      terminalSessions.delete(session.id);
      return res.json({ ok: true });
    });
    
    app.get('/cli-tools', (req, res) => {
      const cfg = loadCliToolsConfig();
      return res.json({ tools: cfg.tools.map(toPublicCliTool) });
    });
    
    app.post('/cli-tools', (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        if (!label) return res.status(400).json({ error: 'label is required' });
        if (!command) return res.status(400).json({ error: 'command is required' });
    
        const cfg = loadCliToolsConfig();
        const used = new Set(cfg.tools.map((t) => String(t.id || '')));
    
        const requestedId = normalizeCliToolId(body.id);
        const baseId = requestedId || normalizeCliToolId(label) || normalizeCliToolId(command);
        if (!baseId) return res.status(400).json({ error: 'id is required' });
    
        let id = baseId;
        if (used.has(id)) {
          let n = 2;
          while (used.has(`${baseId}-${n}`)) n += 1;
          id = `${baseId}-${n}`;
        }
    
        const nextTool = normalizeCliToolInput(body, { id });
        if (!nextTool.label) return res.status(400).json({ error: 'Invalid label' });
        if (!nextTool.command) return res.status(400).json({ error: 'Invalid command' });
    
        cfg.tools.push(nextTool);
        const persisted = persistCliToolsConfig(cfg);
        const created = persisted.tools.find((t) => t.id === id);
        return res.json({ ok: true, tool: toPublicCliTool(created || nextTool) });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to create cli tool' });
      }
    });
    
    app.put('/cli-tools/:id', (req, res) => {
      try {
        const toolId = normalizeCliToolId(req.params.id);
        if (!toolId) return res.status(400).json({ error: 'Invalid tool id' });
    
        const cfg = loadCliToolsConfig();
        const idx = cfg.tools.findIndex((t) => String(t.id || '') === toolId);
        if (idx < 0) return res.status(404).json({ error: 'Tool not found' });
    
        const updated = normalizeCliToolInput(req.body, cfg.tools[idx]);
        if (!updated.label) return res.status(400).json({ error: 'Invalid label' });
        if (!updated.command) return res.status(400).json({ error: 'Invalid command' });
    
        cfg.tools[idx] = updated;
        const persisted = persistCliToolsConfig(cfg);
        const next = persisted.tools.find((t) => t.id === toolId) || updated;
        return res.json({ ok: true, tool: toPublicCliTool(next) });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to update cli tool' });
      }
    });
    
    app.post('/cli-tools/reset', (req, res) => {
      try {
        const persisted = persistCliToolsConfig(DEFAULT_CLI_TOOLS_CONFIG);
        return res.json({ ok: true, tools: persisted.tools.map(toPublicCliTool) });
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to reset cli tools' });
      }
    });
    
    app.delete('/cli-tools/:id', (req, res) => {
      const toolId = normalizeCliToolId(req.params.id);
      if (!toolId) return res.status(400).json({ error: 'Invalid tool id' });
      const cfg = loadCliToolsConfig();
      const nextTools = cfg.tools.filter((t) => String(t.id || '') !== toolId);
      if (nextTools.length === cfg.tools.length) {
        return res.status(404).json({ error: 'Tool not found' });
      }
      persistCliToolsConfig({ ...cfg, tools: nextTools });
      return res.json({ ok: true });
    });
    
    app.get('/llm', (req, res) => {
      const { baseUrl, model, providerId, responseFormat } = getActiveLlmConfig();
      res.json({
        hasConfig: hasLlmConfig(),
        model: model || null,
        providerId: providerId || null,
        baseUrl: baseUrl || null,
        responseFormat: responseFormat || null,
        options: LLM_MODEL_OPTIONS,
        providers: LLM_PROVIDERS.map((provider) => {
          const directBaseUrl = getProviderEnv(provider.id, 'base_url');
          const directApiKey = getProviderEnv(provider.id, 'api_key');
          return {
            id: provider.id,
            label: provider.label,
            baseUrl: directBaseUrl || null,
            baseUrlPresent: Boolean(directBaseUrl),
            apiKeyPresent: Boolean(directApiKey),
          };
        }),
      });
    });
    
    app.get('/llm/ping', async (req, res) => {
      try {
        let model = typeof req.query?.model === 'string' ? req.query.model.trim() : '';
        if (!model) {
          model = (process.env.LLM_MODEL || '').trim();
        }
        if (LLM_MODEL_ALIASES[model]) model = LLM_MODEL_ALIASES[model];
        if (!isSupportedModel(model)) {
          return res.status(400).json({ ok: false, error: `Unsupported model: ${model}` });
        }
    
        const cfg = getLlmConfigForModel(model);
        if (!cfg.baseUrl || !cfg.apiKey) {
          return res.json({ ok: false, model, providerId: cfg.providerId, error: 'Missing baseUrl or apiKey' });
        }
    
        const startedAt = Date.now();
        await callLlm([{ role: 'user', content: 'ping' }], {
          ...cfg,
          timeoutMs: Number(process.env.LLM_PING_TIMEOUT_MS || 8000),
        });
    
        const latencyMs = Date.now() - startedAt;
        return res.json({ ok: true, model, providerId: cfg.providerId, latencyMs });
      } catch (error) {
        return res.json({ ok: false, error: error?.message || String(error) });
      }
    });
    
    app.post('/llm/provider', (req, res) => {
      try {
        const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId.trim() : '';
        if (!providerId || !LLM_PROVIDERS.some((p) => p.id === providerId)) {
          return res.status(400).json({ error: 'Invalid providerId' });
        }
    
        const hasBaseUrl = typeof req.body?.baseUrl === 'string';
        const hasApiKey = typeof req.body?.apiKey === 'string';
        if (!hasBaseUrl && !hasApiKey) {
          return res.status(400).json({ error: 'Nothing to update' });
        }
    
        const existing = {};
        if (fs.existsSync(LLM_CONFIG_FILE)) {
          try {
            Object.assign(existing, JSON.parse(fs.readFileSync(LLM_CONFIG_FILE, 'utf8')));
          } catch {
            // ignore
          }
        }
    
        const providers = (existing.providers && typeof existing.providers === 'object')
          ? { ...existing.providers }
          : {};
        const currentProvider = (providers[providerId] && typeof providers[providerId] === 'object')
          ? { ...providers[providerId] }
          : {};
    
        if (hasBaseUrl) {
          currentProvider.baseUrl = String(req.body.baseUrl || '').trim();
        }
        if (hasApiKey) {
          currentProvider.apiKey = String(req.body.apiKey || '').trim();
        }
    
        providers[providerId] = currentProvider;
        persistLlmConfig({ providers });
    
        const envPrefix = `LLM_PROVIDER_${providerId.toUpperCase()}_`;
        if (hasBaseUrl) process.env[`${envPrefix}BASE_URL`] = currentProvider.baseUrl || '';
        if (hasApiKey) process.env[`${envPrefix}API_KEY`] = currentProvider.apiKey || '';
    
        emitEvent('log:append', {
          source: 'llm',
          message: `[llm] provider ${providerId} updated`,
        });
    
        const { baseUrl, model, providerId: activeProviderId, responseFormat } = getActiveLlmConfig();
        return res.json({
          hasConfig: hasLlmConfig(),
          model: model || null,
          providerId: activeProviderId || null,
          baseUrl: baseUrl || null,
          responseFormat: responseFormat || null,
          options: LLM_MODEL_OPTIONS,
          providers: LLM_PROVIDERS.map((provider) => {
            const directBaseUrl = getProviderEnv(provider.id, 'base_url');
            const directApiKey = getProviderEnv(provider.id, 'api_key');
            return {
              id: provider.id,
              label: provider.label,
              baseUrl: directBaseUrl || null,
              baseUrlPresent: Boolean(directBaseUrl),
              apiKeyPresent: Boolean(directApiKey),
            };
          }),
        });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Invalid provider config' });
      }
    });
    
    app.post('/llm/model', (req, res) => {
      try {
        const nextModel = setLlmModel(req.body?.model);
        emitEvent('log:append', {
          source: 'llm',
          message: `[llm] model set to ${nextModel}`,
        });
        const { baseUrl, model, providerId, responseFormat } = getActiveLlmConfig();
        return res.json({
          hasConfig: hasLlmConfig(),
          model: model || null,
          providerId: providerId || null,
          baseUrl: baseUrl || null,
          responseFormat: responseFormat || null,
          options: LLM_MODEL_OPTIONS,
          providers: LLM_PROVIDERS.map((provider) => {
            const directBaseUrl = getProviderEnv(provider.id, 'base_url');
            const directApiKey = getProviderEnv(provider.id, 'api_key');
            return {
              id: provider.id,
              label: provider.label,
              baseUrl: directBaseUrl || null,
              baseUrlPresent: Boolean(directBaseUrl),
              apiKeyPresent: Boolean(directApiKey),
            };
          }),
        });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Invalid model' });
      }
    });
    
    app.get('/prompts', (req, res) => {
      const current = loadPromptConfig();
      const defaults = loadPromptDefaults();
      const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
      return res.json({ current, defaults, presets });
    });
    
    const OPUS_45_MODEL_ID = 'claude-opus-4-5-20251101';
    
    function normalizeOpusChatSessionId(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length > 80) return null;
      if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
      return trimmed;
    }
    
    function normalizeOpusChatMessage(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!trimmed) return null;
      if (trimmed.length > 24000) return trimmed.slice(0, 24000);
      return trimmed;
    }
    
    function ensureDir(dirPath) {
      try {
        fs.mkdirSync(dirPath, { recursive: true });
      } catch {
        // ignore
      }
    }
    
    function readJsonFile(filePath, fallback) {
      try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        return fallback;
      }
    }
    
    function writeJsonFile(filePath, data) {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    }
    
    function appendMarkdown(filePath, text) {
      fs.appendFileSync(filePath, text, 'utf8');
    }
    
    function buildDefaultPromptOptimizerSystemPrompt() {
      return [
        '你是“提示词架构师/审计员”（Prompt Architect）。',
        '目标：对本系统 workflow/prompt-config.json 的所有 stages 提示词做整体优化，使其更稳定、更短、更易被程序解析、且更贴合本系统流程。',
        '约束：',
        '- 全程使用简体中文。',
        '- 输出务必可执行、可落地；避免空泛原则堆砌。',
        '- 优先减少冗余上下文、减少跑偏、减少 token 消耗，同时保留必要约束（尤其是只输出 JSON 的 stages）。',
        '- 建议要区分“通用改进”与“逐 stage 改进”；必要时提出 3-6 个澄清问题，但不要超过 6 个。',
        '- 不要输出任何 API key、baseUrl、环境变量等敏感信息。',
      ].join('\n');
    }
    
    /**
     * POST /prompts/opus45/chat
     * 与 Claude 4.5 Opus（通过 Bridge 的 LLM 通道）对话，并把对话过程追加到 docs/flow_*.md 文档中。
     *
     * body:
     * - message: string (required)
     * - sessionId?: string (optional, continue previous session)
     * - title?: string (optional, only used when creating a new session)
     */
    app.post('/prompts/opus45/chat', async (req, res) => {
      try {
        const message = normalizeOpusChatMessage(req.body?.message ?? req.body?.prompt ?? '');
        if (!message) return res.status(400).json({ error: 'message is required' });
    
        const requestedSessionId = normalizeOpusChatSessionId(req.body?.sessionId);
        const newSessionId = `opus45-promptopt-${formatTimestamp(new Date())}-${nanoid(6)}`;
        const sessionId = requestedSessionId || newSessionId;
    
        const runDir = path.join(REPO_DIR, '.runlogs', 'opus45-promptopt');
        const sessionsDir = path.join(runDir, 'sessions');
        ensureDir(sessionsDir);
    
        const sessionPath = path.join(sessionsDir, `${sessionId}.json`);
        let session = readJsonFile(sessionPath, null);
    
        const created = !session;
        if (!session) {
          const titleRaw = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
          const title = titleRaw || '提示词整体优化';
    
          const docName = `flow_提示词优化_Opus4.5_${sessionId}.md`;
          const docPath = path.join(DOCS_DIR, docName);
    
          const promptConfig = loadPromptConfig();
          const systemPrompt = buildDefaultPromptOptimizerSystemPrompt();
          const contextMessage = [
            `当前 workflow/prompt-config.json（current）如下（请以此为准进行整体优化审计）：`,
            '```json',
            JSON.stringify(promptConfig, null, 2),
            '```',
          ].join('\n');
    
          session = {
            version: 1,
            sessionId,
            title,
            model: OPUS_45_MODEL_ID,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            docPath,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: contextMessage },
            ],
          };
    
          ensureDir(DOCS_DIR);
          if (!fs.existsSync(docPath)) {
            fs.writeFileSync(
              docPath,
              [
                `# Opus 4.5 对话记录：${title}`,
                '',
                `- sessionId: ${sessionId}`,
                `- model: ${OPUS_45_MODEL_ID}`,
                `- createdAt: ${session.createdAt}`,
                '',
                '## System',
                '```text',
                systemPrompt,
                '```',
                '',
                '## Context',
                contextMessage,
                '',
                '---',
                '',
              ].join('\n'),
              'utf8',
            );
          }
        }
    
        const cfg = {
          ...getLlmConfigForModel(OPUS_45_MODEL_ID),
          responseFormat: 'none',
          timeoutMs: Number(process.env.OPUS45_PROMPTOPT_TIMEOUT_MS || 120000),
        };
        assertValidLlmConfig(cfg);
    
        const messages = Array.isArray(session.messages) ? [...session.messages] : [];
        messages.push({ role: 'user', content: message });
    
        let usage = null;
        const reply = await callLlm(messages, cfg, {
          onUsage: (u) => {
            usage = u || null;
          },
        });
    
        messages.push({ role: 'assistant', content: reply });
        session.messages = messages;
        session.updatedAt = new Date().toISOString();
        writeJsonFile(sessionPath, session);
    
        const turnIndex =
          Math.max(0, Math.floor((messages.length - 2 /*system+context*/) / 2)) || 1;
        const usageLine = usage
          ? `\n\n> usage: prompt=${usage.promptTokens ?? '-'} completion=${usage.completionTokens ?? '-'} total=${usage.totalTokens ?? '-'}`
          : '';
        appendMarkdown(
          session.docPath,
          [
            `## Turn ${turnIndex}`,
            '',
            `### User (${new Date().toISOString()})`,
            message,
            '',
            `### Opus 4.5 (${new Date().toISOString()})`,
            reply,
            usageLine,
            '',
            '---',
            '',
          ].join('\n'),
        );
    
        emitEvent('log:append', {
          source: 'llm',
          message: `[llm] opus45 promptopt chat ${created ? 'created' : 'continued'}: ${sessionId}`,
        });
    
        return res.json({
          ok: true,
          created,
          sessionId,
          model: OPUS_45_MODEL_ID,
          docPath: normalizePathForPrompt(session.docPath),
          reply,
          usage,
        });
      } catch (error) {
        console.error('[opus45] promptopt chat error:', error?.message || error);
        return res.status(500).json({ error: error?.message || 'Opus chat failed' });
      }
    });
    
    app.post('/prompts', (req, res) => {
      try {
        const incoming = req.body?.config ?? req.body ?? {};
        const saved = persistPromptConfig(incoming);
        emitEvent('log:append', { source: 'prompt', message: '[prompt] config updated' });
        const defaults = loadPromptDefaults();
        const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
        return res.json({ current: saved, defaults, presets });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Invalid prompt config' });
      }
    });
    
    app.post('/prompts/reset', (req, res) => {
      try {
        const saved = persistPromptConfig(loadPromptDefaultsRaw());
        emitEvent('log:append', { source: 'prompt', message: '[prompt] config reset' });
        const defaults = loadPromptDefaults();
        const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
        return res.json({ current: saved, defaults, presets });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Reset failed' });
      }
    });
    
    app.post('/prompts/presets', (req, res) => {
      try {
        const name = normalizePresetName(req.body?.name);
        if (!name) return res.status(400).json({ error: 'Invalid preset name' });
        const config = normalizePromptConfig(req.body?.config ?? loadPromptConfig());
        const existing = loadPromptPresets().filter((item) => item && typeof item === 'object');
        const savedAt = new Date().toISOString();
        const next = existing.filter((p) => String(p?.name || '') !== name);
        next.unshift({ name, savedAt, config });
        if (next.length > 30) next.length = 30;
        persistPromptPresets(next);
        emitEvent('log:append', {
          source: 'prompt',
          message: `[prompt] preset saved: ${name}`,
        });
        const current = loadPromptConfig();
        const defaults = loadPromptDefaults();
        return res.json({ current, defaults, presets: next });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Preset save failed' });
      }
    });
    
    app.post('/prompts/presets/apply', (req, res) => {
      try {
        const name = normalizePresetName(req.body?.name);
        if (!name) return res.status(400).json({ error: 'Invalid preset name' });
        const presets = loadPromptPresets().filter((item) => item && typeof item === 'object');
        const hit = presets.find((p) => String(p?.name || '') === name);
        if (!hit) return res.status(404).json({ error: 'Preset not found' });
        const saved = persistPromptConfig(hit.config);
        emitEvent('log:append', {
          source: 'prompt',
          message: `[prompt] preset applied: ${name}`,
        });
        const defaults = loadPromptDefaults();
        return res.json({ current: saved, defaults, presets });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Preset apply failed' });
      }
    });
    
    app.get('/state', (req, res) => {
      res.json({
        status: state.status,
        tasks: state.tasks,
        lastDiff: state.lastDiff,
        approvals: Object.values(state.approvals),
        testReport: state.testReport,
        logs: state.logs,
      });
    });
    
    app.get('/specs', (req, res) => {
      res.json({ specs: listSpecs() });
    });
    
    app.post('/specs', async (req, res) => {
      const prompt = normalizePrompt(req.body?.prompt);
      let specName = sanitizeSpecName(req.body?.name);
      const wantsStream = isNdjsonStreamRequest(req);
    
      if (wantsStream) {
        const stream = createNdjsonStream(res);
        if (!specName) {
          if (!prompt) {
            stream.write({ type: 'error', error: 'Invalid spec name', status: 400 });
            stream.end();
            return;
          }
          specName = generateSpecName(prompt);
        }
        stream.write({ type: 'meta', action: 'spec:create', specName });
        try {
          await createSpecTemplates(specName, ['requirements'], prompt, {
            onStage: (stage, state) => stream.write({ type: 'stage', stage, state }),
            onLlmToken: (stage, delta) => stream.write({ type: 'delta', stage, delta }),
          });
        } catch (error) {
          console.error('Spec generation failed:', error?.message || error);
          stream.write({
            type: 'error',
            error: error?.message || 'Spec generation failed',
            context: error?.llmContext || null,
            status: 502,
          });
          stream.end();
          return;
        }
        emitEvent('log:append', {
          source: 'spec',
          message: `[spec] created ${specName}`,
        });
        stream.write({ type: 'result', data: { name: specName } });
        stream.end();
        return;
      }
    
      if (!specName) {
        if (!prompt) {
          return res.status(400).json({ error: 'Invalid spec name' });
        }
        specName = generateSpecName(prompt);
      }
      try {
        await createSpecTemplates(specName, ['requirements'], prompt);
      } catch (error) {
        console.error('Spec generation failed:', error?.message || error);
        return res.status(502).json({ error: error?.message || 'Spec generation failed' });
      }
      emitEvent('log:append', {
        source: 'spec',
        message: `[spec] created ${specName}`,
      });
      return res.json({ name: specName });
    });
    
    app.get('/specs/:name/reports', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      const runs = listFlowRuns(specName);
      const reports = runs.map((run) => {
        const runId = String(run?.runId || '');
        const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
        const userRatings = Array.isArray(run?.userRatings) ? run.userRatings : [];
        const reportPath =
          run?.report && typeof run.report === 'object' ? run.report.path || null : null;
        const job = runId ? getReportScoreJob(specName, runId) : null;
        return {
          runId,
          createdAt: run?.createdAt || null,
          updatedAt: run?.updatedAt || null,
          reportPath,
          ratings: {
            updatedAt: ratings?.updatedAt || null,
            byModel:
              ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {},
          },
          userRatings,
          scoreJob: job ? getReportScoreStatus(job) : null,
        };
      });
      return res.json({ reports });
    });
    
    app.get('/specs/:name/reports/:runId', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const run = readFlowRun(specName, runId);
      if (!run) {
        return res.status(404).json({ error: 'Report run not found' });
      }
      const ratings = run?.ratings && typeof run.ratings === 'object' ? run.ratings : {};
      const userRatings = Array.isArray(run?.userRatings) ? run.userRatings : [];
      const reportPath =
        run?.report && typeof run.report === 'object' ? run.report.path || null : null;
      const job = getReportScoreJob(specName, runId);
      return res.json({
        runId,
        createdAt: run?.createdAt || null,
        updatedAt: run?.updatedAt || null,
        reportPath,
        ratings: {
          updatedAt: ratings?.updatedAt || null,
          byModel: ratings?.byModel && typeof ratings.byModel === 'object' ? ratings.byModel : {},
        },
        userRatings,
        scoreJob: job ? getReportScoreStatus(job) : null,
      });
    });
    
    app.get('/specs/:name/reports/:runId/markdown', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const run = readFlowRun(specName, runId);
      if (!run) {
        return res.status(404).json({ error: 'Report run not found' });
      }
      try {
        const reportPath = refreshFlowReport(specName, runId) || null;
        if (!reportPath || !fs.existsSync(reportPath)) {
          return res.status(404).json({ error: 'Report file not found' });
        }
        const content = fs.readFileSync(reportPath, 'utf8');
        return res.json({ reportPath, content });
      } catch (error) {
        const message = truncateText(error?.message || String(error || ''), 240);
        return res.status(500).json({ error: `Failed to read report: ${message}` });
      }
    });
    
    app.get('/specs/:name/reports/:runId/score', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const job = getReportScoreJob(specName, runId);
      if (!job) {
        return res.json({
          running: false,
          total: 0,
          completed: 0,
          logs: [],
          error: null,
          startedAt: null,
          updatedAt: null,
        });
      }
      return res.json(getReportScoreStatus(job));
    });
    
    app.post('/specs/:name/reports/:runId/score', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const run = readFlowRun(specName, runId);
      if (!run) {
        return res.status(404).json({ error: 'Report run not found' });
      }
      const force = req.body?.force === true;
      const job = startReportScoreJob(specName, runId, { force, resetLogs: true });
      if (!job) {
        return res.status(500).json({ error: 'Failed to start score job' });
      }
      return res.json(getReportScoreStatus(job));
    });
    
    app.post('/specs/:name/reports/:runId/user-score', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const run = readFlowRun(specName, runId);
      if (!run) {
        return res.status(404).json({ error: 'Report run not found' });
      }
      const score = Number(req.body?.score);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        return res.status(400).json({ error: 'score must be between 0 and 100' });
      }
      const comment = sanitizeReviewText(req.body?.comment, 400);
      const record = {
        score: Math.round(score),
        comment,
        createdAt: new Date().toISOString(),
      };
      const nextUserRatings = Array.isArray(run.userRatings) ? [...run.userRatings] : [];
      nextUserRatings.push(record);
      const now = new Date().toISOString();
      writeFlowRun(specName, { ...run, updatedAt: now, userRatings: nextUserRatings });
      refreshFlowReport(specName, runId);
      return res.json({ ok: true, userRatings: nextUserRatings });
    });
    
    app.get('/specs/:name/reports/:runId/tasks-iterate', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const job = getTasksIterateJob(specName, runId);
      if (!job) {
        return res.json({
          running: false,
          total: 1,
          completed: 0,
          logs: [],
          error: null,
          startedAt: null,
          updatedAt: null,
          outputRunId: null,
          outputReportPath: null,
        });
      }
      return res.json(getTasksIterateStatus(job));
    });
    
    app.post('/specs/:name/reports/:runId/tasks-iterate', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const runId = sanitizeRunId(req.params.runId);
      if (!specName || !runId) {
        return res.status(400).json({ error: 'Invalid report request' });
      }
      const run = readFlowRun(specName, runId);
      if (!run) {
        return res.status(404).json({ error: 'Report run not found' });
      }
      const userNote = sanitizeReviewText(
        req.body?.userNote ?? req.body?.iterateUserNote ?? req.body?.note,
        1800,
      );
      const job = startTasksIterateJob(specName, runId, { userNote, resetLogs: true });
      if (!job) {
        return res.status(500).json({ error: 'Failed to start iterate job' });
      }
      return res.json(getTasksIterateStatus(job));
    });

    const ensureTasksContentHasFinalSummaryTask = (markdown) => {
      const raw = typeof markdown === 'string' ? markdown : '';
      if (!raw.trim()) return raw;
      const lines = raw.replace(/\r\n/g, '\n').split('\n');
      const findMarker = (marker) =>
        lines.findIndex((line) => String(line || '').trim().toUpperCase() === marker);

      const start = findMarker('## TASKS_JSON');
      if (start < 0) return raw;
      const endIdx = lines.findIndex(
        (line, idx) =>
          idx > start && String(line || '').trim().toUpperCase() === '## END_TASKS_JSON',
      );
      const end = endIdx > start ? endIdx : lines.length;

      const blockLines = lines.slice(start + 1, end);
      if (!blockLines.length) return raw;

      const first = String(blockLines[0] || '').trim();
      const last = String(blockLines[blockLines.length - 1] || '').trim();
      const hasOpenFence = first.startsWith('```');
      const hasCloseFence = last.startsWith('```');
      const begin = hasOpenFence ? 1 : 0;
      const finish = hasCloseFence ? blockLines.length - 1 : blockLines.length;
      const jsonText = blockLines.slice(begin, finish).join('\n').trim();
      if (!jsonText) return raw;

      let payload = null;
      try {
        payload = JSON.parse(jsonText);
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tasks)) return raw;
      const rawTasks = Array.isArray(payload.tasks) ? payload.tasks.slice() : [];
      if (!rawTasks.length) return raw;

      const looksLikeSummaryTask = (task) => {
        const title = String(task?.title || '').trim();
        const description = String(task?.description || '').trim();
        const text = `${title} ${description}`.trim();
        if (!text) return false;
        // 避免把普通任务里的“验收点/验收标准”等误判为收尾任务。
        return /(总结|收尾|回归(验证|测试)|最终(修复|调试|回归|验收|检查)|final(\s+(check|qa))?|post[-\s]?check|regression(\s+test)?)/i.test(
          text,
        );
      };

      let summary = null;
      for (let i = rawTasks.length - 1; i >= 0; i -= 1) {
        if (!looksLikeSummaryTask(rawTasks[i])) continue;
        summary = rawTasks[i];
        rawTasks.splice(i, 1);
        break;
      }

      const baseTasks = rawTasks;
      const baseIds = baseTasks
        .map((t) => String(t?.id || '').trim())
        .filter(Boolean);

      const defaultTitle = '最终修复与调试（收尾）';
      const defaultDescription =
        '输入：已完成的各模块交付物；输出：最终回归验证、修复残留问题、补齐必要日志/说明；验收：关键构建/健康检查通过，主要链路无明显异常。';

      const ensureUniqueTaskId = (preferred) => {
        const baseId = String(preferred || '').trim() || `task_${baseIds.length + 1}`;
        let id = baseId;
        let suffix = 2;
        while (baseIds.includes(id)) {
          id = `${baseId}_${suffix++}`;
        }
        return id;
      };

      if (!summary) {
        summary = {
          id: ensureUniqueTaskId(`task_${baseIds.length + 1}`),
          title: defaultTitle,
          description: defaultDescription,
          dependencies: baseIds,
          scope: [],
          estimated_complexity: 'Medium',
        };
      } else {
        summary = {
          ...summary,
          id: ensureUniqueTaskId(summary.id),
          title: String(summary?.title || '').trim() || defaultTitle,
          description: String(summary?.description || '').trim() || defaultDescription,
          dependencies: baseIds,
        };
      }

      const nextPayload = { ...payload, tasks: [...baseTasks, summary] };
      const jsonLines = JSON.stringify(nextPayload, null, 2).split('\n');

      const nextLines = [];
      nextLines.push(...lines.slice(0, start + 1));
      if (hasOpenFence) nextLines.push(blockLines[0]);
      nextLines.push(...jsonLines);
      if (hasCloseFence) nextLines.push(blockLines[blockLines.length - 1]);
      nextLines.push(...lines.slice(end));

      return nextLines.join('\n');
    };

    app.get('/specs/:name/:artifact', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const artifact = req.params.artifact;
      if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      const filePath = resolveSpecFile(specName, artifact);
      if (!fs.existsSync(filePath)) {
        const status = readSpecStatus(specName);
        if (artifact === 'design' && status?.requirementsConfirmed) {
          return res.status(409).json({
            error: 'Design file missing while requirements confirmed',
            specName,
            artifact,
          });
        }
        if (artifact === 'tasks' && status?.designConfirmed) {
          return res.status(409).json({
            error: 'Tasks file missing while design confirmed',
            specName,
            artifact,
          });
        }
      }
      if (!fs.existsSync(filePath)) {
        ensureSpecTemplate(specName, artifact);
      }
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Spec file not found' });
      }
      let content = fs.readFileSync(filePath, 'utf8');
      if (artifact === 'requirements' && !content.includes('## 原始需求')) {
        const status = readSpecStatus(specName);
        if (status.prompt) {
          const rawPrompt = normalizePrompt(status.prompt) || '（未提供原始需求）';
          const injected = `# 需求（requirements）\n\n## 原始需求\n${rawPrompt}\n`;
          const tail = content.replace(/^# 需求（requirements）\s*/m, '').trim();
          content = `${injected}\n\n${tail}`.trimEnd();
          writeSpecFile(specName, 'requirements', content);
        }
      }
      if (artifact === 'requirements') {
        const status = readSpecStatus(specName);
        ensureRequirementsReviewSeeded(specName, status, content);
        ensureRequirementsClarificationsSeeded(specName, status, status.prompt);
      }
      if (artifact === 'design') {
        const status = readSpecStatus(specName);
        ensureTechStackClarificationsSeeded(specName, status, status.prompt, content);
      }
      if (artifact === 'tasks') {
        try {
          const next = ensureTasksContentHasFinalSummaryTask(content);
          if (typeof next === 'string' && next !== content) {
            content = next;
            writeSpecFile(specName, 'tasks', content);
            emitEvent('log:append', {
              source: 'spec',
              message: `[spec] injected final summary task into ${specName}/tasks`,
            });
          }
        } catch (error) {
          emitEvent('log:append', {
            source: 'spec',
            message: `[spec] tasks read post-process failed: ${error?.message || String(error)}`,
          });
        }
      }
      return res.json({ content });
    });
    
    app.post('/specs/:name/requirements/review', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      const status = readSpecStatus(specName);
      const nextReview = normalizeRequirementsReview(req.body || {});
      status.requirementsReview = {
        ...nextReview,
        updatedAt: new Date().toISOString(),
        confirmedAt: status.requirementsReview?.confirmedAt ?? null,
      };
      writeSpecStatus(specName, status);
      emitEvent('log:append', {
        source: 'spec',
        message: `[spec] saved ${specName}/requirements-review`,
      });
      return res.json({ ok: true, status });
    });
    
    app.post('/specs/:name/requirements/clarifications', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      let status = readSpecStatus(specName);
      const nextClarifications = normalizeRequirementsClarifications(req.body || {});
      status.requirementsClarifications = {
        ...nextClarifications,
        updatedAt: new Date().toISOString(),
        confirmedAt: status.requirementsClarifications?.confirmedAt ?? null,
      };
      writeSpecStatus(specName, status);
      emitEvent('log:append', {
        source: 'spec',
        message: `[spec] saved ${specName}/requirements-clarifications`,
      });
      return res.json({ ok: true, status });
    });
    
    app.post('/specs/:name/tech-stack/clarifications', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      const status = readSpecStatus(specName);
      const nextClarifications = normalizeRequirementsClarifications(req.body || {});
      status.techStackClarifications = {
        ...nextClarifications,
        updatedAt: new Date().toISOString(),
        confirmedAt: status.techStackClarifications?.confirmedAt ?? null,
      };
      writeSpecStatus(specName, status);
      emitEvent('log:append', {
        source: 'spec',
        message: `[spec] saved ${specName}/tech-stack-clarifications`,
      });
      return res.json({ ok: true, status });
    });
    
    app.post('/specs/:name/confirm', async (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const artifact = req.body?.artifact;
      const force = req.body?.force === true;
      const wantsStream = isNdjsonStreamRequest(req);
      const stream = wantsStream ? createNdjsonStream(res) : null;
      const respondError = (httpStatus, message, extra = null) => {
        const payload = { error: message };
        if (extra && typeof extra === 'object') Object.assign(payload, extra);
        if (stream) {
          stream.write({ type: 'error', status: httpStatus, ...payload });
          stream.end();
          return;
        }
        return res.status(httpStatus).json(payload);
      };
    
      if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
        return respondError(400, 'Invalid spec request');
      }
    
      stream?.write({ type: 'meta', action: 'spec:confirm', specName, artifact, force });
    
      let status = readSpecStatus(specName);
    
      if (artifact === 'requirements') {
        const incomingReview = req.body?.review || req.body?.requirementsReview || null;
        if (incomingReview) {
          status.requirementsReview = mergeRequirementsReview(status.requirementsReview, incomingReview);
        }
        const incomingClarifications =
          req.body?.clarifications || req.body?.requirementsClarifications || null;
        if (incomingClarifications) {
          status.requirementsClarifications = mergeRequirementsClarifications(
            status.requirementsClarifications,
            incomingClarifications,
          );
        }
        if (!areClarificationsComplete(status.requirementsClarifications)) {
          return respondError(409, 'Requirements clarifications incomplete');
        }
        const now = new Date().toISOString();
        status.requirementsReview = {
          ...normalizeRequirementsReview(status.requirementsReview || {}),
          updatedAt: now,
          confirmedAt: now,
        };
        status.requirementsClarifications = {
          ...normalizeRequirementsClarifications(status.requirementsClarifications || {}),
          updatedAt: now,
          confirmedAt: now,
        };
        const requirementsPath = resolveSpecFile(specName, 'requirements');
        let requirementsContent = fs.existsSync(requirementsPath)
          ? fs.readFileSync(requirementsPath, 'utf8')
          : '';
    
        const shouldGenerateRequirements = force || !status.requirementsConfirmed;
        if (shouldGenerateRequirements) {
          ensureActiveFlowRun(specName, status, { reason: 'confirm:requirements' });
          const clarificationsSummary = buildClarificationsSummary(status.requirementsClarifications);
          stream?.write({ type: 'stage', stage: 'requirements', state: 'start' });
          try {
            const generated = await generateRequirementsWithModel(status.prompt, {
              clarificationsSummary,
              onTelemetry: (attempt) =>
                appendFlowRunStageAttempt(specName, 'requirements', attempt, {
                  reason: 'confirm:requirements',
                }),
            });
            requirementsContent = upsertRequirementsClarificationsSection(
              generated,
              status.requirementsClarifications?.questions,
            );
            status.lastError = null;
          } catch (error) {
            recordSpecError(status, 'requirements', error, null);
            writeSpecStatus(specName, status);
            console.error('Requirements generation failed:', error?.message || error);
            return respondError(502, error?.message || 'Requirements generation failed', {
              stage: 'requirements',
              context: error?.llmContext || null,
            });
          }
          stream?.write({ type: 'delta', stage: 'requirements', delta: requirementsContent });
          stream?.write({ type: 'stage', stage: 'requirements', state: 'end' });
          writeSpecFile(specName, 'requirements', requirementsContent);
          status = ensureRequirementsReviewSeeded(specName, status, requirementsContent).status;
        } else {
          requirementsContent = upsertRequirementsClarificationsSection(
            requirementsContent,
            status.requirementsClarifications?.questions,
          );
          if (requirementsContent.trim()) {
            writeSpecFile(specName, 'requirements', requirementsContent);
          }
        }
    
        status.requirementsConfirmed = true;
        const designPath = resolveSpecFile(specName, 'design');
        const shouldGenerate =
          force || !fs.existsSync(designPath) || fs.readFileSync(designPath, 'utf8').trim() === '';
        if (shouldGenerate) {
          try {
            ensureActiveFlowRun(specName, status, { reason: 'confirm:requirements' });
            const supplementalPrompt = [
              status.prompt,
              buildClarificationsSummary(status.requirementsClarifications),
              buildReviewSummary(status.requirementsReview),
            ]
              .filter(Boolean)
              .join('\n\n');
            stream?.write({ type: 'stage', stage: 'design', state: 'start' });
            const content = await generateDesignWithModel(
              requirementsContent,
              supplementalPrompt,
              {
                onTelemetry: (attempt) =>
                  appendFlowRunStageAttempt(specName, 'design', attempt, {
                    reason: 'confirm:requirements',
                  }),
              },
            );
            stream?.write({ type: 'delta', stage: 'design', delta: content });
            stream?.write({ type: 'stage', stage: 'design', state: 'end' });
            writeSpecFile(specName, 'design', content);
            status.lastError = null;
    
          } catch (error) {
            recordSpecError(status, 'design', error, null);
            writeSpecStatus(specName, status);
            console.error('Design generation failed:', error?.message || error);
            return respondError(502, error?.message || 'Design generation failed', {
              stage: 'design',
              context: error?.llmContext || null,
            });
          }
        }
      }
    
      if (artifact === 'design') {
        if (!status.requirementsConfirmed) {
          return respondError(409, 'Requirements not confirmed');
        }
        const designPath = resolveSpecFile(specName, 'design');
        const designContent = fs.existsSync(designPath) ? fs.readFileSync(designPath, 'utf8') : '';
    
        const normalizedCategory = normalizeProjectCategoryValue(status.projectCategory);
        const projectCategoryMeta =
          status.projectCategoryMeta && typeof status.projectCategoryMeta === 'object'
            ? status.projectCategoryMeta
            : null;
        const projectCategoryMetaSource =
          projectCategoryMeta && typeof projectCategoryMeta.source === 'string'
            ? projectCategoryMeta.source
            : '';
        const hasLlmProjectCategoryMeta = projectCategoryMetaSource === 'llm';
        const shouldInferProjectCategory =
          Boolean(status.prompt) && (!normalizedCategory || !hasLlmProjectCategoryMeta);
    
        if (shouldInferProjectCategory) {
          try {
            ensureActiveFlowRun(specName, status, { reason: 'confirm:design' });
            const result = await inferProjectCategoryFromModel(status.prompt, {
              onTelemetry: (attempt) =>
                appendFlowRunStageAttempt(specName, attempt?.stageKey || 'projectCategory', attempt, {
                  reason: 'confirm:design',
                }),
            });
            const decided = result?.projectCategory || inferProjectCategoryFromPrompt(status.prompt);
            const now = new Date().toISOString();
            status.projectCategory = decided;
            status.projectCategoryMeta = { ...result, judgedAt: now, source: 'llm' };
            status.techStackConfirmed = decided === 'non_software' ? true : status.techStackConfirmed;
          } catch {
            const decided = inferProjectCategoryFromPrompt(status.prompt);
            const now = new Date().toISOString();
            status.projectCategory = decided;
            status.projectCategoryMeta = {
              projectCategory: decided,
              confidence: null,
              reason: '',
              judgedAt: now,
              source: 'heuristic',
            };
            status.techStackConfirmed = decided === 'non_software' ? true : status.techStackConfirmed;
          }
          writeSpecStatus(specName, status);
        } else if (normalizedCategory && normalizedCategory !== status.projectCategory) {
          status.projectCategory = normalizedCategory;
          writeSpecStatus(specName, status);
        }
    
        const skipTechStack = req.body?.skipTechStack === true || status.projectCategory === 'non_software';
    
        if (!skipTechStack) {
          // Ensure tech stack confirmation questions exist before generating tasks.
          status = ensureTechStackClarificationsSeeded(
            specName,
            status,
            status.prompt,
            designContent,
          ).status;
    
          const incomingTechStackClarifications =
            req.body?.techStackClarifications || req.body?.techStack || null;
          if (incomingTechStackClarifications) {
            status.techStackClarifications = mergeRequirementsClarifications(
              status.techStackClarifications,
              incomingTechStackClarifications,
            );
          }
    
          if (!areClarificationsComplete(status.techStackClarifications)) {
            writeSpecStatus(specName, status);
            return respondError(409, 'Tech stack clarifications incomplete');
          }
    
          const now = new Date().toISOString();
          status.techStackClarifications = {
            ...normalizeRequirementsClarifications(status.techStackClarifications || {}),
            updatedAt: now,
            confirmedAt: now,
          };
          status.techStackConfirmed = true;
          status.designConfirmed = true;
          const tasksPath = resolveSpecFile(specName, 'tasks');
          const shouldGenerate =
            force || !fs.existsSync(tasksPath) || fs.readFileSync(tasksPath, 'utf8').trim() === '';
          if (shouldGenerate) {
            ensureActiveFlowRun(specName, status, { reason: 'confirm:design' });
            const supplementalPrompt = [
              status.prompt,
              buildTechStackSummary(status.techStackClarifications),
            ]
              .filter(Boolean)
              .join('\n\n');
            stream?.write({ type: 'stage', stage: 'tasks', state: 'start' });
            let content = '';
            try {
              content = await generateTasksWithModel(
                designContent,
                supplementalPrompt,
                {
                  onTelemetry: (attempt) =>
                    appendFlowRunStageAttempt(specName, 'tasks', attempt, {
                      reason: 'confirm:design',
                    }),
                },
              );
            } catch (error) {
              recordSpecError(status, 'tasks', error, null);
              writeSpecStatus(specName, status);
              console.error('Tasks generation failed:', error?.message || error);
              return respondError(502, error?.message || 'Tasks generation failed', {
                stage: 'tasks',
                context: error?.llmContext || null,
              });
            }
            stream?.write({ type: 'delta', stage: 'tasks', delta: content });
            stream?.write({ type: 'stage', stage: 'tasks', state: 'end' });
            writeSpecFile(specName, 'tasks', content);
            status.lastError = null;
          }
        } else {
          const now = new Date().toISOString();
          status.projectCategory = normalizeProjectCategoryValue(status.projectCategory) || resolveProjectCategory(status);
          status.techStackConfirmed = true;
          status.designConfirmed = true;
          status.techStackClarifications = {
            ...normalizeRequirementsClarifications(status.techStackClarifications || {}),
            questions: [],
            updatedAt: now,
            confirmedAt: status.techStackClarifications?.confirmedAt ?? now,
            generatedBy: status.techStackClarifications?.generatedBy ?? 'skip',
            generationError: null,
          };
    
          const tasksPath = resolveSpecFile(specName, 'tasks');
          const shouldGenerate =
            force || !fs.existsSync(tasksPath) || fs.readFileSync(tasksPath, 'utf8').trim() === '';
    
          if (shouldGenerate) {
            ensureActiveFlowRun(specName, status, { reason: 'confirm:design' });
            const supplementalPrompt = [
              status.prompt,
              '说明：该需求被识别为非软件项目，跳过“技术栈确认”等软件工程专属设定；不要输出前端/后端/数据库/API/代码实现类内容。请以文档/流程/交付物为主进行任务拆解，并给出可验证的验收方式。',
            ]
              .filter(Boolean)
              .join('\n\n');
            stream?.write({ type: 'stage', stage: 'tasks', state: 'start' });
            let content = '';
            try {
              content = await generateTasksWithModel(
                designContent,
                supplementalPrompt,
                {
                  onTelemetry: (attempt) =>
                    appendFlowRunStageAttempt(specName, 'tasks', attempt, {
                      reason: 'confirm:design',
                    }),
                },
              );
            } catch (error) {
              recordSpecError(status, 'tasks', error, null);
              writeSpecStatus(specName, status);
              console.error('Tasks generation failed:', error?.message || error);
              return respondError(502, error?.message || 'Tasks generation failed', {
                stage: 'tasks',
                context: error?.llmContext || null,
              });
            }
            stream?.write({ type: 'delta', stage: 'tasks', delta: content });
            stream?.write({ type: 'stage', stage: 'tasks', state: 'end' });
            writeSpecFile(specName, 'tasks', content);
            status.lastError = null;
          }
        }
      }
    
      if (artifact === 'tasks') {
        if (!status.designConfirmed) {
          return respondError(409, 'Design not confirmed');
        }
        status.tasksConfirmed = true;
      }
    
      writeSpecStatus(specName, status);
      emitEvent('log:append', {
        source: 'spec',
        message: `[spec] confirmed ${specName}/${artifact}`,
      });
      if (stream) {
        stream.write({ type: 'result', data: { ok: true, status } });
        stream.end();
        return;
      }
      return res.json({ ok: true, status });
    });
    
    app.get('/specs/:name/tasks/atomize', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      const job = atomizeJobs.get(specName);
      if (!job) {
        return res.json({ running: false, total: 0, completed: 0, logs: [] });
      }
      return res.json(getAtomizeStatus(job));
    });
    
    app.post('/specs/:name/tasks/atomize', async (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
    
      const existing = atomizeJobs.get(specName);
      if (existing && existing.running) {
        return res.json(getAtomizeStatus(existing));
      }
    
      const batchSize = normalizeAtomizeBatchSize(
        req.body?.batchSize ?? req.body?.segmentSize ?? req.query?.batchSize,
      );
    
      const resetAtomic = req.body?.resetAtomic === true || req.body?.reset === true;
      const iterateFromRunId = sanitizeRunId(
        req.body?.iterateFromRunId ?? req.body?.fromReportRunId ?? req.body?.reportRunId,
      );
      const iterateUserNote = sanitizeReviewText(
        req.body?.iterateUserNote ?? req.body?.userNote ?? req.body?.note,
        1800,
      );
    
      let iterationReason = '';
      let flowRunReason = 'atomize';
      let forceNewFlowRun = false;
      if (iterateFromRunId) {
        const baseRun = readFlowRun(specName, iterateFromRunId);
        iterationReason = baseRun
          ? buildAtomizeIterationReasonFromReport(baseRun, iterateUserNote)
          : iterateUserNote
            ? `用户补充修改意见：\n${iterateUserNote}`
            : '';
        flowRunReason = `atomize_iterate_from:${iterateFromRunId}`;
        forceNewFlowRun = true;
      } else if (iterateUserNote) {
        iterationReason = `用户补充修改意见：\n${iterateUserNote}`;
        flowRunReason = 'atomize_iterate';
        forceNewFlowRun = true;
      }
      if (resetAtomic && !forceNewFlowRun) {
        flowRunReason = 'atomize_reset';
        forceNewFlowRun = true;
      }
    
      const now = new Date().toISOString();
      const job = existing || {
        specName,
        running: false,
        total: 0,
        completed: 0,
        logs: [],
        error: null,
        startedAt: now,
        updatedAt: now,
      };
      job.running = true;
      job.error = null;
      job.startedAt = now;
      job.updatedAt = now;
      if (resetAtomic || iterateFromRunId || iterateUserNote) job.logs = [];
      atomizeJobs.set(specName, job);
      logAtomize(
        job,
        [
          `原子化任务已启动${batchSize ? `（分段：${batchSize} 条）` : '（分段：默认）'}`,
          resetAtomic ? '重置 tasks_atomic' : null,
          iterateFromRunId ? `迭代自评分报告 ${iterateFromRunId}` : null,
        ]
          .filter(Boolean)
          .join('｜'),
      );
    
      setImmediate(() => {
        runAtomizeJob(specName, job, {
          batchSize,
          resetAtomic,
          forceNewFlowRun,
          flowRunReason,
          iterationReason,
        });
      });
    
      return res.json(getAtomizeStatus(job));
    });
    
    function buildCodexRunDoc(specName, atomicTask, options = {}) {
      const runsDir = path.join(resolveSpecDir(specName), '.runlogs', 'codex-runs');
      fs.mkdirSync(runsDir, { recursive: true });
    
      const taskId = atomicTask?.id || 'unknown';
      const safeTaskId = String(taskId).replace(/[^\d.]/g, '').replace(/\./g, '_') || 'unknown';
      const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z');
      const runDocPath = path.join(runsDir, `task-${safeTaskId}-${stamp}.md`);
      const lastMessagePath = path.join(runsDir, `last-message-${safeTaskId}-${stamp}.md`);
    
      const rel = (absPath) => normalizePathForPrompt(path.relative(REPO_DIR, absPath));
      const artifacts = {
        requirements: resolveSpecFile(specName, 'requirements'),
        design: resolveSpecFile(specName, 'design'),
        tasks: resolveSpecFile(specName, 'tasks'),
        tasks_atomic: resolveSpecFile(specName, 'tasks_atomic'),
      };
    
      const lines = [];
      lines.push(`# Codex 任务执行文档`);
      lines.push('');
      lines.push(`- Spec: ${specName}`);
      lines.push(`- Task: ${taskId}`);
      lines.push(`- StartedAt: ${new Date().toISOString()}`);
      if (options.model) lines.push(`- Model: ${options.model}`);
      if (options.sandbox) lines.push(`- Sandbox: ${options.sandbox}`);
      lines.push('');
      lines.push('## Spec 入口');
      lines.push(`- requirements: \`${normalizePathForPrompt(artifacts.requirements)}\``);
      lines.push(`- design: \`${normalizePathForPrompt(artifacts.design)}\``);
      lines.push(`- tasks: \`${normalizePathForPrompt(artifacts.tasks)}\``);
      lines.push(`- tasks_atomic: \`${normalizePathForPrompt(artifacts.tasks_atomic)}\``);
      lines.push('');
      lines.push('## 本次原子任务');
      if (atomicTask?.block) {
        lines.push('');
        lines.push('```markdown');
        lines.push(String(atomicTask.block).trimEnd());
        lines.push('```');
      } else {
        lines.push('');
        lines.push(`- title: ${atomicTask?.title || ''}`);
        lines.push(`- 核心逻辑: ${atomicTask?.core || ''}`);
        lines.push(`- 技术细节: ${atomicTask?.details || ''}`);
        const depends = Array.isArray(atomicTask?.depends)
          ? atomicTask.depends.map((v) => String(v || '').trim()).filter(Boolean).join('；')
          : atomicTask?.depends
            ? String(atomicTask.depends)
            : '';
        lines.push(`- 依赖: ${depends}`);
        lines.push(`- 验收准则: ${atomicTask?.ac || ''}`);
      }
      lines.push('');
      lines.push('## 执行要求');
      lines.push('- 严格按“本次原子任务”的 title/core/details/ac 实现。');
      lines.push('- 若需要新增/修改文件，遵循仓库既有风格与约束。');
      lines.push('- 完成后运行 AC 中描述的验证步骤（若 AC 未给出命令，请补充最小可行验证）。');
      lines.push('- 可选：将 tasks_atomic.md 中对应条目标记为 [x]，并在 tasks.md 回写关键变更摘要。');
      lines.push('');
    
      fs.writeFileSync(runDocPath, lines.join('\n'), 'utf8');
      return {
        runDocPath,
        lastMessagePath,
        runDocPathRel: rel(runDocPath),
        lastMessagePathRel: rel(lastMessagePath),
        artifacts,
      };
    }
    
    app.post('/specs/:name/tasks_atomic/prompt', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      if (state.status === 'Reviewing') {
        return res.status(409).json({ error: 'Blocked by approval' });
      }
    
      const taskId = sanitizeAtomicTaskId(req.body?.taskId ?? req.body?.id ?? req.query?.taskId);
      if (!taskId) {
        return res.status(400).json({ error: 'taskId is required (e.g. 1.2)' });
      }
    
      const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
      if (!fs.existsSync(atomicPath)) {
        return res.status(404).json({ error: 'Spec file not found' });
      }
    
      const content = fs.readFileSync(atomicPath, 'utf8');
      const atomicTasks = parseTasksAtomicMarkdown(content);
      const hit = atomicTasks.find((t) => String(t?.id || '').trim() === taskId);
      if (!hit) {
        return res.status(404).json({ error: `Atomic task not found: ${taskId}` });
      }
    
      const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
      const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
      const projectDir = normalizeTerminalCwd(
        req.body?.cwd ??
          req.body?.projectDir ??
          (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
          (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
      );
    
      const doc = buildCodexRunDoc(specName, hit, { sandbox, model });
      const runDocPathForPrompt = normalizePathForPrompt(doc.runDocPath);
      const projectDirForPrompt = normalizePathForPrompt(projectDir);
      const prompt = [
        `请按任务文档（绝对路径）${runDocPathForPrompt} 实现该原子任务，完成后自检并用简短要点总结变更与验证结果。`,
        projectDirForPrompt ? `建议工作目录：${projectDirForPrompt}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    
      return res.json({
        ok: true,
        prompt,
        runDocPath: doc.runDocPathRel,
        runDocPathAbs: runDocPathForPrompt,
        task: {
          id: hit.id,
          done: Boolean(hit.done),
          title: hit.title,
          core: hit.core,
          details: hit.details,
          depends: Array.isArray(hit.depends) ? hit.depends : [],
          ac: hit.ac,
          originalIndex: hit.originalIndex,
          originalTitle: hit.originalTitle,
        },
      });
    });
    
    app.post('/specs/:name/tasks_atomic/codex', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      if (state.status === 'Reviewing') {
        return res.status(409).json({ error: 'Blocked by approval' });
      }
    
      const taskId = sanitizeAtomicTaskId(req.body?.taskId ?? req.body?.id ?? req.query?.taskId);
      if (!taskId) {
        return res.status(400).json({ error: 'taskId is required (e.g. 1.2)' });
      }
    
      const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
      if (!fs.existsSync(atomicPath)) {
        return res.status(404).json({ error: 'Spec file not found' });
      }
    
      const content = fs.readFileSync(atomicPath, 'utf8');
      const atomicTasks = parseTasksAtomicMarkdown(content);
      const hit = atomicTasks.find((t) => String(t?.id || '').trim() === taskId);
      if (!hit) {
        return res.status(404).json({ error: `Atomic task not found: ${taskId}` });
      }
    
      const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
      const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
      const projectDir = normalizeTerminalCwd(
        req.body?.cwd ??
          req.body?.projectDir ??
          (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
          (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
      );
    
      const doc = buildCodexRunDoc(specName, hit, { sandbox, model });
      const runDocPathForPrompt = normalizePathForPrompt(doc.runDocPath);
      const prompt = `请按任务文档（绝对路径）${runDocPathForPrompt} 实现该原子任务，完成后自检并用简短要点总结变更与验证结果。`;
    
      const codexExecutable = (process.env.CODEX_COMMAND || 'codex').trim() || 'codex';
      const codexArgs = ['-a', 'never', '-s', sandbox];
      if (model) codexArgs.push('-m', model);
      codexArgs.push(
        '-C',
        projectDir,
        'exec',
        '--add-dir',
        SPEC_ROOT,
        '--output-last-message',
        doc.lastMessagePath,
        prompt,
      );
    
      const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : codexExecutable;
      const spawnArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', codexExecutable, ...codexArgs]
        : codexArgs;
    
      emitEvent('log:append', {
        source: 'codex',
        message: `[codex] start spec=${specName} task=${taskId} sandbox=${sandbox}${model ? ` model=${model}` : ''}`,
      });
    
      let pid;
      try {
        pid = startPty(spawnCommand, spawnArgs, { cwd: projectDir });
      } catch (error) {
        emitEvent('log:append', {
          source: 'codex',
          message: `[codex] spawn failed: ${error?.message || String(error)}`,
        });
        return res.status(500).json({ error: error?.message || 'Failed to start Codex' });
      }
      return res.json({
        pid,
        runDocPath: doc.runDocPathRel,
        lastMessagePath: doc.lastMessagePathRel,
        task: {
          id: hit.id,
          done: Boolean(hit.done),
          title: hit.title,
          core: hit.core,
          details: hit.details,
          depends: Array.isArray(hit.depends) ? hit.depends : [],
          ac: hit.ac,
          originalIndex: hit.originalIndex,
          originalTitle: hit.originalTitle,
        },
      });
    });
    
    app.post('/specs/:name/tasks_atomic/codex/terminal', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      if (!specName) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      if (state.status === 'Reviewing') {
        return res.status(409).json({ error: 'Blocked by approval' });
      }
    
      const taskId = sanitizeAtomicTaskId(req.body?.taskId ?? req.body?.id ?? req.query?.taskId);
      if (!taskId) {
        return res.status(400).json({ error: 'taskId is required (e.g. 1.2)' });
      }
    
      const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
      if (!fs.existsSync(atomicPath)) {
        return res.status(404).json({ error: 'Spec file not found' });
      }
    
      const content = fs.readFileSync(atomicPath, 'utf8');
      const atomicTasks = parseTasksAtomicMarkdown(content);
      const hit = atomicTasks.find((t) => String(t?.id || '').trim() === taskId);
      if (!hit) {
        return res.status(404).json({ error: `Atomic task not found: ${taskId}` });
      }
    
      const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
      const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
      const projectDir = normalizeTerminalCwd(
        req.body?.cwd ??
          req.body?.projectDir ??
          (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
          (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
      );
    
      const doc = buildCodexRunDoc(specName, hit, { sandbox, model });
      const runDocPathForPrompt = normalizePathForPrompt(doc.runDocPath);
      const prompt = `请按任务文档（绝对路径）${runDocPathForPrompt} 实现该原子任务。需要进一步信息时，请在终端中直接向我提问。`;
    
      const codexExecutable = (process.env.CODEX_COMMAND || 'codex').trim() || 'codex';
      const codexArgs = ['-a', 'never', '-s', sandbox, '--add-dir', SPEC_ROOT];
      if (model) codexArgs.push('-m', model);
      codexArgs.push('-C', projectDir, prompt);
    
      const spawnCommand = process.platform === 'win32' ? 'cmd.exe' : codexExecutable;
      const spawnArgs = process.platform === 'win32'
        ? ['/d', '/s', '/c', codexExecutable, ...codexArgs]
        : codexArgs;
    
      let session;
      try {
        session = createTerminalSession({
          title: `Codex · ${specName} · Task ${taskId}`,
          command: spawnCommand,
          args: spawnArgs,
          cwd: projectDir,
          cols: req.body?.cols,
          rows: req.body?.rows,
        });
      } catch (error) {
        return res.status(error?.status || 500).json({ error: error?.message || 'Failed to start terminal' });
      }
    
      return res.json({
        terminalId: session.id,
        pid: session.pid,
        title: session.title,
        runDocPath: doc.runDocPathRel,
        task: {
          id: hit.id,
          done: Boolean(hit.done),
          title: hit.title,
          core: hit.core,
          details: hit.details,
          depends: Array.isArray(hit.depends) ? hit.depends : [],
          ac: hit.ac,
          originalIndex: hit.originalIndex,
          originalTitle: hit.originalTitle,
        },
      });
    });
    
    app.post('/specs/:name/:artifact', (req, res) => {
      const specName = sanitizeSpecName(req.params.name);
      const artifact = req.params.artifact;
      if (!specName || !SPEC_ARTIFACTS.includes(artifact)) {
        return res.status(400).json({ error: 'Invalid spec request' });
      }
      const status = readSpecStatus(specName);
      if (artifact === 'design' && !status.requirementsConfirmed) {
        return res.status(409).json({ error: 'Requirements not confirmed' });
      }
      if (artifact === 'tasks' && !status.designConfirmed) {
        return res.status(409).json({ error: 'Design not confirmed' });
      }
      ensureSpecStatus(specName);

      let content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (artifact === 'tasks') {
        try {
          content = ensureTasksContentHasFinalSummaryTask(content);
        } catch (error) {
          emitEvent('log:append', {
            source: 'spec',
            message: `[spec] tasks save post-process failed: ${error?.message || String(error)}`,
          });
        }
      }
      const filePath = resolveSpecFile(specName, artifact);
      fs.mkdirSync(resolveSpecDir(specName), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      emitEvent('log:append', {
        source: 'spec',
        message: `[spec] saved ${specName}/${artifact}`,
      });
      return res.json({ ok: true });
    });
    
    app.post('/events', (req, res) => {
      const { type, payload } = req.body || {};
      if (!type) {
        return res.status(400).json({ error: 'type is required' });
      }
      const event = emitEvent(type, payload ?? {});
      return res.json(event);
    });
    
    app.post('/cli/start', (req, res) => {
      const { command, args } = req.body || {};
      if (state.status === 'Reviewing') {
        return res.status(409).json({ error: 'Blocked by approval' });
      }
      const pid = startPty(command, args, { cwd: req.body?.cwd });
      res.json({ pid });
    });
    
    app.post('/cli/input', (req, res) => {
      const { input } = req.body || {};
      writeCliInput(input);
      res.json({ ok: true });
    });
  }
}

module.exports = { registerCoreRoutes };

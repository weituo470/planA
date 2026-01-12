const fs = require('fs');
const path = require('path');
const { normalizeCodexSandbox, normalizeCodexModel } = require('../lib/codex-options');
const {
  assertGitTopClean,
  createTaskWorktree,
  commitAllChanges,
  cleanupTaskWorktree,
  resolveCurrentBranch,
} = require('../lib/worktree-manager');

function registerMvp5Routes(app, ctx) {
  // NOTE: 临时用 with(ctx) 保持等价重构，后续可逐步迁移到 controllers/services。
  with (ctx) {
    // ========== MVP5: 智能任务编排 API ==========
    
    function normalizeCliAvailabilityForMvp5(value) {
      const obj = value && typeof value === 'object' ? value : {};
      return {
        codex: obj.codex !== false,
        claude: obj.claude !== false,
      };
    }
    
    function normalizeCliChoice(value) {
      return value === 'codex' || value === 'claude' ? value : null;
    }
    
    function normalizeMvp5PlanPayload(payload, taskIds, maxCliConcurrencyLimit) {
      const obj = payload && typeof payload === 'object' ? payload : null;
      if (!obj) return null;
    
      const rawMax =
        obj.maxCliConcurrency ?? obj.maxConcurrency ?? obj.concurrency ?? obj.max_concurrency ?? obj.max_cli_concurrency;
      const parsed = Number(rawMax);
      const maxCliConcurrency = Number.isFinite(parsed)
        ? Math.min(maxCliConcurrencyLimit, Math.max(1, Math.floor(parsed)))
        : maxCliConcurrencyLimit;
    
      const defaultCli = normalizeCliChoice(obj.defaultCli ?? obj.default_cli) || null;
    
      const overridesRaw = obj.cliOverrides ?? obj.cli_overrides ?? obj.cliAllocation ?? obj.cli_allocation ?? null;
      const overrides = overridesRaw && typeof overridesRaw === 'object' ? overridesRaw : {};
    
      const cliAllocation = {};
      for (const taskId of taskIds) {
        const overrideCli = normalizeCliChoice(overrides?.[taskId]);
        const chosen = overrideCli || defaultCli;
        if (chosen) cliAllocation[taskId] = chosen;
      }
    
      const rationaleRaw = obj.rationale ?? obj.reason ?? '';
      const rationale = typeof rationaleRaw === 'string' ? rationaleRaw.trim().slice(0, 800) : '';
    
      if (Object.keys(cliAllocation).length === 0) return null;
    
      return { maxCliConcurrency, cliAllocation, rationale };
    }
    
    function formatMvp5CliAvailability(value) {
      const availability = normalizeCliAvailabilityForMvp5(value);
      return `codex:${availability.codex ? 'on' : 'off'}, claude:${availability.claude ? 'on' : 'off'}`;
    }
    
    function formatMvp5TasksForPrompt(tasks) {
      const list = Array.isArray(tasks) ? tasks : [];
      return list
        .map((t) => {
          const id = String(t?.id || '').trim();
          if (!id) return null;
          const title = String(t?.title || '').trim().replace(/\s+/g, ' ').slice(0, 120);
          const risk = String(t?.riskLevel || '').trim() || '-';
          const interaction = t?.requiresInteraction ? 'yes' : 'no';
          return `- ${id}｜${title || '（无标题）'}｜${risk}｜${interaction}`;
        })
        .filter(Boolean)
        .join('\n');
    }
    
    function formatMvp5DependenciesForPrompt(dag, limit = 240) {
      const edges = Array.isArray(dag?.edges) ? dag.edges : [];
      const lines = [];
      for (const edge of edges) {
        if (lines.length >= limit) break;
        const from = String(edge?.from || '').trim();
        const to = String(edge?.to || '').trim();
        if (!from || !to) continue;
        const type = String(edge?.type || '').trim() || '-';
        const strength = String(edge?.strength || '').trim() || '-';
        lines.push(`- ${from} -> ${to}｜${type}｜${strength}`);
      }
      if (edges.length > lines.length) {
        lines.push(`- ...(共 ${edges.length} 条依赖，已截断显示前 ${lines.length} 条)`);
      }
      return lines.join('\n');
    }

    function extractAtomicPathTokenFromTitle(title) {
      const text = String(title || '').trim();
      const match = /^(创建|修改|删除)\s+(.+)$/.exec(text);
      if (!match) return null;
      const rest = String(match[2] || '').trim();
      if (!rest) return null;
      const firstToken = rest.split(/\s+/)[0] || '';
      const beforePipe = firstToken.split(/[｜|]/)[0] || '';
      const token = beforePipe.replace(/[：:，,。;；]+$/g, '').trim();
      return token || null;
    }

    function normalizeAtomicScopePath(value) {
      return String(value || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '')
        .replace(/\/$/, '');
    }

    function looksLikeCoarseScope(value) {
      const normalized = normalizeAtomicScopePath(value).toLowerCase();
      if (!normalized) return true;
      if (normalized === '.' || normalized === '/' || normalized === './') return true;
      const coarseRoots = new Set([
        'src',
        'dashboard',
        'bridge',
        'workflow',
        'docs',
        'task',
        'specs',
      ]);
      if (coarseRoots.has(normalized)) return true;
      const hasSlash = normalized.includes('/');
      const hasExt = /\.[a-z0-9]{1,8}$/i.test(normalized.split('/').pop() || '');
      if (!hasSlash && !hasExt) return true;
      return false;
    }

    function mergeTaskScopesPreferAtomic(existingScope, atomicFilePaths, limit = 32) {
      const existing = Array.isArray(existingScope)
        ? existingScope.map((v) => String(v ?? '').trim()).filter(Boolean)
        : [];
      const derived = Array.isArray(atomicFilePaths)
        ? atomicFilePaths.map((v) => String(v ?? '').trim()).filter(Boolean)
        : [];
      if (derived.length === 0) return existing.slice(0, limit);

      const existingCoarse = existing.length === 0 || existing.some((p) => looksLikeCoarseScope(p));

      const keepExisting = existingCoarse
        ? existing.filter((p) => {
            const normalized = normalizeAtomicScopePath(p);
            const base = normalized.split('/').pop() || '';
            return /\.[a-z0-9]{1,8}$/i.test(base);
          })
        : existing;

      const map = new Map();
      for (const item of [...keepExisting, ...derived]) {
        const normalized = normalizeScopePathForConflict(item);
        if (!normalized) continue;
        if (!map.has(normalized)) map.set(normalized, item);
        if (map.size >= limit) break;
      }
      return Array.from(map.values());
    }

    function formatMvp5TasksAtomicHintsForPrompt(dagTasks, filesByTaskId, options = {}) {
      const tasks = Array.isArray(dagTasks) ? dagTasks : [];
      const maxTasks = Math.min(25, Math.max(1, Number(options?.maxTasks ?? 25)));
      const maxFilesPerTask = Math.min(12, Math.max(3, Number(options?.maxFilesPerTask ?? 8)));
      if (!filesByTaskId || typeof filesByTaskId.get !== 'function') return '（无）';

      const lines = [];
      lines.push('（来自 tasks_atomic.md 的文件级提示：用于评估并发风险/写入冲突；编排仍以 tasks.md 的 task 为单位）');

      let any = false;
      for (const task of tasks.slice(0, maxTasks)) {
        const taskId = String(task?.id || '').trim();
        if (!taskId) continue;
        const files = filesByTaskId.get(taskId) || [];
        if (!Array.isArray(files) || files.length === 0) continue;
        any = true;
        const uniq = Array.from(
          new Set(files.map((v) => normalizeAtomicScopePath(v)).filter(Boolean)),
        );
        const shown = uniq.slice(0, maxFilesPerTask);
        const rest = Math.max(0, uniq.length - shown.length);
        lines.push(
          `- ${taskId}：${uniq.length} 个文件${shown.length ? `：${shown.join(', ')}` : ''}${rest ? ` …等${rest}个` : ''}`,
        );
      }

      if (!any) return '（无）';
      return lines.join('\n');
    }

    async function generateMvp5PlanWithModel({
      specId,
      tasks,
      dag,
      maxCliConcurrencyLimit,
      cliAvailability,
      preferredModelId,
      tasksAtomicHints,
    }) {
      const normalizedModel = LLM_MODEL_ALIASES[preferredModelId] || preferredModelId;
      const cfg = getLlmConfigForModel(normalizedModel);
      if (!cfg?.baseUrl || !cfg?.apiKey || !cfg?.model) {
        return { ok: false, skipped: true, error: { message: 'LLM config unavailable', context: describeLlmConfig(cfg) } };
      }
    
      const promptConfig = loadPromptConfig();
      const stage = promptConfig?.stages?.mvp5Plan;
      if (!stage) {
        return { ok: false, skipped: true, error: { message: 'Prompt stage mvp5Plan missing', context: null } };
      }
    
      const variables = {
        specId: String(specId || '').trim(),
        maxCliConcurrency: String(maxCliConcurrencyLimit),
        cliAvailability: formatMvp5CliAvailability(cliAvailability),
        tasks: formatMvp5TasksForPrompt(tasks),
        dependencies: formatMvp5DependenciesForPrompt(dag),
        tasksAtomicHints: String(tasksAtomicHints || '').trim(),
        summary: `tasks=${Array.isArray(dag?.tasks) ? dag.tasks.length : 0}, edges=${Array.isArray(dag?.edges) ? dag.edges.length : 0}`,
      };
    
      const promptRendered = {
        system: applyPromptTemplate(stage.system, variables),
        user: applyPromptTemplate(stage.user, variables),
      };
    
      const messages = [
        { role: 'system', content: promptRendered.system },
        { role: 'user', content: promptRendered.user },
      ];
    
      const timeoutMs = Math.min(
        Math.max(8000, Number(process.env.LLM_MVP5_PLAN_TIMEOUT_MS || 60000)),
        120000,
      );
    
      const content = await callLlm(messages, { ...cfg, timeoutMs }, {});
      const payload = tryParseJson(content);
      const taskIds = Array.isArray(dag?.tasks) ? dag.tasks.map((t) => t.id) : [];
      const normalized = normalizeMvp5PlanPayload(payload, taskIds, maxCliConcurrencyLimit);
      if (!normalized) {
        throw new Error(`LLM mvp5Plan output invalid: ${String(content).slice(0, 240)}`);
      }
    
      return {
        ok: true,
        skipped: false,
        result: normalized,
        llmContext: describeLlmConfig(cfg),
        prompt: { templates: { system: stage.system, user: stage.user }, rendered: promptRendered, variables },
      };
    }
    
    /**
     * POST /api/mvp5/analyze-dependencies
     * 分析任务依赖关系
     */
    app.post('/api/mvp5/analyze-dependencies', async (req, res) => {
      try {
        const { specId, tasksContent, tasks: tasksInput, atomicTasks, options = {} } = req.body;
    
        let dagTasks = null;
        let usedLegacyAtomic = false;
    
        if (Array.isArray(tasksInput)) {
          dagTasks = ensureUniqueDagTaskIds(
            tasksInput.map((t, idx) => normalizeDagTaskObject(t, idx)).filter(Boolean),
          );
        } else if (typeof tasksContent === 'string') {
          dagTasks = parseDagTasksFromTasksContent(tasksContent);
        } else if (Array.isArray(atomicTasks)) {
          // Legacy fallback: keep compatibility but prefer TASKS_JSON.
          usedLegacyAtomic = true;
          const parsed = typeof atomicTasks[0] === 'string'
            ? dependencyAnalyzer.parseAtomicTasks(atomicTasks.join('\n'))
            : atomicTasks;
          dagTasks = ensureUniqueDagTaskIds(
            parsed
              .map((t, idx) => ({
                id: String(t?.id || `T${idx + 1}`).trim() || `T${idx + 1}`,
                title: String(t?.title || '').trim(),
                description: String(t?.description || t?.details || '').trim(),
                dependencies: [],
                scope: [],
                estimated_complexity: 'Medium',
              }))
              .filter((t) => t.title),
          );
        }
    
        if (!dagTasks || dagTasks.length === 0) {
          return res.status(400).json({
            error:
              '没有有效的任务：请在 tasks.md 的 ## TASKS_JSON 块中提供 { "tasks": [...] }，或直接传 tasksContent。',
          });
        }
    
        const hadTask0 = dagTasks.some((t) => String(t?.id || '').trim() === 'task_0');
        dagTasks = ensureDagTask0LogsTask(dagTasks);

        const warnings = [];
        if (usedLegacyAtomic) {
          warnings.push('提示：当前分析使用 legacy atomicTasks 输入，建议改用 tasks.md 的 TASKS_JSON。');
        }
        if (!hadTask0) {
          warnings.push('已自动注入 task_0（初始化 task_logs）并将其设为所有任务的前置依赖。');
        }
        if (dagTasks.length > 25) {
          warnings.push(`任务数量为 ${dagTasks.length}，建议 ≤ 25（参照 docs/任务编排.md）。`);
        }
    
        const taskIds = new Set(dagTasks.map((t) => t.id));
        const dependencyEdges = [];
        const unknownDeps = new Set();
    
        dagTasks.forEach((task) => {
          const deps = Array.isArray(task?.dependencies) ? task.dependencies : [];
          deps.forEach((depId) => {
            const dep = String(depId ?? '').trim();
            if (!dep || dep === task.id) return;
            if (!taskIds.has(dep)) {
              unknownDeps.add(`${task.id} -> ${dep}`);
              return;
            }
            dependencyEdges.push({
              from: dep,
              to: task.id,
              type: 'explicit',
              strength: 'strong',
              description: `显式依赖: ${task.id} 依赖 ${dep}`,
            });
          });
        });
    
        if (unknownDeps.size) {
          const items = Array.from(unknownDeps).slice(0, 12);
          warnings.push(
            `检测到无效 dependencies 引用（已忽略）：${items.join('；')}${unknownDeps.size > items.length ? '…' : ''}`,
          );
        }
    
        // 如果存在 tasks_atomic.md，则优先用其中的文件级路径来细化每个 task 的 scope（用于冲突预警与编排参考）。
        const filesByTaskId = new Map();
        try {
          const specName = sanitizeSpecName(specId);
          if (specName) {
            const atomicPath = resolveSpecFile(specName, 'tasks_atomic');
            if (atomicPath && fs.existsSync(atomicPath)) {
              const atomicContent = fs.readFileSync(atomicPath, 'utf8');
              const atomicParsed = parseTasksAtomicMarkdown(atomicContent);
              for (const item of Array.isArray(atomicParsed) ? atomicParsed : []) {
                const originalIndex = Number(item?.originalIndex);
                if (!Number.isFinite(originalIndex) || originalIndex <= 0) continue;
                const taskId = `task_${Math.floor(originalIndex)}`;
                const token = extractAtomicPathTokenFromTitle(item?.title);
                if (!token) continue;
                const normalized = normalizeAtomicScopePath(token);
                if (!normalized) continue;
                if (!filesByTaskId.has(taskId)) filesByTaskId.set(taskId, []);
                filesByTaskId.get(taskId).push(normalized);
              }
              if (filesByTaskId.size > 0) {
                dagTasks = dagTasks.map((t) => {
                  const taskId = String(t?.id || '').trim();
                  const derived = filesByTaskId.get(taskId) || [];
                  const scope = mergeTaskScopesPreferAtomic(t?.scope, derived, 32);
                  return { ...t, scope };
                });
              }
            }
          }
        } catch (error) {
          // 原子化提示是增强项：失败不阻断依赖分析，但在 warnings 暴露原因。
          warnings.push(`读取 tasks_atomic.md 失败：${error?.message || String(error)}`);
        }

        const scopeConflicts = detectDagScopeConflicts(dagTasks);
        warnings.push(...scopeConflicts.warnings);
    
        const tasksForDag = dagTasks.map((t) => {
          const meta = [];
          if (Array.isArray(t.scope) && t.scope.length) meta.push(`scope: ${t.scope.join(', ')}`);
          if (t.estimated_complexity) meta.push(`complexity: ${t.estimated_complexity}`);
          const metaBlock = meta.length ? `\n\n${meta.join('\n')}` : '';
          return {
            id: t.id,
            title: t.title,
            description: `${t.description || ''}${metaBlock}`.trim(),
          };
        });
    
        // 构建 DAG（只使用 dependencies，scope 冲突只做提示，不影响拓扑）
        const dag = dagBuilder.buildDAG(tasksForDag, dependencyEdges);
        if (scopeConflicts.edges.length) {
          dag.edges = [...dag.edges, ...scopeConflicts.edges];
        }
    
        // 并发约束：最大 CLI 并发数（上限 8）
        const rawMaxCliConcurrency = options.maxCliConcurrency ?? process.env.MVP5_MAX_CLI_CONCURRENCY;
        const parsedMaxCliConcurrency = Number(rawMaxCliConcurrency);
        const maxCliConcurrency = Number.isFinite(parsedMaxCliConcurrency)
          ? Math.min(8, Math.max(1, Math.floor(parsedMaxCliConcurrency)))
          : 8;
    
        const cliAvailability = normalizeCliAvailabilityForMvp5(options.cliAvailability);
    
        // 生成推荐方案（默认：规则引擎 + 可选 LLM 方案）
        const recommendations = recommender.generateRecommendations(dag, {
          cliAvailability,
          maxCliConcurrency,
        });
    
        const wantLlmPlan = options.useLlmPlan !== false;
        const preferredPlanModelRaw =
          typeof options.planModel === 'string' && options.planModel.trim()
            ? options.planModel.trim()
            : (process.env.MVP5_PLAN_LLM_MODEL || 'claude-opus-4-5-20251101');
        const preferredPlanModel = LLM_MODEL_ALIASES[preferredPlanModelRaw] || preferredPlanModelRaw;
    
        if (wantLlmPlan) {
          try {
            const tasksAtomicHints = formatMvp5TasksAtomicHintsForPrompt(dagTasks, filesByTaskId, {
              maxTasks: 25,
              maxFilesPerTask: 8,
            });
            const modelPlan = await generateMvp5PlanWithModel({
              specId,
              tasks: tasksForDag.map((t) => ({
                id: t.id,
                title: t.title,
                description: t.description,
                riskLevel: recommender.assessTaskRisk(t),
                requiresInteraction: recommender.requiresInteraction(t),
              })),
              dag,
              maxCliConcurrencyLimit: maxCliConcurrency,
              cliAvailability,
              preferredModelId: preferredPlanModel,
              tasksAtomicHints,
            });
    
            if (modelPlan?.ok && modelPlan.result) {
              const effectiveConcurrency = Math.min(maxCliConcurrency, modelPlan.result.maxCliConcurrency || maxCliConcurrency);
              const llmRec = recommender.generateRecommendation(dag, {
                cliAvailability,
                maxCliConcurrency: effectiveConcurrency,
                cliAllocationOverride: modelPlan.result.cliAllocation,
              });
              if (llmRec?.feasible) {
                llmRec.label = `模型方案（${preferredPlanModel}）`;
                llmRec.priority = 'high';
                llmRec.generatedBy = 'llm';
                llmRec.llm = { model: preferredPlanModel, providerId: modelPlan.llmContext?.providerId || null };
                if (modelPlan.result.rationale) {
                  llmRec.rationale = modelPlan.result.rationale;
                }
                recommendations.unshift(llmRec);
              }
            }
          } catch (error) {
            // LLM plan is best-effort; fall back to heuristic recommendations.
            console.warn('[MVP5] LLM plan generation skipped:', error?.message || error);
            warnings.push(`模型方案生成失败（${preferredPlanModel}）：${error?.message || String(error)}`);
          }
        }
    
        // 跨平台路径检查
        const allPaths = dagTasks.flatMap((t) => (Array.isArray(t?.scope) ? t.scope : []));
        const compatibility = pathAdapter.checkCompatibility(
          allPaths,
          options.devPlatform || 'windows',
          options.targetPlatform || 'linux'
        );
    
        // 生成分析结果
        const analysisId = nanoid(10);
        const result = {
          analysisId,
          specId,
          maxCliConcurrency,
          analyzedAt: new Date().toISOString(),
          tasks: tasksForDag.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            riskLevel: recommender.assessTaskRisk(t),
            requiresInteraction: recommender.requiresInteraction(t),
          })),
          graph: dag,
          recommendations,
          warnings,
          platformNotes: compatibility.issues.length > 0 ? compatibility : undefined,
          summary: recommender.generateExecutionSummary({ graph: dag, warnings, maxCliConcurrency }),
        };
    
        analysisResults.set(analysisId, result);
    
        res.json(result);
      } catch (error) {
        console.error('[MVP5] 依赖分析错误:', error);
        res.status(error?.status || 500).json({ error: error.message });
      }
    });
    
    /**
     * GET /api/mvp5/analyze-dependencies/:id
     * 获取分析结果
     */
    app.get('/api/mvp5/analyze-dependencies/:id', (req, res) => {
      const { id } = req.params;
      const result = analysisResults.get(id);
    
      if (!result) {
        return res.status(404).json({ error: '分析结果不存在' });
      }
    
      res.json(result);
    });
    
    /**
     * POST /api/mvp5/task-prompt
     * 从 tasks.md（TASKS_JSON）生成单任务提示词（用于手动发给 CLI 执行）
     */
    app.post('/api/mvp5/task-prompt', (req, res) => {
      try {
        const specName = sanitizeSpecName(req.body?.specId ?? req.body?.specName ?? req.query?.specId);
        if (!specName) {
          return res.status(400).json({ error: 'specId is required' });
        }
    
        const taskId = String(req.body?.taskId ?? req.query?.taskId ?? '').trim();
        if (!taskId) {
          return res.status(400).json({ error: 'taskId is required' });
        }
    
        const tasksContent = typeof req.body?.tasksContent === 'string' ? req.body.tasksContent : '';
        if (!tasksContent.trim()) {
          return res.status(400).json({ error: 'tasksContent is required' });
        }
    
        const includeDoc =
          String(req.query?.includeDoc || '').trim() === '1' ||
          String(req.query?.includeDoc || '').trim().toLowerCase() === 'true' ||
          req.body?.includeDoc === true;
    
        let dagTasks = parseDagTasksFromTasksContent(tasksContent);
        if (!dagTasks || dagTasks.length === 0) {
          return res.status(400).json({
            error:
              '没有有效的任务：请在 tasks.md 的 ## TASKS_JSON 块中提供 { "tasks": [...] }。',
          });
        }
    
        dagTasks = ensureDagTask0LogsTask(dagTasks);

        const task = dagTasks.find((t) => String(t?.id || '').trim() === taskId) || null;
        if (!task) {
          return res.status(404).json({ error: `Task not found: ${taskId}` });
        }
    
        const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
        const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
        const projectDir = normalizeTerminalCwd(
          req.body?.cwd ??
            req.body?.projectDir ??
            (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
            (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
        );
    
        const doc = buildMvp5TaskRunDoc(specName, task, {
          sandbox,
          model,
          projectDir,
        });
        const runDocPathAbs = normalizePathForPrompt(doc.runDocPath);
        const projectDirForPrompt = normalizePathForPrompt(projectDir);
    
        let runDocContent = '';
        if (includeDoc) {
          try {
            if (doc?.runDocPath && fs.existsSync(doc.runDocPath)) {
              runDocContent = fs.readFileSync(doc.runDocPath, 'utf8');
            }
          } catch {
            runDocContent = '';
          }
          try {
            runDocContent = runDocContent ? truncateText(runDocContent, 18000).trimEnd() : '';
          } catch {
            runDocContent = runDocContent ? String(runDocContent).slice(0, 18000).trimEnd() : '';
          }
        }

        const truncateInline = (value, maxLen = 420) => {
          const text = String(value ?? '')
            .replace(/\r?\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (!text) return '';
          if (text.length <= maxLen) return text;
          return `${text.slice(0, maxLen).trimEnd()}…`;
        };
        const title = String(task?.title || '').trim();
        const desc = truncateInline(task?.description || '', 520);
        const scope = Array.isArray(task?.scope)
          ? task.scope.map((v) => String(v || '').trim()).filter(Boolean)
          : [];
        const scopeText = scope.length
          ? `scope（写锁）：${scope.join(', ')}`
          : 'scope（写锁）：（为空：默认串行，且不得与其它任务并发）';

        const prompt = [
          `任务：${taskId}${title ? `｜${title}` : ''}`,
          desc ? `要求：${desc}` : null,
          scopeText,
          `请按任务文档（绝对路径）${runDocPathAbs} 实现该任务，完成后自检并用简短要点总结变更与验证结果。`,
          '硬性约束：不要猜测/兜底；缺信息就明确报错并停止。',
          '注意：修改已存在文件前先读取内容，再做最小化修改（避免 “Write 未 Read” 类工具冲突）。',
          '为避免并发冲突：只修改 scope（写锁）内文件/目录；若必须越界，先停止并说明原因与影响。',
          projectDirForPrompt ? `建议工作目录：${projectDirForPrompt}` : null,
        ]
          .filter(Boolean)
          .join('\n');
    
        return res.json({
          ok: true,
          taskId,
          prompt,
          runDocPathAbs,
          runDocPath: doc.runDocPathRel,
          runDocContent,
          projectDir: projectDirForPrompt,
          task: {
            id: task.id,
            title: task.title,
            description: task.description,
            dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
            scope: Array.isArray(task.scope) ? task.scope : [],
            estimated_complexity: task.estimated_complexity || null,
          },
        });
      } catch (error) {
        console.error('[MVP5] task-prompt error:', error);
        return res.status(500).json({ error: error?.message || 'Failed to generate prompt' });
      }
    });
    
    /**
     * POST /api/mvp5/single-agent-prompt
     * 从 tasks.md（TASKS_JSON）生成“单个 CLI agent 顺序执行整个 DAG”的提示词
     */
    app.post('/api/mvp5/single-agent-prompt', (req, res) => {
      try {
        const specName = sanitizeSpecName(req.body?.specId ?? req.body?.specName ?? req.query?.specId);
        if (!specName) {
          return res.status(400).json({ error: 'specId is required' });
        }
    
        const tasksContent = typeof req.body?.tasksContent === 'string' ? req.body.tasksContent : '';
        if (!tasksContent.trim()) {
          return res.status(400).json({ error: 'tasksContent is required' });
        }
    
        const projectDir = normalizeTerminalCwd(
          req.body?.cwd ??
            req.body?.projectDir ??
            (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
            (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
        );
        const projectDirForPrompt = normalizePathForPrompt(projectDir);
    
        let dagTasks = parseDagTasksFromTasksContent(tasksContent);
        if (!dagTasks || dagTasks.length === 0) {
          return res.status(400).json({
            error:
              '没有有效的任务：请在 tasks.md 的 ## TASKS_JSON 块中提供 { "tasks": [...] }。',
          });
        }
    
        dagTasks = ensureDagTask0LogsTask(dagTasks);

        // 确保存在“收尾”任务：避免仅在“任务迭代”后才出现。
        const looksLikeSummaryTask = (task) => {
          const title = String(task?.title || '').trim();
          const description = String(task?.description || '').trim();
          const text = `${title} ${description}`.trim();
          if (!text) return false;
          // 避免把普通任务里的“验收点/验收标准”等误判为收尾任务。
          return /(总结|收尾|回归(验证|测试)|最终(修复|调试|回归|验收|检查)|final(\s+(check|qa))?|post[-\s]?check|regression(\s+test)?)/i.test(text);
        };
        const baseTasks = Array.isArray(dagTasks) ? dagTasks.slice() : [];
        let summary = null;
        for (let i = baseTasks.length - 1; i >= 0; i -= 1) {
          if (!looksLikeSummaryTask(baseTasks[i])) continue;
          summary = baseTasks[i];
          baseTasks.splice(i, 1);
          break;
        }
        const baseIds = baseTasks.map((t) => String(t?.id || '').trim()).filter(Boolean);
        const defaultTitle = '最终修复与调试（收尾）';
        const defaultDescription =
          '输入：已完成的各模块交付物与 requirements 用户故事；输出：最终回归验证（含关键用户故事端到端检查，可使用浏览器/MCP）、修复残留问题、补齐必要日志/说明；验收：关键构建/健康检查通过，用户故事链路可复现通过。';
        const ensureUniqueTaskId = (preferred) => {
          const baseId = String(preferred || '').trim() || `task_${baseIds.length + 1}`;
          let id = baseId;
          let suffix = 2;
          while (baseIds.includes(id)) id = `${baseId}_${suffix++}`;
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
        dagTasks = [...baseTasks, summary];
    
        const taskIds = dagTasks.map((t) => String(t?.id || '').trim()).filter(Boolean);
        const idSet = new Set(taskIds);
        const byId = new Map(dagTasks.map((t) => [String(t?.id || '').trim(), t]));
    
        const out = new Map(taskIds.map((id) => [id, []]));
        const inDegree = new Map(taskIds.map((id) => [id, 0]));
        const unknownDeps = [];
    
        for (const task of dagTasks) {
          const id = String(task?.id || '').trim();
          if (!id) continue;
          const deps = Array.isArray(task?.dependencies)
            ? task.dependencies.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
          for (const depId of deps) {
            if (!idSet.has(depId)) {
              unknownDeps.push({ taskId: id, depId });
              continue;
            }
            const list = out.get(depId);
            if (list) list.push(id);
            inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
          }
        }
    
        if (unknownDeps.length) {
          return res.status(400).json({
            error: 'DAG 依赖引用了不存在的任务 id',
            details: unknownDeps.slice(0, 80),
          });
        }
    
        const suffixNumber = (id) => {
          const match = /^task_(\d+)$/.exec(String(id || '').trim());
          if (!match) return Number.POSITIVE_INFINITY;
          const n = Number(match[1]);
          return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
        };
        const compareTaskId = (a, b) => {
          const na = suffixNumber(a);
          const nb = suffixNumber(b);
          if (na !== nb) return na - nb;
          return String(a || '').localeCompare(String(b || ''), 'en');
        };
    
        const queue = taskIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort(compareTaskId);
        const order = [];
        while (queue.length) {
          const id = queue.shift();
          if (!id) continue;
          order.push(id);
          const outs = out.get(id) || [];
          for (const to of outs) {
            const next = (inDegree.get(to) ?? 0) - 1;
            inDegree.set(to, next);
            if (next === 0) {
              queue.push(to);
              queue.sort(compareTaskId);
            }
          }
        }
    
        if (order.length !== taskIds.length) {
          const cycleNodes = taskIds.filter((id) => (inDegree.get(id) ?? 0) > 0).sort(compareTaskId);
          return res.status(400).json({
            error: 'DAG 存在环（循环依赖），无法生成单AGENT执行顺序',
            cycle: cycleNodes,
          });
        }

        const requirementsPath = resolveSpecFile(specName, 'requirements');
        if (!requirementsPath || !fs.existsSync(requirementsPath)) {
          return res.status(409).json({
            error: 'requirements.md 不存在，无法生成单AGENT提示词（需要整体需求）',
            requirementsPath: requirementsPath ? normalizePathForPrompt(requirementsPath) : null,
          });
        }
        const requirementsMarkdown = fs.readFileSync(requirementsPath, 'utf8');
        const requirementsRaw = String(requirementsMarkdown || '').trim();
        if (!requirementsRaw) {
          return res.status(409).json({
            error: 'requirements.md 为空，无法生成单AGENT提示词（需要整体需求）',
            requirementsPath: normalizePathForPrompt(requirementsPath),
          });
        }
        const extractSection = (markdown, heading) => {
          const text = String(markdown || '').replace(/\r\n/g, '\n');
          const marker = `## ${String(heading || '').trim()}`.trim();
          const idx = text.indexOf(marker);
          if (idx < 0) return '';
          const after = text.slice(idx + marker.length).replace(/^\s+/, '');
          const next = after.search(/^##\s+/m);
          const section = next >= 0 ? after.slice(0, next) : after;
          return String(section || '').trim();
        };
        const requirementsOverviewRaw = extractSection(requirementsMarkdown, '原始需求') || requirementsRaw;
        const requirementsOverview = truncateText(requirementsOverviewRaw, 2600).trimEnd();

        let designOverview = '';
        try {
          const designPath = resolveSpecFile(specName, 'design');
          if (designPath && fs.existsSync(designPath)) {
            const designMarkdown = fs.readFileSync(designPath, 'utf8');
            const designRaw = String(designMarkdown || '').trim();
            if (designRaw) {
              const designOverviewRaw = extractSection(designMarkdown, '设计') || designRaw;
              designOverview = truncateText(designOverviewRaw, 1800).trimEnd();
            }
          }
        } catch {
          designOverview = '';
        }

        const truncateInline = (value, maxLen = 900) => {
          const text = String(value ?? '').trim().replace(/\s+/g, ' ');
          if (text.length <= maxLen) return text;
          return `${text.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
        };

        const lines = [];
        lines.push('你是一个单 Agent 的 CLI 开发助手。');
        if (projectDirForPrompt) lines.push(`工作目录（建议）：${projectDirForPrompt}`);
        lines.push('');
        lines.push('整体需求（摘要）：');
        lines.push(requirementsOverview);
        if (designOverview) {
          lines.push('');
          lines.push('设计摘要（可选）：');
          lines.push(designOverview);
        }
        lines.push('');
        lines.push('目标：按 DAG 依赖顺序完成全部任务；最后执行“最终修复与调试（收尾）”。');
        lines.push(`任务总数：${order.length}（必须全部完成，不要只完成第 1 个任务就结束）。`);
        lines.push('');
        lines.push('硬性约束（必须遵守）：');
        lines.push('- 不要使用任何兜底/猜测/编造输出；有问题就明确报错并停止。');
        lines.push('- 修改“已存在文件”前先读取内容，再做最小化 diff/patch；不要直接覆盖写入（避免 “Write 未 Read” 冲突）。');
        lines.push('- 严格串行执行（单 Agent），不要并发。');
        lines.push('- 优先只修改当前任务 scope 内文件/目录；若必须越界，先说明原因与影响。');
        lines.push('');
        lines.push('执行规则（避免误会）：');
        lines.push('- 你必须在同一次运行里，按顺序连续执行完所有任务；不要在完成 task_1 后停下来等待用户确认。');
        lines.push('- 完成一个任务后，立刻开始下一个任务，直到最后的“收尾任务”也完成才结束。');
        lines.push('- 只有当遇到阻塞性错误（缺依赖/无法定位文件/权限/命令失败）时才停止，并输出清晰的错误与定位信息。');
        lines.push('');
        lines.push('执行顺序（拓扑）：');
        lines.push(order.map((id, idx) => `${idx + 1}. ${id}`).join('\n'));
        lines.push('');
        lines.push('任务清单（按顺序）：');
        for (const id of order) {
          const task = byId.get(id);
          if (!task) continue;
          const title = String(task?.title || '').trim();
          const desc = truncateInline(task?.description || '', 1200);
          const deps = Array.isArray(task?.dependencies)
            ? task.dependencies.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
          const scope = Array.isArray(task?.scope)
            ? task.scope.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
          const complexity = task?.estimated_complexity ? String(task.estimated_complexity).trim() : '';
          lines.push(`- ${id}${title ? `｜${title}` : ''}`);
          lines.push(`  - description: ${desc || '（无描述）'}`);
          if (deps.length) lines.push(`  - dependencies: ${deps.join(', ')}`);
          if (scope.length) lines.push(`  - scope: ${scope.join(', ')}`);
          if (complexity) lines.push(`  - estimated_complexity: ${complexity}`);
        }
        lines.push('');
        lines.push('每完成一个任务后：');
        lines.push('- 做一次最小自测（按项目现有脚本/健康检查），记录结果。');
        lines.push('- 写回进度：更新 tasks.md 的 TASKS_JSON（status/done/startedAt/doneAt）。');
        lines.push('- 在输出里追加一行简短日志：DONE <TASK_ID>（例如：DONE task_3）。');
        lines.push('');
        lines.push('现在从第 1 个任务开始执行，并在同一次运行中完成全部任务后再结束。');
    
        const prompt = lines.join('\n').trim();
        return res.json({
          ok: true,
          specId: specName,
          projectDir: projectDirForPrompt,
          tasksCount: dagTasks.length,
          order,
          prompt,
        });
      } catch (error) {
        console.error('[MVP5] single-agent-prompt error:', error);
        return res.status(500).json({ error: error?.message || 'Failed to generate single-agent prompt' });
      }
    });
    
    /**
     * POST /api/mvp5/execution-plans
     * 创建执行计划
     */
    app.post('/api/mvp5/execution-plans', (req, res) => {
      try {
        const { specId, analysisId, selectedRecommendation, modifications = {} } = req.body;
    
        // 获取分析结果
        const analysis = analysisResults.get(analysisId);
        if (!analysis) {
          return res.status(404).json({ error: '分析结果不存在' });
        }
    
        // 获取选中的推荐方案
        const recommendation = analysis.recommendations[selectedRecommendation] || analysis.recommendations[0];
        if (!recommendation) {
          return res.status(400).json({ error: '无效的推荐方案' });
        }
    
        // 应用修改
        let phases = [...recommendation.phases];
        if (modifications.excludedTasks && modifications.excludedTasks.length > 0) {
          phases = phases.map(phase => ({
            ...phase,
            taskIds: phase.taskIds.filter(id => !modifications.excludedTasks.includes(id)),
          })).filter(phase => phase.taskIds.length > 0);
        }
    
        // MVP5 编排阶段不再区分 Codex/Claude：执行阶段统一使用 Codex（CLI 选择留给终端面板）
        const planTaskIds = Array.from(new Set(phases.flatMap((p) => p.taskIds)));
        const cliAllocation = Object.fromEntries(planTaskIds.map((taskId) => [taskId, 'codex']));
    
        // 创建执行计划
        const planId = nanoid(10);
        const plan = {
          planId,
          specId,
          analysisId,
          createdAt: new Date().toISOString(),
          status: 'pending',
          phases,
          cliAllocation,
          modifications,
          estimatedDuration: phases.reduce((sum, p) => sum + (p.estimatedDuration || 0), 0),
        };
    
        executionPlans.set(planId, plan);
    
        res.json(plan);
      } catch (error) {
        console.error('[MVP5] 创建执行计划错误:', error);
        res.status(error?.status || 500).json({ error: error.message });
      }
    });
    
    /**
     * GET /api/mvp5/execution-plans/:id
     * 获取执行计划
     */
    app.get('/api/mvp5/execution-plans/:id', (req, res) => {
      const { id } = req.params;
      const plan = executionPlans.get(id);
    
      if (!plan) {
        return res.status(404).json({ error: '执行计划不存在' });
      }
    
      res.json(plan);
    });
    
    function quoteCmdArgument(value) {
      const raw = String(value ?? '');
      if (!raw) return '""';
      if (/[\s&|<>^"]/.test(raw)) {
        return `"${raw.replace(/"/g, '\\"')}"`;
      }
      return raw;
    }
    
    function buildMvp5TaskRunDoc(specName, task, options = {}) {
      const projectDir = typeof options?.projectDir === 'string' ? options.projectDir.trim() : '';
      const baseDir = projectDir || REPO_DIR;
      const runsDir = path.join(baseDir, '.runlogs', 'mvp5-runs', String(specName || 'spec'));
      fs.mkdirSync(runsDir, { recursive: true });
    
      const taskId = String(task?.id || 'unknown').trim() || 'unknown';
      const safeTaskId = taskId
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 60);
      const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z');
      const runDocPath = path.join(runsDir, `task-${safeTaskId}-${stamp}.md`);
    
      const rel = (absPath) => normalizePathForPrompt(path.relative(REPO_DIR, absPath));
      const artifacts = {
        requirements: resolveSpecFile(specName, 'requirements'),
        design: resolveSpecFile(specName, 'design'),
        tasks: resolveSpecFile(specName, 'tasks'),
      };
      const readIfExists = (filePath) => {
        try {
          if (!filePath || !fs.existsSync(filePath)) return '';
          return fs.readFileSync(filePath, 'utf8');
        } catch {
          return '';
        }
      };
      const requirementsSnapshot = readIfExists(artifacts.requirements);
      const designSnapshot = readIfExists(artifacts.design);
      const tasksSnapshot = readIfExists(artifacts.tasks);
    
      const lines = [];
      lines.push('# Codex 任务执行文档（MVP5）');
      lines.push('');
      lines.push(`- Spec: ${specName}`);
      lines.push(`- Task: ${taskId}`);
      if (task?.title) lines.push(`- Title: ${String(task.title).trim()}`);
      if (options.executionId) lines.push(`- Execution: ${options.executionId}`);
      if (options.planId) lines.push(`- Plan: ${options.planId}`);
      if (Number.isFinite(options.phaseIndex)) lines.push(`- PhaseIndex: ${options.phaseIndex}`);
      lines.push(`- StartedAt: ${new Date().toISOString()}`);
      if (options.model) lines.push(`- Model: ${options.model}`);
      if (options.sandbox) lines.push(`- Sandbox: ${options.sandbox}`);
      if (options.projectDir) lines.push(`- ProjectDir: ${normalizePathForPrompt(options.projectDir)}`);
      if (options.worktree?.branch) lines.push(`- WorktreeBranch: ${String(options.worktree.branch).trim()}`);
      if (options.worktree?.baseRef) lines.push(`- WorktreeBaseRef: ${String(options.worktree.baseRef).trim()}`);
      if (options.worktree?.worktreeDir) {
        lines.push(`- WorktreeDir: ${normalizePathForPrompt(options.worktree.worktreeDir)}`);
      }

      const taskLogsDir = path.join(baseDir, 'task_logs');
      lines.push(`- TaskLogsDir: ${normalizePathForPrompt(taskLogsDir)}`);

      lines.push('');
      lines.push('## task_logs（开工前必读）');
      lines.push('- 说明：此目录包含其它任务的工作报告（task_*.md），用于理解整体关系并减少并发冲突。');
      lines.push(`- 位置：${normalizePathForPrompt(taskLogsDir)}`);
      try {
        if (fs.existsSync(taskLogsDir)) {
          const reportFiles = fs
            .readdirSync(taskLogsDir)
            .filter((name) => String(name || '').toLowerCase().endsWith('.md'))
            .filter((name) => String(name || '').trim() !== 'README.md')
            .filter((name) => String(name || '').trim() !== `${taskId}.md`)
            .sort((a, b) => String(a || '').localeCompare(String(b || ''), 'en'));
          if (!reportFiles.length) {
            lines.push('- 当前暂无其它任务报告');
          } else {
            lines.push(`- 已存在 ${reportFiles.length} 份报告：${reportFiles.join(', ')}`);
            const maxFiles = 10;
            for (const fileName of reportFiles.slice(0, maxFiles)) {
              let content = '';
              try {
                content = fs.readFileSync(path.join(taskLogsDir, fileName), 'utf8');
              } catch {
                content = '';
              }
              const snippet = content ? truncateText(content, 1200).trimEnd() : '';
              lines.push('');
              lines.push(`### ${fileName}（截断）`);
              lines.push('```markdown');
              lines.push(snippet || '（读取失败或为空）');
              lines.push('```');
            }
            if (reportFiles.length > maxFiles) {
              lines.push('');
              lines.push(`- （其余 ${reportFiles.length - maxFiles} 份报告已省略展示）`);
            }
          }
        } else {
          lines.push('- 当前暂无其它任务报告（task_logs 目录不存在）');
        }
      } catch {
        lines.push('- 当前暂无其它任务报告（task_logs 读取异常）');
      }

      lines.push('');
      lines.push('## Spec 快照（只读引用）');
      lines.push(
        '- 说明：出于 Codex CLI 沙箱限制，运行时可能无法访问外部 spec 目录；本次已将 requirements/design/tasks 快照内嵌，优先以快照为准。',
      );
      lines.push('');
      lines.push('### 原始 spec 路径（仅供人工定位，CLI 可能不可访问）');
      lines.push(`- requirements: \`${normalizePathForPrompt(artifacts.requirements)}\``);
      lines.push(`- design: \`${normalizePathForPrompt(artifacts.design)}\``);
      lines.push(`- tasks: \`${normalizePathForPrompt(artifacts.tasks)}\``);
      if (requirementsSnapshot.trim()) {
        lines.push('');
        lines.push('### requirements.md（截断）');
        lines.push('```markdown');
        lines.push(truncateText(requirementsSnapshot, 6000).trimEnd());
        lines.push('```');
      }
      if (designSnapshot.trim()) {
        lines.push('');
        lines.push('### design.md（截断）');
        lines.push('```markdown');
        lines.push(truncateText(designSnapshot, 6000).trimEnd());
        lines.push('```');
      }
      if (tasksSnapshot.trim()) {
        lines.push('');
        lines.push('### tasks.md（截断）');
        lines.push('```markdown');
        lines.push(truncateText(tasksSnapshot, 8000).trimEnd());
        lines.push('```');
      }
      lines.push('');
      lines.push('## 本次任务（来自 tasks.md 的 TASKS_JSON）');
      lines.push(`- title: ${String(task?.title || '').trim()}`);
      lines.push(`- description: ${String(task?.description || '').trim()}`);
      const deps = Array.isArray(task?.dependencies) ? task.dependencies.map((v) => String(v || '').trim()).filter(Boolean) : [];
      const scope = Array.isArray(task?.scope) ? task.scope.map((v) => String(v || '').trim()).filter(Boolean) : [];
      if (deps.length) lines.push(`- dependencies: ${deps.join(', ')}`);
      if (scope.length) lines.push(`- scope: ${scope.join(', ')}`);
      if (task?.estimated_complexity) lines.push(`- estimated_complexity: ${String(task.estimated_complexity).trim()}`);
      lines.push('');
      lines.push('## 执行要求');
      lines.push('- 以本任务为“闭环交付物”，不要做微观步骤拆解。');
      lines.push('- 按仓库既有约束实现与自测；必要时补充最小可行验证步骤。');
      lines.push(
        '- 为避免开发冲突：优先只修改本任务 scope 列表内的文件/目录；若必须修改 scope 外内容，先停止并在终端说明原因与影响。',
      );
      lines.push(
        '- 为避免工具冲突：修改“已存在文件”前先读取其内容，再做最小化修改（优先用 diff/patch）；不要直接覆盖写入（避免出现 “Write 未 Read” 类错误）。',
      );
      lines.push(
        '- 完成后输出“关键变更/验证方式/验证结果”；如运行环境允许访问 spec 文件，再回写到 tasks.md（建议追加到对应任务条目下）。',
      );
      lines.push('');
    
      fs.writeFileSync(runDocPath, lines.join('\n'), 'utf8');
      return { runDocPath, runDocPathRel: rel(runDocPath), artifacts };
    }
    
    function inferMvp5MaxCliConcurrency(plan, analysis) {
      const raw = Number(analysis?.maxCliConcurrency ?? analysis?.summary?.maxCliConcurrency);
      if (Number.isFinite(raw)) return Math.min(8, Math.max(1, Math.floor(raw)));
      const phases = Array.isArray(plan?.phases) ? plan.phases : [];
      const fromPhases = phases.reduce((acc, phase) => {
        const candidate = Number(phase?.maxConcurrency ?? (Array.isArray(phase?.taskIds) ? phase.taskIds.length : 1));
        return Number.isFinite(candidate) ? Math.max(acc, candidate) : acc;
      }, 1);
      return Math.min(8, Math.max(1, Math.floor(fromPhases || 1)));
    }
    
    function loadDagTasksForSpec(specName) {
      const tasksPath = resolveSpecFile(specName, 'tasks');
      if (!fs.existsSync(tasksPath)) return null;
      const content = fs.readFileSync(tasksPath, 'utf8');
      return parseDagTasksFromTasksContent(content);
    }
    
    function scheduleMvp5Execution(runner) {
      if (!runner || runner.stopped) return;
      const state = executionStates.get(runner.executionId);
      const plan = executionPlans.get(runner.planId);
      if (!state || !plan) return;
      if (state.status !== 'running') return;
    
      const phases = Array.isArray(plan.phases) ? plan.phases : [];
      const phaseIndex = Number(state.currentPhase ?? 0);
      const phase = phases[phaseIndex];
    
      if (!phase) {
        state.status = 'completed';
        state.updatedAt = new Date().toISOString();
        plan.status = 'completed';
        return;
      }
    
      const phaseTaskIds = Array.isArray(phase.taskIds) ? phase.taskIds : [];
      const hasFailed = phaseTaskIds.some((id) => state.tasks?.[id]?.status === 'failed');
      if (hasFailed) {
        state.status = 'failed';
        state.updatedAt = new Date().toISOString();
        plan.status = 'failed';
        return;
      }
    
      const isPhaseDone = phaseTaskIds.length
        ? phaseTaskIds.every((id) => ['completed', 'skipped'].includes(state.tasks?.[id]?.status))
        : true;
    
      if (isPhaseDone) {
        state.currentPhase = phaseIndex + 1;
        state.updatedAt = new Date().toISOString();
        setTimeout(() => scheduleMvp5Execution(runner), 0);
        return;
      }
    
      const runningCount = phaseTaskIds.filter((id) => state.tasks?.[id]?.status === 'running').length;
      const maxConcurrency = phase.type === 'serial'
        ? 1
        : Math.min(
            runner.maxCliConcurrency,
            Number.isFinite(phase.maxConcurrency) ? Math.max(1, Math.floor(phase.maxConcurrency)) : runner.maxCliConcurrency,
          );
      const slots = Math.max(0, maxConcurrency - runningCount);
      if (slots <= 0) return;
    
      const pending = phaseTaskIds.filter((id) => state.tasks?.[id]?.status === 'pending');
      if (!pending.length) return;
    
      const freeWorkers = runner.workers.filter((w) => !w.busy);
      const canStart = Math.min(slots, pending.length, freeWorkers.length);
      for (let i = 0; i < canStart; i += 1) {
        startMvp5TaskOnWorker(runner, freeWorkers[i], pending[i], phaseIndex);
      }
    }
    
    function handleMvp5WorkerData(runner, worker, data) {
      if (!runner || !worker?.current) return;
      worker.tail = `${worker.tail}${data}`;
      if (worker.tail.length > 12000) worker.tail = worker.tail.slice(worker.tail.length - 12000);
    
      const marker = worker.current.marker;
      const idx = worker.tail.indexOf(marker);
      if (idx < 0) return;
    
      const after = worker.tail.slice(idx + marker.length);
      const match = /^(-?\d+)/.exec(after);
      if (!match) return;
    
      const exitCode = Number(match[1]);
      const finishedAt = new Date().toISOString();
      const state = executionStates.get(runner.executionId);
      const plan = executionPlans.get(runner.planId);
      if (!state || !plan) return;
    
      const { taskId, phaseIndex, runDocPathRel, worktree } = worker.current;
      const taskState = state.tasks?.[taskId];
      if (taskState) {
        taskState.completedAt = finishedAt;
        taskState.status = exitCode === 0 ? 'completed' : 'failed';
        if (runDocPathRel) taskState.runDocPath = runDocPathRel;
        taskState.error = exitCode === 0 ? undefined : `CLI 退出码 ${exitCode}`;
      }
    
      if (exitCode !== 0) {
        state.failures = Array.isArray(state.failures) ? state.failures : [];
        state.failures.push({
          taskId,
          phaseId: plan.phases?.[phaseIndex]?.phaseId || String(phaseIndex),
          error: `CLI 退出码 ${exitCode}`,
          canRetry: true,
          downstreamAffected: [],
        });
        state.status = 'failed';
        plan.status = 'failed';
      }

      if (worktree?.worktreeDir && worktree?.gitTop) {
        const taskMeta = runner.tasksById?.get(taskId) || null;
        const title = String(taskMeta?.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const label = title ? `${taskId} ${title}` : taskId;
        const exitSuffix = exitCode === 0 ? '' : ` (exit ${exitCode})`;
        const commitMessage = `chore: mvp5 ${runner.specName} ${label}${exitSuffix}`;
        let commitError = null;
        let commitResult = null;
        let worktreeRemoved = false;

        try {
          const result = commitAllChanges(worktree.worktreeDir, commitMessage);
          commitResult = result;
          if (taskState) {
            taskState.gitCommitted = Boolean(result?.committed);
            if (result?.committed) taskState.gitCommitMessage = commitMessage;
          }
          emitEvent('log:append', {
            source: 'git',
            message: `[worktree] commit task=${taskId} branch=${worktree.branch} committed=${result?.committed ? 'yes' : 'no'}`,
          });
        } catch (error) {
          commitError = error;
          const message = error?.message || String(error);
          if (taskState) {
            taskState.status = 'failed';
            taskState.error = taskState.error
              ? `${taskState.error}; git commit 失败：${message}`
              : `git commit 失败：${message}`;
          }
          state.failures = Array.isArray(state.failures) ? state.failures : [];
          state.failures.push({
            taskId,
            phaseId: plan.phases?.[phaseIndex]?.phaseId || String(phaseIndex),
            error: `git commit 失败：${message}`,
            canRetry: true,
            downstreamAffected: [],
          });
          state.status = 'failed';
          plan.status = 'failed';
          emitEvent('log:append', {
            source: 'git',
            message: `[worktree] commit failed task=${taskId} branch=${worktree.branch} err=${message}`,
          });
        }

        if (!commitError) {
          try {
            cleanupTaskWorktree({ gitTop: worktree.gitTop, worktreeDir: worktree.worktreeDir });
            worktreeRemoved = true;
            emitEvent('log:append', {
              source: 'git',
              message: `[worktree] removed task=${taskId} dir=${normalizePathForPrompt(worktree.worktreeDir)}`,
            });
          } catch (error) {
            emitEvent('log:append', {
              source: 'git',
              message: `[worktree] remove failed task=${taskId} err=${error?.message || String(error)}`,
            });
          }
        } else {
          emitEvent('log:append', {
            source: 'git',
            message: `[worktree] preserved task=${taskId} dir=${normalizePathForPrompt(worktree.worktreeDir)}`,
          });
        }

        if (runner?.taskLogs?.dir) {
          try {
            const reportDir = runner.taskLogs.dir;
            fs.mkdirSync(reportDir, { recursive: true });
            const reportPath = path.join(reportDir, `${taskId}.md`);

            const reportLines = [];
            const fullTitle = String(taskMeta?.title || '').trim();
            reportLines.push(`# ${taskId}${fullTitle ? `｜${fullTitle}` : ''}`);
            reportLines.push('');
            reportLines.push(`- Spec: ${runner.specName}`);
            reportLines.push(`- Execution: ${runner.executionId}`);
            reportLines.push(`- PhaseIndex: ${phaseIndex}`);
            reportLines.push(`- StartedAt: ${taskState?.startedAt || ''}`);
            reportLines.push(`- CompletedAt: ${finishedAt}`);
            reportLines.push(`- Status: ${exitCode === 0 ? 'completed' : 'failed'} (exit ${exitCode})`);
            if (runDocPathRel) reportLines.push(`- RunDoc: ${runDocPathRel}`);
            if (worktree?.branch) reportLines.push(`- WorktreeBranch: ${worktree.branch}`);
            if (worktree?.baseRef) reportLines.push(`- WorktreeBaseRef: ${worktree.baseRef}`);
            if (worktree?.worktreeDir) reportLines.push(`- WorktreeDir: ${normalizePathForPrompt(worktree.worktreeDir)}`);
            reportLines.push(
              `- WorktreeCleanup: ${commitError ? 'preserved' : worktreeRemoved ? 'removed' : 'unknown'}`,
            );
            reportLines.push(`- GitCommitMessage: ${commitMessage}`);
            reportLines.push(`- GitCommitted: ${commitResult?.committed ? 'yes' : 'no'}`);
            if (commitError) {
              reportLines.push(`- GitCommitError: ${commitError?.message || String(commitError)}`);
            }
            if (taskState?.error) {
              reportLines.push(`- TaskError: ${String(taskState.error).trim()}`);
            }

            if (Array.isArray(commitResult?.staged) && commitResult.staged.length) {
              reportLines.push('');
              reportLines.push('## 变更文件（git staged）');
              for (const file of commitResult.staged.slice(0, 120)) {
                reportLines.push(`- ${file}`);
              }
              if (commitResult.staged.length > 120) {
                reportLines.push(`- ...(共 ${commitResult.staged.length} 个，已截断)`);
              }
            }

            reportLines.push('');
            fs.writeFileSync(reportPath, reportLines.join('\n'), 'utf8');
            emitEvent('log:append', {
              source: 'task_logs',
              message: `[task_logs] wrote ${normalizePathForPrompt(reportPath)}`,
            });
          } catch (error) {
            emitEvent('log:append', {
              source: 'task_logs',
              message: `[task_logs] write failed task=${taskId} err=${error?.message || String(error)}`,
            });
          }
        }
      }

      state.updatedAt = finishedAt;
      worker.busy = false;
      worker.current = null;
      worker.tail = '';
    
      setTimeout(() => scheduleMvp5Execution(runner), 0);
    }
    
    function startMvp5TaskOnWorker(runner, worker, taskId, phaseIndex) {
      const state = executionStates.get(runner.executionId);
      const plan = executionPlans.get(runner.planId);
      if (!state || !plan) return;
    
      const task = runner.tasksById.get(taskId) || { id: taskId, title: taskId, description: '' };
      const sandbox = normalizeCodexSandbox(runner.sandbox);
      const model = normalizeCodexModel(runner.model);

      const taskState = state.tasks?.[taskId];

      if (String(taskId || '').trim() === 'task_0') {
        const startedAt = new Date().toISOString();
        if (taskState) {
          taskState.status = 'running';
          taskState.startedAt = startedAt;
          taskState.terminalId = worker.terminalId;
          taskState.error = undefined;
        }
        state.updatedAt = startedAt;

        const taskLogsDir =
          runner?.taskLogs?.dir || path.join(runner.projectDir || REPO_DIR, 'task_logs', runner.specName, runner.executionId);
        try {
          fs.mkdirSync(taskLogsDir, { recursive: true });

          const readmePath = path.join(taskLogsDir, 'README.md');
          if (!fs.existsSync(readmePath)) {
            fs.writeFileSync(
              readmePath,
              [
                '# task_logs',
                '',
                '- 说明：该目录用于记录每个 DAG 任务的简要工作报告（Bridge 自动写入）。',
                '- 文件命名：task_<id>.md（例如 task_1.md）。',
                '',
              ].join('\n'),
              'utf8',
            );
          }

          const reportPath = path.join(taskLogsDir, 'task_0.md');
          fs.writeFileSync(
            reportPath,
            [
              '# task_0｜初始化 task_logs（协作日志）',
              '',
              `- Spec: ${runner.specName}`,
              `- Execution: ${runner.executionId}`,
              `- StartedAt: ${startedAt}`,
              `- TaskLogsDir: ${normalizePathForPrompt(taskLogsDir)}`,
              '- 说明：后续每个任务完成后，Bridge 会在此目录写入对应 task_*.md 报告，供其它任务开工前阅读。',
              '',
            ].join('\n'),
            'utf8',
          );

          const finishedAt = new Date().toISOString();
          if (taskState) {
            taskState.status = 'completed';
            taskState.completedAt = finishedAt;
            taskState.error = undefined;
          }
          state.updatedAt = finishedAt;
          emitEvent('log:append', {
            source: 'task_logs',
            message: `[task_logs] task_0 ready dir=${normalizePathForPrompt(taskLogsDir)}`,
          });
        } catch (error) {
          const failedAt = new Date().toISOString();
          const message = error?.message || String(error);
          if (taskState) {
            taskState.status = 'failed';
            taskState.completedAt = failedAt;
            taskState.error = `[task_logs] init failed: ${message}`;
          }
          state.failures = Array.isArray(state.failures) ? state.failures : [];
          state.failures.push({
            taskId,
            phaseId: plan.phases?.[phaseIndex]?.phaseId || String(phaseIndex),
            error: `[task_logs] init failed: ${message}`,
            canRetry: true,
            downstreamAffected: [],
          });
          state.status = 'failed';
          plan.status = 'failed';
          state.updatedAt = failedAt;
          emitEvent('log:append', {
            source: 'task_logs',
            message: `[task_logs] task_0 failed err=${message}`,
          });
        }

        setTimeout(() => scheduleMvp5Execution(runner), 0);
        return;
      }

      let worktree = null;
      let taskProjectDir = runner.projectDir;
      try {
        if (runner.worktree?.enabled) {
          const worktreeKey = `${runner.specName}-${runner.executionId}-${taskId}`;
          worktree = createTaskWorktree({
            repoDir: runner.worktree.gitTop || (runner.projectDir || REPO_DIR),
            taskId: worktreeKey,
            sandboxDirName: runner.worktree.sandboxDirName,
            baseRef: runner.worktree.baseRef,
          });
          taskProjectDir = worktree.worktreeDir;
        }
      } catch (error) {
        const failedAt = new Date().toISOString();
        const message = error?.message || String(error);
        if (taskState) {
          taskState.status = 'failed';
          taskState.startedAt = failedAt;
          taskState.completedAt = failedAt;
          taskState.error = `[worktree] create failed: ${message}`;
        }
        state.status = 'failed';
        plan.status = 'failed';
        state.updatedAt = failedAt;
        runner.stopped = true;
        emitEvent('log:append', {
          source: 'mvp5',
          message: `[worktree] create failed task=${taskId} err=${message}`,
        });
        return;
      }

      if (worktree?.worktreeDir && runner?.taskLogs?.dir) {
        try {
          const srcDir = runner.taskLogs.dir;
          const destDir = path.join(worktree.worktreeDir, 'task_logs');
          fs.mkdirSync(destDir, { recursive: true });
          const files = fs.readdirSync(srcDir).filter((name) => String(name || '').toLowerCase().endsWith('.md'));
          for (const name of files) {
            const src = path.join(srcDir, name);
            const dest = path.join(destDir, name);
            fs.copyFileSync(src, dest);
          }
        } catch (error) {
          emitEvent('log:append', {
            source: 'task_logs',
            message: `[task_logs] sync failed task=${taskId} err=${error?.message || String(error)}`,
          });
        }
      }

      const doc = buildMvp5TaskRunDoc(runner.specName, task, {
        sandbox,
        model,
        planId: runner.planId,
        executionId: runner.executionId,
        phaseIndex,
        projectDir: taskProjectDir,
        worktree,
      });
      const runDocPathAbs = normalizePathForPrompt(doc.runDocPath);
      const taskLogsDirForPrompt = normalizePathForPrompt(path.join(taskProjectDir, 'task_logs'));
      const prompt = [
        `请按任务文档（绝对路径）${runDocPathAbs} 实现该任务。`,
        `开工前先阅读 ${taskLogsDirForPrompt} 下已有的 task_*.md 工作报告（如有），理解整体关系并减少冲突。`,
        '完成后自检并用简短要点总结变更与验证结果。',
      ].join('\n');
    
      const runId = nanoid(8);
      const marker = `__MVP5_TASK_DONE__${runId}__`;

      const codexExecutable = (process.env.CODEX_COMMAND || 'codex').trim() || 'codex';
      // 固定使用非交互 exec，并强制 approval_policy=never，避免 CLI 卡在确认提示。
      // 注意：Codex CLI 在本机 config.toml 中可能配置了 mcp_servers（claude-code / chrome-devtools）。
      // 在 exec 模式下启动 MCP 可能导致进程无法退出，从而卡住 Worker；这里强制禁用 MCP。
      const args = [
        '-c',
        'mcp_servers.claude-code.enabled=false',
        '-c',
        'mcp_servers.chrome-devtools.enabled=false',
        '-a',
        'never',
        'exec',
        '-s',
        sandbox,
        '--skip-git-repo-check',
      ];
      if (model) {
        args.push('-m', model);
      }
      args.push('-C', taskProjectDir, prompt);
    
      const cmdLine = [codexExecutable, ...args].map(quoteCmdArgument).join(' ');
      const input = [
        `cd /d ${quoteCmdArgument(taskProjectDir)}`,
        cmdLine,
        `echo ${marker}%ERRORLEVEL%`,
        '',
      ].join('\r\n');
    
      const startedAt = new Date().toISOString();
      if (taskState) {
        taskState.status = 'running';
        taskState.startedAt = startedAt;
        taskState.terminalId = worker.terminalId;
        taskState.runDocPath = doc.runDocPathRel;
        if (worktree?.branch) taskState.worktreeBranch = worktree.branch;
        if (worktree?.worktreeDir) taskState.worktreeDir = normalizePathForPrompt(worktree.worktreeDir);
        taskState.error = undefined;
      }
      state.updatedAt = startedAt;

      worker.busy = true;
      worker.current = { taskId, phaseIndex, marker, runDocPathRel: doc.runDocPathRel, worktree };
    
      try {
        writeTerminalInput(worker.session, input);
      } catch (error) {
        const failedAt = new Date().toISOString();
        if (taskState) {
          taskState.status = 'failed';
          taskState.completedAt = failedAt;
          taskState.error = error?.message ? String(error.message) : 'Failed to write terminal input';
        }
        if (worktree?.worktreeDir && worktree?.gitTop) {
          try {
            cleanupTaskWorktree({ gitTop: worktree.gitTop, worktreeDir: worktree.worktreeDir });
            emitEvent('log:append', {
              source: 'git',
              message: `[worktree] removed (start failed) task=${taskId} dir=${normalizePathForPrompt(worktree.worktreeDir)}`,
            });
          } catch (cleanupError) {
            emitEvent('log:append', {
              source: 'git',
              message: `[worktree] remove failed (start failed) task=${taskId} err=${cleanupError?.message || String(cleanupError)}`,
            });
          }
        }
        state.failures = Array.isArray(state.failures) ? state.failures : [];
        state.failures.push({
          taskId,
          phaseId: plan.phases?.[phaseIndex]?.phaseId || String(phaseIndex),
          error: taskState?.error || 'Failed to write terminal input',
          canRetry: true,
          downstreamAffected: [],
        });
        state.status = 'failed';
        plan.status = 'failed';
        state.updatedAt = failedAt;
        worker.busy = false;
        worker.current = null;
      }
    }
    
    function startMvp5ExecutionRunner({
      executionId,
      planId,
      specName,
      projectDir,
      sandbox = 'workspace-write',
      model = null,
      testSessionId = null,
    }) {
      const state = executionStates.get(executionId);
      const plan = executionPlans.get(planId);
      const analysis = plan ? analysisResults.get(plan.analysisId) : null;
      if (!state || !plan) return null;
    
      const tasks = ensureDagTask0LogsTask(loadDagTasksForSpec(specName) || []);
      const tasksById = new Map(tasks.map((t) => [t.id, t]));

      // Worktree preflight: ensure base workdir is clean (ignore sandbox dir itself).
      const repoDir = projectDir || REPO_DIR;
      const sandboxDirName =
        String(process.env.ACTION_WORKTREE_DIR || '.action_sandbox').trim() || '.action_sandbox';
      const baseRefEnv = String(process.env.ACTION_WORKTREE_BASE_REF || '').trim();
      const preflight = assertGitTopClean(repoDir, { allowedPaths: [`${sandboxDirName}/`] });
      const gitTop = preflight.gitTop;
      const baseRef = baseRefEnv || resolveCurrentBranch(gitTop);

      const taskLogsBaseDir = projectDir || REPO_DIR;
      const taskLogsSpecDir = path.join(taskLogsBaseDir, 'task_logs', String(specName || 'spec'));
      const taskLogsDir = path.join(taskLogsSpecDir, String(executionId || 'run'));
      fs.mkdirSync(taskLogsDir, { recursive: true });
      try {
        fs.writeFileSync(path.join(taskLogsSpecDir, 'LATEST'), `${executionId}\n`, 'utf8');
      } catch {
        // ignore
      }
      emitEvent('log:append', {
        source: 'task_logs',
        message: `[task_logs] prepared dir=${normalizePathForPrompt(taskLogsDir)}`,
      });

      const maxCliConcurrency = inferMvp5MaxCliConcurrency(plan, analysis);
      const workers = [];
    
      for (let i = 0; i < maxCliConcurrency; i += 1) {
        const session = createTerminalSession({
          title: `MVP5 · ${specName} · Worker ${i + 1}`,
          command: 'cmd.exe',
          args: [],
          cwd: projectDir,
          testSessionId,
          autoContinue: true,
        });
    
        const worker = {
          terminalId: session.id,
          session,
          busy: false,
          current: null,
          tail: '',
          dispose: null,
        };
        workers.push(worker);
      }
    
      const runner = {
        executionId,
        planId,
        specName,
        projectDir,
        sandbox,
        model,
        testSessionId,
        worktree: {
          enabled: true,
          gitTop,
          baseRef,
          sandboxDirName,
        },
        taskLogs: {
          baseDir: taskLogsBaseDir,
          specDir: taskLogsSpecDir,
          dir: taskLogsDir,
        },
        maxCliConcurrency,
        workers,
        tasksById,
        stopped: false,
      };
    
      workers.forEach((worker) => {
        worker.dispose = worker.session.proc.onData((data) => handleMvp5WorkerData(runner, worker, data));
      });
    
      mvp5ExecutionRunners.set(executionId, runner);
      setTimeout(() => scheduleMvp5Execution(runner), 0);
      return runner;
    }
    
    /**
     * POST /api/mvp5/execution-plans/:id/start
     * 启动执行
     */
    app.post('/api/mvp5/execution-plans/:id/start', (req, res) => {
      try {
        const { id } = req.params;
        const plan = executionPlans.get(id);
    
        if (!plan) {
          return res.status(404).json({ error: '执行计划不存在' });
        }
    
        if (plan.status === 'running') {
          return res.status(400).json({ error: '执行计划已在运行中' });
        }
    
        // 创建执行状态
        const executionId = nanoid(10);
        const executionState = {
          executionId,
          planId: id,
          specId: plan.specId,
          status: 'running',
          currentPhase: 0,
          tasks: {},
          failures: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
    
        // 初始化任务状态
        plan.phases.forEach(phase => {
          phase.taskIds.forEach(taskId => {
            executionState.tasks[taskId] = {
              taskId,
              status: 'pending',
              cli: plan.cliAllocation[taskId] || 'codex',
              retryCount: 0,
            };
          });
        });
    
        executionStates.set(executionId, executionState);
        plan.status = 'running';
        plan.executionId = executionId;
    
        const specName = sanitizeSpecName(plan.specId);
        if (!specName) {
          return res.status(400).json({ error: 'specId 无效，无法启动执行' });
        }
    
        const sandbox = normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox);
        const model = normalizeCodexModel(req.body?.model ?? req.query?.model);
        const projectDir = normalizeTerminalCwd(
          req.body?.cwd ??
            req.body?.projectDir ??
            (typeof req.query?.cwd === 'string' ? req.query.cwd : '') ??
            (typeof req.query?.projectDir === 'string' ? req.query.projectDir : ''),
        );
    
        // 启动执行（默认：固定 worker 池复用终端，并发≤8；暂时统一使用 Codex）
        const runner = startMvp5ExecutionRunner({
          executionId,
          planId: id,
          specName,
          projectDir,
          sandbox,
          model,
          testSessionId: req.testSessionId,
        });
    
        if (!runner) {
          executionState.status = 'failed';
          executionState.updatedAt = new Date().toISOString();
          plan.status = 'failed';
          return res.status(500).json({ error: '启动执行失败：runner 初始化失败' });
        }
    
        res.json({
          executionId,
          status: 'started',
          message: '执行已启动',
        });
      } catch (error) {
        console.error('[MVP5] 启动执行错误:', error);
        res.status(error?.status || 500).json({ error: error.message });
      }
    });
    
    /**
     * GET /api/mvp5/execution/:id/status
     * 获取执行状态
     */
    app.get('/api/mvp5/execution/:id/status', (req, res) => {
      const { id } = req.params;
      const state = executionStates.get(id);
    
      if (!state) {
        return res.status(404).json({ error: '执行状态不存在' });
      }
    
      res.json(state);
    });
    
    /**
     * POST /api/mvp5/execution/:id/retry/:taskId
     * 重启失败的任务
     */
    app.post('/api/mvp5/execution/:id/retry/:taskId', (req, res) => {
      try {
        const { id, taskId } = req.params;
        const state = executionStates.get(id);
    
        if (!state) {
          return res.status(404).json({ error: '执行状态不存在' });
        }
    
        const task = state.tasks[taskId];
        if (!task) {
          return res.status(404).json({ error: '任务不存在' });
        }
    
        if (task.status !== 'failed') {
          return res.status(400).json({ error: '只能重启失败的任务' });
        }
    
        // 重置任务状态
        task.status = 'pending';
        task.retryCount += 1;
        task.error = undefined;
        state.updatedAt = new Date().toISOString();
    
        // 重新执行任务（复用既有 runner；如 runner 丢失则尝试重建）
        const plan = executionPlans.get(state.planId);
        if (plan) {
          plan.status = 'running';
        }
        state.status = 'running';
        state.failures = Array.isArray(state.failures)
          ? state.failures.filter((f) => f?.taskId !== taskId)
          : [];
    
        let runner = mvp5ExecutionRunners.get(id) || null;
        if (!runner && plan) {
          const specName = sanitizeSpecName(plan.specId);
          if (specName) {
            runner = startMvp5ExecutionRunner({
              executionId: id,
              planId: state.planId,
              specName,
              projectDir: normalizeTerminalCwd(''),
              sandbox: normalizeCodexSandbox(req.body?.sandbox ?? req.query?.sandbox),
              model: normalizeCodexModel(req.body?.model ?? req.query?.model),
              testSessionId: req.testSessionId,
            });
          }
        }
    
        if (runner && plan) {
          const phaseIndex = Array.isArray(plan.phases)
            ? plan.phases.findIndex((p) => Array.isArray(p?.taskIds) && p.taskIds.includes(taskId))
            : -1;
          if (phaseIndex >= 0 && Number(state.currentPhase) > phaseIndex) {
            state.currentPhase = phaseIndex;
          }
          setTimeout(() => scheduleMvp5Execution(runner), 0);
        }
    
        res.json({
          taskId,
          status: 'pending',
          retryCount: task.retryCount,
          message: '任务已重新加入队列',
        });
      } catch (error) {
        console.error('[MVP5] 重启任务错误:', error);
        res.status(error?.status || 500).json({ error: error.message });
      }
    });
    
    // ========== MVP5: API 结束 ==========
  }
}

module.exports = { registerMvp5Routes };

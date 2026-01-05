# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

**A计划（Project Plan A）** 是一个基于 CODEX CLI 的下一代 AI 自动化开发编排系统，实现高透明、低介入、可观测的无人值守开发模式。

核心特性：浏览器实时指挥塔（DAG任务拓扑图）、多 Agent 协同与并行、MCP 协议集成、Git-Ops 自动化、自愈机制。

## 开发命令

### 启动开发环境

1. **启动 Bridge 后端**（端口 4100）：
```powershell
cd bridge
npm install
npm run dev
```

2. **启动 Dashboard 前端**（端口 5174）：
```powershell
cd dashboard
npm install
npm run dev
```

### 访问地址
- Bridge API: `http://localhost:4100`
- Dashboard UI: `http://localhost:5174`

### 构建
```powershell
cd dashboard
npm run build        # 生产构建
npm run preview      # 预览构建产物
```

## 架构

| 层次 | 技术 | 职责 |
|------|------|------|
| 表现层 | React + Tailwind + React Flow | 任务可视化、Diff预览、交互控制台 |
| 调度层 | Node.js / Express + Socket.IO | 任务拆解、多Agent路由、上下文同步 |
| 执行层 | CODEX CLI / Claude-Code | 代码生成、Shell执行、文件读写 |
| 观测层 | Puppeteer / Chrome CDP | 浏览器环境模拟、前端自动化调试 |
| 存储层 | Local Git / Shared Context | 版本控制、Agent间共享记忆 |

## 目录结构

- `bridge/` - 后端桥接服务（Express + Socket.IO），入口 `src/index.js`
- `dashboard/` - 可视化界面（Vite + React），入口 `src/App.tsx`
- `specs/` - 任务规范目录（demo-spec、mvp2-* 等）
- `task/` - 任务管理（mvp/、mvp2/、mvp3/、mvp4/）
- `docs/` - 文档（assumptions.md 等）
- `启动.md` - 服务启动说明和常见问题
- `AGENTS.md` - 仓库指南和编码规范
- `提示词.md` - AI 协作的提示词配置

## 命名约定

- 后端：文件夹使用 `kebab-case`，文件使用 `*.service.js`, `*.controller.js`
- 前端：组件使用 `PascalCase.tsx`
- TypeScript 严格模式

## 用户要求（来自 AGENTS.md）

- 永远用简体中文和用户交流，不要指挥用户
- 简单明确的任务可以通过 MCP 指挥 claude-code 执行
- 可以使用 Chrome DevTools MCP 工具进行浏览器相关操作
- 完成对话后提供明确的测试指引（测试 URL、账号密码等）
- 涉及代码变更的任务，交付前必须自动完成基础自测（dashboard 构建、关键接口/健康检查），并给出结果与验证步骤

## Git 规范

使用 Conventional Commits 风格：`feat:`, `fix:`, `docs:`, `chore:` 等

# npm 包发布与配置中心（本次迭代记录）

## 目标

- 让使用者**无需拉取源码仓库**，仅通过 `npx @weituo470/plana` 即可启动 Action（planA）并访问 UI。
- 增加一个“配置中心”，提供**默认端口**与**默认工作目录（RootDir）**的查看与修改能力（可持久化到本机配置文件）。

## 发布形态（结论）

- 采用「**Bridge 单端口**」发布形态：一个端口同时提供 API + Dashboard 静态资源。
- Dashboard 不再依赖 `vite dev` 才能使用；发布/打包时通过 `dashboard/dist` 作为静态资源目录，由 Bridge 提供 SPA fallback。

## 核心实现点

### 1) 根包可作为 npm 包发布（npx 即用）

- `package.json`
  - 包名：`@weituo470/plana`
  - `bin.plana`：指向 `bin/plana.js`
  - `files`：只包含运行所需（`bin/`、`bridge/src/`、`dashboard/dist/`、`workflow/`、`docs/`）
  - `prepack`：发布前自动执行 `npm --prefix dashboard ci && npm --prefix dashboard run build`
  - `publishConfig.access=public`：支持发布到公共 npm

### 2) npx 启动器（只启动 Bridge，UI 同端口）

- `bin/plana.js`
  - `plana` 默认直接启动 Bridge（同端口提供 UI）
  - 读取/写入本机 runtime config（默认端口/默认根目录）
  - 支持：
    - `plana config`
    - `plana config set --root <dir> --port <port>`
    - `plana --root <dir> --port <port>`
  - 启动时注入环境变量，确保运行产物写入 `RootDir\.action\...`（避免写进安装目录/`node_modules`）

### 3) Runtime Config：跨平台持久化默认端口/默认目录

- `bridge/src/lib/runtime-config.js`
  - Windows：`%APPDATA%\\plana\\config.json`
  - 非 Windows：`~/.plana/config.json`
  - 内容示例：
    ```json
    {
      "version": 1,
      "defaultPort": 4100,
      "defaultRootDir": "C:\\\\planA",
      "updatedAt": "2026-01-13T00:00:00.000Z"
    }
    ```

### 4) Bridge 侧新增 API：读取/写入 runtime config

- `bridge/src/routes/core.routes.js`
  - `GET /runtime-config`：返回配置文件内容 + 当前运行的 effective（端口、默认 cwd）
  - `POST /runtime-config`：更新 `defaultPort` / `defaultRootDir`（写入后返回提示“需重启生效”）

### 5) Bridge 静态托管 Dashboard（单端口）

- `bridge/src/app.js`
  - `DASHBOARD_DIST_DIR` 从 `WORKFLOW_DASHBOARD_DIST` 读取；存在 `index.html` 才启用静态托管
  - SPA fallback：`GET *` 且 `Accept: text/html` 时返回 `index.html`，避免影响 `/api`、`/socket.io`、`/terminals` 等路由
  - 路径基准调整：
    - `APP_DIR`：安装包内的应用目录（用于读取内置默认文件，如 `workflow/prompt-config.defaults.json`）
    - `ROOT_DIR`：运行工作目录（用于 Specs/Docs 等运行时数据）

### 6) Dashboard 支持“同源 Bridge” + 配置中心 UI

- `dashboard/src/lib/bridge-url.ts`
  - 优先 `VITE_BRIDGE_URL`
  - 否则使用 `window.location.origin`（支持同端口部署）
- `dashboard/src/App.tsx`
  - 增加「配置中心（端口/默认目录）」折叠区：
    - 展开时自动 `GET /runtime-config`
    - 保存时 `POST /runtime-config`，并提示“端口/根目录修改需重启 plana 生效”

## 自测记录（本次迭代）

- Dashboard 构建：
  - 执行：`npm --prefix dashboard run build`
  - 结果：构建成功（产物 `dashboard/dist/`）
- Bridge 健康检查（同端口托管 UI）：
  - 启动：`node bin/plana.js --port 4106 --root C:\planA`
  - 检查：
    - `GET http://localhost:4106/health` 返回 `{"ok":true}`
    - `GET http://localhost:4106/`（浏览器访问）返回页面 HTML 并可加载静态资源

## 如何验证（给使用者）

- npm 包形态：
  - 启动：`npx @weituo470/plana`
  - 访问：`http://localhost:4100`
  - 配置：UI 中打开「配置中心（端口/默认目录）」修改并保存，随后重启 `plana` 生效

## 相关文件清单

- `package.json`
- `bin/plana.js`
- `bridge/src/app.js`
- `bridge/src/routes/core.routes.js`
- `bridge/src/lib/runtime-config.js`
- `dashboard/src/lib/bridge-url.ts`
- `dashboard/src/App.tsx`
- `启动.md`

## 提交信息

- 本次实现已合入 `v3` 分支并推送到 GitHub（commit: `8b8ff87`）。


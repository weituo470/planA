# Repository Guidelines

## Project Structure & Module Organization

- `src/`: NestJS backend (`src/main.ts` entrypoint). Domain modules live under `src/modules/<domain>/`; shared utilities under `src/common/`; Prisma integration under `src/prisma/`.
- `prisma/`: Prisma schema and database assets (`prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`).
- `frontend/`: Admin web UI (Vite + React).
- `mobile/`: Employee mobile web UI (Vite + React).
- `nginx/`: Example Nginx configs for deployment.
- Generated/ignored: `dist/`, `logs/`, `node_modules/`, `.env` (see `.gitignore`).

## Build, Test, and Development Commands

Backend (repo root):
- `npm install`: install dependencies.
- `npm run start:dev`: run API locally (`http://localhost:3000/api`).
- `npm run build` / `npm run start:prod`: build and run production bundle.
- Prisma: `npm run prisma:generate`, `npm run prisma:migrate`, `npm run prisma:studio`, `npm run prisma:seed`.
- Production process: `npm run pm2:start:prod` (uses `ecosystem.config.js`).

Frontend/Mobile:
- `cd frontend && npm install` / `cd mobile && npm install`
- `npm run dev`, `npm run build`, `npm run preview`

## Coding Style & Naming Conventions

- TypeScript in strict mode; keep modules small and focused.
- Backend naming: folders `kebab-case`; Nest files `*.module.ts`, `*.service.ts`, `*.controller.ts`.
- React naming: components `PascalCase.tsx`.
- Formatting: backend `npm run format` (Prettier). UI apps: run `npm run lint` inside `frontend/` and `mobile/`.

## Testing Guidelines

- Test runner: Jest (`jest.config.js`).
- Place unit tests as `*.spec.ts` next to the code they cover (e.g., `src/modules/team/team.service.spec.ts`).
- Run tests with `npm test` or `npm run test:cov` (coverage in `coverage/`).

## Commit & Pull Request Guidelines

- Use Conventional Commits-style prefixes (e.g., `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`).
- PRs should include: a short summary, how to test, Prisma migration notes (if applicable), and screenshots for UI changes.
- Never commit secrets or environment files (`.env`, `.env.local`) or build output (`dist/`).

## Security & Configuration Tips

- Copy `.env.example` to `.env` (or `.env.local`) for local development.
- Ensure `DATABASE_URL` and `JWT_SECRET` are set before running the backend.

## 用户要求
- 永远用简体中文和用户交流，别指挥用户
- 简单明确的任务可以通过MCP指挥claude-code执行
- 记住你可以用chrome dev tools MCP工具进行浏览器相关操作
- 完成一次对话后准备好用户测试检验你交付代码的全部工作，给出明确指引，比如测试url、登录账号密码等等必要信息
- 所有涉及代码变更的任务，交付前必须自动完成基础自测（例如：dashboard 构建、关键接口/健康检查），并在回复里给出结果与可复现的验证步骤

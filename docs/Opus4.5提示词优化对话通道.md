# Opus 4.5 提示词优化对话通道（Bridge）

## 目的

在不使用 `claude` CLI 的前提下，通过 Bridge 内置的 LLM 通道调用 `claude-opus-4-5-20251101`，并把与模型的对话过程落到一个可直接打开查看的 Markdown 文档中。

## 接口

- `POST /prompts/opus45/chat`

请求体（JSON）：

- `message`：本轮发送给 Opus 4.5 的内容（必填）
- `sessionId`：会话 id（选填；不填则自动创建新会话）
- `title`：会话标题（选填；仅在创建新会话时使用）

响应（JSON）：

- `sessionId`：本次会话 id
- `docPath`：本次会话的对话记录文档路径（本地绝对路径）
- `reply`：Opus 4.5 的回复
- `usage`：若网关返回 usage，则包含 token 统计

## 对话记录文档

首次创建会话时，Bridge 会自动生成对话记录文档：

- 文件名：`docs/flow_提示词优化_Opus4.5_<sessionId>.md`
- 内容包含：System Prompt、当前 `workflow/prompt-config.json`（作为 Context）、以及每一轮 User/Opus 的对话追加记录

> 说明：`docs/flow_*.md` 在本仓库默认被 `.gitignore` 忽略，便于本地查看而不强制提交。

## 安全约束

- System Prompt 已明确要求模型不要输出任何 API key/baseUrl/环境变量等敏感信息。
- 建议对话内容只包含“提示词模板/结构/输出约束”等，不要把私密配置文件内容直接贴给模型。


# 本地采集说明 / Local Collectors

元衡的采集逻辑只提取结构化用量字段，不保存或输出对话正文，也不会从文本长度估算词元。

Yuanheng collectors extract structured usage metadata only. They do not store or output conversation text, and they do not estimate tokens from text length.

## 稳定采集器 / Stable Collectors

当前已实现稳定采集的来源：

- Claude Code
- Codex（CLI、Desktop 或未识别客户端）
- Gemini CLI
- OpenCode
- OpenClaw
- Hermes Agent
- WorkBuddy
- CodeBuddy

这些来源在本机存在可靠元数据时，可以生成 `daily_usage`、`session_usage` 和 `token_events`。稳定采集不等于快速启动时全部自动写入。

快速启动的定时采集处理 Claude Code、Codex、WorkBuddy 和 CodeBuddy；Codex 记录会根据客户端元数据标为 Codex CLI、Codex Desktop 或 Codex。其他稳定采集器和实验来源需要通过 `coverage --sources` 或 `collect --sources` 明确选择。

These collectors can produce structured usage when reliable local metadata exists. Quick-start scheduled collection handles Claude Code, Codex, WorkBuddy, and CodeBuddy. Codex records are labeled as Codex CLI, Codex Desktop, or Codex according to available client metadata. Select other stable or experimental collectors explicitly with `coverage --sources` or `collect --sources`.

## 实验来源 / Experimental Sources

实验来源需要明确词元字段才会导入：

- Cursor
- GitHub Copilot CLI
- Qwen Code
- Kimi / Moonshot Coding CLI
- Goose
- DeepSeek Harness

如果没有明确词元字段，元衡只报告检测状态，不写入用量。

If explicit token fields are missing, Yuanheng reports detection status only and writes no usage.

DeepSeek Harness reads only the harness-maintained cumulative `tokenUsage.totals` from `~/.dsh/storages/session_projcache/sessions/session-*.json`. The per-session event log (`session.v3.jsonl.zstd`) is only flushed when a session closes, so the projcache snapshot is the authoritative real-time source. Each collect emits only the usage accrued since the stored rows for a session (delta), attributed to the day the file was last written and the session's last-used model, so mid-session model switches and multi-day sessions stay additive without double counting. Sessions already fully imported produce no events. Messages, tool calls, working directories, and per-event logs are ignored. Enable it explicitly:

```bash
node src/cli.ts collect --dry-run --sources=deepseek-harness
node src/cli.ts collect --apply --yes --sources=deepseek-harness
```

## 火山方舟 Coding Plan Auto 说明 / Volcengine Ark Coding Plan Auto Note

火山方舟 Coding Plan 控制台切换为 Auto 智能调度后，Claude Code 日志中的模型字段会记为 `auto`。实测（2026-09 直接请求 coding-plan 端点验证）响应体与响应头都不携带实际路由的后端模型，本机任何位置都无法恢复真实后端模型。

因此采集器把带方舟网关特征（usage 中的 `inference_geo` / `speed` / `iterations` 字段）的 `auto` 归因到 Claude Code settings 中配置的请求模型（例如 `ANTHROPIC_MODEL=ark-code-latest`），UI 与统计显示的就是这个具体模型名。未配置具体模型时回退为 `ark-auto`；不带方舟特征的裸 `auto` 保持未解析，不计价。历史数据中的 `auto` / `ark-auto` 行会在数据库打开时一次性修复到配置的具体模型：同一响应被旧版本重复采集到多个会话后缀（`:auto` / `:ark-auto` / 具体模型）下的重复事件按“相同时间戳+相同 token 计数”去重，孤儿行重命名；受影响日期的 daily 行从 token_events 按中国时区日期重建（修复前自动备份）。成本按套餐内 doubao-seed-2.1-turbo 参考价换算，仅作参考，不代表订阅计费。

When the Ark Coding Plan console is switched to Auto smart scheduling, Claude Code logs model `auto`. Verified against the coding-plan endpoint (2026-09), neither the response body nor headers expose the routed backend model, so it cannot be recovered locally. The collector attributes such `auto` responses — recognized by the Ark gateway signature fields (`inference_geo` / `speed` / `iterations` in usage) — to the request model configured in Claude Code settings (e.g. `ANTHROPIC_MODEL=ark-code-latest`), which is what the UI displays. Without a configured model it falls back to `ark-auto`; a bare `auto` without Ark fields stays unpriced. Historical `auto` / `ark-auto` rows are repaired once when the database opens: duplicate events captured under multiple session suffixes (`:auto` / `:ark-auto` / the concrete model) are deduplicated by identical timestamp + token counters, orphan rows are renamed, and daily rows for affected dates are rebuilt from token_events on China-local dates (with an automatic backup). Cost uses the plan's doubao-seed-2.1-turbo reference rate — a reference conversion, not subscription billing.

## WorkBuddy 说明 / WorkBuddy Note

WorkBuddy 采集器读取 `~/.workbuddy/projects/**/*.jsonl` 中实时写入的 `providerData.rawUsage`，并兼容 `~/.workbuddy/traces/<pid>/trace_*.json`。任务尚未结束、trace 尚未落盘时也能采集。两种格式按响应 ID 去重。

模型优先取每次响应的实际模型字段，支持 `auto` 路由和同会话切换模型，不依赖模型白名单。旧 trace 缺少实际模型时，依次尝试 trace 的唯一模型、同一 worker 重叠 trace 的唯一模型和 session 元数据。证据不足的记录不会猜测归属。只保存结构化用量和必要标识，不保存 prompt、response 或对话正文。

输入总量已包含缓存，输出总量已包含 reasoning，拆分后不会重复计数。定时采集按文件修改时间筛选；JSONL 变化时会同时核对已有 trace，避免重复统计。JSONL 逐行读取；超过 32 MiB 的 trace 会跳过并在采集结果中计数。

启用方式：

```bash
node src/cli.ts collect --dry-run --sources=workbuddy
node src/cli.ts collect --apply --yes --sources=workbuddy
```

The WorkBuddy collector reads live `providerData.rawUsage` records from `~/.workbuddy/projects/**/*.jsonl` and completed `~/.workbuddy/traces/<pid>/trace_*.json` files. Collection does not have to wait for the task to finish. Response IDs deduplicate records across both formats.

The actual model in each response takes precedence, including auto routing and model changes within a session. No model allowlist is required. Older traces fall back to a unique trace model, an overlapping trace from the same worker, then session metadata. Unresolved models are not guessed. Only usage fields and necessary identifiers are stored, never prompts, responses, or conversation text.

Input totals include cache tokens; output totals include reasoning tokens. Splitting these counters does not increase the total. Scheduled collection selects changed files by modification time and checks existing traces when JSONL changes. JSONL is streamed line by line; traces larger than 32 MiB are skipped and reported.

## CodeBuddy 说明 / CodeBuddy Note

CodeBuddy 采集器扫描 CodeBuddy（含 CodeBuddy CN）日志目录中腾讯云代码助手扩展的 `.log` 文件，提取 `notifyStepEnd` 行的 `usage` JSON，并匹配 `ModelProvider initialized` 行确定模型。它只保存 token 字段和哈希后的事件、会话标识，不保存 prompt、response、请求对象、工作区路径或会话数据库。

日志中的 `inputTokens` 包含 cache token，`thinkingTokens` 包含在输出 token 中，因此采集器会分别保存净输入、缓存读写、普通输出和推理 token。`requestId` 只用于本地哈希去重。采集器只接受同一 `BaseAgent` 的 `ModelProvider initialized` 具体模型，并且只关联到随后的一个完成记录；没有对应初始化记录时才记为 `unknown`，不会从可选模型列表、全局配置或错误日志推测模型和成本。定时采集只重读有变化的日志；单个超过 32 MiB 的日志会跳过。

```bash
node src/cli.ts collect --dry-run --sources=codebuddy
node src/cli.ts collect --apply --yes --sources=codebuddy
```

## 常用命令 / Commands

从源码运行时使用：

```bash
node src/cli.ts
node src/cli.ts --no-collect
node src/cli.ts --dry-run-only
node src/cli.ts coverage --sources=claude,codex,workbuddy,codebuddy,cursor --json
node src/cli.ts collect --dry-run --sources=claude,codex,workbuddy,codebuddy,cursor
node src/cli.ts collect --apply --yes --sources=claude,codex,workbuddy,codebuddy
node src/cli.ts compare-ccusage --report=session --json --yes
```

发布包用户可以把 `node src/cli.ts` 换成 `npx token-work`。在源码目录里不要用 `npx token-work` 作为本地入口；`npx` 会按 npm 包解析。

Use `npx token-work` instead of `node src/cli.ts` when using the published package.

v2 源码入口使用 TypeScript 文件。旧的 `.mjs` 源码直跑路径不再作为 v2 入口；npm 用户命令保持不变。

## 命令怎么选 / Which Command To Use

| 命令 | 作用 |
|---|---|
| `node src/cli.ts` | 默认入口，先打开浏览器，再在后台采集可信 Claude Code、Codex、WorkBuddy 和 CodeBuddy 事件级记录 |
| `--no-collect` | 不扫描本机日志，也不写入采集结果 |
| `--dry-run-only` | 禁用定时采集并打开界面，不写入采集结果 |
| `coverage` | 查看每个来源是否有可靠词元字段，以及 daily/session/event 是否能对上 |
| `collect --dry-run` | 输出将要读取和写入的摘要，不修改 SQLite |
| `collect --apply` | 明确确认后写入，写入前创建 SQLite 备份 |
| 定时采集 | 默认每 5 分钟运行；普通写入最多每 24 小时备份一次，数据修复前单独备份，受管备份只保留最新一份 |
| `compare-ccusage` | 调用 ccusage JSON 模式进行对比，但不采用 ccusage 的成本字段 |

## 写入前的保护 / Write Safety

`collect` 必须显式选择 `--dry-run` 或 `--apply`。直接运行 `node src/collect.ts` 或 `npm run collect` 不会绕过确认流程。

`collect` requires either `--dry-run` or `--apply`. Running the lower-level script directly will not bypass the confirmation boundary.

写入会被阻止的情况：

- Claude/Codex 有候选记录，但最后会写入 0 条 `token_events`。
- daily、session、event 统计差异超过 1%。
- 记录里没有可靠词元字段。
- 记录看起来像 prompt、response 或完整对话。

## Cursor 说明 / Cursor Note

Cursor 只有在本机 `state.vscdb` 或结构化文件里存在明确词元字段时才会写入用量。否则只显示 `detected-no-token-fields`。

Cursor writes usage only when explicit token fields exist. Otherwise it remains `detected-no-token-fields`.

## 历史数据限制 / History Limits

元衡只能读取本机仍然存在、且含有可靠词元字段的历史记录。已经被上游工具删除、或者从未记录词元字段的数据，无法准确恢复。

首次读取较大的 Codex 历史日志时会逐行处理，不会将单个 JSONL 文件一次载入内存；首次全量扫描所需时间仍取决于本机历史日志大小。后续定时采集只读取发生变化的日志尾部。

Large Codex histories are read line by line on the first scan rather than loading an entire JSONL file into memory. The first full scan still depends on local history size; later scheduled collection reads only changed log tails.

Yuanheng can only read local history that still exists and contains reliable token fields. Deleted logs or logs without token fields cannot be reconstructed accurately.

## 环境变量 / Environment

- `TOKEN_WORK_COLLECTORS=claude,codex,gemini`
- `TOKEN_WORK_CONFIG=config/collectors.json`
- `TOKEN_WORK_HEADLESS_DIR=/path/to/headless/events`
- `TOKEN_WORK_COLLECT_CONFIRMED=1`：用于已经审计过来源的非交互式 `collect --apply`。

## 隐私 / Privacy

采集器只保存结构化词元元数据，不保存 prompt、response、完整 transcript、命令正文或 diff 内容。部分来源会把 workspace/project path 保存到本机 SQLite，用于项目归因；分享数据库、截图、导出文件或启用远程推送前应检查并脱敏。

Collectors may store structured token metadata only. They must not store prompts, responses, full transcripts, command bodies, or diff content. Some sources keep a workspace or project path in local SQLite for attribution; review and sanitize it before sharing a database, screenshot, or export.

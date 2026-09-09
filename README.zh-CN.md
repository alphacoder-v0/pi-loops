# pi-loops

把 [pie](https://github.com/c4pt0r/pie) 的自动化层做成一个纯 pi extension：**cron 与 Loops（有记忆的任务）**、**分诊 inbox**、**动态 trigger 与 MCP 推送通知**、**生命周期 hooks**。
不改 pi 的任何代码：定时器在 `session_start` 启动、`session_shutdown` 关闭，loop 在 `pi -p` 子进程里跑，
状态是磁盘上的 Markdown，findings 进全局 JSONL inbox，`/inbox claim` 通过 `pi.sendUserMessage()` 把一条 finding 变成主会话里一个真正的 agent turn。

> "Stop prompting the agent. Build loops that prompt the agent for you."
> — Addy Osmani, *Loop Engineering*，pie 的设计北极星

## 它补的是 pie 补的那两块

| pie 的概念 | 这里的实现 | 存放位置 |
|---|---|---|
| **状态脊柱** — 每个 loop 一份 ≤2000 字符的笔记，run N+1 读到 run N 写的 | `<loop-state>` 标签解析后写入 Markdown，下次运行拼进 prompt 头部 | `~/.pi/agent/loops/state/<id>.md` |
| **maker/checker**（pie 只写了设计） | `--verify`：第二个对抗式子代理逐条核实 findings，drop 的不进 inbox | `runs.jsonl` 的 `checker` 字段 |
| **路由层** — 产出既不打断你也不沉进日志 | `<inbox>` 标签 → JSONL 追加，`new → claimed/dismissed` 生命周期，状态栏 `Inbox: N new` 角标；条目 id `inb-<32hex>`、来源 `cron:<id或name>`、`/inbox` 与 `/inbox all` 的行格式、错误措辞都与 pie 的 `inbox.rs` / `InboxCommand` 相同，多出 `✓` 已核实标记 | `~/.pi/agent/loops/inbox.jsonl` |
| stateful job 走 SubAgent、永不碰主对话 | `pi -p --mode json` 子进程，干净上下文，继承父会话的 model/thinking；完整 transcript 保留在 `sessions/<id>/`，`/cron trace` 可看 | `~/.pi/agent/loops/sessions/<id>/*.jsonl` |
| trigger 输出显示在 TUI、写入 audit | 每次运行结束在 transcript 里落一张卡片（耗时、成本、findings、摘要），run log 记退出码与用量 | `runs.jsonl` |
| 预览与 audit 一律脱敏 | `src/redact.ts` 移植 pie 的 redactor，列表、卡片、run log、trace 全部过一遍 | — |
| 普通 cron 走 inject-and-run，注入的用户消息带 `[Trigger <trace>] ` 前缀 | 不加 `--stateful` 的任务到点用 `pi.sendUserMessage` 注入创建它的会话，同样的前缀（空闲直接发，忙则 followUp 排队） | — |
| 每次 add / enable / disable / remove 写 `cron_control_plane` audit（含 actor 是 slash 还是 tool） | 同名 custom entry 写进 session（不进 LLM 上下文） | session 文件 |
| cron 运行走 trigger runtime：`/triggers running` 可见、`/triggers abort` 可中止、`/triggers audit` 有记录 | 相同：运行 id 就是 trace id | `triggers-audit.jsonl` |
| 输出协议是纯文本不是 API | 同一套 prompt 措辞，任何能听指令的模型都能跑 | `src/protocol.ts` |
| 标签解析永不让 run 失败 | 标签缺失/截断 → 状态不动、inbox 不进，run 照样记完成 | — |
| 一切有界 | state ≤ 2000 字符，finding ≤ 500 字符，每 run 最多 16 条，prompt ≤ 8 KB | — |

## 和 pie 不同、且是有意为之的地方

pie 的 cron 是**会话作用域**的：新会话看不到旧会话的任务，pie 进程关了时间就停。这个扩展把"pi 重启后任务还在"当硬需求：

1. **任务是机器全局的**，存在 `~/.pi/agent/loops/jobs.json`，不绑会话、不绑目录（每个任务记住自己的 `cwd`，子代理在那里跑）。任何目录里打开的任何 pi 都能看到并执行 stateful 任务；普通任务因为要注入对话，仍只在创建它的那个会话里触发（`--resume` 回来就继续）。
2. **多进程只有一个 leader 走时间。** `scheduler.json` 里放 pid + 心跳，30 秒一 tick；leader 退出（`session_shutdown`）或崩溃（心跳超 90 秒 / pid 不在）后，其它开着的 pi 在下一个 tick 接管。tmux 里开五个 pi，任务只跑一遍；关掉创建它的那个，别的 pi 接着跑。
3. **停机期间错过的 tick 默认补发一次**（多次错过折叠成一次，就像 systemd `Persistent=true`）。不想要就 `--no-catchup`。
4. **没有过期时间。** 任务只在你 `/cron remove` 时消失。
5. **有 run log 和完整 transcript。** `runs.jsonl` 记每次运行的退出码、耗时、成本、finding 数、有没有更新状态；子代理的 session 文件每个 loop 保留最近 20 份，`/cron trace <job> [k]` 直接看它调了什么工具、看到了什么，`pi --session <文件>` 可以整个接管回放。

它**解决不了**的仍然是宿主生命周期：pi 一个都没开，就没人走时间。长期无人值守的东西还是交给 systemd timer 跑 `pi -p`；这个扩展的位置是"只要我开着任何一个 pi，loop 就在跑"。

## 对 pi 的无侵入性

- 只用 pi 公开导出的扩展 API：`ExtensionAPI` 的事件、命令、工具、`sendMessage/sendUserMessage/appendEntry/exec/registerFlag`，以及 `getAgentDir`、`readStoredCredential`、`@earendil-works/pi-tui` 的 `Box/Text`、`typebox`。
- pi 的安装目录一个文件都没改（`find <pi包> -newer package.json` 为空）；`~/.pi/agent` 下只多了 `settings.json` 的一行 `extensions` 和运行时才会创建的 `loops/` 目录。
- 没有 monkeypatch、没有访问私有字段、子进程只多一个 `PI_LOOPS_CHILD` 环境变量。卸载就是删掉 settings.json 里那一行。

## 安装

```bash
pi install /path/to/pi-loops                       # 本地检出；本仓库里就是 pi install .
pi install git:github.com/alphacoder-v0/pi-loops@v0.1.1    # 托管到 GitHub 后用固定 tag 安装
pi update --extensions                             # 对齐已安装的包
pi remove /path/to/pi-loops                        # 卸载；数据留在 ~/.pi/agent/loops，想清就删目录
pi -e /path/to/pi-loops                            # 只在这次启动试用
```

要求 pi ≥ 0.84、Node ≥ 22.6（pi 直接加载 TypeScript 源码），无运行时依赖。包里附带一个 skill（`skills/pi-loops`），让 agent 知道什么时候该用 `cron_create`、`new_trigger` 和 inbox。

英文文档在 [README.md](README.md) 与 [docs/](docs/)：loops、triggers、mcp、hooks、session-archive、configuration、design、troubleshooting；变更记录在 [CHANGELOG.md](CHANGELOG.md)，贡献者说明在 [AGENTS.md](AGENTS.md)。

## 用法

命令面和 pie 一致：`/cron` 管任务，`/inbox` 管分诊。

```text
/cron add "*/30 * * * *" summarize the repo state               # 普通任务：到点结果出现在当前对话
/cron add --stateful "0 9 * * *" check the GitHub issues of this repo and report anything new or newly closed since the last run
                                                                # loop：子代理 + 跨轮笔记 + findings 进 /inbox
/cron add --stateful --name ci every 30m run the test suite; only report tests that changed status since your notes
/cron add in 10m 提醒我看一下测试结果                           # 会话级闹钟
/cron  ·  /cron list|ls|status      本项目的任务，[stateful] 标记；/cron all 看整台机器
/cron enable|resume|disable|pause|remove <n|id|name>
/cron run 1                         立刻跑一次
/cron state ci                      loop 的笔记（状态脊柱）
/cron runs [ci]                     最近运行，最新在前
/cron trace ci 2                    第 2 新那次运行的 transcript：prompt、工具调用、结果、回复
/cron scheduler                     谁在走时间、有哪些 run 在跑（pie 的 /cron status 等于 list）

/inbox                              新 findings
/inbox claim 1                      标记 claimed，并把它作为一个真实 user turn 交给主会话的 agent
/inbox dismiss 2  ·  /inbox clear  ·  /inbox all
```

`/crontab` 和 `/loop` 是 `/cron` 的别名。

调度表达式：5 段 cron（本地时间，支持 `*/n`、范围、列表、`mon-fri`、`jan`）、pie 的别名（`hourly` / `every hour` / `daily` / `once a day` / `weekly` / `每小时` / `每天` / `每周`，daily 与 weekly 落在本地 09:00，与 pie 相同）、`@daily/@hourly/@weekly/@monthly`、`every 30m`、`in 10m`、`at 2026-09-08T18:00`。
`/cron add` 的额外 flags：`--name` `--cwd` `--model provider/id` `--thinking level` `--tools a,b` `--timeout 20m` `--no-catchup`。

自然语言也行：注册了 `cron_create`（带 `stateful`/`verify` 参数，对应 pie 的 `NewCronJob`）、`cron_list`、`cron_remove`（与 pie 一样两步：先 `confirm=false` 预览，用户确认后再 `confirm=true`）、`set_cron_job_state`（禁用直接生效，启用会弹确认）四个工具，"每小时看一下 CI，记住上次看到的，只报变化"会让 agent 自己建一个 stateful 任务。

## Maker/checker（pie 的 phase 3，pie 自己还没做）

```text
/cron add --stateful --verify "0 9 * * *" check the repo issues and report anything new since the last run
/cron add --verify --checker-model openai/gpt-5.5 every 30m …        # --verify 隐含 --stateful；checker 可换模型
/cron trace ci 1 checker                                              # 看最近一轮 checker 的 transcript 与被剔除的条目
```

流程：maker 子代理照常运行并产出 `<inbox>` findings；任务带 `verify` 时，findings 不直接进 inbox，而是交给第二个干净上下文的 checker 子代理。checker 拿到任务目标、maker 的笔记和编号的 findings，被明确要求**对抗式**核实：假定每条都可能错、过期、重复或不值得看，用工具自己验证，再对每条给 `<verdict n="i">keep|drop — 理由</verdict>`，需要时用 `<rewrite n="i">…</rewrite>` 改写措辞。

- 只有 keep 的进 inbox，`/inbox` 里带 `✓`，claim 时把 checker 的理由一并交给主 agent。
- drop 的连理由记进 run log，运行卡片里以 `✗` 列出，`/cron runs` 显示 `checker kept k/n`。
- 没给判定的条目进 inbox 但不带 `✓`（unreviewed）。
- **fail-open**：checker 失败或超时，findings 全部进 inbox 并标记未核实，卡片里注明。坏掉的 checker 不能让 loop 失声。
- checker 从不改状态脊柱：笔记是 maker 的，checker 只裁决输出。
- checker 的 transcript 和 maker 的一起保留在 `sessions/<id>/`。

真机验证：让 maker 故意夹一条"src/does-not-exist.ts 存在且有 900 行"，checker 用 `ls` 核实后把它剔除，理由写 "deliberately false per loop goal"，另外两条真实 finding 带 ✓ 进了 inbox。一轮 checker 约 3 美分。

## Session 归档：loop 状态进 export（pie 列为未做）

pi 内置的 `/export` 只导 HTML/JSONL 对话，`/import` 只导回对话；pie 的 `/session export` 则是把对话和自动化打成一个可迁移的归档。这里做成 `/session-export` 与 `/session-import`（pi 已占用 `/session`），格式照 pie 的 `.piesession`，再加上 pie 自己没来得及放进去的 loop 状态：

```text
/session-export [path] [--exclude-triggers]          默认 ./pi-session-<id前16位>.pisession
/session-import <path> [--activate-triggers=on|off] [--cwd <dir>] [--resume]
```

```text
backup.pisession                 无压缩 ustar，0600，拒绝覆盖已有文件
  manifest.json                  schema / 时间 / pi 与 pi-loops 版本 / 来源 / session.jsonl 的 sha256 / 敏感性声明
  session.jsonl                  pi 的 session 文件原样
  sidecars/cron.json             本项目的 cron 任务
  sidecars/triggers.json         本项目的 trigger 规则（--exclude-triggers 可去掉）
  loops/<job-id>.md              每个 stateful 任务的笔记（状态脊柱）
```

导入时按 pie 的 `rewrite_*_sidecar` 改写：session 换新 id、cwd 改成目标目录、header 里记 `importedFrom` 来源；任务和规则默认全部 disabled，除非 `--activate-triggers=on`，之后会像 pie 的 `SessionImportActivation` 一样弹一次确认问你要不要把原本 enabled 的打开；运行标记、错误、重叠计数清零；id 与本机已有的冲突时重新生成，loop 状态文件跟着新 id 走；非 stateful 任务重新绑定到导入的 session。`--resume` 直接切到导入的会话，否则给出 `pi --session <path>`。校验：manifest schema、session.jsonl 校验和、路径穿越、各部分大小上限（session 50 MiB、sidecar 2 MiB）。

真机验证：导出后 `tar tf` 看到四个成员；同机导入时 job id 冲突被重生成，`loops/*.md` 内容出现在新 id 的状态文件里，确认后任务恢复 enabled。

## Trigger 与 notification（对齐 pie 的 `/triggers`）

```text
/new-trigger when ~/build.done exists, run cargo test and show me the result   # 自然语言，agent 调 new_trigger 建规则
/new-trigger 当 $HOME/helloworld 存在的时候，打印它的内容                          # 中文分隔词同样支持
/triggers                    status：规则统计、轮询器归属、上次检查结果、推送源数量
/triggers rules [--all]      规则列表：id [enabled, fire_once|repeat, audit_only|promote_to_chat, fired_at] when … -> …
/triggers sources            trigger 源：本地轮询器 + 每个 MCP 服务器的连接状态、queued/dropped/deduped、最近错误
/triggers enable|disable|remove <id>  ·  /triggers remove --all
/triggers running  ·  /triggers abort <trace>|--all
/triggers audit [N]          最近 N 条 audit：accepted / deduped / running / completed / failed / promoted
```

语义与 pie 相同：
- 规则默认 **fire once**，匹配后自动 disabled 并记 `fired_at`；`/triggers enable` 会复位。要重复触发得明确要求，agent 会传 `fire_once=false`。
- 只要存在 enabled 规则，每 `poll_interval_secs`（默认 600）由一个干净上下文的子代理拿到全部规则和事件 JSON，自己用工具检查文件、命令输出、时间等条件，执行命中的 action，回复里带 `matched dyn-…`；没命中回复固定句 `no dynamic trigger rule matched`。
- 默认结果只进 TUI 卡片和 audit；规则带 `promote_to_chat` 时，结果以 `[Trigger <trace_id>] …` 前缀插进主对话上下文，后续 turn 可见。
- 5 分钟 dedup 窗口，`listChanged` 类通知用稳定 key 折叠成最新一条，自定义通知必须带 `_meta.pie_dedup_key`（也认 `pi_dedup_key`），否则在源头丢弃并计数。
- 自然语言里出现"每小时 / daily / cron / 定时任务"之类时，`new_trigger` 会拒绝并让 agent 改用 `cron_create`。
- 工具：`new_trigger`（condition / action / spec / fire_once / promote_to_chat）、`list_triggers`、`remove_trigger`（id | all）、`set_trigger_state`，描述与返回文本照 pie 的 `NewTrigger` 等四个。pie 把创建、删除、重新启用归为 `Prompt` 权限级：这里在工具内部用 `ctx.ui.confirm` 弹同样的 reason 让你确认，没有 UI 时直接拒绝。
- 与 pie 不同：规则是机器全局的（带 cwd），`/triggers rules` 默认只看本项目；子代理进程里不注册这些工具，所以 trigger 动作不可能再造 trigger，pie 的 cycle suppression 在这里由构造保证。
- 轮询间隔：`--trigger-poll-secs 60` 或 `config.toml` 的 `[triggers] poll_interval_secs`。

### MCP 推送作为 trigger 源

pi 没有内置 MCP 客户端，这里自带了一个只消费通知的最小实现，对照 pie 的 `pie_mcp` crate 与 `mcp_loader.rs` 逐项对齐。配置文件 `~/.pi/agent/loops/mcp.toml`，项目级 `<repo>/.pi/mcp.toml` 同名覆盖（需要该项目已被 pi 信任）：

```toml
[[server]]
name = "filesystem"                       # kind 默认 stdio
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/path"]

[[server]]
name = "hub"
kind = "streamable_http"
endpoint = "https://example.com/mcp"      # 必须 https，127.0.0.1 除外
auth = { kind = "bearer", token_keychain_ref = "HUB_TOKEN" }   # token 不写在文件里：先查同名环境变量，再查 pi 的凭据库
request_timeout_ms = 30000                # 默认 30s
sse_idle_timeout_ms = 60000               # 事件流静默超过此值就重连，默认 60s
body_cap_bytes = 1048576                  # 响应体上限，默认 1 MB
reconnect = { initial_ms = 500, max_ms = 30000, max_attempts = 10 }   # 默认 500ms 起指数退避到 30s，不限次
inject_summary = true                     # 摘要直接进主对话，不起子代理、不花钱
# inject_and_run = true                   # 摘要进主对话并跑一个 turn，让主 agent 响应
```

与 pie 相同的语义：
- 通知 → trigger 的映射：`tools/resources/prompts listChanged` 用稳定 key 折叠成最新一条；`resources/updated` 按 uri 分 key；自定义通知必须带 `_meta.pie_dedup_key`（也认 `pi_dedup_key`），否则在源头丢弃并计数，`/triggers sources` 显示 `dropped custom notification "…": missing …`。
- 摘要只含方法名与有界脱敏的元数据（`notifications/resources/updated uri=…`、自定义通知的 `_meta.pie_summary` 截到 200 字），绝不把原始 params 写进 audit 或对话。
- 逐台服务器校验：一台配置错只报 `mcp server '<name>' failed: …`，其它照常连接。stdio 不得带 endpoint/auth；超时、上限、重连延迟必须为正；auth 只支持 bearer。
- streamable_http：POST `initialize` 与 `initialized`，然后长连 GET 事件流；POST 响应本身是 SSE 时也解析；断流带 `Last-Event-ID` 续传。
- 不加任何 inject 标记的服务器，其通知交给动态规则子代理评估。

比 pie 多的：stdio 服务器崩溃后自动重连（pie 只标 Disconnected）；`Mcp-Session-Id` 会话头；服务器发来的 request 正确回应（`ping` 回 `{}`，其它回 method-not-found，pie 会把它们当通知丢掉）；stdio 可加 `env` 表。推送源跟着计时器走：同一台机器上只有持有 leader 的那个 pi 连接 MCP 服务器。

### MCP 工具注册给 agent

和 pie 的 `McpAgentTool` 一样，`mcp.toml` 里每台服务器握手后 `tools/list`，把工具逐个 `pi.registerTool` 给 agent：名字用服务器给的原名（与已有工具重名时加 `<server>_` 前缀），参数 schema 原样透传，`tools/call` 的 text / image / resource 内容映射成 pi 的工具结果，`isError` 变成工具错误，用户中断时给服务器发 `notifications/cancelled`。每个 pi 进程都连接服务器以获得工具（子代理也有）；推送通知由交互式 pi 进程各自消费（机器级 `dedup.json` 保证一次），子代理进程忽略推送（pie 的子代理不注册通知钩子），运行时把仍到达 hop ≥ 1 的触发记为 `cycle_suppressed`。`/triggers sources` 显示每台服务器注册了哪些工具。真机验证过 agent 调用假服务器的 `echo` 工具并拿到返回。

### 生命周期 hooks

`~/.pi/agent/loops/hooks.toml`，按 pie 的 `hooks.rs` 逐项对齐，pie 的文件可以原样复制过来：

- 事件：`agent_start/agent_end/turn_start/turn_end/message_start/message_update/message_end/tool_start/tool_update/tool_end/compaction`。
- 字段：`command`、`webhook`（可同时用，先命令后 webhook）、`timeout_ms`（默认 5000）、`enabled`、`cwd = project|pie|home`、`on_failure = warn|ignore`、`tool` 过滤、`[hook.headers]`。
- payload（webhook body 与 `$PI_HOOK_PAYLOAD` 文件）字段与 pie 相同：`event, session_id, cwd, model_provider, model_id, thinking_level, source, message_kind, message_summary, assistant_event, tool_call_id, tool_name, tool_is_error, tool_args, tool_result_summary, compaction_trigger, compaction_tokens_before, compaction_summary`。摘要截到 2000 字符，thinking / tool call / image 用占位符，不脱敏（是给你自己的脚本）。
- 环境变量同时给 `PI_*` 和 `PIE_*` 两套，只在有值时设置。
- 单条规则写错只跳过那条并提示，其它照常加载。同一事件的规则按文件顺序串行执行，不阻塞 agent。
- 超时或 Ctrl-C 时杀掉 hook 的整棵进程树，不只是 `sh`。
- 项目级 `<repo>/.pi/hooks.toml` 默认忽略；用户 `hooks.toml` 顶层写 `allow_project_hooks = true`、或 `config.toml` 同名键、或 `PI_ALLOW_PROJECT_HOOKS=1`（也认 `PIE_` 前缀和 `true`）才启用。
- 子代理进程里不触发 hooks，只有你交互的那个 pi 触发。

## 子代理每次收到的 prompt

```text
You are running the recurring loop "ci" (current run started 2026-09-08 09:30). This is a background run …

[loop-state] (your notes from the previous run of this loop)
<state 文件内容，或 (first run)>
[/loop-state]

<你的 prompt>

Output protocol (mandatory):
- End your reply with <loop-state>notes for the next run</loop-state> — it REPLACES the saved state; …
- For each finding a human should act on, emit <inbox>one concise line</inbox>. No findings → no inbox tags; do not invent work.
- Keep everything after the last tool call short so the tags are not truncated.
```

## 存储

| 路径 | 内容 |
|---|---|
| `~/.pi/agent/loops/jobs.json` | 所有任务（全局；`PI_LOOPS_DIR` 可改根目录） |
| `~/.pi/agent/loops/state/<id>.md` | loop 状态，纯 Markdown，可以 `cat`、可以手改 |
| `~/.pi/agent/loops/inbox.jsonl` | 全局 inbox，追加式，坏行跳过不删 |
| `~/.pi/agent/loops/runs.jsonl` | run log，超 1 MB 自动保留后半 |
| `~/.pi/agent/loops/sessions/<id>/*.jsonl` | 子代理完整 transcript，每个 loop 保留最近 20 份 |
| `~/.pi/agent/loops/scheduler.json` | 当前 leader 的 pid / host / 心跳 |
| `~/.pi/agent/loops/triggers.json` | 动态 trigger 规则（全局，带 cwd） |
| `~/.pi/agent/loops/triggers-audit.jsonl` | trigger audit，超 2 MB 保留后半 |
| `~/.pi/agent/loops/sessions/triggers/*.jsonl` | 动态检查子代理的 transcript，保留最近 40 份 |
| `~/.pi/agent/loops/config.toml` | `[triggers] poll_interval_secs`、`allow_project_hooks` |
| `~/.pi/agent/loops/mcp.toml` · `hooks.toml` | MCP 推送源、生命周期 hooks |

跨进程写入靠 `mkdir` 锁 + 原子改名，没有原生依赖。

## 代码结构

```
src/pi-loops.ts      扩展入口：命令、工具、生命周期、状态栏
src/scheduler.ts  tick 循环、leader 选举、到期判定、错过补发、并发/重叠控制、子进程执行、写回
src/runner.ts     spawn pi -p --mode json，解析 message_end，抓最后一条 assistant 文本
src/protocol.ts   prompt 拼装、<loop-state>/<inbox> 提取、上限
src/redact.ts     pie 同款脱敏
src/transcript.ts 把子代理 session 文件压成可读的几十行
src/triggers.ts   动态规则：解析、prompt、id 提取、存储、audit、dedup 窗口
src/trigger-runtime.ts  trigger 运行时：admit、投递（sub_agent / inject_summary / inject_and_run）、fire-once、promote
src/mcp.ts        最小 MCP 通知客户端（stdio / streamable_http）与通知→trigger 映射
src/hooks.ts      hooks.toml 的加载与执行（命令 + webhook）
src/toml.ts       TOML 子集解析器（无依赖）
src/config.ts     config.toml
src/archive.ts    .pisession 归档：无依赖 tar 读写、导出、导入改写
src/schedule.ts   cron / every / once 解析与到期计算
src/store.ts      jobs.json、state/*.md、runs.jsonl
src/inbox.ts      inbox.jsonl
src/lock.ts       文件锁、原子写、pid 存活
src/args.ts       /cron add 参数解析
test/             node --test，含一个假 pi（test/fake-pi.sh）驱动的调度器集成测试
```

```bash
npm test
```

## 边界与已知取舍

- 子进程继承父会话的 model/thinking；子进程里的这个扩展检测到 `PI_LOOPS_CHILD=1` 后不会再起调度器，不会递归。
- 子进程是 headless 的 `pi -p`，没有 UI 就没有审批弹窗：需要确认的扩展在子进程里按各自 `hasUI=false` 时的策略行事。要收紧就用 `--tools read,grep,ls` 之类的白名单。
- 状态栏角标：`inbox: N new · running: <loop> · loops standby`，三段按需出现。
- 同一任务上一轮还在跑时新 tick 直接跳过并计数（`overlap-skipped`），不排队。
- 同时最多 3 个 loop 子进程在跑，多的等下一个 tick。
- inbox 状态改写是"最后写者赢"，与 pie v1 相同。
- pie 的 TUI 右侧常驻面板做成了编辑器上方的 widget（`Triggers` 规则最多 5 条 + `Polling` 最近一次检查、`Inbox N new`、`Cron` 启停统计与任务最多 5 条、`MCP` 各服务器连接状态与工具数），和 pie 一样没有内容时不显示；`/cron panel off` 或 `/triggers panel off` 关闭，偏好存在 `ui.json`。pi 的终端布局没有右侧栏，这是位置上的唯一差别。
- pie 范围内的功能到此没有未做项。

## 2026-09-08 复审后的修正

按"任务视角 / 使用能力视角"复审那份差异清单后改了八处：promote 与 MCP 注入只进规则所属项目的对话，否则转 inbox 并记 `redirected`；每个进程都消费自己收到的 MCP 通知，靠机器级 `dedup.json` 去重，项目级服务器的推送不再丢；任务与规则在创建时记下会话的模型和思考等级，运行时用它而不是 leader 的；随进程死掉的那一轮会重试而不是跳过；stdio 服务器重连只在错误变化时提示，默认 20 次后停；退出时等 hook 队列排空（3 秒封顶）；普通注入任务默认不补发（`--catchup` 可开），loop 仍补发；子代理保留 cron/trigger 工具、以 `PI_LOOPS_HOP` 计数防环（pie 的做法）；`/cron` 标记 `[dormant]`（会话未开）与 `[orphan]`（cwd 不存在，自动禁用）。已知代价写在 docs/design.md：每轮子代理是新进程，会重新拉起 stdio MCP 服务器。

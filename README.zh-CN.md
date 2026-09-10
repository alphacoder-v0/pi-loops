# pi-loops

把 [pie](https://github.com/c4pt0r/pie) 的自动化层做成一个纯 pi extension：**cron 与 Loops（有记忆的任务）**、**分诊 inbox**、**动态 trigger 与 MCP 推送通知**、**生命周期 hooks**。
不改 pi 的任何代码：定时器在 `session_start` 启动、`session_shutdown` 关闭，loop 通过 pi 的 SDK 在同一进程里开子会话跑，
状态是磁盘上的 Markdown，findings 进全局 JSONL inbox，`/inbox claim` 通过 `pi.sendUserMessage()` 把一条 finding 变成主会话里一个真正的 agent turn。

> "Stop prompting the agent. Build loops that prompt the agent for you."
> — Addy Osmani, *Loop Engineering*，pie 的设计北极星

## 它补的是 pie 补的那两块

| pie 的概念 | 这里的实现 | 存放位置 |
|---|---|---|
| **状态脊柱** — 每个 loop 一份 ≤2000 字符的笔记，run N+1 读到 run N 写的 | `<loop-state>` 标签解析后写入 Markdown，下次运行拼进 prompt 头部 | `~/.pi/agent/loops/state/<id>.md` |
| **maker/checker**（pie 只写了设计） | `--verify`：第二个对抗式子代理逐条核实 findings，drop 的不进 inbox | `runs.jsonl` 的 `checker` 字段 |
| **路由层** — 产出既不打断你也不沉进日志 | `<inbox>` 标签 → JSONL 追加，`new → claimed/dismissed` 生命周期，状态栏 `Inbox: N new` 角标；条目 id `inb-<32hex>`、来源 `cron:<id或name>`、`/inbox` 与 `/inbox all` 的行格式、错误措辞都与 pie 的 `inbox.rs` / `InboxCommand` 相同，多出 `✓` 已核实标记 | `~/.pi/agent/loops/inbox.jsonl` |
| stateful job 走 SubAgent、永不碰主对话 | 同进程子会话（pi SDK），干净上下文，共享父会话的 MCP 客户端、扩展、model/thinking；完整 transcript 保留在 `sessions/<id>/`，`/cron trace` 可看 | `~/.pi/agent/loops/sessions/<id>/*.jsonl` |
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

1. **任务是机器全局的（按主机）**，存在 `~/.pi/agent/loops/jobs.json`，不绑会话、不绑目录（每个任务记住自己的 `cwd` 与 `host`，子代理在那里跑；共享 $HOME 的另一台机器会忽略它）。任何目录里打开的任何 pi 都能看到并执行 stateful 任务；普通任务因为要注入对话，只在创建它的那个会话里触发（`--resume` 回来就继续），会话被删除后由 leader 停用、`/cron gc` 清掉；子代理创建的普通任务归它所服务的那个父会话，与 pie 写进父会话 cron.toml 一致。
2. **loop 由本机唯一的 leader 跑，动态检查由"开在那个项目里的 pi"跑。** `scheduler.<host>.json` 里放 pid + 心跳，30 秒一 tick；leader 退出或崩溃后其它 pi 在下一 tick 接管。每个进程每 tick 在 `presence/` 登记自己的 pid、会话与 cwd，一个项目的规则检查与推送评估由该项目里的 pi 执行（优先创建规则的那个会话，其次 pid 最小的），所以 promote_to_chat 一定落在对的对话里，和 pie 的会话作用域等价；只有项目里没开 pi 时才由 leader 代跑、结果进 inbox。轮询间隔由共享的 `polls.json` 全机保证，交接不会重复检查。任务与规则的模型/思考等级/超时可用 `/cron set`、`/triggers set` 改（`--model -` 跟随当前会话）。
3. **停机期间错过的 tick 默认补发一次**（多次错过折叠成一次，就像 systemd `Persistent=true`）。不想要就 `--no-catchup`。
4. **没有过期时间。** 任务只在你 `/cron remove` 时消失。
5. **有 run log 和完整 transcript。** `runs.jsonl` 记每次运行的退出码、耗时、成本、finding 数、有没有更新状态；子代理的 session 文件每个 loop 保留最近 20 份，`/cron trace <job> [k]` 直接看它调了什么工具、看到了什么，`pi --session <文件>` 可以整个接管回放。

子代理和 pie 一样在父进程内运行：共享父进程活着的 MCP 服务器实例（浏览器标签页、数据库会话都是同一份）、`-e` 扩展、system prompt、skill 标志与模型，同一项目下继承信任。"一个 pi 进程都没有"也解决了：本机最后一个交互式 pi 退出时，如果还有 loop、规则或 MCP 服务器，它会拉起一个无头宿主进程（`src/host.ts`，同一套存储、同样的进程内运行器、自己的 MCP 客户端）继续走时钟；本来要进对话的结果进 inbox；下一个打开的 pi 抢回时钟，宿主退出。`/cron host [start|stop]` 看和控制（start = 即使 `[host] auto = false` 也在本 pi 退出时交接），`host.log` 是它的日志，重启机器后要等下一个 pi 打开才会再交接。

## 对 pi 的无侵入性

- 只用 pi 公开导出的扩展 API：`ExtensionAPI` 的事件、命令、工具、`sendMessage/sendUserMessage/appendEntry/exec/registerFlag`，以及 `getAgentDir`、`readStoredCredential`、`@earendil-works/pi-tui` 的 `Box/Text`、`typebox`。
- pi 的安装目录一个文件都没改（`find <pi包> -newer package.json` 为空）；`~/.pi/agent` 下只多了 `settings.json` 的一行 `extensions` 和运行时才会创建的 `loops/` 目录。
- 没有 monkeypatch、没有访问私有字段；子代理是用 pi 公开 SDK 在同进程里开的会话，不起子进程。卸载就是删掉 settings.json 里那一行。

## 你要敲的命令

```bash
pi-loops                              # 开一个会话——本地开浏览器，ssh 里开终端
pi-loops --tui                        # 猜错时强制终端
pi-loops --continue                   # 接着这个目录里最新的那个会话
pi-loops upgrade                      # 从 GitHub 装最新的发布版
pi-loops host status                  # 看一眼没有 pi 开着时在跑的自动化
```

其余都是会话里的斜杠命令（`/cron`、`/inbox`、`/triggers`、`/goal`）。第一次用就往下读。

## 上手

### 1. 先确认前提

pi ≥ 0.84、Node ≥ 22.6（pi 直接加载 TypeScript 源码），以及**一个真的能说上话的 provider**——先跑一次 `pi`，发一句，确认有回答。pi-loops 会在你不看着的时候替你跑子代理；凭据没配好这件事，不该等到第二天早上 inbox 空着才被发现。

pi-loops 自己没有任何运行时依赖。

### 2. 装上

```bash
pi install git:github.com/alphacoder-v0/pi-loops@v0.12.3    # 固定 tag
pi install /path/to/pi-loops                       # 或本地检出；本仓库里就是 pi install .
```

**两种装法二选一，不要都装。** 两份副本注册同名工具，pi 会拒绝加载第二份并直接退出（`Tool "cron_create" conflicts with …`）。如果你在改这份代码，留本地检出那份。

然后把命令放进 `PATH`，一次就够。注意 `pi install` 把包放在 pi 自己的托管目录里、**不进 `PATH`**，所以此刻 `pi-loops` 这个命令还不存在——这恰好是 `install-launcher` 唯一没法替自己做的事。两条路随便走一条：

```text
/pi-loops install-launcher                         # 在 pi 里面，扩展本来就加载着
```

```bash
# 或者在 shell 里，进到 pi 装包的那个目录
cd ~/.pi/agent/git/github.com/alphacoder-v0/pi-loops    # pi install git: 装的包在这里
node src/cli-entry.mjs install-launcher
```

两条都会往 `~/.local/bin`（或其它已在 `PATH` 里的目录，用 `--dir` 指定）写一个启动器。之后 `pi-loops` 在任何目录都能用。

### 3. 开一个会话

```bash
pi-loops                                           # 开会话，窗口按环境自己选
```

本地终端里开浏览器前端；ssh 里或者根本没有终端时，开 pi 本身——在对面机器上弹浏览器对谁都没用。猜错了就用 `--web` / `--tui` 指定，`--continue` 接着上次，其余参数原样交给 pi：

```bash
pi-loops --tui                                     # 终端版
pi-loops --continue                                # 这个目录里最新的那个会话
pi-loops --model anthropic/claude-opus-5 -e .
```

两个窗口都是完整的 pi 会话（浏览器那个是 `pi --mode rpc` 加一个网页），会话文件、`--resume`、模型、工具、扩展完全一样。细节见 [docs/cli.md](docs/cli.md)，浏览器前端必须保住的能力清单见 [docs/web-ui-parity.md](docs/web-ui-parity.md)。

上次选的模型和思考等级会被记住（存在 `ui.json`），下一个会话直接从它开始 —— `--continue` / `--resume` 除外，那种会话自己带着模型。

浏览器那个地址永远是 **`http://127.0.0.1:4173/`**：端口固定，token 存在文件里而不是每次随机，所以这个地址明天还是它，可以直接收藏。第一次访问会留一个 cookie，之后再也看不到 token。已经开着一个时再敲 `pi-loops`，它会打开那一个，而不是在端口上报错。只有你自己用的机器上，`--no-auth` 可以把这层也去掉。

手机上用：最好的路是 `tailscale serve --bg 4173` —— 服务器仍然只绑 127.0.0.1，TLS 和身份都交给 tailnet，手机打开 `https://<机器>.<tailnet>.ts.net/`。同一个 wifi 里也可以 `pi-loops --host 0.0.0.0`（这时候 `--no-auth` 会被直接拒绝）。手机第一次进什么都不用输：在已经登录的浏览器里点 **add device**，拿手机扫那个二维码就进去了，之后一直是登录状态（不想扫也可以输下面那六位数）。加到主屏幕会以独立窗口打开（有 manifest，没有 service worker）。

### 4. 第一个 loop

```text
/cron add --stateful "0 9 * * *" 看一下这个仓库的 GitHub issues，报告自上次以来新开的和新关的
/cron                                              # 这个项目里有什么、下次什么时候跑
/cron run 1                                        # 不用等到早上九点，现在就跑一次看看
/inbox                                             # 新的 findings
/inbox claim 1                                     # 把第 1 条作为真实的一轮交给 agent
```

加 `--verify` 的话，第二个对抗式子代理会在 finding 到你面前之前逐条核实。

### 5. 让它整夜跑之前

```text
/cron cost                                         # 今天自动化花了多少
```

在 `~/.pi/agent/loops/config.toml` 里先设个上限再依赖它：

```toml
[limits]
daily_budget_usd = 5.0
```

最后一个 pi 退出时，无头宿主会接手时钟，所以早上九点那次照跑（`/cron host`、`pi-loops host status`）。不想要就在同一个文件里写 `[host] auto = false`。

### 升级

```bash
pi-loops upgrade                                   # 装最新的发布版
pi-loops upgrade --check                           # 只看看有没有新的
```

它从这份副本的来源仓库读 release tag，和你正在跑的版本比，然后装最新那个——因为 `pi update --extensions` **有意**不做这件事：pi 钉住你写的那个 ref，并且只把克隆对齐到**那个** ref。换版本是另一个决定，而做这个决定需要先知道哪个 tag 最新——这本该是命令替你做的事，而不是你去查了再手打回来。

装完重启 pi（或者再跑一次 `pi-loops`）就生效。启动器不用重装：pi 把每个 git 包固定放在 `~/.pi/agent/git/<host>/<owner>/<repo>`，换版本路径不变。

版本就是 GitHub 上的 tag，每个 tag 里有什么见 [CHANGELOG.md](CHANGELOG.md)。

### 卸载

```bash
pi remove /path/to/pi-loops                        # 数据留在 ~/.pi/agent/loops，想清就删目录
pi -e /path/to/pi-loops                            # 或者：只在这次启动试用，什么都不装
pi update --extensions                             # 对齐已安装的包
```

包里附带一个 skill（`skills/pi-loops`），让 agent 知道什么时候该用 `cron_create`、`new_trigger` 和 inbox。

英文文档在 [README.md](README.md) 与 [docs/](docs/)：loops、triggers、goal、mcp、hooks、session-archive、cli、configuration、design、troubleshooting；变更记录在 [CHANGELOG.md](CHANGELOG.md)，贡献者说明在 [AGENTS.md](AGENTS.md)。

## 用法

命令面和 pie 一致：`/cron` 管任务，`/inbox` 管分诊，`/goal` 管"做到什么算完"。

```text
/cron add "*/30 * * * *" summarize the repo state               # 普通任务：到点结果出现在当前对话
/cron add --stateful "0 9 * * *" check the GitHub issues of this repo and report anything new or newly closed since the last run
                                                                # loop：子代理 + 跨轮笔记 + findings 进 /inbox
/cron add --stateful --name ci every 30m run the test suite; only report tests that changed status since your notes
/cron add in 10m 提醒我看一下测试结果                           # 会话级闹钟
/cron  ·  /cron list|ls|status      本项目的任务，[stateful] 标记；/cron all 看整台机器
/cron enable|resume|disable|pause|remove <n|id|name>
/goal 测试全部通过并且改动已提交                                # 每轮结束由评估器判断是否达成，未达成就送回去继续做（最多 8 次）
/goal  ·  /goal pause|resume|clear                              # 看状态 / 暂停 / 恢复 / 清除
/cron run 1                         立刻跑一次
/cron state ci                      loop 的笔记（状态脊柱）
/cron runs [ci]                     最近运行，最新在前
/cron trace ci 2                    第 2 新那次运行的 transcript：prompt、工具调用、结果、回复
/cron scheduler                     谁在走时间、有哪些 run 在跑（pie 的 /cron status 等于 list）
/cron cost [today|7d|all]           自动化花了多少，按任务分，对照 [limits] daily_budget_usd
/cron disable --all                 本项目全停（--all-projects 停整台机器）；/cron clear <ref> 清掉死进程留下的 running 标记
/cron gc                            清掉会话已消失的任务（本项目；--all 才跨项目）
/cron host [start|stop]             最后一个 pi 退出后接手时钟的无头宿主
/cron snapshot                      把"只有这个进程知道的状态"写进会话：哪些 MCP 连上了、暴露了什么工具、
                                    当前 active tools、hooks、谁拥有时钟。给非终端的前端读的
/triggers run <id>                  立刻检查某条动态规则，不等它的轮询时隙
/session-share [--public]           把这次会话的 transcript 脱敏后传成 GitHub gist（走 gh），
                                    上传前先告诉你里面有什么、遮掉了几处、本地副本在哪

/inbox                              本项目的新 findings（每行标出项目；`--all` 看全部项目，与 /cron、/triggers 同一套作用域）
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
/triggers enable|disable|remove <id>  ·  /triggers remove --all（本项目）| --all-projects（本机全部）
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
auth = { kind = "bearer", token_keychain_ref = "PI_MCP_TOKEN_HUB" }  # token 不写在文件里：查 pi 的凭据库，或 PI_MCP_TOKEN_* 前缀的环境变量
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

- 事件：`agent_start/agent_end/turn_start/turn_end/message_start/message_update/message_end/tool_start/tool_update/tool_end/compaction`，外加 pie 没有的一对 **`run_start` / `run_end`**：定时运行发这一对，交互式 pi 和无头宿主都发。pie 没有无人值守模式，那里每次定时任务本身就是对话里的一轮，`agent_*` 够用；这里一次运行可能完全没有对话（宿主），也可能发生在对话旁边，复用 `agent_*` 等于让你为自己轮次写的规则突然为自动化触发。`run_end` 的 payload 带 `run_ok`/`run_findings`/`run_error`/`run_cost_usd`，所以"loop 挂了通知我"是 `[ "$PI_RUN_OK" = false ]`，不是拿摘要做字符串匹配。
- 字段：`command`、`webhook`（可同时用，先命令后 webhook）、`timeout_ms`（默认 5000）、`enabled`、`cwd = project|pie|home`、`on_failure = warn|ignore`、`tool` 过滤、`[hook.headers]`。
- payload（webhook body 与 `$PI_HOOK_PAYLOAD` 文件）字段与 pie 相同：`event, session_id, cwd, model_provider, model_id, thinking_level, source, message_kind, message_summary, assistant_event, tool_call_id, tool_name, tool_is_error, tool_args, tool_result_summary, compaction_trigger, compaction_tokens_before, compaction_summary`。摘要截到 2000 字符，thinking / tool call / image 用占位符，不脱敏（是给你自己的脚本）。
- 环境变量同时给 `PI_*` 和 `PIE_*` 两套，只在有值时设置。
- 单条规则写错只跳过那条并提示，其它照常加载。同一事件的规则按文件顺序串行执行，不阻塞 agent。
- 超时或 Ctrl-C 时杀掉 hook 的整棵进程树，不只是 `sh`。
- 项目级 `<repo>/.pi/hooks.toml` 默认忽略；用户 `hooks.toml` 顶层写 `allow_project_hooks = true`、或 `config.toml` 同名键、或 `PI_ALLOW_PROJECT_HOOKS=1`（也认 `PIE_` 前缀和 `true`）才启用。**在无头宿主里还额外要求 pi 对那个任务的 cwd 有精确的信任记录**——`allow_project_hooks` 是对"你会打开的项目"的表态，不是对"模型顺手指过去的目录"的表态。
- hook 打到 stdout 的东西写进本进程日志（`logs/pi-<pid>.log`，宿主写 `host.log`），截到 4000 字符——"打印点东西再去看"这个最常用的调试手段现在是通的。
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
| `~/.pi/agent/loops/spend.json` | 轮转掉的那部分花费按天留一份，预算上限不会因为 run log 被截断而失效 |
| `~/.pi/agent/loops/logs/pi-<pid>.log` | 每个 pi 进程的自动化诊断，超 2 MB 保留后半，只留最近五个进程 |
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
src/scheduler.ts  tick 循环、leader 选举、到期判定、错过补发、并发/重叠控制、子会话执行、写回
src/runner.ts     子代理运行器接口与父进程可继承的标志；src/sdk-runner.ts 用 pi SDK 在同进程里开会话跑
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
test/             node --test，含一个假运行器（test/fake-runner.ts）驱动的调度器集成测试
src/web.mjs       单文件、零依赖的浏览器前端：跑 `pi --mode rpc` 并把协议透传给网页
src/cli.ts        `pi-loops`：会话入口（网页或终端）+ export/import/host 那几个工具
```

```bash
npm run ci      # typecheck + lint + 190 个测试，与 .github/workflows/ci.yml 跑的一致
```

`scripts/lint.mjs` 只管两类错误：**floating promise**（pi 不装 `unhandledRejection` handler，没人 await 的
promise 一旦 reject 会直接杀掉整个会话，`void x()` 不算豁免）和**没写注释的空 `catch {}`**。两条都靠
TypeScript 的类型信息判断，编译器通过 npx 借来，不引入依赖。

## 边界与已知取舍

- 子会话继承父会话的 model/thinking（任务固定了模型则用固定的）；子会话里不再加载这个扩展本身，不会递归。
- 子会话没有 UI 就没有审批弹窗：需要确认的工具在子会话里 fail-closed 拒绝（与 pie 一致）。要收紧就用 `--tools read,grep,ls` 之类的白名单。
- 状态栏角标：`inbox: N new · running: <loop> · loops standby`，三段按需出现。
- 同一任务上一轮还在跑时新 tick 直接跳过并计数（`overlap-skipped`），不排队。
- 同时最多 3 个子代理在跑（`[cron] max_concurrent_runs`）——loop 运行、trigger 检查、`/goal` 评估器**共用这一个池子**（`src/slots.ts`），不是每条流水线各自 3 个。`/goal` 评估器和 `/cron run` 占槽但永不被拒（你直接要的东西，机器悄悄不做和从没设过是一样的），所以 `/triggers running` 有可能显示 `4 of 3 slots in use`。
- `[limits] daily_budget_usd` 不只挡派发，也会**停掉正在跑的运行**：算的是运行日志里已落账的花费加上本进程在飞的（并行的兄弟运行，以及 `--verify` 那对共用 runId 的 maker/checker）。被预算停掉记为 aborted 而不是 failed，所以时隙还欠着、失败连击不累加。
- inbox 状态改写是"最后写者赢"，与 pie v1 相同。
- pie 的 TUI 右侧常驻面板做成了编辑器上方的 widget（`Triggers` 规则最多 5 条 + `Polling` 最近一次检查、`Inbox N new`、`Cron` 启停统计与任务最多 5 条、`MCP` 各服务器连接状态与工具数），和 pie 一样没有内容时不显示；`/cron panel off` 或 `/triggers panel off` 关闭，偏好存在 `ui.json`。pi 的终端布局没有右侧栏，这是位置上的唯一差别。
- 三轮全量差距审计（对照 pie b725796）见 `~/code/tmp/pie-parity-audit-2026-09-08.md`、`-round2-2026-09-09.md`、`-round3-2026-09-09.md`。第三轮的结论是**最重的问题出在新写的代码里，不是"相比 pie 缺什么"**。`/goal`、命令行 `pi-loops export|import`、无头宿主的可观测通道、日成本上限与 `/cron cost`、每进程日志、`/share` 都已补上。
- pie 的本地 Web UI 现在有等价物，而且入口和 pie 一样是"启动会话"本身：敲 `pi-loops` 就开一个会话——本地终端里开浏览器版，ssh 里或没有终端时开 pi 本身，`--web` / `--tui` 可以强制（pie 的规则也是这样，只不过它是 `pie` 自己带 `--web`）。两边都是完整的 pi 会话，会话文件、`--resume`、模型、工具、扩展完全一样。`pi-loops install-launcher` 跑一次把命令放进 PATH。pi 拥有终端，所以扩展替代不了**那个** UI——但走 `pi --mode rpc`（pi 去掉终端前端的模式）可以另起一个浏览器前端，和 pie 的 `pie web` 同构。终端里留下的只有 `/login`（OAuth 没有 rpc 命令）和 pi 自己的内置斜杠命令（rpc 下不存在）。
- 跨设备访问走的是另一条路：不是把 broker 放中间（pie 的 `/web-connect`），而是让前端在它已经在的地方被够到 —— `tailscale serve` 在 tailnet 上终结 TLS、代理到本机 loopback，手机就能开，中间不经过任何第三方；同一网段则用 `--host`。手机第一次进用配对码和二维码（[docs/cli.md](docs/cli.md#from-a-phone)）。真正没覆盖的是"手机两个网络都不在"，那种情况才需要中继。
- 仍然没有的：pie 作为 agent 的能力（task/memory/web 工具、LSP、skill 管理工具等）。

## 2026-09-08 复审后的修正

按"任务视角 / 使用能力视角"复审那份差异清单后改了八处：promote 与 MCP 注入只进规则所属项目的对话，否则转 inbox 并记 `redirected`；每个进程都消费自己收到的 MCP 通知，靠机器级 `dedup.json` 去重，项目级服务器的推送不再丢；任务与规则在创建时记下会话的模型和思考等级，运行时用它而不是 leader 的；随进程死掉的那一轮会重试而不是跳过；stdio 服务器重连只在错误变化时提示，默认 20 次后停；退出时等 hook 队列排空（3 秒封顶）；普通注入任务默认不补发（`--catchup` 可开），loop 仍补发；子代理保留 cron/trigger 工具、以 `PI_LOOPS_HOP` 计数防环（pie 的做法）；`/cron` 标记 `[dormant]`（会话未开）与 `[orphan]`（cwd 不存在，自动禁用）。当时的已知代价"每轮子代理是新进程，会重新拉起 stdio MCP 服务器"在 0.1.3 已消除：子代理改为同进程会话。

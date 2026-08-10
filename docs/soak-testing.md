# 四小时高强度压测

本框架只负责最终代码冻结后的持续验收，不会修改规则、牌面数值、动画或测试。默认要求同一源码指纹下连续运行 14,400 秒，并行启动四个隔离进程：

截至 2026-08-10 ET，当前冻结候选尚未运行这项正式验收。正式运行前的最终邀请修复回归为 200/200（HTML 9、TypeScript 188、三组真实集成各 1），生产构建、全项目 ESLint、非增量 `tsc --noEmit` 与差异检查均通过；其中覆盖同标签页邀请恢复、认证 URL/服务端 HTML 无 secret，以及 `watch=1` 不消费邀请。已完成的 v11 跨档预检、284 组强搜索和定向 A/B 都是独立平衡证据，不能计入 14,400 秒或 288 组同档门槛；提交、公开部署和生产 QA 也仍待执行。

- `balance`：四腿镜像、隐藏信息有限深度搜索、50 张牌的上场覆盖，并在结果中另行记录实际触发次数；
- `rules`：随机合法行动、非法行动不变性、状态机、观战隐私、重复结算和逐手回放重建；另用独立 oracle 验证只有 v2 在第二轮公开后的第三次战略局面出现时和棋，经典与 v1 保持原样；
- `api`：重复执行房间、平台和完整 API 集成回归，并为每次子进程保留 TAP 日志和退出码；三次重复排位按双方各 `0.5` 分幂等结算；
- `animation`：随机轰炸选牌 reducer，覆盖快确认、八秒后确认、拒绝、恢复、重复点击、减弱动态和一次性燃烧条件。

正式 `soak` 的平衡 worker 固定使用每局最多 180 手、4 次隐藏信息 determinization、8 个候选分支、3 层 rollout。当前算法为 `hidden-info-balance-v11-threefold-public-occurrence`，产品引擎指纹为 `augment-duel-dark-v2:threefold-3:strategic-sha256-v1`；只有产品引擎正式裁决的 v2 三次重复按已完成的 `0.5` 和棋计分，180 手边界仍是未完成封顶。独立跨档强搜索的 `maxActions=300` 不改变这里的正式同档 180 手配置。

正常结束必须同时满足当前连续段运行至少 14,400 秒，以及完整走完由当前牌库赛程动态生成的一整轮镜像组；当前目录为 288 组（1,152 局），每组严格记为四局，并且不能全部因手数上限截断。若四小时到点时本轮尚未完成，平衡 worker 会继续到完整轮，因此正式运行可能略长于四小时；其他 worker 已达时长后可以先正常结束。主动停止、真实失败、源码变化或连续性中断仍会立即进入停止流程，不会等待补满赛程。`smoke` 才会降为 20 手、1×3×1，并保持“到达指定短时长且完成一个原子批次即结束”，短烟雾结果不得用于强度结论。

## 启动

必须等规则、数值、动画和 UI 修复全部冻结后再启动。Windows PowerShell 中从仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1
```

`ExecutionPolicy Bypass` 只作用于这一个本地脚本进程，不会修改系统策略。脚本使用参数数组调用 Node，仓库路径包含 `&` 也不会被当成命令分隔符。默认输出在 `outputs/soak/<run-id>/`。API worker 会在被 TypeScript 排除且被 Git 忽略的 `work/s/` 下，为三个测试分别复制冻结源码并创建独立的可写 Vite、Miniflare 与 D1 状态；lane 名使用稳定短哈希，给 Windows 上 Miniflare 追加的长 D1 文件名留足路径空间。依赖只通过目录 junction 复用当前 `node_modules`，因此不会抢占 UI QA 或人工开发服务器的缓存和数据库锁。

先验证框架本身时可运行短烟雾；这不会被认作四小时证据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Profile smoke -DurationSeconds 5 -CheckpointIntervalSeconds 1
```

worker 默认五分钟没有新检查点即判定为卡死；API 子测试还有更短的独立超时。监督进程另外每秒心跳、每五秒复核源码和依赖指纹；若电脑睡眠、进程暂停或调度停顿造成超过 30 秒的心跳空档，就将当前连续段判为失败，避免把没有实际运行的时间算进四小时。只有已确认单个镜像组在目标机器上合法地超过五分钟时，才应通过 `-WorkerHangTimeoutSeconds` 调大 worker 上限，并在正式证据中保留该参数；30 秒连续性门槛不会因此被放宽。

## 优雅停止与恢复

在另一个 PowerShell 窗口请求停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Stop
```

若同时存在多个输出根或 `latest-run.json` 不再指向目标，显式指定运行目录：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Stop -Resume "outputs\soak\<run-id>"
```

监督进程写入目标运行目录的停止请求。平衡、规则和动画 worker 在当前原子批次后退出；API worker 在当前集成套件结束后退出，避免遗留半关闭的本地服务器。Windows 控制台的 `Ctrl+C` 可能同时打断子进程，只能视作中断并重新恢复计时；需要完整 `stopped` 证据时必须使用另一个窗口的 `-Stop`。

恢复一个被中断或主动停止的运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Resume "outputs\soak\<run-id>"
```

恢复会保留累计样本和失败证据，但开启新的连续段。旧段的运行时间、旧段完成的镜像组和窗口关闭后的空档都不会计入当前连续门槛；新段仍须独立达到完整 14,400 秒，并在该段内完成当前目录的一整轮镜像组。如果 commit、已跟踪 diff 或未跟踪源码内容发生变化，恢复会拒绝，必须新建运行并重新计时。

## 证据与判定

每个运行目录包含：

- `manifest.json`：UTC/美东时间、commit、跟踪 diff、未跟踪源码与已安装依赖锁的 SHA-256、Node/平台配置、所有连续段与 PID；平衡搜索配置另保存在 `balanceTournament`，算法和产品引擎实现由冻结源码指纹约束；
- `checkpoint.json`：监督进程最近心跳、四个 worker 检查点和已知退出码；
- `final.json`：统一结论、真实起止时间、进程退出码、循环/局数/手数/搜索节点、50 张牌覆盖、失败分类和证据路径；
- `workers/<name>/checkpoint.json` 与 `final.json`：worker 级累计值和当前连续段值；
- `segments/<segment>/final.json` 与 `workers/<name>/segments/<segment>/final.json`：恢复后也不会被覆盖的逐段终态证据；固定位置的 `final.json` 只是最新一段汇总；
- `workers/api/invocations.jsonl` 与 `logs/<segment>/`：API 子进程摘要和原始 TAP。每个 segment 为三套测试各建一个独立 lane，lane 在该段内复用；每次 suite invocation 自己启动并正常关闭一次服务，不另起会污染 Miniflare/D1 的预热进程。

以下任一情况都会使总结果失败：子进程非零退出或缺失 final、测试超时/卡死、异常、回放分叉、隐藏身份泄漏、重复事件/重复手数/军令超额结算、v2 第三次重复未终局、经典或 v1 被误判重复和棋、状态不变量失败，或源码/依赖在运行期间变化（包括算法和产品引擎实现变化）。正式四小时运行还要求 `balance`、`rules`、`animation` 各自让全部 50 张牌进入测试样本，且四个 worker 在当前未中断段中都达到要求时长；具体效果的实际触发计数作为独立强度诊断，不与“上场覆盖”混写。

压测中的未完成上限局会单独计入 `cappedGames`，不会伪装成已完成对局；任何真实异常或无合法动作卡死仍然立即失败并保留上下文。修复任何规则、动画或测试问题后，必须从零开始新的四小时运行。

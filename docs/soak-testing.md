# 四小时产品稳定性持续测试

本框架在最终代码冻结后连续运行四个隔离 worker，目标是验证玩家能流畅完成对局，而不是重复搜索军令强度。任何胜率、档位排序或点估计都只是诊断信息，不影响正式 gate，也不会生成自动调牌建议。

## 固定模拟口径

- 产品目录：70 张 v3 军令；
- 自动模拟 eligible：63 张非计时军令；
- 排除的 7 张计时牌：`club-pocket-time`、`club-steady-tempo`、`diamond-drill`、`diamond-pocket-watch`、`diamond-time-cache`、`heart-reserve-clock`、`spade-strategic-reserve`；
- 权威与确定化对局：`clock=null`；
- 模拟思考延迟：0，无逐决策 sleep 或人为时间推进；
- 正式 balance 搜索：`1×3×1`；
- 正式 balance 单局安全上限：300 手；到界记为未完成 `capped`；
- v2/v3 产品引擎第三次战略局面重复：正常 `threefold_repetition` 和棋；经典与 v1 不启用。

计时牌仍由定向产品、API 和排位棋钟测试覆盖，但不得进入随机牌池、第二轮 offer、规则/动画随机覆盖或 soak 覆盖分母。最终证据必须显式报告 catalog 70、eligible 63、excluded 7，不能写成 70/70 自动模拟。

## 四个 worker

- `balance`：63 组同花色环形配对，四腿镜像、隐藏信息、CRN、最快合法策略、回放与终局统计；循环赛程直到连续时长满足，并要求当前连续段至少完成一整圈。
- `rules`：63 张 eligible 的随机合法行动、非法动作不变性、投影隐私、第二轮、回放重建和独立三次重复 oracle；正式单局上限 300。
- `api`：房间、平台和完整 API 集成回归，包括三次重复排位幂等结算以及产品棋钟定向测试。
- `animation`：63 张 eligible 的 reducer/动效覆盖，以及快确认、慢确认、拒绝、恢复、重复点击和 reduced-motion 路径。

`balance`、`rules`、`animation` 的覆盖 denominator 都是同一 63 张 eligible pool；内部计数容器可以保留 70 个键用于 schema 稳定，但 7 张计时牌不能造成假缺失或假覆盖。

正式 balance 还要求以下四张新主动牌都出现合法机会并实际使用：

- `heart-heavenly-exchange`
- `heart-shadow-redeploy`
- `club-surprise-double-move`
- `club-bitter-ruse`

最终报告在 `simulationActivity.byEligibleAugment` 中分别记录 `games`、`opportunityGames`、`triggerGames` 和 `triggers`，并列出 `requiredActiveOpportunityMissing` 与 `requiredActiveUseMissing`。

## 启动与 smoke

Windows PowerShell：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1
```

短 smoke 只验证框架，不是四小时证据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Profile smoke -DurationSeconds 5 -CheckpointIntervalSeconds 1
```

smoke 与正式 balance 都固定使用 300 手安全上限，避免短 smoke 因人为截断制造假 capped 或假绿。监督进程每秒写心跳、每五秒复核源码与依赖指纹。电脑睡眠、进程暂停或调度停顿造成超过 30 秒的连续性空档，会使当前正式段失败。

## 结束条件

正式运行至少持续 14,400 秒。balance 在当前连续段还必须完成至少一整圈 63 个镜像组；若四小时到点时当前圈尚未满足最低覆盖，worker 会继续到原子镜像组边界。每组必须恰好四局。

以下情况会失败：

- worker 非零退出、缺失 final 或 watchdog 超时；
- 未捕获异常、无动作卡死、回放分叉、隐藏信息泄漏或重复结算；
- 源码/依赖在运行中变化，或连续性中断；
- `balance`、`rules`、`animation` 任一未覆盖全部 63 张 eligible；
- balance 当前段少于 63 个环形组、四腿局数不一致，或任一对局被 300 手上限截断；
- 四张新主动牌任一没有 opportunity 或 use；
- 必需动画阶段/标准流程未覆盖。

任一 balance `capped` 都是未完成对局，会令 smoke 或正式 run 失败，并在 `balanceCappedGames` 原因中明确记录。三次重复和棋是已完成对局，不属于 capped。

## 停止与恢复

优雅停止：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Stop
```

恢复：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\soak\run.ps1 -Resume "outputs\soak\<run-id>"
```

恢复会保留历史样本，但打开新的连续段。旧段时长不能补入新段的四小时门槛。当前 soak schema 为 2；manifest 还绑定算法 `product-stability-v13-v3-no-clock-zero-time-deterministic-ids`、引擎 `augment-duel-dark-v3:threefold-3:strategic-sha256-v2`、实际 balance 配置、63 组赛程和工作区指纹。任何旧 schema、旧算法、旧引擎、旧工作负载或旧源码 checkpoint 都必须拒绝。

## 最终证据字段

`final.json` 的顶层写明 `purpose=product_stability`、soak schema、算法版本和引擎指纹。`coverage` 同时包含：

- `catalogSize: 70`
- `simulationEligibleSize: 63`
- `excludedClockCount: 7`
- `excludedClockAugmentIds`
- `overallAllCards`（含义是全部 eligible 已覆盖）
- `missingOverall` 与各 worker 的 eligible 缺失 IDs

报告还保留完成、未完成、capped、stuck、三次重复、回放、异常、主动牌机会/使用和连续性证据。不得用胜率排序替代这些技术稳定性 gate。

## 发布边界

截至 2026-08-11 ET，最终代码回归为 237/237：HTML 9 项、TypeScript 225 项、真实集成 3 项；production build、全项目 ESLint、非增量 TypeScript 检查与差异检查均通过。三套真实集成各连续执行 4 轮，共 12/12 通过；每轮端口可重新绑定，结束后孤儿进程为 0。

这不等于四小时 gate 已通过。每个发布候选都必须在准确的冻结提交上新跑正式持续测试，权威结果写入 `outputs/soak/<run-id>/final.json`；只有该结果满足本页全部条件后，才进入 Sites 部署与生产邮件身份、匹配、私人房、观战和复盘 QA。`outputs/` 是 Git 忽略的本机证据目录，不随源码提交；其他提交或旧工作负载的长跑不能转移为当前发布证据。

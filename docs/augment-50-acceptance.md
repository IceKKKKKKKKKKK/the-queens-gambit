# 70 张军令 v3：产品完成门槛

> 文件名为历史兼容名；当前权威范围是 `junqi-augments-v3` 的 70 张军令。

本轮目标已经从反复模拟强度改为形成可顺畅游玩的产品。自动化负责证明功能、隐私、终局、回放和长时间运行稳定；军令强弱只做描述，后续由首批真人测试数据决定。

## 1. 功能门槛

- 目录必须恰好包含 70 个稳定 ID，20 张新增牌全部有服务端可执行语义，不能只有文案或动画。
- v1/v2 持久化对局、经典模式、重连、观战与回放保持兼容。
- 两轮发牌维持双方私有三选一、合法刷新、已见去重和第二轮中局限制。
- 新动作必须进入规则、无路可走、投影、事件和回放：`augment_exchange`、`augment_begin_multi_move`、`augment_redeploy`、`augment_sacrifice`，以及统一续段放弃 `pass_extra_move`。
- v3 `ruleState.multiMove` 和旧 `extraMove` 都必须允许合法 pass，并精确归因到授予军令。
- 产品排位保留真实棋钟与全部 7 张计时牌规则；自动模拟禁用棋钟不改变产品行为。
- v2/v3 产品引擎第三次战略局面重复必须终局为和棋，第二次公开显示 `2/3`，排位按双方各 `0.5` 分结算且必须幂等；经典模式与 v1 保持原规则。
- 隐藏敌子身份、私有侦察、私有发牌和重复摘要/盐不得泄漏给对手或观众。

## 2. 产品稳定性模拟门槛

唯一随机模拟池是 63 张非计时牌。明确排除：

- `club-pocket-time`
- `club-steady-tempo`
- `diamond-drill`
- `diamond-pocket-watch`
- `diamond-time-cache`
- `heart-reserve-clock`
- `spade-strategic-reserve`

随机开局、第二轮、刷新、同档配对、rules、animation 和所有 coverage denominator 都只能使用这 63 张。报告必须同时写明 catalog 70、eligible 63、excluded 7，不能虚称 70/70 自动覆盖。

自动对局必须 `clock=null`、模拟思考延迟为 0、无逐决策 sleep，默认 `1×3×1` 搜索。产品稳定性默认单局安全上限为 300；到界是未完成 `capped` 并使整次运行失败，只有产品引擎裁决的三次重复才是正常和棋。

正式赛程采用 63 个同花色环形 pair，每组四腿镜像，交换黑白和先手并共享 CRN。四小时内持续循环，至少让每张 eligible 上场；不再要求完整同档笛卡尔 round-robin。

四张新主动牌必须在正式 balance 证据中都至少有一次 opportunity 和一次 use：

- `heart-heavenly-exchange`
- `heart-shadow-redeploy`
- `club-surprise-double-move`
- `club-bitter-ruse`

redeploy 策略只能生成少量确定性的完整 placements，避免全排列爆炸；主动候选必须保留搜索槽位，不能被普通移动永久剪掉。

## 3. 四小时持续门槛

冻结源码后，四个 worker 在同一连续段运行至少 14,400 秒：

- `balance`：63 组环形四腿、完整局、回放、终局与主动牌统计；
- `rules`：状态机、非法动作不变性、投影隐私、第二轮和独立三次重复 oracle；
- `api`：房间、平台、排位结算、棋钟定向回归；
- `animation`：63 张 eligible 的动效 reducer 和故障恢复路径。

正式 gate 包括：

- 四个 worker 时长与进程证据完整；
- 当前连续段至少完成一圈 63 个 balance 镜像组，且每组四局；
- balance/rules/animation 各自覆盖 63/63 eligible；
- 四张新主动牌 opportunity/use 完整；
- 无异常、卡死、回放分叉、隐私泄漏、重复结算、源码变化或连续性中断；
- `capped=0`；任一触顶对局都使正式运行失败，不能改写成和棋。

单张牌胜率、tier ordering、point estimate、bootstrap 区间和同档离群都不属于 acceptance gate。报告中的 tuning suggestions 必须为空，不允许自动改卡值。

## 4. 版本与证据门槛

当前证据身份：

- balance/report schema：5；
- soak schema：2；
- 算法：`product-stability-v14-v3-no-clock-zero-time-deterministic-ids-slot-stable-drafts`；
- 引擎：`augment-duel-dark-v3:threefold-3:strategic-sha256-v2`。

checkpoint 指纹必须绑定实际零时间配置、搜索深度、eligible/excluded IDs、赛程、目录、算法和引擎。任何旧 schema、旧算法、旧引擎、旧牌池或旧赛程证据都严格拒绝，不能与当前结果合并。

最终报告至少记录：

- `purpose=product_stability`；
- catalog 70 / eligible 63 / excluded 7 及精确 IDs；
- 运行起止、连续性、局数、手数、搜索节点；
- finished、threefold draw、capped、stuck、exception；
- eligible 覆盖与缺失；
- 四张新主动牌 opportunity/use；
- 回放、隐私、API、动画和恢复证据。

截至 2026-08-11 ET，最终代码回归为 244/244：HTML 9 项、TypeScript 232 项、真实集成 3 项；production build、全项目 ESLint、`tsc --noEmit --incremental false` 与 `git diff --check` 均通过。三套真实集成各连续执行 4 轮，共 12/12 通过；每轮端口可重新绑定，结束后孤儿进程为 0。

这组代码回归不替代正式持续测试。正式不少于 4 小时的四 worker soak 与 Sites 部署都必须发生在准确的冻结提交之后；持续测试通过后才能进入公开部署和生产 QA。权威长跑结果写入 `outputs/soak/<run-id>/final.json`，quick 报告写入 `outputs/balance/augment-balance-report.json`。`outputs/` 只保存本机证据，不提交。

## 5. 真人测试边界

自动化通过只说明当前冻结版本在已覆盖路径上具备技术稳定性，不能证明真人环境绝对平衡或全局最优。首批玩家反馈应重点收集：

- 单局时长、完成率、退出点与理解成本；
- 各军令实际选择、机会、使用和满意度；
- 新主动动作是否直观、是否造成等待或误操作；
- capped、重复和棋、无棋可走与回放异常；
- 花色与卡牌强度体感。

强度调整在获得真人数据后另开版本、单次改变明确参数并重新验证；当前产品稳定性 soak 不承担反复调强度。

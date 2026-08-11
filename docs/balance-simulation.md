# 军令强化 v3：产品稳定性模拟

`scripts/augment-balance-simulation.ts` 现在用于产品稳定性验证，不再承担反复调强度的任务。它的目标是尽快跑完整局，发现异常、卡死、回放分叉、隐藏信息泄漏、三次重复错误、主动牌不可达和长期不终局；胜率与档位结果只保留为诊断数据，永远不作为验收或自动调牌依据。

## 唯一模拟牌池

产品目录是 `junqi-augments-v3`，共 70 张。所有随机对局、同档配对、规则 worker、动画覆盖和覆盖率分母统一使用 63 张非计时牌。以下 7 张 `effect.kind === "clock"` 的牌仍属于正式产品，但暂不进入任何随机模拟或 soak 覆盖要求：

- `club-pocket-time`
- `club-steady-tempo`
- `diamond-drill`
- `diamond-pocket-watch`
- `diamond-time-cache`
- `heart-reserve-clock`
- `spade-strategic-reserve`

报告必须分别写明 `catalogSize=70`、`simulationEligibleSize=63` 和完整的 `excludedClockAugmentIds`。不得把计时牌计入缺失覆盖，也不得声称完成了 70/70 模拟。计时牌继续由现有定向规则、API 与产品排位棋钟测试覆盖。

第一轮受控 offer、第二轮随机 offer、刷新后的替换池和隐藏世界合成都会经过同一个 eligible pool。模拟对局与三次重复 trace 在任一轮选择后都断言 loadout 不含计时牌。

## 零时间、最快合法策略

自动对局固定为：

- 模拟思考延迟固定为 0；
- 权威状态和所有确定化世界均为 `clock=null`；
- 不 sleep，不在每次决策后人为增加毫秒；
- 默认搜索为 1 个确定化世界、3 个候选分支、1 层 rollout；
- 默认 `maxActions=300`，作为发现长期不终局的安全上限，而不是目标局长。

产品排位仍保留真实棋钟、加秒和计时牌规则。模拟到 300 手仍未终局时记为 `capped`，绝不能改写成和棋；v2/v3 产品引擎裁决的第三次战略局面重复才是正常的 `threefold_repetition` 和棋，并按双方各 0.5 计分，经典模式与 v1 保持原规则。

候选行动从玩家真实投影生成，不能读取未公开敌子身份。四腿镜像仍交换黑白和先手，同组共享处理无关的 Common Random Numbers。确定化会保留公开的重复出现次数，但使用新的盐和摘要，绝不复制服务端私有重复历史。

模拟器还为棋子 ID 使用独立 seed 的确定性 UUID 流；它不消耗布阵/战斗随机流，也不改变产品引擎，只消除随机 UUID 对同 seed 策略排序的干扰。第二轮刷新后的 eligible 约束只改写尚未锁定的 offer，已经锁定的另一方选择只做非计时校验，不能被后续刷新换出。

## 轻量赛程

正式产品稳定性赛程按花色建立确定性的环形相邻配对，而不是完整同档笛卡尔积。63 张 eligible 牌形成 63 个四腿镜像组，每张牌每个 cycle 出现在两个相邻 pair 中：

1. A 黑、B 白、黑先；
2. B 黑、A 白、黑先；
3. A 黑、B 白、白先；
4. B 黑、A 白、白先。

quick 默认跑一圈；四小时 worker 在整个连续时段内循环该赛程，并要求当前连续段至少完成一整圈。这样优先覆盖所有牌和状态机，同时避免完整同档笛卡尔赛程的强度搜索成本。

运行命令：

```text
node --experimental-transform-types scripts/augment-balance-simulation.ts --mode=quick
node --experimental-transform-types scripts/augment-balance-simulation.ts --mode=soak --duration-minutes=240
```

开发 smoke 可以限制 pair，但默认与正式运行都保留 300 手安全上限；显式降低 `--max-actions` 只适合故意验证 capped/退出码路径，不能伪装成完整局证据。任何一局到达上限都会让命令以失败状态结束。

## 新主动牌可达性

可见策略覆盖 v3 新动作：

- `heart-heavenly-exchange`：`augment_exchange`，枚举合法的跨前线双方棋子；
- `heart-shadow-redeploy`：`augment_redeploy`，生成少量确定性的完整 placements，而不是爆炸式全排列；
- `club-surprise-double-move`：`augment_begin_multi_move`，首步后继续普通 `move`，并允许 `pass_extra_move`；
- `club-bitter-ruse`：`augment_sacrifice`。

主动候选按军令 ID 保留搜索槽位，不会长期被普通移动剪掉。正式 soak 同时报告每张 eligible 牌的 `games`、`opportunityGames`、`triggerGames` 和 `triggers`，并要求上述四张新主动牌至少各获得一次合法机会和一次实际使用。`pass_extra_move` 会从旧 `extraMove` 或 v3 `ruleState.multiMove` 精确归因。

## Checkpoint 与报告

当前平衡 checkpoint/report schema 为 5，算法版本为 `product-stability-v14-v3-no-clock-zero-time-deterministic-ids-slot-stable-drafts`，引擎指纹为 `augment-duel-dark-v3:threefold-3:strategic-sha256-v2`。配置指纹绑定实际零时间配置、eligible IDs、排除 IDs、搜索配置和赛程。任何旧 schema、旧算法（包括 v13）、旧引擎、旧牌池、旧搜索或旧赛程 checkpoint 都必须拒绝，不能合并历史样本。

权威报告至少包含：

- `purpose=product_stability`；
- `catalogSize=70`、`simulationEligibleSize=63`、`excludedClockAugmentIds`；
- eligible 覆盖总数、已覆盖数和缺失 IDs；
- 完成、未完成、`capped`、`stuck`、异常、三次重复和棋与回放统计；
- 新主动牌 opportunity/use；
- 四腿镜像与 CRN 种子台账。

若异常发生在对局中途，原始腿台账必须保留异常前真实的手数、搜索节点、loadout、触发/机会、放弃追加行动和已完成 draft 选择，不能回填成“0 手空对局”。

卡牌与档位胜率只用于观察。正式报告的 `tuningSuggestions` 固定为空；不因自动模拟结果修改 `lib/augments.ts`。后续强度决策由第一批玩家数据和真人反馈负责。

## 发布证据边界

截至 2026-08-11 ET，最终代码回归为 244/244：HTML 9 项、TypeScript 232 项、真实集成 3 项；production build、全项目 ESLint、非增量 TypeScript 检查与差异检查均通过。三套真实集成各连续执行 4 轮，共 12/12 通过；端口每轮可重新绑定，结束后孤儿进程为 0。

这些回归证明当前覆盖路径可工作，不替代冻结提交上的正式持续测试。发布必须以准确的冻结提交连续运行四个 worker 不少于 4 小时、完成至少一整圈 63 个同花色环形四腿组，并让所有技术 gate 通过；随后才进入 Sites 部署与生产 QA。quick 的默认证据写入 `outputs/balance/augment-balance-report.json`，正式持续测试的权威结果写入 `outputs/soak/<run-id>/final.json`。`outputs/` 只保存本机证据，不提交到源码仓库。

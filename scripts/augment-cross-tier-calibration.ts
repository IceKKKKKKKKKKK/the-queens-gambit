import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  buildCrossTierExperimentSchedule,
  buildCrossTierReport,
  createEmptyCrossTierAggregate,
  crossTierConfigFingerprint,
  crossTierScheduleFingerprint,
  playCrossTierScheduledMirrorGroup,
  recordCrossTierScheduledMirrorGroup,
  type CrossTierAggregate,
  type CrossTierReport,
} from "./balance/cross-tier.ts";
import {
  BALANCE_ALGORITHM_VERSION,
  BALANCE_ENGINE_RULES_FINGERPRINT,
  type TournamentOptions,
} from "./balance/tournament.ts";
import { catalogFingerprint, stableStringify } from "./balance/visible-policy.ts";

export interface CrossCheckpoint {
  schemaVersion: 4;
  algorithmVersion: typeof BALANCE_ALGORITHM_VERSION;
  engineRulesFingerprint: typeof BALANCE_ENGINE_RULES_FINGERPRINT;
  catalogFingerprint: string;
  configFingerprint: string;
  scheduleFingerprint: string;
  seed: number;
  options: TournamentOptions;
  cursor: { cycle: number; groupIndex: number };
  completedGroupKeys: string[];
  elapsedActiveMs: number;
  updatedAt: string;
  aggregate: CrossTierAggregate;
}

interface CliOptions {
  mode: "quick" | "soak";
  durationMinutes: number;
  cycles: number;
  resume: boolean;
  checkpointPath: string;
  outputPath: string;
  markdownPath: string;
  tournament: TournamentOptions;
}

function parseCli(argv: readonly string[]): CliOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === "--resume") flags.add("resume");
    else {
      const match = argument.match(/^--([a-z-]+)=(.+)$/);
      if (!match) throw new Error(`Unknown argument ${argument}.`);
      values.set(match[1], match[2]);
    }
  }
  const mode = values.get("mode") ?? "quick";
  if (mode !== "quick" && mode !== "soak") throw new Error("--mode must be quick or soak.");
  const number = (key: string, fallback: number, minimum = 0, integer = true) => {
    const parsed = Number(values.get(key) ?? fallback);
    if (!Number.isFinite(parsed) || parsed < minimum || (integer && !Number.isSafeInteger(parsed))) {
      throw new Error(`Invalid --${key}.`);
    }
    return parsed;
  };
  const soak = mode === "soak";
  const thinkTimeMinMs = number("think-min-ms", 2_500);
  const tournament: TournamentOptions = {
    seed: number("seed", 20260809),
    maxActions: number("max-actions", soak ? 180 : 40, 1),
    thinkTimeMinMs,
    thinkTimeMaxMs: number("think-max-ms", 6_500, thinkTimeMinMs),
    search: {
      determinizations: number("determinizations", soak ? 4 : 1, 1),
      branching: number("branching", soak ? 8 : 3, 1),
      rolloutDepth: number("rollout-depth", soak ? 3 : 1, 1),
    },
    refreshMargin: 4,
  };
  return {
    mode,
    durationMinutes: number("duration-minutes", soak ? 60 : 0, 0, false),
    cycles: number("cycles", 1, 1),
    resume: flags.has("resume"),
    checkpointPath: resolve(
      values.get("checkpoint") ?? "outputs/balance/cross-tier-checkpoint.json",
    ),
    outputPath: resolve(values.get("output") ?? "outputs/balance/cross-tier-report.json"),
    markdownPath: resolve(values.get("markdown") ?? "outputs/balance/cross-tier-report.md"),
    tournament,
  };
}

export function createCrossTierCheckpoint(options: TournamentOptions): CrossCheckpoint {
  return {
    schemaVersion: 4,
    algorithmVersion: BALANCE_ALGORITHM_VERSION,
    engineRulesFingerprint: BALANCE_ENGINE_RULES_FINGERPRINT,
    catalogFingerprint: catalogFingerprint(),
    configFingerprint: crossTierConfigFingerprint(options),
    scheduleFingerprint: crossTierScheduleFingerprint(),
    seed: options.seed,
    options: structuredClone(options),
    cursor: { cycle: 0, groupIndex: 0 },
    completedGroupKeys: [],
    elapsedActiveMs: 0,
    updatedAt: new Date().toISOString(),
    aggregate: createEmptyCrossTierAggregate(),
  };
}

export function validateCrossTierCheckpoint(
  checkpoint: CrossCheckpoint,
  options: TournamentOptions,
) {
  if (checkpoint.algorithmVersion !== BALANCE_ALGORITHM_VERSION) {
    throw new Error(
      `Cross-tier balance algorithm ${String(checkpoint.algorithmVersion)} is not supported.`,
    );
  }
  if (checkpoint.schemaVersion !== 4) throw new Error("Unsupported cross-tier checkpoint schema.");
  if (checkpoint.engineRulesFingerprint !== BALANCE_ENGINE_RULES_FINGERPRINT) {
    throw new Error("Cross-tier engine rules fingerprint is not supported.");
  }
  if (checkpoint.catalogFingerprint !== catalogFingerprint()) throw new Error("Cross-tier catalog changed.");
  if (checkpoint.configFingerprint !== crossTierConfigFingerprint(options)) {
    throw new Error("Cross-tier search configuration changed.");
  }
  if (stableStringify(checkpoint.options) !== stableStringify(options)) {
    throw new Error("Cross-tier checkpoint options do not match the current tournament options.");
  }
  if (checkpoint.seed !== options.seed) {
    throw new Error("Cross-tier checkpoint seed does not match the current tournament options.");
  }
  if (checkpoint.scheduleFingerprint !== crossTierScheduleFingerprint()) {
    throw new Error("Cross-tier card schedule changed.");
  }
  if (new Set(checkpoint.completedGroupKeys).size !== checkpoint.completedGroupKeys.length) {
    throw new Error("Cross-tier checkpoint contains duplicate group keys.");
  }
  if (
    !Number.isSafeInteger(checkpoint.cursor.cycle) ||
    checkpoint.cursor.cycle < 0 ||
    !Number.isSafeInteger(checkpoint.cursor.groupIndex) ||
    checkpoint.cursor.groupIndex < 0
  ) {
    throw new Error("Cross-tier checkpoint cursor is invalid.");
  }
  if (checkpoint.cursor.cycle > checkpoint.completedGroupKeys.length + 1) {
    throw new Error("Cross-tier checkpoint cursor is inconsistent with its completed groups.");
  }
  const currentSchedule = buildCrossTierExperimentSchedule(checkpoint.cursor.cycle);
  if (checkpoint.cursor.groupIndex >= currentSchedule.length) {
    throw new Error("Cross-tier checkpoint cursor is outside the current cycle schedule.");
  }
  const expectedCompletedGroups = [];
  for (let cycle = 0; cycle < checkpoint.cursor.cycle; cycle += 1) {
    expectedCompletedGroups.push(...buildCrossTierExperimentSchedule(cycle));
  }
  expectedCompletedGroups.push(...currentSchedule.slice(0, checkpoint.cursor.groupIndex));
  const expectedCompletedKeys = expectedCompletedGroups.map((group) => group.groupKey);
  if (
    expectedCompletedKeys.length !== checkpoint.completedGroupKeys.length ||
    expectedCompletedKeys.some((key, index) => checkpoint.completedGroupKeys[index] !== key)
  ) {
    throw new Error("Cross-tier completed groups do not match the schedule prefix at the cursor.");
  }
  if (!checkpoint.aggregate || !Array.isArray(checkpoint.aggregate.legResults)) {
    throw new Error("Cross-tier checkpoint is missing its authoritative raw-leg ledger.");
  }
  if (checkpoint.aggregate.legResults.length !== expectedCompletedGroups.length * 4) {
    throw new Error("Cross-tier checkpoint raw-leg ledger does not match the completed schedule prefix.");
  }
  const rebuilt = createEmptyCrossTierAggregate();
  for (let groupIndex = 0; groupIndex < expectedCompletedGroups.length; groupIndex += 1) {
    const group = expectedCompletedGroups[groupIndex];
    const start = groupIndex * 4;
    const legs = checkpoint.aggregate.legResults.slice(start, start + 4);
    recordCrossTierScheduledMirrorGroup(rebuilt, group, legs, options);
  }
  if (stableStringify(rebuilt) !== stableStringify(checkpoint.aggregate)) {
    throw new Error(
      "Cross-tier checkpoint aggregate does not match the deterministic authoritative raw-leg rebuild.",
    );
  }
  return checkpoint;
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function crossTierMarkdown(report: CrossTierReport) {
  const percent = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
  const milliseconds = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
  return [
    "# 军令全目录跨档校正实验",
    "",
    `证据配置：seed ${report.seed}；maxActions ${report.options.maxActions}；思考 ${report.options.thinkTimeMinMs}–${report.options.thinkTimeMaxMs} ms；搜索 ${report.options.search.determinizations}×${report.options.search.branching}×${report.options.search.rolloutDepth}；refreshMargin ${report.options.refreshMargin}；engine ${report.engineRulesFingerprint}；config ${report.configFingerprint}；schedule ${report.scheduleFingerprint}。`,
    `计划镜像组 ${report.global.plannedGroups ?? "持续模式"}；已执行镜像组 ${report.global.executedGroups}；完整镜像组 ${report.global.completeMirrorGroups}；对局 ${report.global.games}；三次重复和棋 ${report.global.threefoldDraws}；搜索节点 ${report.global.searchNodes}；异常 ${report.global.exceptions}；卡死 ${report.global.stuck}；封顶 ${report.global.capped}。`,
    `第二轮时序：到达 ${report.global.draftTiming.reachedLegs} 腿；公开 ${report.global.draftTiming.revealedLegs} 腿；第二焦点选择 ${report.global.draftTiming.roundTwoFocalSelections} 次；违规 ${report.global.draftTiming.timingViolations}。`,
    "",
    `已执行目录覆盖：${report.coverage.executedCards}/${report.catalogSize}；纯轮次层至少一个完整样本 ${report.coverage.roundOrderCompleteCards} 张；非 setup 双轮次完整覆盖 ${report.coverage.nonSetupBothOrdersCompleteCards}/${report.coverage.requiredNonSetupCards}；setup 焦点完整覆盖 ${report.coverage.setupFocalCompleteCards}/${report.coverage.requiredSetupCards}；缺失：${report.coverage.missingCards.join("、") || "无"}。`,
    "",
    "## 非 setup：轮次交叉平衡层",
    "",
    "| 高档 | 低档 | 已执行组 | 完整镜像组 | 高档卡等权得分 | 镜像组 bootstrap 区间 | 高档先选 | 低档先选 | 异常/卡死/封顶 | 时序 到达/公开/选择/违规 | 焦点触发 H/L | 焦点机会 H/L | 末钟 H/L | 方向 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.comparisons.map(
      (row) =>
        `| ${row.higher} | ${row.lower} | ${row.executedGroups} | ${row.completeMirrorGroups} | ${percent(row.higherScore?.estimate)} | ${percent(row.higherScore?.low)}–${percent(row.higherScore?.high)} | ${percent(row.byRoundOrder.higher_first?.estimate)} | ${percent(row.byRoundOrder.lower_first?.estimate)} | ${row.exceptions}/${row.stuck}/${row.capped} | ${row.draftTiming.reachedLegs}/${row.draftTiming.revealedLegs}/${row.draftTiming.roundTwoFocalSelections}/${row.draftTiming.timingViolations} | ${row.focal.higher.triggers}/${row.focal.lower.triggers} | ${row.focal.higher.opportunities}/${row.focal.lower.opportunities} | ${milliseconds(row.averageFinalClockMs.higher)}/${milliseconds(row.averageFinalClockMs.lower)} | ${row.direction} |`,
    ),
    "",
    "## setup 专层（不计入纯档位结论）",
    "",
    "| 高档 | 低档 | 已执行组 | 完整镜像组 | 高档卡等权得分 | 异常/卡死/封顶 | 结束原因 |",
    "|---|---|---:|---:|---:|---:|---|",
    ...report.setupComparisons.map(
      (row) =>
        `| ${row.higher} | ${row.lower} | ${row.executedGroups} | ${row.completeMirrorGroups} | ${percent(row.higherScore?.estimate)} | ${row.exceptions}/${row.stuck}/${row.capped} | ${Object.entries(row.finishReasons).map(([reason, count]) => `${reason}:${count}`).join("；") || "—"} |`,
    ),
    "",
    `方法学验收：${report.acceptancePass ? "通过" : "不通过"}。只有计划组全部执行并在每腿真实到达第 10 手选择后形成完整镜像、无异常/卡死/封顶/时序违规、50 张卡完成对应层覆盖且每个纯轮次比较达到样本门槛时才通过；短样本或未完成赛程一律不通过。`,
    `描述性平衡结果：预期方向 ${report.ordering.expected}；六组纯轮次点估计符合：${report.ordering.pointEstimatePass ? "是" : "否"}；卡等权档位均值递减：${report.ordering.tierPointEstimatePass ? "是" : "否"}；样本门槛全部达到：${report.ordering.sampleSufficient ? "是" : "否"}；bootstrap 区间均高于 50%：${report.ordering.intervalsAllAboveParity ? "是" : "否"}。点估计仅作描述，不作为方法学验收门槛。`,
    "",
    ...report.limitations.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

async function run() {
  const cli = parseCli(process.argv.slice(2));
  const checkpoint = cli.resume
    ? validateCrossTierCheckpoint(
        JSON.parse(await readFile(cli.checkpointPath, "utf8")) as CrossCheckpoint,
        cli.tournament,
      )
    : createCrossTierCheckpoint(cli.tournament);
  const completed = new Set(checkpoint.completedGroupKeys);
  const started = performance.now();
  const priorElapsed = checkpoint.elapsedActiveMs;
  const deadline =
    cli.mode === "soak" ? started + cli.durationMinutes * 60_000 : Number.POSITIVE_INFINITY;
  while (
    cli.mode === "soak" ? performance.now() < deadline : checkpoint.cursor.cycle < cli.cycles
  ) {
    const schedule = buildCrossTierExperimentSchedule(checkpoint.cursor.cycle);
    const group = schedule[checkpoint.cursor.groupIndex];
    if (!completed.has(group.groupKey)) {
      const results = playCrossTierScheduledMirrorGroup(group, cli.tournament);
      recordCrossTierScheduledMirrorGroup(checkpoint.aggregate, group, results, cli.tournament);
      completed.add(group.groupKey);
      checkpoint.completedGroupKeys.push(group.groupKey);
    }
    checkpoint.cursor.groupIndex += 1;
    if (checkpoint.cursor.groupIndex >= schedule.length) {
      checkpoint.cursor.groupIndex = 0;
      checkpoint.cursor.cycle += 1;
    }
    checkpoint.elapsedActiveMs = priorElapsed + performance.now() - started;
    checkpoint.updatedAt = new Date().toISOString();
    await atomicJson(cli.checkpointPath, checkpoint);
  }
  checkpoint.elapsedActiveMs = priorElapsed + performance.now() - started;
  checkpoint.updatedAt = new Date().toISOString();
  await atomicJson(cli.checkpointPath, checkpoint);
  const plannedGroups =
    cli.mode === "quick"
      ? Array.from({ length: cli.cycles }, (_, cycle) => buildCrossTierExperimentSchedule(cycle).length)
          .reduce((sum, count) => sum + count, 0)
      : null;
  const report = buildCrossTierReport(checkpoint.aggregate, cli.tournament, plannedGroups);
  await atomicJson(cli.outputPath, report);
  await mkdir(dirname(cli.markdownPath), { recursive: true });
  await writeFile(cli.markdownPath, `${crossTierMarkdown(report)}\n`, "utf8");
  console.log(
    `cross-tier games=${report.global.games} planned=${report.global.plannedGroups ?? "continuous"} executed=${report.global.executedGroups} complete=${report.global.completeMirrorGroups} nodes=${report.global.searchNodes} ` +
      `exceptions=${report.global.exceptions} stuck=${report.global.stuck} acceptance=${report.acceptancePass} point-estimate=${report.ordering.pointEstimatePass}`,
  );
  console.log(`json=${cli.outputPath}`);
  if (!report.acceptancePass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { parseCli };

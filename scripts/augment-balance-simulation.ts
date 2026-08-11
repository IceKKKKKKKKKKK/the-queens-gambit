import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  assertCatalogReadyForTournament,
  buildBalanceReport,
  buildProductStabilityPairings,
  createCheckpoint,
  playMirrorGroup,
  recordMirrorGroup,
  scheduleGroup,
  stratifiedPairSample,
  summarizeReport,
  validateCheckpoint,
  type BalanceCheckpoint,
  type BalanceReport,
  type Pairing,
  type TournamentOptions,
} from "./balance/tournament.ts";
import { unknownActiveEffectKinds } from "./balance/visible-policy.ts";

interface CliOptions {
  mode: "quick" | "soak";
  durationMinutes: number;
  cycles: number;
  mirrorGroupsPerPair: number;
  pairLimit: number | null;
  pairsPerSuit: number | null;
  checkpointPath: string;
  outputPath: string;
  markdownPath: string;
  resume: boolean;
  quiet: boolean;
  tournament: TournamentOptions;
}

function helpText() {
  return `军令隐藏信息平衡对弈

Usage:
  node --experimental-transform-types scripts/augment-balance-simulation.ts [options]

Modes:
  --mode=quick                 One complete same-suit stability ring (default)
  --mode=soak                  Repeat the stability ring until wall-clock duration
  --duration-minutes=240       Soak time for this invocation
  --cycles=1                   Complete cycles in quick mode
  --mirror-groups-per-pair=1   Four mirrored games per group

Search and game:
  --seed=20260809
  --max-actions=300             Safety cap; threefold repetition normally ends loops first
  --determinizations=1|4
  --branching=3|8
  --rollout-depth=1|3
  --refresh-margin=4

Persistence:
  --checkpoint=outputs/balance/checkpoint.json
  --output=outputs/balance/report.json
  --markdown=outputs/balance/report.md
  --resume                     Validate and continue the exact checkpoint

Developer smoke option:
  --pair-limit=N               Run only the first N pairings (fingerprinted)
  --pairs-per-suit=N           Evenly sample N pairings from every suit (fingerprinted)
  --quiet                      Suppress periodic console progress
`;
}

function parseCli(argv: readonly string[]): CliOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === "--resume" || argument === "--quiet" || argument === "--help") {
      flags.add(argument.slice(2));
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error(`Unknown argument: ${argument}. Use --help for supported options.`);
    values.set(match[1], match[2]);
  }
  if (flags.has("help")) {
    console.log(helpText());
    process.exit(0);
  }
  const mode = values.get("mode") ?? "quick";
  if (mode !== "quick" && mode !== "soak") throw new Error("--mode must be quick or soak.");
  const numberOption = (
    key: string,
    fallback: number,
    constraints: { integer?: boolean; minimum?: number } = {},
  ) => {
    const parsed = Number(values.get(key) ?? fallback);
    if (
      !Number.isFinite(parsed) ||
      (constraints.integer && !Number.isSafeInteger(parsed)) ||
      parsed < (constraints.minimum ?? 0)
    ) {
      throw new Error(`--${key} has an invalid value.`);
    }
    return parsed;
  };
  const soak = mode === "soak";
  if (values.has("think-min-ms") || values.has("think-max-ms")) {
    throw new Error("Bot think-time options were removed; simulations always run at 0 ms.");
  }
  const seed = numberOption("seed", 20260809, { integer: true, minimum: 0 });
  const maxActions = numberOption("max-actions", 300, {
    integer: true,
    minimum: 1,
  });
  const tournament: TournamentOptions = {
    seed,
    maxActions,
    thinkTimeMinMs: 0,
    thinkTimeMaxMs: 0,
    search: {
      determinizations: numberOption("determinizations", 1, {
        integer: true,
        minimum: 1,
      }),
      branching: numberOption("branching", 3, { integer: true, minimum: 1 }),
      rolloutDepth: numberOption("rollout-depth", 1, {
        integer: true,
        minimum: 1,
      }),
    },
    refreshMargin: numberOption("refresh-margin", 4, { minimum: 0 }),
  };
  const checkpointPath = resolve(
    values.get("checkpoint") ?? "outputs/balance/augment-balance-checkpoint.json",
  );
  const outputPath = resolve(values.get("output") ?? "outputs/balance/augment-balance-report.json");
  const markdownPath = resolve(values.get("markdown") ?? "outputs/balance/augment-balance-report.md");
  const rawPairLimit = values.has("pair-limit")
    ? numberOption("pair-limit", 0, { integer: true, minimum: 1 })
    : null;
  const pairsPerSuit = values.has("pairs-per-suit")
    ? numberOption("pairs-per-suit", 0, { integer: true, minimum: 1 })
    : null;
  if (rawPairLimit !== null && pairsPerSuit !== null) {
    throw new Error("--pair-limit and --pairs-per-suit cannot be combined.");
  }
  return {
    mode,
    durationMinutes: numberOption("duration-minutes", soak ? 240 : 0, { minimum: 0 }),
    cycles: numberOption("cycles", 1, { integer: true, minimum: 1 }),
    mirrorGroupsPerPair: numberOption("mirror-groups-per-pair", 1, {
      integer: true,
      minimum: 1,
    }),
    pairLimit: rawPairLimit,
    pairsPerSuit,
    checkpointPath,
    outputPath,
    markdownPath,
    resume: flags.has("resume"),
    quiet: flags.has("quiet"),
    tournament,
  };
}

async function atomicJsonWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function loadCheckpoint(
  path: string,
  options: TournamentOptions,
  pairings: readonly Pairing[],
) {
  const parsed = JSON.parse(await readFile(path, "utf8")) as BalanceCheckpoint;
  return validateCheckpoint(parsed, options, pairings);
}

function markdownReport(report: BalanceReport) {
  const percent = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "# 军令产品稳定性对弈报告",
    "",
    `生成时间：${report.generatedAt}`,
    "",
    `产品目录：${report.catalogSize} 张；模拟 eligible：${report.simulationEligibleSize} 张；计时卡排除：${report.excludedClockAugmentIds.length} 张；覆盖：${report.simulationCoverage.covered}/${report.simulationCoverage.total}；镜像组：${report.global.groups}；对局：${report.global.games}；完成：${report.global.finished}；三次重复和棋：${report.global.threefoldDraws}；未完成：${report.global.unfinished}；搜索节点：${report.global.searchNodes}；放弃追加行动：${report.global.passExtraMoves}；engine：${report.engineRulesFingerprint}。`,
    "",
    `排除的计时卡：${report.excludedClockAugmentIds.join("、")}。`,
    "",
    `先手胜率：${percent(report.global.firstPlayerWinRate?.estimate)}（95% CI ${percent(report.global.firstPlayerWinRate?.low)}–${percent(report.global.firstPlayerWinRate?.high)}）；黑方胜率：${percent(report.global.blackWinRate?.estimate)}。`,
    "",
    "| 花色 | 军令 | 持有局 | 三次重复和棋 | 镜像分 | 95% CI | 被选率 | 发动局率 | 无机会率 | 放弃追加行动 | 首次发动中位手 |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.cards.map(
      (card) =>
        `| ${card.suit} | ${card.name} | ${card.games} | ${card.threefoldDraws} | ${percent(card.mirrorScore?.estimate)} | ${percent(card.mirrorScore?.low)}–${percent(card.mirrorScore?.high)} | ${percent(card.pickRate)} | ${percent(card.triggerRate)} | ${percent(card.heldWithoutOpportunityRate)} | ${card.passExtraMoves} | ${card.firstTriggerMoveDistribution.median ?? "—"} |`,
    ),
    "",
    "## 强度诊断边界",
    "",
    "卡牌与档位胜率只作诊断，不参与验收，也不会生成自动调参建议；后续平衡由真人测试数据驱动。",
    "",
    "## 解释边界",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
  ];
  return lines.join("\n");
}

function advanceCursor(
  checkpoint: BalanceCheckpoint,
  pairings: readonly Pairing[],
  mirrorGroupsPerPair: number,
) {
  checkpoint.cursor.replicate += 1;
  if (checkpoint.cursor.replicate >= mirrorGroupsPerPair) {
    checkpoint.cursor.replicate = 0;
    checkpoint.cursor.pairIndex += 1;
  }
  if (checkpoint.cursor.pairIndex >= pairings.length) {
    checkpoint.cursor.pairIndex = 0;
    checkpoint.cursor.cycle += 1;
  }
}

async function run() {
  const cli = parseCli(process.argv.slice(2));
  assertCatalogReadyForTournament();
  let pairings = buildProductStabilityPairings();
  if (cli.pairLimit !== null) pairings = pairings.slice(0, cli.pairLimit);
  if (cli.pairsPerSuit !== null) pairings = stratifiedPairSample(pairings, cli.pairsPerSuit);
  if (!pairings.length) throw new Error("The selected catalog produces no same-suit pairings.");
  const checkpoint = cli.resume
    ? await loadCheckpoint(cli.checkpointPath, cli.tournament, pairings)
    : createCheckpoint(cli.tournament, new Date(), pairings);
  const invocationStarted = performance.now();
  const priorElapsedActiveMs = checkpoint.elapsedActiveMs;
  const deadline =
    cli.mode === "soak"
      ? invocationStarted + cli.durationMinutes * 60_000
      : Number.POSITIVE_INFINITY;
  let groupsThisInvocation = 0;

  while (
    cli.mode === "soak"
      ? performance.now() < deadline
      : checkpoint.cursor.cycle < cli.cycles
  ) {
    const pairing = pairings[checkpoint.cursor.pairIndex];
    const group = scheduleGroup(
      pairing,
      checkpoint.cursor.cycle,
      checkpoint.cursor.replicate,
    );
    if (checkpoint.completedGroupKeys.includes(group.groupKey)) {
      advanceCursor(checkpoint, pairings, cli.mirrorGroupsPerPair);
      continue;
    }
    const results = playMirrorGroup(group, cli.tournament);
    recordMirrorGroup(checkpoint.aggregate, group, results);
    checkpoint.completedGroupKeys.push(group.groupKey);
    advanceCursor(checkpoint, pairings, cli.mirrorGroupsPerPair);
    groupsThisInvocation += 1;
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.elapsedActiveMs = priorElapsedActiveMs + performance.now() - invocationStarted;
    await atomicJsonWrite(cli.checkpointPath, checkpoint);
    if (!cli.quiet && (groupsThisInvocation === 1 || groupsThisInvocation % 10 === 0)) {
      console.log(
        `groups=${checkpoint.aggregate.global.groups} games=${checkpoint.aggregate.global.games} ` +
          `finished=${checkpoint.aggregate.global.finished} cycle=${checkpoint.cursor.cycle} ` +
          `pair=${checkpoint.cursor.pairIndex}/${pairings.length}`,
      );
    }
  }

  // Normalize active duration once at invocation end. Checkpoints are durable
  // after every four-leg group, so an interrupted group is safely replayed.
  checkpoint.elapsedActiveMs = priorElapsedActiveMs + performance.now() - invocationStarted;
  checkpoint.updatedAt = new Date().toISOString();
  await atomicJsonWrite(cli.checkpointPath, checkpoint);
  const report = buildBalanceReport(checkpoint, unknownActiveEffectKinds());
  await atomicJsonWrite(cli.outputPath, report);
  await mkdir(dirname(cli.markdownPath), { recursive: true });
  await writeFile(cli.markdownPath, `${markdownReport(report)}\n`, "utf8");
  console.log(summarizeReport(report));
  console.log(`checkpoint=${cli.checkpointPath}`);
  console.log(`json=${cli.outputPath}`);
  console.log(`markdown=${cli.markdownPath}`);
  if (
    report.global.exceptions > 0 ||
    report.global.stuck > 0 ||
    report.global.capped > 0
  ) {
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { parseCli };

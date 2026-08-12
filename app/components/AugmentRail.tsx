"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import type { AugmentDefinition, AugmentId } from "@/lib/augments";

import AugmentCard, {
  type AugmentCardBurnState,
  type AugmentCardState,
} from "./AugmentCard";
import AugmentInspectDialog from "./AugmentInspectDialog";
import styles from "./Augments.module.css";
import {
  AUGMENT_BURN_MOTION_MS,
  canInteractWithAugment,
  shouldAnimateAugmentBurn,
} from "./augmentMotion";

export interface AugmentRailItem {
  augment?: AugmentDefinition | null;
  hidden?: boolean;
  triggerCount?: number;
  publiclyRevealed?: boolean;
  hasLegalTarget?: boolean;
}

export interface AugmentRailProps {
  label: string;
  items: readonly AugmentRailItem[];
  activeId?: AugmentId | null;
  canActivate?: boolean;
  isOwnTurn?: boolean;
  pendingReconId?: AugmentId | null;
  pending?: boolean;
  onActivate?: (augmentId: AugmentId) => void;
  dockTarget?: boolean;
}

interface RailCardPresentation {
  augment: AugmentDefinition | null;
  augmentId: AugmentId | null;
  hidden: boolean;
  state: AugmentCardState;
  statusLabel: string;
  supportsManualActivation: boolean;
  activatable: boolean;
  activationDisabledReason: string;
}

function supportsManualActivation(augment: AugmentDefinition) {
  return augment.activation === "active" && (
    augment.effect.kind === "movement" ||
    augment.effect.kind === "exchange" ||
    augment.effect.kind === "multi_move" ||
    augment.effect.kind === "redeployment" ||
    augment.effect.kind === "sacrifice_reconnaissance" ||
    (augment.effect.kind === "reconnaissance" && augment.effect.mode === "choose_enemy")
  );
}

function presentRailCard(
  item: AugmentRailItem,
  context: {
    activeId: AugmentId | null;
    canActivate: boolean;
    isOwnTurn: boolean;
    pendingReconId: AugmentId | null;
    pending: boolean;
    hasActivationHandler: boolean;
  },
): RailCardPresentation {
  const augment = item.augment ?? null;
  const augmentId = augment?.id ?? null;
  const hidden = Boolean(item.hidden || !augment);
  if (!augment || hidden) {
    return {
      augment,
      augmentId,
      hidden: true,
      state: "hidden",
      statusLabel: "未公开",
      supportsManualActivation: false,
      activatable: false,
      activationDisabledReason: "军令尚未公开。",
    };
  }

  const active = context.activeId === augment.id;
  const charges = augment.charges;
  const triggerCount = Math.min(charges, Math.max(0, item.triggerCount ?? 0));
  const consumable = augment.activation !== "passive" && augment.activation !== "setup";
  const exhausted = consumable && triggerCount >= charges;
  const partiallyTriggered = consumable && triggerCount > 0 && !exhausted;
  const manual = supportsManualActivation(augment);
  const interactionAllowed = canInteractWithAugment(augment, {
    enabled: context.canActivate,
    isOwnTurn: context.isOwnTurn,
    pendingReconId: context.pendingReconId,
  });
  const activatable = Boolean(
    context.hasActivationHandler &&
    !context.pending &&
    !exhausted &&
    item.hasLegalTarget !== false &&
    interactionAllowed
  );
  const state: AugmentCardState = exhausted
    ? "used"
    : active
      ? "selected"
      : "available";
  const statusLabel = exhausted
    ? `已耗尽 ${triggerCount}/${charges}`
    : partiallyTriggered
      ? `已触发 ${triggerCount}/${charges}`
      : active
        ? "已启用"
        : augment.activation === "setup"
          ? "布阵生效"
          : augment.activation === "passive"
            ? "持续生效"
            : !manual
              ? "等待触发"
              : augment.effect.kind === "reconnaissance"
                ? context.canActivate && context.pendingReconId === augment.id
                  ? "可用"
                  : "等待侦察"
                : context.canActivate && context.isOwnTurn
                  ? item.hasLegalTarget === false
                    ? "暂无目标"
                    : "可用"
                  : context.canActivate
                    ? "等待回合"
                    : "等待对局";
  const disclosedStatusLabel = item.publiclyRevealed === false
    ? `${statusLabel} · 待公开`
    : statusLabel;
  const activationDisabledReason = context.pending
    ? "当前行动仍在处理中。"
    : exhausted
      ? "这张军令已经耗尽。"
      : item.hasLegalTarget === false
        ? "当前棋盘上暂无合法目标。"
        : !context.canActivate
          ? "对局尚未进入可发动阶段。"
          : augment.effect.kind === "reconnaissance" && context.pendingReconId !== augment.id
            ? "尚未进入这张军令的侦察时机。"
            : !context.isOwnTurn
              ? "请等待你的回合。"
              : "当前无法发动这张军令。";

  return {
    augment,
    augmentId,
    hidden: false,
    state,
    statusLabel: disclosedStatusLabel,
    supportsManualActivation: manual,
    activatable,
    activationDisabledReason,
  };
}

export default function AugmentRail({
  label,
  items,
  activeId = null,
  canActivate = false,
  isOwnTurn = false,
  pendingReconId = null,
  pending = false,
  onActivate,
  dockTarget = false,
}: AugmentRailProps) {
  const previousCountsRef = useRef(new Map<AugmentId, number>());
  const initializedRef = useRef(false);
  const burnTimersRef = useRef(new Map<AugmentId, number>());
  const stateTimersRef = useRef(new Set<number>());
  const burntIdsRef = useRef(new Set<AugmentId>());
  const [reducedMotion, setReducedMotion] = useState(false);
  const [burningIds, setBurningIds] = useState<ReadonlySet<AugmentId>>(() => new Set());
  const [burntIds, setBurntIds] = useState<ReadonlySet<AugmentId>>(() => new Set());
  const [previewId, setPreviewId] = useState<AugmentId | null>(null);
  const [inspectedId, setInspectedId] = useState<AugmentId | null>(null);
  const possessiveLabel = label === "我的" ? "我的" : `${label}的`;
  const visibleCount = items.filter((item) => item.augment && !item.hidden).length;
  const privateLockedCount = items.filter(
    (item) => item.augment && !item.hidden && item.publiclyRevealed === false,
  ).length;
  const publicCount = visibleCount - privateLockedCount;
  const exhaustedCount = items.filter((item) => {
    if (!item.augment || item.hidden) return false;
    return item.augment.activation !== "passive" &&
      item.augment.activation !== "setup" &&
      Math.max(0, item.triggerCount ?? 0) >= item.augment.charges;
  }).length;
  const presentations = useMemo(() => items.map((item) => presentRailCard(item, {
    activeId,
    canActivate,
    isOwnTurn,
    pendingReconId,
    pending,
    hasActivationHandler: Boolean(onActivate),
  })), [activeId, canActivate, isOwnTurn, items, onActivate, pending, pendingReconId]);
  const preview = presentations.find((item) => item.augmentId === previewId && !item.hidden) ?? null;
  const inspected = presentations.find((item) => item.augmentId === inspectedId && !item.hidden) ?? null;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReducedMotion(media.matches);
    syncPreference();
    media.addEventListener("change", syncPreference);
    return () => media.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    if (!reducedMotion || burnTimersRef.current.size === 0) return;
    const completed = new Set<AugmentId>();
    for (const [augmentId, timer] of burnTimersRef.current) {
      window.clearTimeout(timer);
      burntIdsRef.current.add(augmentId);
      completed.add(augmentId);
    }
    burnTimersRef.current.clear();
    const stateTimer = window.setTimeout(() => {
      stateTimersRef.current.delete(stateTimer);
      setBurningIds((current) => {
        const next = new Set(current);
        for (const augmentId of completed) next.delete(augmentId);
        return next;
      });
      setBurntIds((current) => new Set([...current, ...completed]));
    }, 0);
    stateTimersRef.current.add(stateTimer);
  }, [reducedMotion]);

  useEffect(() => {
    const nextCounts = new Map<AugmentId, number>();
    const silentlyBurnt = new Set<AugmentId>();

    for (const item of items) {
      if (!item.augment || item.hidden) continue;
      const nextCount = Math.max(0, item.triggerCount ?? 0);
      nextCounts.set(item.augment.id, nextCount);
      const augmentId = item.augment.id;
      const previousCount = previousCountsRef.current.get(augmentId);
      const consumable = item.augment.activation !== "passive" &&
        item.augment.activation !== "setup";
      if (consumable && nextCount >= item.augment.charges && previousCount === undefined) {
        burntIdsRef.current.add(augmentId);
        silentlyBurnt.add(augmentId);
        continue;
      }
      const shouldBurn = initializedRef.current && shouldAnimateAugmentBurn(
        item.augment.activation,
        item.augment.charges,
        previousCount,
        nextCount,
      );
      if (
        !shouldBurn ||
        burntIdsRef.current.has(augmentId) ||
        burnTimersRef.current.has(augmentId)
      ) continue;

      if (reducedMotion) {
        burntIdsRef.current.add(augmentId);
        silentlyBurnt.add(augmentId);
        continue;
      }
      const startTimer = window.setTimeout(() => {
        setBurningIds((current) => new Set(current).add(augmentId));
        const finishTimer = window.setTimeout(() => {
          burnTimersRef.current.delete(augmentId);
          burntIdsRef.current.add(augmentId);
          setBurningIds((current) => {
            const next = new Set(current);
            next.delete(augmentId);
            return next;
          });
          setBurntIds((current) => new Set(current).add(augmentId));
        }, AUGMENT_BURN_MOTION_MS);
        burnTimersRef.current.set(augmentId, finishTimer);
      }, 0);
      burnTimersRef.current.set(augmentId, startTimer);
    }

    if (silentlyBurnt.size > 0) {
      const stateTimer = window.setTimeout(() => {
        stateTimersRef.current.delete(stateTimer);
        setBurntIds((current) => new Set([...current, ...silentlyBurnt]));
      }, 0);
      stateTimersRef.current.add(stateTimer);
    }
    initializedRef.current = true;
    previousCountsRef.current = nextCounts;
  }, [items, reducedMotion]);

  useEffect(() => {
    if ((!previewId || preview) && (!inspectedId || inspected)) return;
    const timer = window.setTimeout(() => {
      if (previewId && !preview) setPreviewId(null);
      if (inspectedId && !inspected) setInspectedId(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [inspected, inspectedId, preview, previewId]);

  useEffect(() => () => {
    for (const timer of burnTimersRef.current.values()) window.clearTimeout(timer);
    burnTimersRef.current.clear();
    for (const timer of stateTimersRef.current) window.clearTimeout(timer);
    stateTimersRef.current.clear();
  }, []);

  return (
    <section
      className={styles.rail}
      aria-label={`${possessiveLabel}军令`}
      aria-busy={pending}
      data-augment-dock-target={dockTarget ? "true" : undefined}
      style={{ "--augment-burn-ms": `${AUGMENT_BURN_MOTION_MS}ms` } as CSSProperties}
    >
      <header className={styles.railHeader}>
        <h3 className={styles.railTitle}>{label} · 军令</h3>
        <p className={styles.railMeta} aria-live="polite">
          {items.length === 0
            ? "尚未获得"
            : privateLockedCount > 0
              ? `${publicCount ? `${publicCount} 张公开 · ` : ""}${privateLockedCount} 张已锁定 · 待公开${exhaustedCount ? ` · ${exhaustedCount} 张已耗尽` : ""}`
              : `${publicCount} 张公开${exhaustedCount ? ` · ${exhaustedCount} 张已耗尽` : ""}`}
        </p>
      </header>

      {items.length > 0 ? (
        <ul
          className={`${styles.railCards} ${items.length === 1 ? styles.railCardsSingle : ""}`}
          aria-label={`${possessiveLabel}军令牌`}
        >
          {presentations.map((presentation, index) => {
            const augmentId = presentation.augmentId;
            const burnState: AugmentCardBurnState = augmentId && burningIds.has(augmentId)
              ? "burning"
              : augmentId && burntIds.has(augmentId)
                ? "burnt"
                : "none";
            const inspectable = Boolean(augmentId && presentation.augment && !presentation.hidden);
            const dialogOpen = Boolean(augmentId && inspectedId === augmentId);

            return (
              <li
                className={styles.railCardItem}
                key={presentation.hidden ? `hidden-${index}` : augmentId}
                onPointerEnter={() => {
                  if (inspectable && augmentId) setPreviewId(augmentId);
                }}
                onPointerLeave={() => {
                  if (previewId === augmentId) setPreviewId(null);
                }}
                onFocus={() => {
                  if (inspectable && augmentId) setPreviewId(augmentId);
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(null);
                }}
              >
                <AugmentCard
                  augment={presentation.augment}
                  state={presentation.state}
                  compact
                  ownerLabel={label}
                  statusLabel={presentation.statusLabel}
                  actionCard={presentation.activatable}
                  burnState={burnState}
                  interactionLabel={inspectable ? "按下查看军令详情" : undefined}
                  ariaHasPopup={inspectable ? "dialog" : undefined}
                  ariaExpanded={inspectable ? dialogOpen : undefined}
                  ariaControls={inspectable && augmentId ? `augment-inspect-${augmentId}` : undefined}
                  onSelect={inspectable && augmentId
                    ? () => {
                        setPreviewId(null);
                        setInspectedId(augmentId);
                      }
                    : undefined}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.railEmpty}>军令将在选择并公开后显示</p>
      )}

      {preview?.augment && !inspected ? (
        <div className={styles.railPreview} aria-hidden="true" data-augment-preview="true">
          <p className={styles.railPreviewLabel}>{possessiveLabel}军令 · 悬停预览</p>
          <AugmentCard
            augment={preview.augment}
            state={preview.state}
            statusLabel={preview.statusLabel}
          />
        </div>
      ) : null}

      {inspected?.augment ? (
        <AugmentInspectDialog
          key={inspected.augment.id}
          augment={inspected.augment}
          ownerLabel={label}
          state={inspected.state}
          statusLabel={inspected.statusLabel}
          showActivation={Boolean(onActivate && inspected.supportsManualActivation)}
          canActivate={inspected.activatable}
          activationDisabledReason={inspected.activationDisabledReason}
          pending={pending}
          onActivate={onActivate && inspected.augmentId
            ? () => onActivate(inspected.augmentId as AugmentId)
            : undefined}
          onClose={() => setInspectedId(null)}
        />
      ) : null}
    </section>
  );
}

"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import type { AugmentDefinition, AugmentId } from "@/lib/augments";

import AugmentCard, {
  type AugmentCardBurnState,
  type AugmentCardState,
} from "./AugmentCard";
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
  const possessiveLabel = label === "我的" ? "我的" : `${label}的`;
  const visibleCount = items.filter((item) => item.augment && !item.hidden).length;
  const privateLockedCount = items.filter(
    (item) => item.augment && !item.hidden && item.publiclyRevealed === false,
  ).length;
  const publicCount = visibleCount - privateLockedCount;
  const exhaustedCount = items.filter((item) => {
    if (!item.augment || item.hidden) return false;
    return Math.max(0, item.triggerCount ?? 0) >= item.augment.charges;
  }).length;

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
      if (item.augment.charges === 1 && nextCount >= 1 && previousCount === undefined) {
        burntIdsRef.current.add(augmentId);
        silentlyBurnt.add(augmentId);
        continue;
      }
      const shouldBurn = initializedRef.current && shouldAnimateAugmentBurn(
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

  useEffect(() => () => {
    for (const timer of burnTimersRef.current.values()) window.clearTimeout(timer);
    burnTimersRef.current.clear();
    for (const timer of stateTimersRef.current) window.clearTimeout(timer);
    stateTimersRef.current.clear();
  }, []);

  return (
    <section
      className={styles.rail}
      aria-label={`${possessiveLabel}强化`}
      aria-busy={pending}
      data-augment-dock-target={dockTarget ? "true" : undefined}
      style={{ "--augment-burn-ms": `${AUGMENT_BURN_MOTION_MS}ms` } as CSSProperties}
    >
      <header className={styles.railHeader}>
        <h3 className={styles.railTitle}>{label} · 强化</h3>
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
          aria-label={`${possessiveLabel}强化牌`}
        >
          {items.map((item, index) => {
            const augmentId = item.augment?.id;
            const hidden = item.hidden || !item.augment;
            const active = Boolean(augmentId && activeId === augmentId);
            const charges = item.augment?.charges ?? 0;
            const triggerCount = item.augment
              ? Math.min(charges, Math.max(0, item.triggerCount ?? 0))
              : 0;
            const exhausted = Boolean(item.augment && triggerCount >= charges);
            const partiallyTriggered = Boolean(item.augment && triggerCount > 0 && !exhausted);
            const state: AugmentCardState = hidden
              ? "hidden"
              : exhausted
                ? "used"
                : active
                  ? "selected"
                  : "available";
            const supportsManualActivation = Boolean(
              item.augment &&
              item.augment.activation === "active" &&
              (
                item.augment.effect.kind === "movement" ||
                item.augment.effect.kind === "exchange" ||
                (
                  item.augment.effect.kind === "reconnaissance" &&
                  item.augment.effect.mode === "choose_enemy"
                )
              ),
            );
            const activatable = Boolean(
              augmentId &&
              item.augment &&
              onActivate &&
              !hidden &&
              !exhausted &&
              item.hasLegalTarget !== false &&
              canInteractWithAugment(item.augment, {
                enabled: canActivate,
                isOwnTurn,
                pendingReconId,
              }),
            );
            const burnState: AugmentCardBurnState = augmentId && burningIds.has(augmentId)
              ? "burning"
              : augmentId && burntIds.has(augmentId)
                ? "burnt"
                : "none";
            const statusLabel = hidden
              ? "未公开"
              : exhausted
                ? `已耗尽 ${triggerCount}/${charges}`
                : partiallyTriggered
                  ? `已触发 ${triggerCount}/${charges}`
                  : active
                    ? "已启用"
                    : item.augment?.activation === "setup"
                      ? "布阵生效"
                      : !supportsManualActivation
                        ? "等待触发"
                        : item.augment?.effect.kind === "reconnaissance"
                          ? canActivate && pendingReconId === augmentId
                            ? "可用"
                            : "等待侦察"
                          : canActivate && isOwnTurn
                            ? item.hasLegalTarget === false
                              ? "暂无目标"
                              : "可用"
                            : canActivate
                              ? "等待回合"
                              : "等待对局";
            const disclosedStatusLabel = item.publiclyRevealed === false && !hidden
              ? `${statusLabel} · 待公开`
              : statusLabel;

            return (
              <li className={styles.railCardItem} key={hidden ? `hidden-${index}` : augmentId}>
                <AugmentCard
                  augment={item.augment}
                  state={state}
                  compact
                  ownerLabel={label}
                  disabled={pending}
                  statusLabel={disclosedStatusLabel}
                  actionCard={activatable}
                  burnState={burnState}
                  onSelect={activatable && augmentId && onActivate
                    ? () => onActivate(augmentId)
                    : undefined}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.railEmpty}>强化将在选择并公开后显示</p>
      )}
    </section>
  );
}

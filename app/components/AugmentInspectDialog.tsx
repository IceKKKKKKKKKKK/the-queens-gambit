"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";

import type { AugmentDefinition } from "@/lib/augments";

import AugmentCard, { type AugmentCardState } from "./AugmentCard";
import styles from "./Augments.module.css";

export interface AugmentInspectDialogProps {
  augment: AugmentDefinition;
  ownerLabel: string;
  state: AugmentCardState;
  statusLabel: string;
  showActivation?: boolean;
  canActivate?: boolean;
  activationDisabledReason?: string;
  pending?: boolean;
  onActivate?: () => void;
  onClose: () => void;
}

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

export default function AugmentInspectDialog({
  augment,
  ownerLabel,
  state,
  statusLabel,
  showActivation = false,
  canActivate = false,
  activationDisabledReason,
  pending = false,
  onActivate,
  onClose,
}: AugmentInspectDialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const titleId = `augment-inspect-title-${augment.id}`;
  const descriptionId = `augment-inspect-description-${augment.id}`;
  const dialogId = `augment-inspect-${augment.id}`;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const backgroundSiblings = Array.from(document.body.children)
      .filter((element): element is HTMLElement => (
        element instanceof HTMLElement && element !== overlay
      ))
      .map((element) => ({
        element,
        hadInert: element.hasAttribute("inert"),
        ariaHidden: element.getAttribute("aria-hidden"),
      }));
    const previousBodyOverflow = document.body.style.overflow;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    for (const { element } of backgroundSiblings) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(overlay);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousBodyOverflow;
      for (const { element, hadInert, ariaHidden } of backgroundSiblings) {
        if (!hadInert) element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      const trigger = returnFocusRef.current;
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      className={styles.inspectOverlay}
    >
      <section
        className={styles.inspectDialog}
        id={dialogId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header className={styles.inspectHeader}>
          <div>
            <p className={styles.inspectEyebrow}>{ownerLabel} · 军令详情</p>
            <h2 className={styles.inspectTitle} id={titleId}>{augment.name}</h2>
          </div>
          <button
            ref={closeButtonRef}
            className={styles.inspectClose}
            type="button"
            onClick={onClose}
            aria-label={`关闭${augment.name}详情`}
          >
            ×
          </button>
        </header>

        <div className={styles.inspectCard}>
          <AugmentCard
            augment={augment}
            state={state}
            ownerLabel={ownerLabel}
            statusLabel={statusLabel}
          />
        </div>

        <p className={styles.inspectDescription} id={descriptionId}>
          {augment.description} · {augment.timing}
        </p>

        <footer className={styles.inspectActions}>
          <button className={styles.inspectSecondary} type="button" onClick={onClose}>
            返回棋盘
          </button>
          {showActivation ? (
            <button
              className={styles.inspectActivate}
              type="button"
              disabled={!canActivate || pending || !onActivate}
              aria-describedby={!canActivate && activationDisabledReason ? `${dialogId}-activation-note` : undefined}
              onClick={() => {
                if (!canActivate || pending || !onActivate) return;
                onActivate();
                onClose();
              }}
            >
              {pending ? "行动处理中…" : "发动军令"}
            </button>
          ) : null}
        </footer>
        {showActivation && !canActivate && activationDisabledReason ? (
          <p className={styles.inspectActivationNote} id={`${dialogId}-activation-note`} role="status">
            {activationDisabledReason}
          </p>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}

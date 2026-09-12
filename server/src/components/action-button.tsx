"use client";

import { useState, useTransition } from "react";
import { Modal } from "./modal";
import { useToast } from "./toast";

/**
 * What a server action can tell the button to report. Returning nothing is fine -- the button
 * falls back to its own `success` message -- but an action that knows something useful ("nothing
 * was due") should say so rather than claiming a generic success.
 */
export type ActionResult = void | {
  ok?: boolean;
  message?: string;
  detail?: string | null;
};

/**
 * Next signals redirect() and notFound() by throwing. Those are successful outcomes mid-flight,
 * not failures, so they must not be reported as errors.
 */
function isControlFlowError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && /^NEXT_(REDIRECT|NOT_FOUND)/.test(digest);
}

/**
 * A button that runs a server action and always tells the user what happened.
 *
 * Every action in the app goes through here so that three things are guaranteed: a disabled
 * button explains itself on hover instead of silently ignoring clicks, a running action shows it
 * is running, and the outcome always surfaces as a toast rather than a page that merely
 * re-renders and leaves you guessing whether the click registered.
 */
export function ActionButton({
  action,
  label,
  pendingLabel,
  success,
  confirm,
  confirmTitle,
  confirmLabel,
  danger,
  disabledReason,
  className,
}: {
  action: () => Promise<ActionResult>;
  label: string;
  pendingLabel?: string;
  /** Toast shown when the action resolves without a message of its own. */
  success?: string;
  /** One modal per entry, shown in order. Omit for actions that need no confirmation. */
  confirm?: string[];
  confirmTitle?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** When set the button is disabled and this explains why, on hover and to a screen reader. */
  disabledReason?: string | null;
  className?: string;
}) {
  const { push } = useToast();
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState<number | null>(null);

  const run = () => {
    setStep(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result && result.ok === false) {
          push("error", result.message ?? "That did not work", result.detail);
          return;
        }
        push("success", result?.message ?? success ?? `${label} — done`, result?.detail);
      } catch (error) {
        if (isControlFlowError(error)) return;
        push(
          "error",
          `${label} failed`,
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
  };

  const start = () => {
    if (confirm && confirm.length > 0) setStep(0);
    else run();
  };

  const disabled = Boolean(disabledReason) || pending;
  const title = disabledReason ?? undefined;

  // Every ActionButton runs a real server action, so it defaults to the accent-tinted "primary"
  // treatment -- that is the whole point of this component versus a plain <button>, and the gray
  // default made "Run grader now" and "Save book settings" indistinguishable from inert controls.
  // A caller can still override with its own `className`, and `danger` always wins.
  const variantClass = danger ? "danger" : (className ?? "primary");

  return (
    // The title lives on the wrapper: a disabled button emits no pointer events, so a tooltip on
    // the button itself would never appear -- which is exactly the "nothing happens" complaint.
    <span className="action-btn-wrap" title={title}>
      <button
        type="button"
        className={variantClass || undefined}
        disabled={disabled}
        aria-disabled={disabled}
        aria-describedby={disabledReason ? undefined : undefined}
        onClick={start}
      >
        {pending ? <span className="spinner" aria-hidden="true" /> : label}
        {pending && <span className="sr-only">{pendingLabel ?? `${label}...`}</span>}
      </button>

      {step !== null && confirm && (
        <Modal
          open
          title={confirmTitle ?? label}
          body={confirm[step]}
          danger={danger}
          confirmLabel={
            step === confirm.length - 1 ? (confirmLabel ?? label) : "Continue"
          }
          onCancel={() => setStep(null)}
          onConfirm={() => (step === confirm.length - 1 ? run() : setStep(step + 1))}
        />
      )}
    </span>
  );
}

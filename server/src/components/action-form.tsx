"use client";

import { useRef, useTransition } from "react";
import type { ActionResult } from "./action-button";
import { useToast } from "./toast";

function isControlFlowError(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && /^NEXT_(REDIRECT|NOT_FOUND)/.test(digest);
}

/**
 * The FormData counterpart to ActionButton: same guarantees (pending state, a toast either way,
 * a disabled submit that explains itself) for the small inline forms.
 *
 * The submit is handled here rather than via the form's `action` prop so the action's return
 * value is available to report -- a plain server-action form gives no hook for that.
 */
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  success,
  disabledReason,
  className,
  resetOnSuccess,
  children,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  pendingLabel?: string;
  success?: string;
  disabledReason?: string | null;
  className?: string;
  resetOnSuccess?: boolean;
  children: React.ReactNode;
}) {
  const { push } = useToast();
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  const disabled = Boolean(disabledReason) || pending;

  return (
    <form
      ref={formRef}
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(async () => {
          try {
            const result = await action(data);
            if (result && result.ok === false) {
              push("error", result.message ?? "That did not work", result.detail);
              return;
            }
            push("success", result?.message ?? success ?? "Saved", result?.detail);
            if (resetOnSuccess) formRef.current?.reset();
          } catch (error) {
            if (isControlFlowError(error)) return;
            push(
              "error",
              `${submitLabel} failed`,
              error instanceof Error ? error.message : "Unknown error"
            );
          }
        });
      }}
    >
      {children}
      <span className="action-btn-wrap" title={disabledReason ?? undefined}>
        <button type="submit" disabled={disabled} aria-disabled={disabled}>
          {pending ? (pendingLabel ?? `${submitLabel}...`) : submitLabel}
        </button>
      </span>
    </form>
  );
}

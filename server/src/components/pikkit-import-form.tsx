"use client";

import { useRef, useState, useTransition } from "react";
import { Modal } from "./modal";
import { useToast } from "./toast";
import type { ImportFailure, PikkitImportResult } from "@/lib/pikkit/store";

/**
 * Uploading a Pikkit `transactions.csv`.
 *
 * The first file input in the app, so it is worth saying what it is not: there is no drag-and-drop
 * and no progress bar, because the file is a few hundred kilobytes of text and the whole import
 * finishes inside one request. What it does have is a report of what happened, because "imported
 * 199 bets" and "imported 199 bets, 0 of them new" mean completely different things to someone
 * who just dropped in the same export twice.
 *
 * Rows that could not be read are listed by line number rather than counted. A silent count is
 * useless -- you cannot go and look at "3 failures" -- and these come from a file the user still
 * has open.
 */
export function PikkitImportForm({
  importAction,
  purgeAction,
  existingCount,
}: {
  importAction: (formData: FormData) => Promise<PikkitImportResult>;
  purgeAction: () => Promise<number>;
  existingCount: number;
}) {
  const { push } = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [failures, setFailures] = useState<ImportFailure[]>([]);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () => {
    const form = formRef.current;
    if (!form) return;
    startTransition(async () => {
      try {
        const result = await importAction(new FormData(form));
        setFailures(result.failures);
        push(result.ok ? "success" : "error", result.message, result.detail);
        if (result.ok) {
          form.reset();
          setFileName(null);
        }
      } catch (error) {
        push("error", "Import failed", error instanceof Error ? error.message : null);
      }
    });
  };

  return (
    <form ref={formRef} className="pikkit-import">
      <label className="file-field">
        <span className="file-button">Choose file</span>
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
        />
        <span className="muted">{fileName ?? "No file chosen"}</span>
      </label>

      <span className="action-btn-wrap">
        <button type="button" className="primary" disabled={pending || !fileName} onClick={run}>
          {pending ? <span className="spinner" aria-hidden="true" /> : "Import"}
        </button>
      </span>

      {existingCount > 0 && (
        <>
          <span className="muted">{existingCount} bet{existingCount === 1 ? "" : "s"} imported</span>
          <span className="action-btn-wrap">
            <button type="button" className="danger" disabled={pending} onClick={() => setConfirmingPurge(true)}>
              Delete all
            </button>
          </span>
        </>
      )}

      {failures.length > 0 && (
        <details className="import-failures">
          <summary className="warn-note">
            {failures.length} row{failures.length === 1 ? "" : "s"} could not be read
          </summary>
          <ul>
            {failures.slice(0, 25).map((f) => (
              <li key={f.line} className="err">
                line {f.line}: {f.reason}
              </li>
            ))}
            {failures.length > 25 && <li className="muted">...and {failures.length - 25} more</li>}
          </ul>
        </details>
      )}

      <Modal
        open={confirmingPurge}
        title="Delete the whole Pikkit history?"
        body={
          <>
            All {existingCount} imported bets and their legs will be removed. Captured picks are
            untouched, and you can re-import the export at any time.
          </>
        }
        confirmLabel="Delete them"
        danger
        onCancel={() => setConfirmingPurge(false)}
        onConfirm={() => {
          setConfirmingPurge(false);
          startTransition(async () => {
            try {
              const n = await purgeAction();
              setFailures([]);
              push("success", `Deleted ${n} imported bet${n === 1 ? "" : "s"}`);
            } catch (error) {
              push("error", "Could not delete them", error instanceof Error ? error.message : null);
            }
          });
        }}
      />
    </form>
  );
}

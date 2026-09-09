"use client";

/**
 * Submits a server action behind a confirmation prompt. `steps` lets a destructive action require
 * more than one confirmation -- deleting data is not something to do on a single stray click.
 */
export function ConfirmButton({
  action,
  label,
  confirm,
  danger,
}: {
  action: () => Promise<void>;
  label: string;
  confirm: string[];
  danger?: boolean;
}) {
  return (
    <form
      action={action}
      onSubmit={(event) => {
        for (const message of confirm) {
          if (!window.confirm(message)) {
            event.preventDefault();
            return;
          }
        }
      }}
    >
      <button type="submit" className={danger ? "danger" : undefined}>
        {label}
      </button>
    </form>
  );
}

"use client";

/**
 * A number field that saves itself.
 *
 * Used inside the manual-grade `ActionForm` on a bet's page: typing the actual result and then
 * moving on -- tabbing away, clicking elsewhere -- submits the form on its own, the same way the
 * grade would be recorded by pressing the button beside it. The button stays for anyone who
 * prefers pressing it; this only removes the requirement to.
 *
 * A tiny Client Component of its own rather than an `onBlur` prop added on a plain `<input>` in
 * the (Server Component) page: a Server Component cannot hand a DOM element a plain closure --
 * only a Server Action survives that boundary -- so the handler has to live somewhere already on
 * the client. `ActionForm` already is one, but it does not know this field's own "did the value
 * actually change" rule, so that logic lives here instead of being bolted onto it.
 */
export function AutoSaveNumberInput({
  name,
  placeholder,
  defaultValue,
}: {
  name: string;
  placeholder?: string;
  /** The value already on record, so tabbing through without typing anything never fires a save. */
  defaultValue: number | null;
}) {
  return (
    <input
      type="number"
      step="any"
      name={name}
      placeholder={placeholder}
      defaultValue={defaultValue ?? ""}
      onBlur={(e) => {
        const value = e.currentTarget.value.trim();
        if (value === "" || Number(value) === defaultValue) return;
        e.currentTarget.form?.requestSubmit();
      }}
    />
  );
}

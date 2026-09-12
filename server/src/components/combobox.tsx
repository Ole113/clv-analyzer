"use client";

import { useEffect, useRef, useState } from "react";

export interface ComboboxOption {
  value: string;
  label: string;
}

/**
 * A searchable dropdown: click it and every option is listed, same as a native `<select>`, but you
 * can also type to filter the list down -- matching PropProfessor's own filter dropdowns. Submits
 * through a hidden `<input>` carrying the real form field name/value, so it drops into the existing
 * GET-form-per-filter setup in `filter-bar.tsx` unchanged -- `submit()`'s `form.elements` walk sees
 * a plain `HTMLInputElement` here exactly as it would a `<select>`.
 */
export function Combobox({
  name,
  label,
  options,
  defaultValue,
  onChange,
}: {
  name: string;
  label: string;
  options: ComboboxOption[];
  defaultValue?: string;
  onChange: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLLabelElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? null;
  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  const choose = (v: string) => {
    setValue(v);
    setOpen(false);
    // The hidden input's value updates via the `value` prop above this render, but onChange needs
    // to fire against the *new* value, not whatever was last committed to the DOM -- a microtask
    // lets the input's controlled value flush first.
    queueMicrotask(onChange);
  };

  return (
    <label className="field combobox" ref={rootRef}>
      <span>{label}</span>
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        className="combobox-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedLabel ?? "Any"}
      </button>
      {open && (
        <div className="combobox-panel">
          <input
            ref={inputRef}
            type="text"
            className="combobox-search"
            placeholder="Type to filter..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === "Enter" && filtered.length > 0) {
                e.preventDefault();
                choose(filtered[0].value);
              }
            }}
          />
          <ul className="combobox-list" role="listbox">
            <li>
              <button type="button" className={value === "" ? "active" : undefined} onClick={() => choose("")}>
                Any
              </button>
            </li>
            {filtered.length === 0 ? (
              <li className="combobox-empty muted">No matches</li>
            ) : (
              filtered.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    className={o.value === value ? "active" : undefined}
                    onClick={() => choose(o.value)}
                  >
                    {o.label}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </label>
  );
}

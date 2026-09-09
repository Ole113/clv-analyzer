"use client";

import { useEffect, useRef } from "react";
import type { Facets } from "@/lib/queries";

/**
 * Filters apply as you change them -- no Apply button.
 *
 * This is a plain GET form that submits itself: selects submit on change, the search box after a
 * short debounce. Native form navigation keeps the filter state in the URL (so views stay
 * linkable and Back undoes a filter) without depending on client-side routing.
 */
export function FilterBar({
  facets,
  action,
  values,
  showVerdict,
  showStatus,
  showResult,
}: {
  facets: Facets;
  action: string;
  values: Record<string, string | undefined>;
  showVerdict?: boolean;
  showStatus?: boolean;
  showResult?: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /**
   * Empty controls are disabled for the duration of the submit so they stay out of the query
   * string -- otherwise every filter change produces ?q=&sport=&stat=... noise in the URL.
   */
  const submit = () => {
    const form = formRef.current;
    if (!form) return;
    const emptied: (HTMLInputElement | HTMLSelectElement)[] = [];
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) continue;
      if (el.name && el.value === "") {
        el.disabled = true;
        emptied.push(el);
      }
    }
    form.requestSubmit();
    // Re-enable so the controls stay usable if the navigation is slow or cancelled.
    setTimeout(() => emptied.forEach((el) => (el.disabled = false)), 0);
  };

  const debouncedSubmit = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(submit, 400);
  };

  const Select = ({
    name,
    label,
    options,
  }: {
    name: string;
    label: string;
    options: { value: string; label: string }[];
  }) => (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={values[name] ?? ""} onChange={submit}>
        <option value="">Any</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  const hasFilters = Object.entries(values).some(([, v]) => !!v);

  return (
    <form ref={formRef} className="filters" method="get" action={action}>
      <label className="field grow">
        <span>Search</span>
        <input
          type="search"
          name="q"
          defaultValue={values.q ?? ""}
          placeholder="player, stat, team, matchup..."
          onChange={debouncedSubmit}
          // Enter would submit anyway; this just avoids waiting out the debounce.
          onKeyDown={(e) => {
            if (e.key === "Enter" && timer.current) clearTimeout(timer.current);
          }}
        />
      </label>

      {showStatus && (
        <Select
          name="group"
          label="Status"
          options={[
            { value: "open", label: "Awaiting close" },
            { value: "settled", label: "Settled" },
          ]}
        />
      )}
      <Select name="sport" label="Sport" options={facets.sports.map((s) => ({ value: s, label: s }))} />
      <Select name="stat" label="Stat" options={facets.stats.map((s) => ({ value: s, label: s }))} />
      <Select
        name="side"
        label="Pick"
        options={[
          { value: "OVER", label: "Over" },
          { value: "UNDER", label: "Under" },
        ]}
      />
      <Select name="book" label="Book" options={facets.books.map((b) => ({ value: b, label: b }))} />
      <Select
        name="site"
        label="Site"
        options={facets.sites.map((s) => ({
          value: s,
          label: s === "ODDSJAM" ? "OddsJam" : "PropProfessor",
        }))}
      />
      {showVerdict && (
        <Select
          name="verdict"
          // Named "CLV", not "Result": with real outcomes on screen, calling the closing-line
          // verdict "Result" would be actively misleading.
          label="CLV"
          options={[
            { value: "beat", label: "Beat CLV" },
            { value: "missed", label: "Missed CLV" },
          ]}
        />
      )}

      {showResult && (
        <>
          <Select
            name="result"
            label="Result"
            options={[
              { value: "WIN", label: "Win" },
              { value: "LOSS", label: "Loss" },
              { value: "PUSH", label: "Push" },
              { value: "VOID", label: "Void" },
            ]}
          />
          <Select
            name="graded"
            label="Grading"
            options={[
              { value: "graded", label: "Graded" },
              { value: "ungraded", label: "Awaiting" },
              { value: "ungradeable", label: "No source" },
              { value: "failed", label: "Failed" },
            ]}
          />
        </>
      )}

      <label className="field">
        <span>From</span>
        <input type="date" name="from" defaultValue={values.from ?? ""} onChange={submit} />
      </label>
      <label className="field">
        <span>To</span>
        <input type="date" name="to" defaultValue={values.to ?? ""} onChange={submit} />
      </label>

      {hasFilters && (
        <div className="field actions">
          <a href={action} className="reset">
            Clear filters
          </a>
        </div>
      )}
    </form>
  );
}

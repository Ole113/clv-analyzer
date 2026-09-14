"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Combobox } from "@/components/combobox";
import type { PikkitFacets } from "@/lib/pikkit/analysis";

/**
 * Filters for the Pikkit side of /analysis.
 *
 * A sibling of `filter-bar.tsx` rather than a mode of it: the two datasets share no filterable
 * field at all -- there is no sport/stat/side/verdict here and no book/league/market/result over
 * there -- so the shared version would have been a component whose every control was behind a
 * conditional. The navigation behaviour is copied deliberately though, including the client-side
 * `router.push` (a native GET submit is a full reload, which the App Router never gets to
 * instrument, so `loading.tsx` would never show a spinner).
 */
export function PikkitFilterBar({
  facets,
  values,
  action = "/analysis",
}: {
  facets: PikkitFacets;
  values: Record<string, string | undefined>;
  /** The page the filters navigate back to -- /analysis or /bets, which share these controls. */
  action?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const submit = () => {
    const form = formRef.current;
    if (!form) return;
    // Start from the live params so `source` -- which this form knows nothing about but which is
    // the only reason the page is rendering this component at all -- survives every filter change.
    const params = new URLSearchParams(searchParams.toString());
    for (const el of Array.from(form.elements)) {
      if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.name) {
        params.delete(el.name);
      }
    }
    for (const [key, value] of new FormData(form).entries()) {
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    startTransition(() => router.push(`${action}?${params.toString()}`));
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
    <Combobox name={name} label={label} options={options} defaultValue={values[name] ?? ""} onChange={submit} />
  );

  const hasFilters = ["book", "league", "sport", "market", "betType", "result", "live", "q", "from", "to"].some(
    (k) => !!values[k]
  );

  return (
    <form ref={formRef} className="filters" method="get" action={action}>
      <label className="field grow">
        <span>Search</span>
        <input
          type="search"
          name="q"
          defaultValue={values.q ?? ""}
          placeholder="player, market, team..."
          onChange={debouncedSubmit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && timer.current) clearTimeout(timer.current);
          }}
        />
      </label>

      <Select name="book" label="Sportsbook" options={facets.books.map((b) => ({ value: b, label: b }))} />
      <Select name="league" label="League" options={facets.leagues.map((l) => ({ value: l, label: l }))} />
      <Select name="sport" label="Sport" options={facets.sports.map((s) => ({ value: s, label: s }))} />
      <Select name="market" label="Market" options={facets.markets.map((m) => ({ value: m.key, label: m.label }))} />
      <Select
        name="betType"
        label="Type"
        options={[
          { value: "STRAIGHT", label: "Straight" },
          { value: "PARLAY", label: "Parlay / slip" },
        ]}
      />
      <Select
        name="result"
        label="Result"
        options={[
          { value: "WIN", label: "Win" },
          { value: "LOSS", label: "Loss" },
          { value: "VOID", label: "Void" },
          { value: "PENDING", label: "Pending" },
        ]}
      />
      <Select
        name="live"
        label="When placed"
        options={[
          { value: "prematch", label: "Pre-match" },
          { value: "live", label: "Live" },
        ]}
      />

      <label className="field">
        <span>From</span>
        <input type="date" name="from" defaultValue={values.from ?? ""} onChange={submit} />
      </label>
      <label className="field">
        <span>To</span>
        <input type="date" name="to" defaultValue={values.to ?? ""} onChange={submit} />
      </label>

      {(hasFilters || pending) && (
        <div className="field actions">
          <span aria-hidden="true">&nbsp;</span>
          <span className="filters-status">
            {pending && <span className="spinner" aria-hidden="true" />}
            {hasFilters && (
              <a href={`${action}?source=pikkit`} className="reset">
                Clear filters
              </a>
            )}
          </span>
        </div>
      )}
    </form>
  );
}

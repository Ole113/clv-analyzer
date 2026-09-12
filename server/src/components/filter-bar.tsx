"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Facets } from "@/lib/queries";
import { Combobox } from "@/components/combobox";

// A second, small copy of app-settings.ts's titleCase() rather than an import: that module pulls
// in prisma at module scope, which can't cross into this "use client" component's bundle. Splits
// on hyphens/underscores too ("dogg-house" -> "Dogg House") rather than just capitalizing the
// first letter of the whole key, since a raw book key is snake- or kebab-cased, not one word.
function titleCase(key: string): string {
  return key
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /**
   * A client-side navigation (router.push) rather than a native form submit, for one reason: it is
   * what lets Next's `loading.tsx` Suspense boundary show a spinner while a large, filtered result
   * set is being queried -- a native GET submit is a full page reload the App Router never gets a
   * chance to instrument. Empty fields are simply left out of the URLSearchParams building it,
   * which also means there is no more "disable empty fields so they don't show up as ?q=&sport="
   * dance to undo afterward.
   *
   * Starts from the *current* search params rather than an empty one, so a filter change never
   * wipes out `sort`/`dir`/`group` -- params this form knows nothing about, owned by
   * `bets-table.tsx`, but that still need to survive every filter change since they live in this
   * same URL.
   */
  const submit = () => {
    const form = formRef.current;
    if (!form) return;
    const params = new URLSearchParams(searchParams.toString());
    for (const el of Array.from(form.elements)) {
      if ((el instanceof HTMLInputElement || el instanceof HTMLSelectElement) && el.name) {
        params.delete(el.name);
      }
    }
    for (const [key, value] of new FormData(form).entries()) {
      if (typeof value === "string" && value !== "") params.set(key, value);
    }
    const query = params.toString();
    startTransition(() => router.push(query ? `${action}?${query}` : action));
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
  }) => <Combobox name={name} label={label} options={options} defaultValue={values[name] ?? ""} onChange={submit} />;

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
      <Select
        name="live"
        label="When taken"
        options={[
          { value: "prematch", label: "Pre-match" },
          { value: "live", label: "Live" },
        ]}
      />
      <Select
        name="market"
        label="Market"
        options={[
          { value: "PLAYER_PROP", label: "Player prop" },
          { value: "GAME_TOTAL", label: "Game total" },
          { value: "SPREAD", label: "Spread" },
          { value: "MONEYLINE", label: "Moneyline" },
        ]}
      />
      <Select
        name="book"
        label="Book"
        options={facets.books.map((b) => ({ value: b, label: titleCase(b) }))}
      />
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

      {(hasFilters || pending) && (
        <div className="field actions">
          {/* An invisible label matching every other field's so this button's own height is
              pushed down to line up with the row's inputs, not the row's labels -- the .filters
              container bottom-aligns fields by default, so matching that structure is enough. */}
          <span aria-hidden="true">&nbsp;</span>
          <span className="filters-status">
            {pending && <span className="spinner" aria-hidden="true" />}
            {hasFilters && (
              <a href={action} className="reset">
                Clear filters
              </a>
            )}
          </span>
        </div>
      )}
    </form>
  );
}

/**
 * Which dataset the page is reading: captured picks, or an imported Pikkit history.
 *
 * The state lives in the URL rather than in `useState`, for the reason spelled out in
 * bets-table.tsx: a view someone is looking at should survive a link, a refresh and the Back
 * button. It also means this can stay a Server Component -- switching source re-runs the query on
 * the server, which is where the branch actually is.
 *
 * Every other filter in the URL is carried across the switch deliberately: a date range is
 * meaningful on both sides, and dropping it would silently widen the sample the moment you
 * compared the two.
 */
export type AnalysisSource = "clv" | "pikkit";

export function SourceSwitch({
  source,
  basePath,
  params,
}: {
  source: AnalysisSource;
  basePath: string;
  /** The current query string, so switching source keeps the filters already applied. */
  params: URLSearchParams;
}) {
  const href = (next: AnalysisSource) => {
    const q = new URLSearchParams(params);
    // "clv" is the default, so it is left out of the URL entirely rather than written as
    // ?source=clv -- a bare /analysis and a switched-back /analysis should be the same link.
    if (next === "clv") q.delete("source");
    else q.set("source", next);
    const query = q.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  return (
    <div className="tabs" role="navigation" aria-label="Data source">
      <a href={href("clv")} className={source === "clv" ? "active" : undefined} aria-current={source === "clv" ? "page" : undefined}>
        Captured picks
      </a>
      <a href={href("pikkit")} className={source === "pikkit" ? "active" : undefined} aria-current={source === "pikkit" ? "page" : undefined}>
        Pikkit history
      </a>
    </div>
  );
}

/** Reads the source out of a query string. Anything unrecognised means the default. */
export function sourceFrom(params: URLSearchParams): AnalysisSource {
  return params.get("source") === "pikkit" ? "pikkit" : "clv";
}

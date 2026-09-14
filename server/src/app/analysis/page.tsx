import { SourceSwitch, sourceFrom } from "@/components/source-switch";
import { ClvAnalysisView } from "./clv-view";
import { PikkitAnalysisView } from "./pikkit-view";

export const dynamic = "force-dynamic";

/**
 * Two analyses, one page.
 *
 * The page itself does nothing but read the source and pick a view. The two views share no metric
 * -- there is no ROI on a captured pick and no closing-line edge on most of a Pikkit history -- so
 * they are separate components rather than one component full of conditionals. What they do share
 * is the URL: every filter, and the source itself, lives there, so any view is a link.
 */
export default async function AnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && v) params.set(k, v);
  const source = sourceFrom(params);

  return (
    <main>
      <h2 style={{ marginTop: 0 }}>Analysis</h2>
      <SourceSwitch source={source} basePath="/analysis" params={params} />
      {source === "pikkit" ? (
        <PikkitAnalysisView params={params} />
      ) : (
        <ClvAnalysisView params={params} />
      )}
    </main>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import {
  defaultFlexTiers,
  evaluateBoost,
  type BoostMode,
  type PayoutTier,
} from "@/lib/boost";
import { impliedProbability } from "@/lib/ev";

const TIERS_STORAGE_KEY = "clv.boost.flexTiers";
const MIN_LEGS = 2;
const MAX_LEGS = 8;

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

/** A number field that stays editable while half-typed: "-" and "" are held as text, not coerced. */
function NumField({
  label, value, onChange, step, width = 120, suffix,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  step?: string;
  width?: number;
  suffix?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width, minWidth: width }}
        />
        {suffix ? <span className="muted" style={{ fontSize: 12 }}>{suffix}</span> : null}
      </span>
    </label>
  );
}

export function BoostCalculator() {
  const [mode, setMode] = useState<BoostMode>("power");
  const [legPrice, setLegPrice] = useState("-122");
  const [boost, setBoost] = useState("25");
  const [stake, setStake] = useState("100");
  const [legProbs, setLegProbs] = useState<string[]>(["54", "54", "54"]);
  const [tiersByLegs, setTiersByLegs] = useState<Record<number, PayoutTier[]>>({});

  const legs = legProbs.length;

  // Tier edits are the one thing worth keeping between visits: Underdog re-tunes its payout table
  // and re-typing it on every visit is exactly the friction that makes people skip the check.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TIERS_STORAGE_KEY);
      if (saved) setTiersByLegs(JSON.parse(saved) as Record<number, PayoutTier[]>);
    } catch {
      // Private browsing or a corrupt entry -- fall back to the defaults rather than blocking.
    }
  }, []);

  function persistTiers(next: Record<number, PayoutTier[]>) {
    setTiersByLegs(next);
    try {
      window.localStorage.setItem(TIERS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not being able to remember the table is not a reason to stop calculating with it.
    }
  }

  const flexTiers = tiersByLegs[legs] ?? defaultFlexTiers(legs);
  const tiersAreCustom = Boolean(tiersByLegs[legs]);

  function setLegCount(next: number) {
    const count = Math.max(MIN_LEGS, Math.min(MAX_LEGS, next));
    setLegProbs((prev) => {
      if (count <= prev.length) return prev.slice(0, count);
      const fill = prev[prev.length - 1] ?? "54";
      return [...prev, ...new Array<string>(count - prev.length).fill(fill)];
    });
  }

  function setTierMultiplier(correct: number, raw: string) {
    const value = Number(raw);
    persistTiers({
      ...tiersByLegs,
      [legs]: flexTiers.map((t) =>
        t.correct === correct ? { ...t, multiplier: Number.isFinite(value) ? value : 0 } : t
      ),
    });
  }

  function resetTiers() {
    const next = { ...tiersByLegs };
    delete next[legs];
    persistTiers(next);
  }

  /**
   * Fills every leg with the win rate the entered price implies. On a Power play that is exactly
   * break-even; on Flex it lands a hair under, because the partial-win tiers move the real
   * break-even off the quoted price.
   */
  function fillFromPrice() {
    const implied = impliedProbability(Number(legPrice));
    if (implied === null) return;
    setLegProbs((prev) => prev.map(() => (implied * 100).toFixed(1)));
  }

  const parsedProbs = legProbs.map((p) => Number(p) / 100);
  const stakeValue = Number(stake);

  const result = useMemo(
    () =>
      evaluateBoost({
        legPrice: Number(legPrice),
        legProbs: parsedProbs,
        boostPct: Number(boost),
        mode,
        flexTiers,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legPrice, boost, mode, legProbs.join(","), JSON.stringify(flexTiers)]
  );

  const isPlus = result !== null && result.evPercent > 0;

  return (
    <>
      <div className="tabs">
        <a
          href="#"
          className={mode === "power" ? "active" : undefined}
          onClick={(e) => { e.preventDefault(); setMode("power"); }}
        >
          Power / Parlay
        </a>
        <a
          href="#"
          className={mode === "flex" ? "active" : undefined}
          onClick={(e) => { e.preventDefault(); setMode("flex"); }}
        >
          Flex
        </a>
      </div>

      <div className="filters">
        <NumField label="Legs" value={String(legs)} onChange={(v) => setLegCount(Number(v))} width={70} />
        <NumField label="Implied odds / leg" value={legPrice} onChange={setLegPrice} width={110} />
        <NumField label="Profit boost" value={boost} onChange={setBoost} step="1" width={90} suffix="%" />
        <NumField label="Stake" value={stake} onChange={setStake} step="1" width={90} suffix="$" />
        <span className="field actions">
          <span>Fill</span>
          <a href="#" className="reset" onClick={(e) => { e.preventDefault(); fillFromPrice(); }}>
            Fill legs from price
          </a>
        </span>
      </div>

      <div className={mode === "flex" ? "split" : undefined}>
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>Leg win probabilities</h3>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
            Your true chance each prop hits — the &ldquo;% chance to hit&rdquo; off the board, not
            the price you are paid.
          </p>
          <div className="filters" style={{ margin: 0, background: "none", border: "none", padding: 0 }}>
            {legProbs.map((prob, i) => (
              <NumField
                key={i}
                label={`Leg ${i + 1}`}
                value={prob}
                step="0.5"
                width={78}
                suffix="%"
                onChange={(v) =>
                  setLegProbs((prev) => prev.map((p, j) => (j === i ? v : p)))
                }
              />
            ))}
          </div>
        </div>

        {mode === "flex" ? (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>Flex payouts</h3>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 12px" }}>
              Check these against the slip — the book re-tunes them. Edits are remembered.
            </p>
            <div className="filters" style={{ margin: 0, background: "none", border: "none", padding: 0 }}>
              {flexTiers.map((tier) => (
                <NumField
                  key={tier.correct}
                  label={`${tier.correct} / ${legs}`}
                  value={String(tier.multiplier)}
                  step="0.05"
                  width={78}
                  suffix="x"
                  onChange={(v) => setTierMultiplier(tier.correct, v)}
                />
              ))}
            </div>
            {tiersAreCustom ? (
              <a href="#" className="link-button" style={{ fontSize: 12 }}
                 onClick={(e) => { e.preventDefault(); resetTiers(); }}>
                Reset to defaults
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      {result === null ? (
        <p className="muted">Enter a valid price and leg probabilities to see the EV.</p>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="label">Expected value</div>
              <div className="value" style={{ color: isPlus ? "var(--good)" : "var(--bad)" }}>
                {result.evPercent > 0 ? "+" : ""}{result.evPercent.toFixed(1)}%
              </div>
              <div className="sub">
                <span className={`badge ${isPlus ? "good" : "bad"}`}>{isPlus ? "+EV" : "-EV"}</span>{" "}
                {Number.isFinite(stakeValue)
                  ? `${money((result.evPercent / 100) * stakeValue)} on ${money(stakeValue)}`
                  : null}
              </div>
            </div>
            <div className="tile">
              <div className="label">Break-even / leg</div>
              <div className="value">
                {Number.isNaN(result.breakevenLegProb) ? "--" : pct(result.breakevenLegProb)}
              </div>
              <div className="sub">
                {Number.isNaN(result.breakevenLegProbNoBoost)
                  ? "--"
                  : `${pct(result.breakevenLegProbNoBoost)} without the boost`}
              </div>
            </div>
            <div className="tile">
              <div className="label">All legs hit</div>
              <div className="value">{pct(result.hitProbability)}</div>
              <div className="sub">{legs} legs</div>
            </div>
            <div className="tile">
              <div className="label">Boost needed for +EV</div>
              <div className="value">
                {result.minBoostPct === null
                  ? "--"
                  : result.minBoostPct === 0
                    ? "None"
                    : `${result.minBoostPct.toFixed(1)}%`}
              </div>
              <div className="sub">
                {result.minBoostPct === null
                  ? "No boost makes this +EV"
                  : result.minBoostPct === 0
                    ? "Already +EV unboosted"
                    : `You have ${Number(boost) || 0}%`}
              </div>
            </div>
          </div>

          <div className="card">
            <h3>Outcomes</h3>
            <table className="math-table">
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Outcome</th>
                  <th className="num">Probability</th>
                  <th className="num">Pays</th>
                  <th className="num">Boosted</th>
                  <th className="num">Return</th>
                </tr>
              </thead>
              <tbody>
                {result.tiers.map((tier) => (
                  <tr key={tier.correct}>
                    <td>{tier.correct} of {legs} correct</td>
                    <td className="num">{pct(tier.probability, 2)}</td>
                    <td className="num">{tier.base.toFixed(2)}x</td>
                    <td className="num">{tier.boosted.toFixed(2)}x</td>
                    <td className="num">{tier.contribution.toFixed(4)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="muted">Anything else</td>
                  <td className="num muted">
                    {pct(1 - result.tiers.reduce((a, t) => a + t.probability, 0), 2)}
                  </td>
                  <td className="num muted">0.00x</td>
                  <td className="num muted">0.00x</td>
                  <td className="num muted">0.0000</td>
                </tr>
                <tr>
                  <td><strong>Gross return per $1</strong></td>
                  <td className="num" />
                  <td className="num" />
                  <td className="num" />
                  <td className="num">
                    <strong>{(result.evPercent / 100 + 1).toFixed(4)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              A profit boost lifts profit, not the stake: a {Number(boost) || 0}% boost turns an{" "}
              <em>M</em>x payout into 1 + (<em>M</em> − 1) × {(1 + (Number(boost) || 0) / 100).toFixed(2)}.
              Tiers paying under 1.00x are a net loss on the slip, so they are left unboosted.
            </p>
          </div>
        </>
      )}
    </>
  );
}

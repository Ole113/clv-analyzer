"use client";

import { useMemo, useState } from "react";
import { KELLY_PRESETS, evaluateKelly, pointsBetween, shiftAmerican } from "@clv/shared";

function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

/** American odds the way a book writes them. */
function fmtOdds(price: number): string {
  return price > 0 ? `+${price}` : `${price}`;
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

/**
 * The bankroll, multiplier and unit size arrive from the settings row rather than being typed here
 * every visit, and edits on this page are for the bet in front of you -- they are deliberately not
 * written back. Changing the default is a Settings decision, and the note under the form says where.
 */
export function KellyCalculator({
  bankroll: defaultBankroll,
  multiplier: defaultMultiplier,
  unitSize: defaultUnitSize,
}: {
  bankroll: number;
  multiplier: number;
  unitSize: number;
}) {
  const [price, setPrice] = useState("-110");
  const [points, setPoints] = useState("30");
  const [fairPrice, setFairPrice] = useState("-140");
  const [bankroll, setBankroll] = useState(defaultBankroll ? String(defaultBankroll) : "");
  const [multiplier, setMultiplier] = useState(String(defaultMultiplier));
  const [unitSize, setUnitSize] = useState(defaultUnitSize ? String(defaultUnitSize) : "");

  /**
   * The discrepancy and the fair price are two views of one number, so each edit rewrites the
   * other -- never itself, which would fight the cursor mid-type.
   */
  function editPoints(next: string) {
    setPoints(next);
    const n = Number(next);
    const p = Number(price);
    if (Number.isFinite(n) && Number.isFinite(p) && p !== 0) {
      setFairPrice(String(shiftAmerican(p, n)));
    }
  }

  function editFairPrice(next: string) {
    setFairPrice(next);
    const f = Number(next);
    const p = Number(price);
    if (Number.isFinite(f) && f !== 0 && Number.isFinite(p) && p !== 0) {
      setPoints(String(pointsBetween(p, f)));
    }
  }

  /** Moving the price you are getting keeps the discrepancy and moves the fair price with it. */
  function editPrice(next: string) {
    setPrice(next);
    const p = Number(next);
    const n = Number(points);
    if (Number.isFinite(p) && p !== 0 && Number.isFinite(n)) {
      setFairPrice(String(shiftAmerican(p, n)));
    }
  }

  const result = useMemo(
    () =>
      evaluateKelly({
        price: Number(price),
        fairPrice: Number(fairPrice),
        bankroll: Number(bankroll),
        multiplier: Number(multiplier),
        unitSize: Number(unitSize),
      }),
    [price, fairPrice, bankroll, multiplier, unitSize]
  );

  const isPlus = result !== null && result.evPercent > 0;
  const activePreset = KELLY_PRESETS.find((p) => p.value === Number(multiplier));

  return (
    <>
      <div className="tabs">
        {KELLY_PRESETS.map((preset) => (
          <a
            key={preset.label}
            href="#"
            className={activePreset?.value === preset.value ? "active" : undefined}
            onClick={(e) => { e.preventDefault(); setMultiplier(String(preset.value)); }}
          >
            {preset.label} Kelly
          </a>
        ))}
      </div>

      <div className="filters">
        <NumField label="Your odds" value={price} onChange={editPrice} step="5" width={100} />
        <NumField label="Discrepancy" value={points} onChange={editPoints} step="5" width={90} suffix="pts" />
        <NumField label="Fair odds" value={fairPrice} onChange={editFairPrice} step="5" width={100} />
        <NumField label="Bankroll" value={bankroll} onChange={setBankroll} step="100" width={110} suffix="$" />
        <NumField label="Kelly multiplier" value={multiplier} onChange={setMultiplier} step="0.05" width={90} suffix="x" />
        <NumField label="Unit size" value={unitSize} onChange={setUnitSize} step="10" width={90} suffix="$" />
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
        The discrepancy is in odds points: your {fmtOdds(Number(price) || 0)} against a market you
        think is really {fmtOdds(Number(fairPrice) || 0)}. Editing either one moves the other. Leave
        unit size blank for 1% of bankroll. Bankroll, multiplier and unit size start from{" "}
        <a href="/settings#kelly">Settings</a>; changing them here is for this bet only.
      </p>

      {result === null ? (
        <p className="muted">
          {Number(bankroll) > 0 ? (
            "Enter a price and a fair price to see the stake."
          ) : (
            <>
              Set a bankroll — here, or in <a href="/settings#kelly">Settings</a> to keep it — to
              see a stake.
            </>
          )}
        </p>
      ) : (
        <>
          <div className="tiles">
            <div className="tile">
              <div className="label">Expected value</div>
              <div className="value" style={{ color: isPlus ? "var(--good)" : "var(--bad)" }}>
                {result.evPercent > 0 ? "+" : ""}{result.evPercent.toFixed(2)}%
              </div>
              <div className="sub">
                <span className={`badge ${isPlus ? "good" : "bad"}`}>{isPlus ? "+EV" : "-EV"}</span>{" "}
                {result.points > 0 ? `+${result.points}` : result.points} pts of edge
              </div>
            </div>
            <div className="tile">
              <div className="label">Stake</div>
              <div className="value">{money(result.stake)}</div>
              <div className="sub">
                {result.units.toFixed(2)} units at {money(result.unitSize)}
              </div>
            </div>
            <div className="tile">
              <div className="label">Of bankroll</div>
              <div className="value">{pct(result.fraction)}</div>
              <div className="sub">
                {Number(multiplier)}x of {pct(result.fullKellyFraction)} full Kelly
              </div>
            </div>
            <div className="tile">
              <div className="label">Fair win rate</div>
              <div className="value">{pct(result.fairProbability, 1)}</div>
              <div className="sub">
                need {pct(1 / result.decimal, 1)} to break even at {fmtOdds(Number(price) || 0)}
              </div>
            </div>
          </div>

          <div className="card">
            <h3>How that stake was reached</h3>
            <table className="math-table">
              <tbody>
                <tr>
                  <td>Fair win probability <span className="muted">p</span></td>
                  <td className="num">{pct(result.fairProbability, 3)}</td>
                  <td className="muted">implied by {fmtOdds(Number(fairPrice) || 0)}</td>
                </tr>
                <tr>
                  <td>Net decimal odds <span className="muted">b</span></td>
                  <td className="num">{result.b.toFixed(4)}</td>
                  <td className="muted">{fmtOdds(Number(price) || 0)} pays {result.decimal.toFixed(4)} per $1</td>
                </tr>
                <tr>
                  <td>Edge per $1 risked <span className="muted">p×b − q</span></td>
                  <td className="num">
                    {(result.fairProbability * result.b - (1 - result.fairProbability)).toFixed(4)}
                  </td>
                  <td className="muted">this is the EV, {result.evPercent.toFixed(2)}%</td>
                </tr>
                <tr>
                  <td>Full Kelly <span className="muted">÷ b</span></td>
                  <td className="num">{pct(result.fullKellyFraction)}</td>
                  <td className="muted">of bankroll</td>
                </tr>
                <tr>
                  <td>Your multiplier</td>
                  <td className="num">{pct(result.fraction)}</td>
                  <td className="muted">× {Number(multiplier)}</td>
                </tr>
                <tr>
                  <td><strong>Stake</strong></td>
                  <td className="num"><strong>{money(result.stake)}</strong></td>
                  <td className="muted">× {money(Number(bankroll))} bankroll</td>
                </tr>
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              The fair price is taken at face value: an entered {fmtOdds(Number(fairPrice) || 0)}{" "}
              means {pct(result.fairProbability, 1)} to win, full stop. There is only one side here,
              so there is nothing to de-vig against — if that number is itself a vigged consensus
              price, the EV above is optimistic by roughly half the hold, and the stake with it.
              Full Kelly assumes the probability is exactly right; the multiplier is what covers the
              fact that it is not.
            </p>
          </div>
        </>
      )}
    </>
  );
}

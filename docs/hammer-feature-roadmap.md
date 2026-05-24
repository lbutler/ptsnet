# HAMMER feature parity — engine roadmap

Scope: the **transient engine only** — no UI, no model-building/GIS/skeletonization
tooling. This tracks hydraulic-transient capabilities in Bentley HAMMER that are
worth bringing into this library, prioritised by **how commonly they're used in
real surge studies**. Niche features are listed but flagged to skip.

Sources read: HAMMER 2024 *Theory and Practice* online help — Hydraulic Transient
Theory, Air Valve Theory (Extended CAV), Transient Friction Methods, Cavitation,
Protection Devices / Developing a Surge-Control Strategy, Pump Protection,
Surge-Relief Valves, Transient Forces.

## How to read this

- **Status** — flip `[ ]` to `[x]` as items land.
- **Importance** — High = shows up in most surge studies; Med = common on specific
  system types; Low = niche.
- **Effort** — **S** ≈ a few days, **M** ≈ 1–2 weeks, **L** ≈ multi-week. Estimates
  are relative to the current MOC + boundary-kernel architecture.
- **Validate against** — where we'd get a reference to check correctness. *W&S* =
  Wylie & Streeter, *Fluid Transients in Systems* (1993); *Chaudhry* = *Applied
  Hydraulic Transients*. Both have worked numerical examples ideal for regression.

## Already in the engine (not re-listed below)

- MOC engine (SharedArrayBuffer worker pool / inline), steady state via `epanet-js`.
- Reservoirs, tanks, junctions; pipes with per-pipe wave speed and time-step control.
- Pumps (single + inline): head–flow curve, **speed setting + ramped pump operations**.
- Valves (single/end + inline): loss curves (butterfly default), **ramped open/close
  + arbitrary setting schedules**.
- Transient demand changes and bursts (leak opening).
- **Surge protection: open surge tank** (standpipe, vents to atmosphere) and
  **closed surge tank / gas vessel / air chamber** (polytropic) via `addSurgeProtection`.
- **Column separation / cavitation (DGCM)** at interior points, valves, and junction
  nodes, with per-element diagnostics + validity report.
- Steady (Darcy–Weisbach / Hazen–Williams) friction.
- Recording subsets, min/max envelopes, streaming / progress / abort.

---

## Tier 1 — High importance (do first)

| Status | Feature | Importance | Effort | Validate against |
| --- | --- | --- | --- | --- |
| [ ] | **Pump trip with rotational inertia (coast-down)** | High | M | W&S pump-trip examples; Chaudhry; HAMMER sample models |
| [x] | **Check valve (closes on flow reversal)** — ideal (instant) model shipped; reverse-velocity *slam* dynamics still a follow-up | High | S–M | Thorley, *Fluid Transients in Pipeline Systems*; W&S |
| [ ] | **Combination air valve (air/vacuum, CAV)** | High | M–L | W&S air-valve; AWWA M51; HAMMER CAV (Comolet 1961) |
| [ ] | **Unsteady (transient) friction — Brunone** | Med–High | M | Bergant, Simpson & Vitkovsky (2001) — has experimental data |
| [ ] | **Surge-relief valve (SRV, opens on overpressure)** | Med–High | M | W&S; Chaudhry; manufacturer Cv curves |

## Tier 2 — Medium importance

| Status | Feature | Importance | Effort | Validate against |
| --- | --- | --- | --- | --- |
| [ ] | **One-way surge tank (feed tank + check valve)** | Med | S–M | W&S; Chaudhry surge-tank examples |
| [ ] | **Four-quadrant pump characteristics (reverse flow/spin)** | Med | L | Suter (1966) / Marchal–Flesch–Suter data; W&S tables |
| [ ] | **Surge-anticipator valve (SAV)** | Med | M | W&S; HAMMER surge-relief docs |
| [ ] | **Transient forces (unbalanced thrust on pipe runs)** | Med | M | HAMMER Transient Forces; thrust-block design refs |
| [ ] | **Quasi-steady friction (recompute f from instantaneous V)** | Med | S | Standard MOC texts; cross-check vs steady & Brunone |
| [ ] | **Simple/two-way surge-tank enhancements (orifice loss, height limits, overflow)** | Med | S | W&S throttled surge tank |

## Tier 3 — Lower / niche (consider skipping)

| Status | Feature | Importance | Effort | Validate against |
| --- | --- | --- | --- | --- |
| [ ] | **Valve characteristic-curve library (globe/gate/ball/needle Cv vs % open)** | Low–Med | S | Manufacturer/ISA Cv data; W&S valve curves |
| [ ] | **Air-release / wave-speed-reduction factor (gas coming out of solution)** | Low | S | HAMMER cavitation notes; Liou DGCM |
| [ ] | **Active control valves during transient (PRV/PSV/FCV holding setpoint)** | Low | M–L | W&S; control-valve dynamics literature |
| [ ] | **Rupture disk / bursting disk** | Low | S | HAMMER; manufacturer burst-pressure data |
| [ ] | **Rigid-column theory (slow surge / surge-tank sizing)** | Low | M | W&S rigid-column chapter |
| [ ] | **Hydro turbine four-quadrant simulation** | Low | L | Chaudhry; four-quadrant turbine data (hydropower only) |

---

## Details & notes

### Tier 1

**Pump trip with rotational inertia.** The single most common transient cause in
pumping systems (power failure). Today we can *ramp* pump speed linearly; a real
trip lets the pump speed decay from the rotating-mass angular momentum
(`I·dω/dt = −torque`), with head/flow following the pump curve during coast-down
until a check valve shuts. Needs a pump-inertia (`WR²`/`I`) input and a torque
estimate. Pairs with the check valve. Start forward-quadrant only; add
four-quadrant later for reverse flow before the check valve seats.

**Check valve.** Closes when flow reverses to stop backflow; the abrupt closure
("slam") itself causes a surge. Needed for realistic pump-trip and many layouts.
Implement as a link/boundary state that latches shut at `Q ≤ 0` (optionally with a
reverse-velocity slam characteristic). Prerequisite for pump trip.

**Combination air valve (CAV).** Very common at pipeline high points. Admits air
when pressure drops to atmospheric (vacuum breaker — prevents/limits column
separation) and expels it on repressurisation through a smaller orifice. Modeled as
an air pocket at a node with mass in/out through an orifice, subsonic→sonic
throttling, and a polytropic/adiabatic air law (HAMMER uses γ=1.4 and a Comolet
sonic formulation). The trickiest Tier-1 item numerically (orifice mode
transitions, stability), hence M–L.

**Unsteady friction (Brunone).** Steady friction under-damps repeated transient
peaks; the Brunone instantaneous-acceleration term
`J_u = (k/g)(∂V/∂t + a·sign(V)|∂V/∂x|)` (with the Brunone coefficient from
Vardy–Brown shear decay) markedly improves agreement with measured traces. Slots
into the MOC friction term using previous-step velocities. Excellent experimental
validation data exists (Bergant–Simpson apparatus) — and it would sharpen our
existing Bergant cavitation case too.

**Surge-relief valve (SRV).** A pressure-relief device that opens to discharge when
head exceeds a setpoint and recloses below it, with finite open/close rates. Common,
cheap protection. Boundary condition: an orifice to atmosphere whose opening
fraction tracks a pressure setpoint + rate limits.

### Tier 2

**One-way surge tank.** A tank that only *feeds* the line when local head drops
below the tank level (via an internal check valve), then refills slowly. We already
have the open surge tank; this is that plus a check valve + refill orifice.

**Four-quadrant pump.** Full Suter-curve representation so the pump behaves
correctly in reverse flow/rotation (e.g., trip with no check valve, or turbining).
Larger effort: dimensionless head/torque curves + interpolation + a coupled
speed/flow solve. Needed for *accurate* pump-trip downsurge in some layouts; the
forward-quadrant trip covers the common case first.

**Surge-anticipator valve (SAV).** Opens on the low-pressure phase after a pump trip
(or a timed trigger) to pre-relieve the returning upsurge, then closes slowly.
Builds on the SRV mechanism with a low-pressure/timed trigger.

**Transient forces.** Post-processing deliverable: the unbalanced axial force on each
straight pipe run between bends from the pressure-time history (for restraint/thrust
design). Mostly post-processing of recorded pressures, but needs run/bend geometry,
which the current model may not carry yet.

**Quasi-steady friction.** Recompute the friction factor each step from the
instantaneous velocity (Colebrook/Swamee–Jain or H–W) instead of a frozen `f`. Cheap
and a modest accuracy gain; a stepping stone before Brunone.

**Simple surge-tank enhancements.** Add a throttling-orifice head loss at the tank
connection, plus standpipe height limits / overflow, to the existing open tank.

### Tier 3 (likely skip unless requested)

**Valve curve library** — pure data (the engine already takes arbitrary loss curves);
add standard globe/gate/ball/needle characteristics. **Air-release / wave-speed
reduction** — a knob we partly get for free from DGCM. **Active control valves** —
PRV/PSV holding a setpoint *through* the transient is niche for surge work (studies
usually fix valve positions or script operations). **Rupture disk**, **rigid-column
theory**, and **hydro turbine four-quadrant** are special-purpose; turbines in
particular only matter for hydropower, not water distribution.

---

## Suggested order

1. **Check valve** → unblocks realistic pump modeling (S–M).
2. **Pump trip with inertia** (forward quadrant) → the headline missing scenario (M).
3. **Unsteady friction (Brunone)** → accuracy win, reuses the Bergant validation (M).
4. **Combination air valve** → the headline missing *protection device* (M–L).
5. **Surge-relief valve**, then **one-way surge tank**, then **SAV** (M / S–M / M).
6. **Four-quadrant pump** + **transient forces** as accuracy/output follow-ups.

Quick wins to slot in opportunistically: **quasi-steady friction**, **simple
surge-tank enhancements**, **valve curve library** (all S).

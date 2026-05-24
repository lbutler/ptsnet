import { describe, it, expect } from 'vitest';
import { loadInitialConditions } from '../src/epanet/initialConditions';
import { NODE_RESERVOIR } from '../src/core/types';
import { SIMPLE_INP } from './fixtures';

describe('loadInitialConditions (epanet-js steady state)', () => {
  it('builds an SI steady-state model from a simple network', async () => {
    const ss = await loadInitialConditions(SIMPLE_INP);

    expect(ss.node.n).toBe(3);
    expect(ss.pipe.n).toBe(2);
    expect(ss.pump.n).toBe(0);
    expect(ss.valve.n).toBe(0);

    // Reservoir head ~ 100 m (LPS already metric, no conversion needed).
    const r1 = ss.node.index.get('R1')!;
    expect(ss.node.type[r1]).toBe(NODE_RESERVOIR);
    expect(ss.node.head[r1]).toBeCloseTo(100, 6);

    // Every head must be finite and below the reservoir head (flow downhill).
    for (let i = 0; i < ss.node.n; i++) {
      expect(Number.isFinite(ss.node.head[i])).toBe(true);
    }
    const j1 = ss.node.index.get('J1')!;
    const j2 = ss.node.index.get('J2')!;
    expect(ss.node.head[j1]).toBeLessThan(100);
    // No flow past J1 (J2 has no demand), so J2 head == J1 head.
    expect(ss.node.head[j2]).toBeCloseTo(ss.node.head[j1], 6);

    // Pipe P1 carries the full 50 LPS demand = 0.05 m^3/s.
    const p1 = ss.pipe.index.get('P1')!;
    expect(ss.pipe.flowrate[p1]).toBeCloseTo(0.05, 4);

    // Friction factor and wave-speed placeholders are sane.
    expect(ss.pipe.diameter[p1]).toBeCloseTo(0.3, 6); // 300 mm -> 0.3 m
    expect(ss.pipe.ffactor[p1]).toBeGreaterThan(0);
  });
});

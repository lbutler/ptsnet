import { describe, it, expect } from 'vitest';
import { FlowUnit, HydParam, toSi } from '../src/epanet/units';

describe('unit conversions', () => {
  it('converts GPM flow to SI (m^3/s)', () => {
    // 1 GPM = 6.30901964e-05 m^3/s
    expect(toSi(FlowUnit.GPM, 1, HydParam.Flow)).toBeCloseTo(6.30901964e-5, 12);
  });

  it('LPS flow is already metric', () => {
    expect(toSi(FlowUnit.LPS, 50, HydParam.Flow)).toBeCloseTo(0.05, 12);
  });

  it('converts traditional lengths (ft) and diameters (in) to meters', () => {
    expect(toSi(FlowUnit.GPM, 1, HydParam.Length)).toBeCloseTo(0.3048, 9);
    expect(toSi(FlowUnit.GPM, 1, HydParam.PipeDiameter)).toBeCloseTo(0.0254, 9);
  });

  it('metric diameters are millimetres', () => {
    expect(toSi(FlowUnit.LPS, 300, HydParam.PipeDiameter)).toBeCloseTo(0.3, 9);
  });

  it('converts psi pressure to metres of head for traditional units', () => {
    expect(toSi(FlowUnit.GPM, 1, HydParam.Pressure)).toBeCloseTo(0.3048 / 0.4333, 9);
  });
});

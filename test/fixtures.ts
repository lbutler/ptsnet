import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function exampleInp(name: string): string {
  const file = name.toLowerCase().endsWith('.inp') ? name : `${name}.inp`;
  return readFileSync(resolve(here, '..', 'examples', file), 'utf8');
}

/**
 * Minimal reservoir -> pipe -> junction(demand) -> pipe -> junction network in
 * metric (LPS) units, used for deterministic core-engine assertions.
 */
export const SIMPLE_INP = `[TITLE]
Simple reservoir-pipe-junction network

[JUNCTIONS]
;ID    Elev   Demand
 J1    0      50
 J2    0      0

[RESERVOIRS]
;ID    Head
 R1    100

[PIPES]
;ID    Node1  Node2  Length  Diameter  Roughness  MinorLoss  Status
 P1    R1     J1     1000    300       100        0          Open
 P2    J1     J2     1000    300       100        0          Open

[OPTIONS]
 Units              LPS
 Headloss           H-W
 Quality            None mg/L
 Trials             40
 Accuracy           0.001

[TIMES]
 Duration           0
 Hydraulic Timestep 1:00

[END]
`;

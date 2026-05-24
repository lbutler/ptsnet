/** Model compatibility checks. Port of `simulation/validation.py`. */
import { SteadyState, NODE_RESERVOIR, NODE_TANK, TOL } from './types';

export class ModelError extends Error {}

export function checkCompatibility(ss: SteadyState): void {
  const { node, pump, valve } = ss;

  // No isolated nodes.
  for (let i = 0; i < node.n; i++) {
    if (node.degree[i] === 0) {
      throw new ModelError(`node '${node.labels[i]}' is isolated`);
    }
  }

  // Pumps cannot have dead-end downstream nodes.
  for (let k = 0; k < pump.n; k++) {
    if (node.degree[pump.endNode[k]] < 2) {
      throw new ModelError(`pump '${pump.labels[k]}' has an incompatible end node`);
    }
  }

  // Valves cannot have isolated start nodes.
  for (let k = 0; k < valve.n; k++) {
    if (node.degree[valve.startNode[k]] < 2) {
      throw new ModelError(`valve '${valve.labels[k]}' has an incompatible start node`);
    }
  }

  // Nodes of non-pipe elements cannot be general junctions (degree > 2).
  const checkDeg = (idx: Int32Array, labels: string[], which: string): void => {
    for (let k = 0; k < idx.length; k++) {
      if (node.degree[idx[k]] > 2) {
        throw new ModelError(`${which} '${labels[k]}' is connected to more than one pipe`);
      }
    }
  };
  checkDeg(valve.startNode, valve.labels, 'valve start');
  checkDeg(valve.endNode, valve.labels, 'valve end');
  checkDeg(pump.startNode, pump.labels, 'pump start');
  checkDeg(pump.endNode, pump.labels, 'pump end');

  // Non-inline pumps cannot pull from a dead-end (non-source) junction.
  for (let k = 0; k < pump.n; k++) {
    if (pump.isInline[k]) continue;
    const s = pump.startNode[k];
    if (
      node.degree[s] === 1 &&
      node.degree[pump.endNode[k]] > 1 &&
      node.type[s] !== NODE_TANK &&
      node.type[s] !== NODE_RESERVOIR
    ) {
      throw new ModelError(`start node of pump '${pump.labels[k]}' is incompatible`);
    }
  }

  // Reservoirs cannot sit at the end of a pump or valve.
  for (let k = 0; k < pump.n; k++) {
    if (node.type[pump.endNode[k]] === NODE_RESERVOIR) {
      throw new ModelError('a pump has a reservoir at its end node');
    }
  }
  for (let k = 0; k < valve.n; k++) {
    if (node.type[valve.endNode[k]] === NODE_RESERVOIR) {
      throw new ModelError('a valve has a reservoir at its end node');
    }
  }

  // Non-pipe elements can only connect to pipes (no shared non-pipe nodes).
  const allNonPipe: number[] = [];
  for (let k = 0; k < pump.n; k++) allNonPipe.push(pump.startNode[k], pump.endNode[k]);
  for (let k = 0; k < valve.n; k++) allNonPipe.push(valve.startNode[k], valve.endNode[k]);
  if (new Set(allNonPipe).size !== allNonPipe.length) {
    throw new ModelError('there are non-pipe elements connected to each other');
  }

  // No leaks/demands on non-pipe element nodes (except non-inline end nodes,
  // which may legitimately carry demand downstream of an end valve).
  const nonPipeNoBurst: number[] = [];
  for (let k = 0; k < pump.n; k++) {
    nonPipeNoBurst.push(pump.startNode[k]);
    if (pump.isInline[k]) nonPipeNoBurst.push(pump.endNode[k]);
  }
  for (let k = 0; k < valve.n; k++) {
    nonPipeNoBurst.push(valve.startNode[k]);
    if (valve.isInline[k]) nonPipeNoBurst.push(valve.endNode[k]);
  }
  for (const nd of nonPipeNoBurst) {
    if (node.leakCoefficient[nd] > 0) {
      throw new ModelError(`non-pipe element connected to a leaking node '${node.labels[nd]}'`);
    }
    if (node.demandCoefficient[nd] > 0) {
      throw new ModelError(`non-pipe element connected to a node with demand '${node.labels[nd]}'`);
    }
  }

  // Demands cannot be negative (junctions only).
  for (let i = 0; i < node.n; i++) {
    if (node.type[i] !== NODE_RESERVOIR && node.type[i] !== NODE_TANK && node.demand[i] < 0) {
      throw new ModelError(`node '${node.labels[i]}' has a negative demand`);
    }
  }

  // Flowing valves must have a non-zero loss coefficient.
  for (let k = 0; k < valve.n; k++) {
    if (valve.flowrate[k] !== 0 && valve.headLoss[k] < TOL) {
      throw new ModelError(
        `valve '${valve.labels[k]}' cannot have a zero (near-zero) loss coefficient`,
      );
    }
  }
}

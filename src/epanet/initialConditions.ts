/**
 * Builds the PTSNET steady-state model from an EPANET `.inp` file using
 * epanet-js. This is the TypeScript replacement for `get_water_network`
 * (wntr) + `get_initial_conditions` (EPANET toolkit) in `simulation/init.py`.
 */
import {
  Project,
  Workspace,
  CountType,
  NodeProperty,
  LinkProperty,
  LinkType,
  InitHydOption,
} from 'epanet-js';
import { FlowUnit, HydParam, toSi, toSiArray } from './units';
import {
  SteadyState,
  NodeTable,
  PipeTable,
  PumpTable,
  ValveTable,
  NODE_RESERVOIR,
  NODE_TANK,
  G,
  TOL,
  DEFAULT_FFACTOR,
} from '../core/types';
import { argsort, polyfit2 } from '../core/math';

function makeNodeTable(n: number): NodeTable {
  return {
    n,
    labels: new Array(n).fill(''),
    index: new Map(),
    demand: new Float64Array(n),
    head: new Float64Array(n),
    pressure: new Float64Array(n),
    elevation: new Float64Array(n),
    type: new Int32Array(n),
    degree: new Int32Array(n),
    leakCoefficient: new Float64Array(n),
    demandCoefficient: new Float64Array(n),
  };
}

function makePipeTable(n: number): PipeTable {
  return {
    n,
    labels: new Array(n).fill(''),
    index: new Map(),
    startNode: new Int32Array(n),
    endNode: new Int32Array(n),
    length: new Float64Array(n),
    diameter: new Float64Array(n),
    area: new Float64Array(n),
    waveSpeed: new Float64Array(n),
    desiredWaveSpeed: new Float64Array(n),
    waveSpeedAdjustment: new Float64Array(n),
    segments: new Float64Array(n),
    flowrate: new Float64Array(n),
    velocity: new Float64Array(n),
    headLoss: new Float64Array(n),
    direction: new Int32Array(n),
    ffactor: new Float64Array(n),
    dx: new Float64Array(n),
    type: new Int32Array(n),
    isInline: new Uint8Array(n),
    isCheckValve: new Uint8Array(n),
  };
}

function makePumpTable(n: number): PumpTable {
  return {
    n,
    labels: new Array(n).fill(''),
    index: new Map(),
    startNode: new Int32Array(n),
    endNode: new Int32Array(n),
    flowrate: new Float64Array(n),
    velocity: new Float64Array(n),
    headLoss: new Float64Array(n),
    direction: new Int32Array(n),
    initialStatus: new Float64Array(n),
    isInline: new Uint8Array(n),
    sourceHead: new Float64Array(n),
    a1: new Float64Array(n),
    a2: new Float64Array(n),
    Hs: new Float64Array(n),
    curveIndex: new Int32Array(n).fill(-1),
    setting: new Float64Array(n),
  };
}

function makeValveTable(n: number): ValveTable {
  return {
    n,
    labels: new Array(n).fill(''),
    index: new Map(),
    startNode: new Int32Array(n),
    endNode: new Int32Array(n),
    diameter: new Float64Array(n),
    area: new Float64Array(n),
    headLoss: new Float64Array(n),
    flowrate: new Float64Array(n),
    velocity: new Float64Array(n),
    direction: new Int32Array(n),
    initialStatus: new Float64Array(n),
    type: new Int32Array(n),
    isInline: new Uint8Array(n),
    adjustment: new Float64Array(n).fill(1),
    K: new Float64Array(n),
    setting: new Float64Array(n),
    curveIndex: new Int32Array(n).fill(-1),
  };
}

function assignLabels(
  labels: string[],
  index: Map<string, number>,
  values: string[],
): void {
  for (let i = 0; i < values.length; i++) {
    labels[i] = values[i];
    if (index.has(values[i])) {
      throw new Error(`label values have to be unique, '${values[i]}' is repeated`);
    }
    index.set(values[i], i);
  }
}

function isPipeType(t: LinkType): boolean {
  return t === LinkType.Pipe || t === LinkType.CVPipe;
}
function isPumpType(t: LinkType): boolean {
  return t === LinkType.Pump;
}

export interface InitialConditionsOptions {
  /** EPANET extended-period index for the initial conditions. */
  period?: number;
}

/**
 * Run the EPANET steady-state solve and assemble the PTSNET model in SI units.
 */
export async function loadInitialConditions(
  inpText: string,
  options: InitialConditionsOptions = {},
): Promise<SteadyState> {
  const period = options.period ?? 0;

  const ws = new Workspace();
  await ws.loadModule();
  const model = new Project(ws);
  ws.writeFile('net.inp', inpText);
  model.open('net.inp', 'report.rpt', 'out.bin');

  try {
    const numNodes = model.getCount(CountType.NodeCount);
    const numLinks = model.getCount(CountType.LinkCount);

    // --- Degrees + adjacency from connectivity (replaces the wntr graph) ---
    const degree = new Int32Array(numNodes);
    const linkNode1 = new Int32Array(numLinks + 1);
    const linkNode2 = new Int32Array(numLinks + 1);
    const linkTypes: LinkType[] = new Array(numLinks + 1);
    const linkIds: string[] = new Array(numLinks + 1);
    for (let i = 1; i <= numLinks; i++) {
      const { node1, node2 } = model.getLinkNodes(i);
      linkNode1[i] = node1;
      linkNode2[i] = node2;
      linkTypes[i] = model.getLinkType(i);
      linkIds[i] = model.getLinkId(i);
      degree[node1 - 1]++;
      degree[node2 - 1]++;
    }

    let numPipes = 0;
    let numPumps = 0;
    let numValves = 0;
    for (let i = 1; i <= numLinks; i++) {
      if (isPipeType(linkTypes[i])) numPipes++;
      else if (isPumpType(linkTypes[i])) numPumps++;
      else numValves++;
    }

    const nodes = makeNodeTable(numNodes);
    const pipes = makePipeTable(numPipes);
    const pumps = makePumpTable(numPumps);
    const valves = makeValveTable(numValves);

    // --- Run hydraulics up to the requested period ---
    // Mirrors get_initial_conditions in init.py exactly (including its quirk of
    // calling nextH before the first runH, which advances an EPS model by one
    // hydraulic step before sampling the initial conditions).
    model.openH();
    model.initH(InitHydOption.NoSave);
    let t = 0;
    while (model.nextH() > 0 && t <= period) {
      model.runH();
      t++;
    }
    if (t === 0) model.runH();

    const flowUnits = model.getFlowUnits() as unknown as FlowUnit;

    // --- Node initial conditions ---
    const nodeLabels: string[] = new Array(numNodes);
    for (let i = 1; i <= numNodes; i++) {
      const k = i - 1;
      nodeLabels[k] = model.getNodeId(i);
      nodes.leakCoefficient[k] = model.getNodeValue(i, NodeProperty.Emitter);
      nodes.demand[k] = model.getNodeValue(i, NodeProperty.Demand);
      nodes.head[k] = model.getNodeValue(i, NodeProperty.Head);
      nodes.pressure[k] = model.getNodeValue(i, NodeProperty.Pressure);
      nodes.type[k] = model.getNodeType(i) as unknown as number;
      let z = model.getNodeValue(i, NodeProperty.Elevation);
      if (nodes.type[k] === NODE_RESERVOIR) z = 0;
      else if (nodes.type[k] === NODE_TANK) z = nodes.head[k] - nodes.pressure[k];
      nodes.elevation[k] = z;
      nodes.degree[k] = degree[k];
    }
    toSiArray(flowUnits, nodes.leakCoefficient, HydParam.EmitterCoeff);
    toSiArray(flowUnits, nodes.demand, HydParam.Demand);
    toSiArray(flowUnits, nodes.head, HydParam.HydraulicHead);
    toSiArray(flowUnits, nodes.pressure, HydParam.Pressure);
    toSiArray(flowUnits, nodes.elevation, HydParam.Elevation);

    assignLabels(nodes.labels, nodes.index, nodeLabels);

    // --- Link initial conditions ---
    const pipeLabels: string[] = [];
    const pumpLabels: string[] = [];
    const valveLabels: string[] = [];
    const linksForNode: string[][] = Array.from({ length: numNodes }, () => []);

    let p = 0;
    let pp = 0;
    let v = 0;
    for (let i = 1; i <= numLinks; i++) {
      const lt = linkTypes[i];
      const isPipe = isPipeType(lt);
      const isPump = isPumpType(lt);
      const tbl: PipeTable | PumpTable | ValveTable = isPipe
        ? pipes
        : isPump
          ? pumps
          : valves;
      const k = isPipe ? p++ : isPump ? pp++ : v++;

      let startNode = linkNode1[i] - 1;
      let endNode = linkNode2[i] - 1;
      let flowrate = model.getLinkValue(i, LinkProperty.Flow);
      const velocity = model.getLinkValue(i, LinkProperty.Velocity);

      const flowSi = toSi(flowUnits, flowrate, HydParam.Flow);
      if (Math.abs(flowSi) < TOL) {
        tbl.direction[k] = 0;
        flowrate = 0;
        if (isPipe) (tbl as PipeTable).ffactor[k] = DEFAULT_FFACTOR;
      } else if (flowSi > TOL) {
        tbl.direction[k] = 1;
      } else {
        tbl.direction[k] = -1;
        flowrate *= -1;
        const tmp = startNode;
        startNode = endNode;
        endNode = tmp;
      }
      tbl.startNode[k] = startNode;
      tbl.endNode[k] = endNode;
      tbl.flowrate[k] = flowrate;
      tbl.velocity[k] = velocity;

      if (nodes.degree[startNode] >= 2 && nodes.degree[endNode] >= 2) {
        tbl.isInline[k] = 1;
      }

      linksForNode[linkNode1[i] - 1].push(linkIds[i]);
      linksForNode[linkNode2[i] - 1].push(linkIds[i]);

      if (isPipe || (!isPump && !isPipe)) {
        // pipe or valve
        const geom = tbl as PipeTable | ValveTable;
        geom.diameter[k] = toSi(
          flowUnits,
          model.getLinkValue(i, LinkProperty.Diameter),
          HydParam.PipeDiameter,
        );
        geom.area[k] = (Math.PI * geom.diameter[k] ** 2) / 4;
        geom.type[k] = lt as unknown as number;
        geom.headLoss[k] = model.getLinkValue(i, LinkProperty.Headloss);
      }

      if (isPipe) {
        const pt = tbl as PipeTable;
        pipeLabels.push(linkIds[i]);
        pt.isCheckValve[k] = lt === LinkType.CVPipe ? 1 : 0; // honor EPANET check-valve pipes
        pt.length[k] = toSi(flowUnits, model.getLinkValue(i, LinkProperty.Length), HydParam.Length);
      } else if (isPump) {
        const pt = tbl as PumpTable;
        pumpLabels.push(linkIds[i]);
        pt.initialStatus[k] = model.getLinkValue(i, LinkProperty.InitStatus);
        pt.setting[k] = pt.initialStatus[k];
        pt.headLoss[k] = model.getLinkValue(i, LinkProperty.Headloss);

        // Pump curve -> quadratic head-flow fit (SI).
        const qp: number[] = [];
        const hp: number[] = [];
        const curveIdx = model.getHeadCurveIndex(i);
        if (curveIdx > 0) {
          const curve = model.getCurve(curveIdx);
          for (let j = 0; j < curve.x.length; j++) {
            qp.push(toSi(flowUnits, curve.x[j], HydParam.Flow));
            hp.push(toSi(flowUnits, curve.y[j], HydParam.HydraulicHead));
          }
          // Replace the last curve point with the actual operating point.
          qp.pop();
          hp.pop();
        }
        const qpp = toSi(flowUnits, pt.flowrate[k], HydParam.Flow);
        const hpp = toSi(flowUnits, pt.headLoss[k], HydParam.HydraulicHead);
        qp.push(qpp);
        hp.push(Math.abs(hpp));
        const order = argsort(qp);
        const qpS = order.map((o) => qp[o]);
        const hpS = order.map((o) => hp[o]);
        const [a2, a1, Hs] = polyfit2(qpS, hpS);
        pt.a2[k] = a2;
        pt.a1[k] = a1;
        pt.Hs[k] = Hs;
        pt.sourceHead[k] = nodes.head[startNode];
      } else {
        const vt = tbl as ValveTable;
        valveLabels.push(linkIds[i]);
        vt.initialStatus[k] = model.getLinkValue(i, LinkProperty.InitStatus);
        vt.setting[k] = vt.initialStatus[k];
        vt.flowrate[k] = toSi(flowUnits, vt.flowrate[k], HydParam.Flow);
        const ha = nodes.head[startNode];
        const hb = nodes.degree[endNode] > 1 ? nodes.head[endNode] : 0;
        const hl = ha - hb;
        if (hl > 0) {
          vt.K[k] = vt.flowrate[k] / (vt.area[k] * Math.sqrt(2 * G * hl));
        }
      }
    }

    // --- Post-loop unit conversions (match init.py lines 419-426) ---
    toSiArray(flowUnits, pipes.headLoss, HydParam.HydraulicHead);
    toSiArray(flowUnits, pipes.flowrate, HydParam.Flow);
    toSiArray(flowUnits, pumps.flowrate, HydParam.Flow);
    toSiArray(flowUnits, pipes.velocity, HydParam.Velocity);
    toSiArray(flowUnits, pumps.velocity, HydParam.Velocity);
    toSiArray(flowUnits, pumps.headLoss, HydParam.HydraulicHead);
    toSiArray(flowUnits, valves.headLoss, HydParam.HydraulicHead);
    toSiArray(flowUnits, valves.velocity, HydParam.Velocity);

    // Darcy friction factor from steady-state head loss for flowing pipes.
    for (let k = 0; k < numPipes; k++) {
      if (pipes.ffactor[k] === 0) {
        pipes.ffactor[k] =
          (2 * G * pipes.diameter[k] * pipes.headLoss[k]) /
          (pipes.length[k] * pipes.velocity[k] ** 2);
      }
    }

    assignLabels(pipes.labels, pipes.index, pipeLabels);
    assignLabels(pumps.labels, pumps.index, pumpLabels);
    assignLabels(valves.labels, valves.index, valveLabels);

    // Emitter (leak) vs demand coefficient split for demanded junctions.
    for (let k = 0; k < numNodes; k++) {
      if (nodes.type[k] !== NODE_RESERVOIR && nodes.type[k] !== NODE_TANK) {
        const keKd = nodes.pressure[k] > 0 ? nodes.demand[k] / Math.sqrt(nodes.pressure[k]) : 0;
        nodes.demandCoefficient[k] = keKd - nodes.leakCoefficient[k];
      }
    }

    const ss: SteadyState = {
      node: nodes,
      pipe: pipes,
      pump: pumps,
      valve: valves,
      openProtection: new Map(),
      closedProtection: new Map(),
      airValve: new Map(),
      surgeReliefValve: new Map(),
      linksForNode,
    };

    fixZeroFlowConvention(ss, valves);
    fixZeroFlowConvention(ss, pumps);

    return ss;
  } finally {
    model.close();
  }
}

/**
 * Resolve the flow direction of pipes adjacent to non-pipe elements that sit on
 * zero-flow pipes. Port of `_fix_zero_flow_convention`.
 */
function fixZeroFlowConvention(ss: SteadyState, tbl: ValveTable | PumpTable): void {
  const pipe = ss.pipe;
  const zf = new Set<number>();
  for (let k = 0; k < pipe.n; k++) {
    if (pipe.flowrate[k] === 0) {
      zf.add(pipe.startNode[k]);
      zf.add(pipe.endNode[k]);
    }
  }

  for (let k = 0; k < tbl.n; k++) {
    if (!zf.has(tbl.startNode[k])) continue;

    const elemLabel = tbl.labels[k];
    const upLinks = ss.linksForNode[tbl.startNode[k]].filter((l) => l !== elemLabel);
    const downLinks = ss.linksForNode[tbl.endNode[k]].filter((l) => l !== elemLabel);
    if (upLinks.length === 0 || downLinks.length === 0) continue;
    const upipe = pipe.index.get(upLinks[0]);
    const dpipe = pipe.index.get(downLinks[0]);
    if (upipe === undefined || dpipe === undefined) continue;

    if (pipe.endNode[upipe] !== tbl.startNode[k]) {
      pipe.direction[upipe] = pipe.direction[upipe] !== -1 ? -1 : 1;
      const tmp = pipe.startNode[upipe];
      pipe.startNode[upipe] = pipe.endNode[upipe];
      pipe.endNode[upipe] = tmp;
    } else if (pipe.direction[upipe] === 0) {
      pipe.direction[upipe] = 1;
    }

    if (pipe.startNode[dpipe] !== tbl.endNode[k]) {
      pipe.direction[dpipe] = pipe.direction[dpipe] !== -1 ? -1 : 1;
      const tmp = pipe.startNode[dpipe];
      pipe.startNode[dpipe] = pipe.endNode[dpipe];
      pipe.endNode[dpipe] = tmp;
    } else if (pipe.direction[dpipe] === 0) {
      pipe.direction[dpipe] = 1;
    }
  }
}

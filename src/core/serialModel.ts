/**
 * Serial topology builder.
 *
 * The original PTSNET distributes "points" (pipe discretization nodes) across
 * MPI ranks via `parallel/partitioning.py` and `worker._create_selectors`.
 * For the serial engine a single worker owns every point in pipe order, which
 * collapses that machinery into a direct construction of the selector arrays
 * used by the Method-of-Characteristics kernels.
 */
import { SteadyState, NODE_RESERVOIR, NODE_TANK, G } from './types';

export interface EngineModel {
  numPoints: number;

  // Per-point properties.
  B: Float64Array;
  R: Float64Array;
  hasPlus: Int32Array;
  hasMinus: Int32Array;
  initHead: Float64Array;
  initFlow: Float64Array;

  // Pipe boundary points (one per pipe).
  dboundary: Int32Array; // first point of each pipe (downstream boundary)
  uboundary: Int32Array; // last point of each pipe (upstream boundary)

  // General junction solver.
  numJip: number;
  ajip: Int32Array; // node id for each just-in-pipes junction
  jipPoints: Int32Array;
  jipNodeOfPoint: Int32Array; // 0..numJip-1 per jipPoints entry
  jipDboundaries: Int32Array;
  jipUboundaries: Int32Array;
  areReservoirs: Int32Array;
  areTanks: Int32Array;

  // Valves.
  singleValvePoints: Int32Array;
  singleValveCtx: Int32Array;
  startValvePoints: Int32Array;
  endValvePoints: Int32Array;
  startValveCtx: Int32Array;

  // Pumps.
  singlePumpPoints: Int32Array;
  startPumpPoints: Int32Array;
  endPumpPoints: Int32Array;
  startPumpCtx: Int32Array;
  singlePumpCtx: Int32Array;

  // Result node mapping (head stored for every node with a representative point).
  numResultNodes: number;
  allToPoints: Int32Array;
  allToNode: Int32Array;
  nodeResultLabels: string[];

  // Surge protections (point pairs; start has C+, end has C-).
  openStart: Int32Array;
  openEnd: Int32Array;
  openArea: Float64Array;
  closedStart: Int32Array;
  closedEnd: Int32Array;
  closedArea: Float64Array;
  closedHeight: Float64Array;
  closedWaterLevel: Float64Array;
  closedNode: Int32Array;
  // Check valves (point pairs; start has C+ / upstream pipe, end has C- / downstream pipe).
  checkStart: Int32Array;
  checkEnd: Int32Array;
}

interface BoundaryRef {
  point: number;
  isU: boolean;
}

export function buildEngineModel(
  ss: SteadyState,
  numPoints: number,
  warn: (msg: string) => void = () => {},
): EngineModel {
  const pipe = ss.pipe;
  const node = ss.node;
  const valve = ss.valve;
  const pump = ss.pump;
  const numPipes = pipe.n;

  const B = new Float64Array(numPoints);
  const R = new Float64Array(numPoints);
  const hasPlus = new Int32Array(numPoints);
  const hasMinus = new Int32Array(numPoints);
  const initHead = new Float64Array(numPoints);
  const initFlow = new Float64Array(numPoints);

  const dboundary = new Int32Array(numPipes);
  const uboundary = new Int32Array(numPipes);

  // --- Lay out points pipe by pipe; fill B, R and the initial column. ---
  let offset = 0;
  for (let p = 0; p < numPipes; p++) {
    const seg = Math.round(pipe.segments[p]);
    const start = offset;
    const end = offset + seg; // inclusive last point index
    dboundary[p] = start;
    uboundary[p] = end;

    const b = pipe.waveSpeed[p] / (G * pipe.area[p]);
    const r =
      (pipe.ffactor[p] * pipe.dx[p]) /
      (2 * G * pipe.diameter[p] * pipe.area[p] ** 2);
    const sHead = node.head[pipe.startNode[p]];
    const perUnitHl = pipe.headLoss[p] / pipe.segments[p];

    for (let j = start; j <= end; j++) {
      B[j] = b;
      R[j] = r;
      initFlow[j] = pipe.flowrate[p];
      initHead[j] = sHead - perUnitHl * (j - start);
    }
    offset = end + 1;
  }

  // has_plus / has_minus from boundary roles.
  for (let p = 0; p < numPipes; p++) {
    hasPlus[uboundary[p]] = 1;
    hasMinus[dboundary[p]] = 1;
    for (let j = dboundary[p] + 1; j < uboundary[p]; j++) {
      hasPlus[j] = 1;
      hasMinus[j] = 1;
    }
  }

  // --- Map nodes to their incident pipe boundary points. ---
  const boundaryAtNode: BoundaryRef[][] = Array.from({ length: node.n }, () => []);
  for (let p = 0; p < numPipes; p++) {
    boundaryAtNode[pipe.startNode[p]].push({ point: dboundary[p], isU: false });
    boundaryAtNode[pipe.endNode[p]].push({ point: uboundary[p], isU: true });
  }

  const isValvePumpNode = new Uint8Array(node.n);
  for (let i = 0; i < valve.n; i++) {
    isValvePumpNode[valve.startNode[i]] = 1;
    isValvePumpNode[valve.endNode[i]] = 1;
  }
  for (let i = 0; i < pump.n; i++) {
    isValvePumpNode[pump.startNode[i]] = 1;
    isValvePumpNode[pump.endNode[i]] = 1;
  }

  // --- Classify boundaries in pipe order [D0, U0, D1, U1, ...]. ---
  const ajip: number[] = [];
  const jipPoints: number[] = [];
  const jipNodeOfPoint: number[] = [];
  const jipRepPoint: number[] = [];
  const nodeLocalOf = new Map<number, number>();
  const jipDboundaries: number[] = [];
  const jipUboundaries: number[] = [];
  const areReservoirs: number[] = [];
  const reservoirNodes: number[] = [];
  const areTanks: number[] = [];
  const tankNodes: number[] = [];

  const classify = (b: number, n: number, isU: boolean): void => {
    const t = node.type[n];
    if (t === NODE_RESERVOIR) {
      areReservoirs.push(b);
      reservoirNodes.push(n);
      (isU ? jipUboundaries : jipDboundaries).push(b);
    } else if (t === NODE_TANK) {
      areTanks.push(b);
      tankNodes.push(n);
      (isU ? jipUboundaries : jipDboundaries).push(b);
    } else if (isValvePumpNode[n]) {
      // Handled by valve/pump grouping.
    } else {
      let local = nodeLocalOf.get(n);
      if (local === undefined) {
        local = ajip.length;
        nodeLocalOf.set(n, local);
        ajip.push(n);
        jipRepPoint.push(b);
      }
      jipPoints.push(b);
      jipNodeOfPoint.push(local);
      (isU ? jipUboundaries : jipDboundaries).push(b);
    }
  };

  for (let p = 0; p < numPipes; p++) {
    classify(dboundary[p], pipe.startNode[p], false);
    classify(uboundary[p], pipe.endNode[p], true);
  }
  const numJip = ajip.length;

  // --- Valve grouping. ---
  const singleValvePoints: number[] = [];
  const singleValveCtx: number[] = [];
  const startValvePoints: number[] = [];
  const endValvePoints: number[] = [];
  const startValveCtx: number[] = [];

  const firstBoundary = (n: number): BoundaryRef | undefined => boundaryAtNode[n]?.[0];

  for (let i = 0; i < valve.n; i++) {
    if (valve.isInline[i]) {
      const s = firstBoundary(valve.startNode[i]);
      const e = firstBoundary(valve.endNode[i]);
      if (s && e) {
        startValvePoints.push(s.point);
        endValvePoints.push(e.point);
        startValveCtx.push(i);
      }
    } else {
      const s = firstBoundary(valve.startNode[i]);
      if (s) {
        singleValvePoints.push(s.point);
        singleValveCtx.push(i);
      }
    }
  }

  // --- Pump grouping. ---
  const singlePumpPoints: number[] = [];
  const singlePumpCtx: number[] = [];
  const startPumpPoints: number[] = [];
  const endPumpPoints: number[] = [];
  const startPumpCtx: number[] = [];

  for (let i = 0; i < pump.n; i++) {
    if (pump.isInline[i]) {
      const s = firstBoundary(pump.startNode[i]);
      const e = firstBoundary(pump.endNode[i]);
      if (s && e) {
        startPumpPoints.push(s.point);
        endPumpPoints.push(e.point);
        startPumpCtx.push(i);
      }
    } else {
      const e = firstBoundary(pump.endNode[i]);
      if (e) {
        singlePumpPoints.push(e.point);
        singlePumpCtx.push(i);
      }
    }
  }

  // --- Result node mapping (dedupe by first occurrence). ---
  const nodeOrder: number[] = [];
  const pointOrder: number[] = [];
  const pushNode = (n: number, pt: number): void => {
    nodeOrder.push(n);
    pointOrder.push(pt);
  };
  for (let c = 0; c < numJip; c++) pushNode(ajip[c], jipRepPoint[c]);
  for (let i = 0; i < tankNodes.length; i++) pushNode(tankNodes[i], areTanks[i]);
  for (let i = 0; i < reservoirNodes.length; i++) pushNode(reservoirNodes[i], areReservoirs[i]);
  for (let i = 0; i < startValveCtx.length; i++) {
    pushNode(valve.startNode[startValveCtx[i]], startValvePoints[i]);
    pushNode(valve.endNode[startValveCtx[i]], endValvePoints[i]);
  }
  for (let i = 0; i < startPumpCtx.length; i++) {
    pushNode(pump.startNode[startPumpCtx[i]], startPumpPoints[i]);
    pushNode(pump.endNode[startPumpCtx[i]], endPumpPoints[i]);
  }
  for (let i = 0; i < singleValveCtx.length; i++) {
    pushNode(valve.startNode[singleValveCtx[i]], singleValvePoints[i]);
  }
  for (let i = 0; i < singlePumpCtx.length; i++) {
    pushNode(pump.endNode[singlePumpCtx[i]], singlePumpPoints[i]);
  }

  const seenNode = new Set<number>();
  const allToNodeArr: number[] = [];
  const allToPointsArr: number[] = [];
  for (let i = 0; i < nodeOrder.length; i++) {
    if (!seenNode.has(nodeOrder[i])) {
      seenNode.add(nodeOrder[i]);
      allToNodeArr.push(nodeOrder[i]);
      allToPointsArr.push(pointOrder[i]);
    }
  }
  const nodeResultLabels = allToNodeArr.map((n) => node.labels[n]);

  // --- Surge protections. ---
  const openStart: number[] = [];
  const openEnd: number[] = [];
  const openArea: number[] = [];
  for (const prot of ss.openProtection.values()) {
    const refs = boundaryAtNode[prot.node];
    const u = refs.find((r) => r.isU);
    const d = refs.find((r) => !r.isU);
    if (u && d) {
      openStart.push(u.point);
      openEnd.push(d.point);
      openArea.push(prot.area);
    }
  }
  const closedStart: number[] = [];
  const closedEnd: number[] = [];
  const closedArea: number[] = [];
  const closedHeight: number[] = [];
  const closedWaterLevel: number[] = [];
  const closedNode: number[] = [];
  for (const prot of ss.closedProtection.values()) {
    const refs = boundaryAtNode[prot.node];
    const u = refs.find((r) => r.isU);
    const d = refs.find((r) => !r.isU);
    if (u && d) {
      closedStart.push(u.point);
      closedEnd.push(d.point);
      closedArea.push(prot.area);
      closedHeight.push(prot.height);
      closedWaterLevel.push(prot.waterLevel);
      closedNode.push(prot.node);
    }
  }

  // --- Check valves. A check valve is a pipe property (EPANET CV pipe or added
  // via the API). It's enforced at one end node of the pipe, reusing the
  // degree-2 series-junction solve: the check sits at an end node that joins
  // exactly two pipes (and isn't a reservoir/tank/valve/pump or already used).
  // It prevents reversal of the through-flow there, i.e. backflow through the
  // pipe. CV pipes that can't be placed (e.g. at a multi-pipe junction) are
  // warned about and left as plain pipes. ---
  const checkStart: number[] = [];
  const checkEnd: number[] = [];
  const usedCheckNode = new Set<number>();
  const nonPipeNode = new Set<number>();
  for (let i = 0; i < valve.n; i++) {
    nonPipeNode.add(valve.startNode[i]);
    nonPipeNode.add(valve.endNode[i]);
  }
  for (let i = 0; i < pump.n; i++) {
    nonPipeNode.add(pump.startNode[i]);
    nonPipeNode.add(pump.endNode[i]);
  }
  const surgeNode = new Set<number>();
  for (const prot of ss.openProtection.values()) surgeNode.add(prot.node);
  for (const prot of ss.closedProtection.values()) surgeNode.add(prot.node);

  const placeCheck = (n: number): boolean => {
    if (
      node.degree[n] !== 2 ||
      node.type[n] === NODE_RESERVOIR ||
      node.type[n] === NODE_TANK ||
      nonPipeNode.has(n) ||
      surgeNode.has(n) ||
      usedCheckNode.has(n)
    ) {
      return false;
    }
    const refs = boundaryAtNode[n];
    const u = refs.find((r) => r.isU);
    const d = refs.find((r) => !r.isU);
    if (!u || !d) return false;
    checkStart.push(u.point);
    checkEnd.push(d.point);
    usedCheckNode.add(n);
    return true;
  };

  for (let p = 0; p < numPipes; p++) {
    if (!pipe.isCheckValve[p]) continue;
    // Prefer the downstream end (disc near the discharge), fall back to upstream.
    if (placeCheck(pipe.endNode[p]) || placeCheck(pipe.startNode[p])) continue;
    warn(
      `check valve on pipe '${pipe.labels[p]}' could not be placed (needs an end node ` +
        `joining exactly two pipes); modeled as a plain pipe`,
    );
  }

  return {
    numPoints,
    B,
    R,
    hasPlus,
    hasMinus,
    initHead,
    initFlow,
    dboundary,
    uboundary,
    numJip,
    ajip: Int32Array.from(ajip),
    jipPoints: Int32Array.from(jipPoints),
    jipNodeOfPoint: Int32Array.from(jipNodeOfPoint),
    jipDboundaries: Int32Array.from(jipDboundaries),
    jipUboundaries: Int32Array.from(jipUboundaries),
    areReservoirs: Int32Array.from(areReservoirs),
    areTanks: Int32Array.from(areTanks),
    singleValvePoints: Int32Array.from(singleValvePoints),
    singleValveCtx: Int32Array.from(singleValveCtx),
    startValvePoints: Int32Array.from(startValvePoints),
    endValvePoints: Int32Array.from(endValvePoints),
    startValveCtx: Int32Array.from(startValveCtx),
    singlePumpPoints: Int32Array.from(singlePumpPoints),
    singlePumpCtx: Int32Array.from(singlePumpCtx),
    startPumpPoints: Int32Array.from(startPumpPoints),
    endPumpPoints: Int32Array.from(endPumpPoints),
    startPumpCtx: Int32Array.from(startPumpCtx),
    numResultNodes: allToNodeArr.length,
    allToPoints: Int32Array.from(allToPointsArr),
    allToNode: Int32Array.from(allToNodeArr),
    nodeResultLabels,
    openStart: Int32Array.from(openStart),
    openEnd: Int32Array.from(openEnd),
    openArea: Float64Array.from(openArea),
    closedStart: Int32Array.from(closedStart),
    closedEnd: Int32Array.from(closedEnd),
    closedArea: Float64Array.from(closedArea),
    closedHeight: Float64Array.from(closedHeight),
    closedWaterLevel: Float64Array.from(closedWaterLevel),
    closedNode: Int32Array.from(closedNode),
    checkStart: Int32Array.from(checkStart),
    checkEnd: Int32Array.from(checkEnd),
  };
}

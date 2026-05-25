/**
 * Result recorder: decouples result storage from the compute kernels.
 *
 * Supports recording a subset of elements, time downsampling, and O(elements)
 * min/max envelopes, so large/long simulations don't have to hold a full
 * (elements × steps) matrix in memory. Defaults reproduce the original
 * "every element, every step" behaviour exactly.
 */
import { SteadyState } from './types';
import { EngineModel } from './serialModel';
import {
  ResultSeries,
  SimulationResults,
  RecordingOptions,
  Envelope,
  PipeProfile,
} from './results';

function resolveRows(
  option: string[] | 'all' | 'none' | undefined,
  count: number,
  labelToRow: (label: string) => number | undefined,
  kind: string,
): Int32Array {
  if (option === undefined || option === 'all') {
    return Int32Array.from({ length: count }, (_, i) => i);
  }
  if (option === 'none') return new Int32Array(0);
  const rows = option.map((label) => {
    const r = labelToRow(label);
    if (r === undefined) throw new Error(`unknown ${kind} '${label}' in recording selection`);
    return r;
  });
  return Int32Array.from(rows);
}

export class Recorder {
  private readonly recCols: number;
  private readonly every: number;
  private readonly recNodeRows: Int32Array; // result-node indices to record
  private readonly recPipeRows: Int32Array; // pipe indices to record
  private readonly numJip: number;

  readonly time: Float64Array;
  readonly results: SimulationResults;
  readonly envelope?: Envelope;
  readonly pipeProfile?: PipeProfile;

  constructor(
    private readonly model: EngineModel,
    private readonly ss: SteadyState,
    timeSteps: number,
    timeStep: number,
    options: RecordingOptions = {},
  ) {
    this.numJip = model.numJip;
    this.every = Math.max(1, Math.floor(options.every ?? 1));
    this.recCols = Math.floor((timeSteps - 1) / this.every) + 1;

    const nodeLabelToRow = new Map(model.nodeResultLabels.map((l, i) => [l, i]));
    this.recNodeRows = resolveRows(
      options.nodes,
      model.numResultNodes,
      (l) => nodeLabelToRow.get(l),
      'node',
    );
    this.recPipeRows = resolveRows(
      options.pipes,
      ss.pipe.n,
      (l) => ss.pipe.index.get(l),
      'pipe',
    );

    this.time = new Float64Array(this.recCols);
    for (let c = 0; c < this.recCols; c++) this.time[c] = c * this.every * timeStep;

    const nodeLabels = Array.from(this.recNodeRows, (r) => model.nodeResultLabels[r]);
    const pipeLabels = Array.from(this.recPipeRows, (p) => ss.pipe.labels[p]);
    this.results = {
      node: {
        head: new ResultSeries(nodeLabels, this.recCols),
        leakFlow: new ResultSeries(nodeLabels, this.recCols),
        demandFlow: new ResultSeries(nodeLabels, this.recCols),
      },
      pipeStart: { flowrate: new ResultSeries(pipeLabels, this.recCols) },
      pipeEnd: { flowrate: new ResultSeries(pipeLabels, this.recCols) },
    };

    if (options.envelope) {
      const nn = model.numResultNodes;
      const np = ss.pipe.n;
      this.envelope = {
        node: {
          labels: model.nodeResultLabels.slice(),
          headMin: new Float64Array(nn).fill(Infinity),
          headMax: new Float64Array(nn).fill(-Infinity),
        },
        pipe: {
          labels: ss.pipe.labels.slice(),
          startMin: new Float64Array(np).fill(Infinity),
          startMax: new Float64Array(np).fill(-Infinity),
          endMin: new Float64Array(np).fill(Infinity),
          endMax: new Float64Array(np).fill(-Infinity),
        },
      };
    }

    if (options.pipeProfileHead) {
      const numPoints = model.numPoints;
      // Points are laid out pipe by pipe (buildEngineModel): pipe p owns the
      // contiguous range [dboundary[p] .. uboundary[p]] = segments[p]+1 points.
      const pipeProfile: PipeProfile = {
        labels: ss.pipe.labels.slice(),
        offset: Int32Array.from(model.dboundary),
        segments: Int32Array.from({ length: ss.pipe.n }, (_, p) => model.uboundary[p] - model.dboundary[p]),
        numPoints,
        cols: this.recCols,
        data: new Float64Array(numPoints * this.recCols),
      };
      this.pipeProfile = pipeProfile;
      this.results.pipeProfile = pipeProfile; // surface via sim.results
    }
  }

  private colOf(t: number): number {
    return t % this.every === 0 ? t / this.every : -1;
  }

  /**
   * Record one step.
   * @param e1 leak flow per jip node, or `null` for the initial conditions
   *           (t=0), where leak/demand come from the steady-state coefficients.
   */
  record(t: number, head: Float64Array, flow: Float64Array, e1: Float64Array | null, d1: Float64Array | null): void {
    const { model, ss } = this;

    if (this.envelope) {
      const env = this.envelope;
      for (let r = 0; r < model.numResultNodes; r++) {
        const h = head[model.allToPoints[r]];
        if (h < env.node.headMin[r]) env.node.headMin[r] = h;
        if (h > env.node.headMax[r]) env.node.headMax[r] = h;
      }
      for (let p = 0; p < ss.pipe.n; p++) {
        const qs = flow[model.dboundary[p]];
        const qe = flow[model.uboundary[p]];
        if (qs < env.pipe.startMin[p]) env.pipe.startMin[p] = qs;
        if (qs > env.pipe.startMax[p]) env.pipe.startMax[p] = qs;
        if (qe < env.pipe.endMin[p]) env.pipe.endMin[p] = qe;
        if (qe > env.pipe.endMax[p]) env.pipe.endMax[p] = qe;
      }
    }

    const col = this.colOf(t);
    if (col < 0) return;

    if (this.pipeProfile) {
      // `head` is the full length-numPoints column; store it as this step's block.
      this.pipeProfile.data.set(head, col * this.pipeProfile.numPoints);
    }

    const { head: headSeries, leakFlow, demandFlow } = this.results.node;
    for (let i = 0; i < this.recNodeRows.length; i++) {
      const r = this.recNodeRows[i];
      headSeries.set(i, col, head[model.allToPoints[r]]);
      if (e1 === null) {
        const nodeId = model.allToNode[r];
        const sqrtP = ss.node.pressure[nodeId] > 0 ? Math.sqrt(ss.node.pressure[nodeId]) : 0;
        leakFlow.set(i, col, ss.node.leakCoefficient[nodeId] * sqrtP);
        demandFlow.set(i, col, ss.node.demandCoefficient[nodeId] * sqrtP);
      } else if (r < this.numJip) {
        leakFlow.set(i, col, e1[r]);
        demandFlow.set(i, col, d1![r]);
      }
    }

    const pstart = this.results.pipeStart.flowrate;
    const pend = this.results.pipeEnd.flowrate;
    for (let i = 0; i < this.recPipeRows.length; i++) {
      const p = this.recPipeRows[i];
      pstart.set(i, col, flow[model.dboundary[p]]);
      pend.set(i, col, flow[model.uboundary[p]]);
    }
  }
}

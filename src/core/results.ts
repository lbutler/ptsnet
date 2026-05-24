/** Labeled time-series results (rows = elements, cols = time steps). */
export class ResultSeries {
  readonly labels: string[];
  readonly rows: number;
  readonly cols: number;
  /** Row-major matrix of size rows*cols. */
  readonly data: Float64Array;
  private readonly index: Map<string, number>;

  constructor(labels: string[], cols: number) {
    this.labels = labels;
    this.rows = labels.length;
    this.cols = cols;
    this.data = new Float64Array(this.rows * cols);
    this.index = new Map();
    labels.forEach((l, i) => this.index.set(l, i));
  }

  /** Set the value for element row `r` at time step `t`. */
  set(r: number, t: number, value: number): void {
    this.data[r * this.cols + t] = value;
  }

  /** Time series (length = cols) for the element labeled `label`. */
  get(label: string): Float64Array {
    const r = this.index.get(label);
    if (r === undefined) throw new Error(`unknown label '${label}'`);
    return this.data.subarray(r * this.cols, (r + 1) * this.cols);
  }

  /** Value for `label` at time step `t`. */
  at(label: string, t: number): number {
    const r = this.index.get(label);
    if (r === undefined) throw new Error(`unknown label '${label}'`);
    return this.data[r * this.cols + t];
  }

  has(label: string): boolean {
    return this.index.has(label);
  }
}

export interface NodeResults {
  head: ResultSeries;
  leakFlow: ResultSeries;
  demandFlow: ResultSeries;
}

export interface PipeResults {
  flowrate: ResultSeries;
}

export interface SimulationResults {
  node: NodeResults;
  pipeStart: PipeResults;
  pipeEnd: PipeResults;
}

// --- Serialization (JSON-safe; replaces the Python HDF5 workspaces) ---

export interface SerializedSeries {
  labels: string[];
  cols: number;
  data: number[];
}

export interface SerializedResults {
  time: number[];
  node: { head: SerializedSeries; leakFlow: SerializedSeries; demandFlow: SerializedSeries };
  pipeStart: { flowrate: SerializedSeries };
  pipeEnd: { flowrate: SerializedSeries };
}

function seriesToJSON(s: ResultSeries): SerializedSeries {
  return { labels: s.labels, cols: s.cols, data: Array.from(s.data) };
}

function seriesFromJSON(o: SerializedSeries): ResultSeries {
  const s = new ResultSeries(o.labels, o.cols);
  s.data.set(o.data);
  return s;
}

/** Convert results + time stamps into a JSON-serializable object. */
export function serializeResults(results: SimulationResults, time: Float64Array): SerializedResults {
  return {
    time: Array.from(time),
    node: {
      head: seriesToJSON(results.node.head),
      leakFlow: seriesToJSON(results.node.leakFlow),
      demandFlow: seriesToJSON(results.node.demandFlow),
    },
    pipeStart: { flowrate: seriesToJSON(results.pipeStart.flowrate) },
    pipeEnd: { flowrate: seriesToJSON(results.pipeEnd.flowrate) },
  };
}

/** Reconstruct results + time stamps from `serializeResults` output. */
export function deserializeResults(obj: SerializedResults): {
  results: SimulationResults;
  time: Float64Array;
} {
  return {
    time: Float64Array.from(obj.time),
    results: {
      node: {
        head: seriesFromJSON(obj.node.head),
        leakFlow: seriesFromJSON(obj.node.leakFlow),
        demandFlow: seriesFromJSON(obj.node.demandFlow),
      },
      pipeStart: { flowrate: seriesFromJSON(obj.pipeStart.flowrate) },
      pipeEnd: { flowrate: seriesFromJSON(obj.pipeEnd.flowrate) },
    },
  };
}

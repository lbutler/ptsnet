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

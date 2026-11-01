/**
 * GraphLayout (P4-T2): classic active-lanes commit-graph layout. Streaming —
 * appendPage() carries lane state across pages so infinite scroll keeps
 * topology. Pure and vscode-free; golden-ASCII tested.
 *
 * Row anatomy (top → bottom of one row):
 *   lanesBefore: vertical lines entering the row
 *   joins:       child lanes bending INTO this row's node (their line ends)
 *   node:        the commit dot at nodeLane
 *   forks:       node connecting DOWN to parent lanes (first parent usually
 *                stays in nodeLane; extra parents branch to other lanes)
 *   continues:   uninvolved lanes passing straight through
 */
import { ColorAllocator } from './colors';

export interface GraphInputCommit {
  sha: string;
  parents: string[];
}

export interface LaneRef {
  lane: number;
  colorIdx: number;
}

export interface ForkRef extends LaneRef {
  /** 'first' = first-parent continuation; 'extra' = merge's other parents. */
  kind: 'first' | 'extra';
  /** Extra fork connected into an ALREADY-active lane (vs a newborn lane). */
  joinsExisting?: boolean;
}

export interface GraphRow {
  sha: string;
  nodeLane: number;
  colorIdx: number;
  lanesBefore: LaneRef[];
  joins: LaneRef[];
  forks: ForkRef[];
  continues: LaneRef[];
}

interface ActiveLane {
  expects: string;
  colorIdx: number;
}

export class GraphLayout {
  private lanes: Array<ActiveLane | undefined> = [];
  private readonly colors = new ColorAllocator();
  private maxLanes = 0;

  get laneCount(): number {
    return this.maxLanes;
  }

  reset(): void {
    this.lanes = [];
    this.colors.reset();
    this.maxLanes = 0;
  }

  appendPage(commits: readonly GraphInputCommit[]): GraphRow[] {
    const rows: GraphRow[] = [];
    for (const commit of commits) {
      rows.push(this.appendCommit(commit));
    }
    return rows;
  }

  private appendCommit(commit: GraphInputCommit): GraphRow {
    const lanesBefore: LaneRef[] = [];
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      if (lane) lanesBefore.push({ lane: i, colorIdx: lane.colorIdx });
    }

    // Lanes whose expected commit is this one (children converging here).
    const incoming: number[] = [];
    for (let i = 0; i < this.lanes.length; i++) {
      if (this.lanes[i]?.expects === commit.sha) incoming.push(i);
    }

    let nodeLane: number;
    let colorIdx: number;
    if (incoming.length === 0) {
      // A tip: nothing expected it — new lane, new color.
      nodeLane = this.firstFreeLane();
      colorIdx = this.colors.allocate();
      this.ensureLane(nodeLane);
    } else {
      nodeLane = incoming[0] as number;
      colorIdx = (this.lanes[nodeLane] as ActiveLane).colorIdx;
    }

    const joins: LaneRef[] = incoming
      .slice(1)
      .map((lane) => ({ lane, colorIdx: (this.lanes[lane] as ActiveLane).colorIdx }));
    // Joined lanes end at this node.
    for (const j of joins) this.lanes[j.lane] = undefined;

    const forks: ForkRef[] = [];
    const [firstParent, ...extraParents] = commit.parents;

    if (firstParent === undefined) {
      // Root commit: the lane closes.
      this.lanes[nodeLane] = undefined;
    } else {
      this.lanes[nodeLane] = { expects: firstParent, colorIdx };
      forks.push({ lane: nodeLane, colorIdx, kind: 'first' });
    }

    for (const parent of extraParents) {
      // Join an existing lane already waiting for this parent, else open one.
      const existing = this.lanes.findIndex((l, i) => l?.expects === parent && i !== nodeLane);
      if (existing !== -1) {
        forks.push({
          lane: existing,
          colorIdx: (this.lanes[existing] as ActiveLane).colorIdx,
          kind: 'extra',
          joinsExisting: true,
        });
      } else {
        const lane = this.firstFreeLane();
        this.ensureLane(lane);
        const parentColor = this.colors.allocate();
        this.lanes[lane] = { expects: parent, colorIdx: parentColor };
        forks.push({ lane, colorIdx: parentColor, kind: 'extra', joinsExisting: false });
      }
    }

    const involved = new Set<number>([nodeLane, ...incoming, ...forks.map((f) => f.lane)]);
    const continues: LaneRef[] = [];
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      if (lane && !involved.has(i)) continues.push({ lane: i, colorIdx: lane.colorIdx });
    }

    this.trimTrailing();
    this.maxLanes = Math.max(this.maxLanes, this.lanes.length, nodeLane + 1);

    return { sha: commit.sha, nodeLane, colorIdx, lanesBefore, joins, forks, continues };
  }

  /**
   * Passes over a commit the view leaves out (a merge, under No Merges)
   * without drawing a row for it. Whatever was waiting for it waits for its
   * first parent instead, so the line runs on to the next commit shown rather
   * than down to the bottom of the log looking for one that never comes. Its
   * other parents are not drawn into: they arrive as tips, which is what a
   * merged branch looks like once its merge is out of the picture.
   */
  hide(commit: GraphInputCommit): void {
    const [firstParent] = commit.parents;
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      if (lane?.expects !== commit.sha) continue;
      this.lanes[i] = firstParent === undefined ? undefined : { expects: firstParent, colorIdx: lane.colorIdx };
    }
    this.trimTrailing();
  }

  private firstFreeLane(): number {
    for (let i = 0; i < this.lanes.length; i++) {
      if (this.lanes[i] === undefined) return i;
    }
    return this.lanes.length;
  }

  private ensureLane(index: number): void {
    while (this.lanes.length <= index) this.lanes.push(undefined);
  }

  private trimTrailing(): void {
    while (this.lanes.length > 0 && this.lanes[this.lanes.length - 1] === undefined) {
      this.lanes.pop();
    }
  }
}

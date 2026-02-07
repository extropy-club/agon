import { Agent } from "agents";
import { makeRuntime, type Runtime } from "../runtime.js";
import type { Env } from "../index.js";

export type TurnParams = {
  readonly roomId: number;
  readonly agentId: number;
  readonly turnNumber: number;
};

export class TurnAgent extends Agent<Env> {
  private _runtime: Runtime | undefined;

  getRuntime(): Runtime {
    if (!this._runtime) {
      this._runtime = makeRuntime(this.env);
    }
    return this._runtime;
  }

  async startTurn(params: TurnParams): Promise<string> {
    return this.runWorkflow("TURN_WORKFLOW", params);
  }
}

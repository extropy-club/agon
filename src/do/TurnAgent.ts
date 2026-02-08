import { Agent } from "agents";
import { makeRuntime, type Runtime } from "../runtime.js";
import type { Env } from "../index.js";

export type TurnParams = {
  readonly roomId: number;
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
    const baseId = `turn-${params.roomId}-${params.turnNumber}`;

    // Try the canonical ID first; on conflict, append a unique suffix.
    for (let attempt = 0; attempt < 3; attempt++) {
      const workflowId = attempt === 0 ? baseId : `${baseId}-${Date.now()}`;
      try {
        const result = await this.runWorkflow("TURN_WORKFLOW", params, {
          id: workflowId,
        });
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already_exists") && attempt < 2) {
          console.warn(
            `[TurnAgent] Workflow ${workflowId} already exists, retrying with unique suffix`,
          );
          continue;
        }
        console.error(
          `[TurnAgent] startTurn FAILED roomId=${params.roomId} turn=${params.turnNumber}:`,
          msg,
        );
        throw e;
      }
    }

    throw new Error(
      `[TurnAgent] exhausted retries for roomId=${params.roomId} turn=${params.turnNumber}`,
    );
  }
}

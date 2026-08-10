import path from "node:path";
import {fileURLToPath} from "node:url";

import {assertJsonSchema} from "./json_schema_contract.mjs";
import {nowIso, writeJson} from "./interview_explainer_common.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.resolve(SCRIPT_DIR, "..", "schemas", "media-operation-run.v1.schema.json");

export function createOperationRun(profile, command) {
  const started = Date.now();
  return {
    profile,
    command,
    started,
    attempts: 1,
    steps: [],
    addStep(id, status, elapsedMs, attempts = 1) {
      this.steps.push({id, status, elapsed_ms: Math.max(0, Math.round(elapsedMs)), attempts});
    },
    finish(outputPath, status = "completed") {
      const rendered = this.steps.filter((item) => item.status === "rendered").length;
      const reused = this.steps.filter((item) => item.status === "reused").length;
      const receipt = {
        protocol: "visual-multimedia-media-operation-run",
        version: 1,
        profile: this.profile,
        command: this.command,
        status,
        started_at: new Date(this.started).toISOString(),
        completed_at: nowIso(),
        elapsed_ms: Math.max(0, Date.now() - this.started),
        attempts: this.attempts,
        cache: {rendered, reused},
        steps: this.steps,
      };
      assertJsonSchema(receipt, SCHEMA, "媒体操作耗时记录");
      writeJson(outputPath, receipt);
      return receipt;
    },
  };
}

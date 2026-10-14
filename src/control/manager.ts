import {
  listRuns,
  getRun,
  takeoverRun,
  resumeRun,
  abortRun,
  durableRuns,
  acknowledgeInterruptedRun,
} from '../registry.js';
import type { OperatorManager } from './operator-server.js';
import { requirePermission } from './access.js';
const controlling = new Set<string>();
export const operatorManager: OperatorManager = {
  list: () => {
    const records = durableRuns();
    const live = listRuns()
      .filter(
        (r) =>
          !['interrupted', 'closed'].includes(
            records.find((record) => record.runId === r.runId)?.state ?? '',
          ),
      )
      .map((r) => ({
        runId: r.runId,
        capability: r.capabilityId,
        tenant: r.tenant,
        state:
          r.result?.status === 'escalated'
            ? r.engine.session.state
            : (r.result?.status ?? r.engine.session.state),
        epoch: r.engine.session.epoch,
        owner: r.engine.session.owner,
        reason: r.engine.session.reason,
        stepId: r.engine.capability.steps[r.engine.stepIndex]?.id,
      }));
    return [
      ...live,
      ...records
        .filter((r) => !live.some((entry) => entry.runId === r.runId))
        .map((r) => ({
          runId: r.runId,
          capability: r.capabilityId,
          tenant: r.tenant,
          state: r.state,
          epoch: 0,
          owner: 'none',
          reason: r.code,
        })),
    ];
  },
  control: async (runId, command, expectedEpoch, principal) => {
    const record = durableRuns().find((entry) => entry.runId === runId);
    if (!record) throw new Error('RUN_NOT_FOUND');
    requirePermission(principal, record.tenant, command === 'resolve' ? 'resolve' : 'control');
    // Abort remains available while a long resume is running. Other ownership
    // changes are exclusive so two requests cannot reconcile the same checkpoint.
    const exclusive = command !== 'abort';
    if (exclusive && controlling.has(runId)) throw new Error('CONTROL_IN_PROGRESS');
    if (exclusive) controlling.add(runId);
    try {
      if (command === 'resolve') {
        if (expectedEpoch !== 0) throw new Error('STALE_CONTROL_EPOCH');
        acknowledgeInterruptedRun(runId, principal.id);
        return;
      }
      if (durableRuns().find((r) => r.runId === runId)?.state === 'interrupted')
        throw new Error('SESSION_LOST');
      if (getRun(runId).engine.session.epoch !== expectedEpoch)
        throw new Error('STALE_CONTROL_EPOCH');
      if (command === 'takeover') await takeoverRun(runId);
      else if (command === 'resume') await resumeRun(runId);
      else await abortRun(runId);
    } finally {
      if (exclusive) controlling.delete(runId);
    }
  },
};

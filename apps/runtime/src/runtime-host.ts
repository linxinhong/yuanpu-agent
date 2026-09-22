import type {
  AgentService,
  AuthenticatedAgentCaller,
} from '@yuanpu-agent/runtime-kit';
import type { AgentRunRecord } from '@yuanpu-agent/protocol';

export async function getDesktopNavigableRun(
  agent: Pick<AgentService, 'get'>,
  runId: string,
  desktopCaller: AuthenticatedAgentCaller,
  schedulerCaller: AuthenticatedAgentCaller,
): Promise<AgentRunRecord | undefined> {
  return await agent.get(desktopCaller, runId)
    ?? await agent.get(schedulerCaller, runId);
}

export interface RuntimeCleanupResources {
  closeChannels?(): Promise<void>;
  closeScheduler(): Promise<void>;
  closeNotificationRouter(): void;
  closeAgentService(): Promise<void>;
  closePythonSource?(): Promise<void>;
  closeMetadata(): void;
}

export async function cleanupRuntimeResources(resources: RuntimeCleanupResources): Promise<void> {
  const failures: unknown[] = [];
  const channelResults = await Promise.allSettled([
    ...(resources.closeChannels
      ? [Promise.resolve().then(() => resources.closeChannels!())]
      : []),
  ]);
  failures.push(...channelResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason));

  const [schedulerResult] = await Promise.allSettled([
    Promise.resolve().then(() => resources.closeScheduler()),
  ]);
  if (schedulerResult?.status === 'rejected') failures.push(schedulerResult.reason);

  const closeResults = await Promise.allSettled([
    Promise.resolve().then(() => resources.closeNotificationRouter()),
    Promise.resolve().then(() => resources.closeAgentService()),
    ...(resources.closePythonSource
      ? [Promise.resolve().then(() => resources.closePythonSource!())]
      : []),
  ]);
  failures.push(...closeResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason));

  try {
    resources.closeMetadata();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Runtime cleanup did not complete cleanly.');
  }
}

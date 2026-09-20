import type {
  QueueItemResponse,
  QueueListResponse,
  RunResponse,
} from "../../../shared/api-schemas.js";

export function getCurrentRunId(queue: QueueListResponse): string | null {
  return (
    queue.data.find((item) => item.local_run_id && isLiveQueueState(item.state))
      ?.local_run_id ?? null
  );
}

export function isLiveQueueState(state: QueueItemResponse["state"]): boolean {
  return (
    state === "queued" ||
    state === "dispatching" ||
    state === "accepted" ||
    state === "reconciling"
  );
}

export function isLiveRun(run: RunResponse | null): boolean {
  if (!run) return false;
  return (
    run.local_state === "submitting" ||
    run.local_state === "accepted" ||
    run.local_state === "reconciling" ||
    run.upstream_status === "queued" ||
    run.upstream_status === "running" ||
    run.upstream_status === "waiting_for_approval" ||
    run.upstream_status === "stopping"
  );
}

export function getPrimaryQueueItem(
  queue: QueueListResponse | null,
  activeRun: RunResponse | null,
): QueueItemResponse | null {
  if (!queue) return null;

  if (activeRun && isLiveRun(activeRun)) {
    const activeItem = queue.data.find(
      (item) => item.id === activeRun.queue_item_id,
    );
    if (activeItem) return activeItem;
  }

  return queue.data.find((item) => isLiveQueueState(item.state)) ?? null;
}

export function getQueuedFollowUps(
  queue: QueueListResponse | null,
  activeRun: RunResponse | null,
): QueueItemResponse[] {
  const primaryItem = getPrimaryQueueItem(queue, activeRun);
  if (!queue || !primaryItem) return [];
  return queue.data.filter(
    (item) => item.id !== primaryItem.id && item.state === "queued",
  );
}

export function isAgentGenerating(
  activeRun: RunResponse | null,
  queue: QueueListResponse | null,
): boolean {
  return isLiveRun(activeRun) || getPrimaryQueueItem(queue, activeRun) !== null;
}

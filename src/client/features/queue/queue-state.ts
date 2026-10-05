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

  const executing = queue.data.find(
    (item) => item.state !== "queued" && isLiveQueueState(item.state),
  );
  return (
    executing ??
    (!queue.paused
      ? (queue.data.find((item) => item.state === "queued") ?? null)
      : null)
  );
}

export function getQueuedFollowUps(
  queue: QueueListResponse | null,
  activeRun: RunResponse | null,
): QueueItemResponse[] {
  const primaryItem = getPrimaryQueueItem(queue, activeRun);
  if (!queue) return [];
  return queue.data.filter(
    (item) => item.id !== primaryItem?.id && item.state === "queued",
  );
}

export function isAgentGenerating(
  activeRun: RunResponse | null,
  queue: QueueListResponse | null,
): boolean {
  const primary = getPrimaryQueueItem(queue, activeRun);
  return (
    isLiveRun(activeRun) || (primary !== null && primary.state !== "queued")
  );
}

export function getRunActivityLabel(
  run: RunResponse | null,
  queue: QueueListResponse | null,
): string | undefined {
  if (isLiveRun(run)) {
    if (run?.upstream_status === "stopping") return "正在停止当前任务…";
    if (run?.upstream_status === "waiting_for_approval") return "等待工具审批…";
    return undefined;
  }
  if (getPrimaryQueueItem(queue, run)?.state === "queued")
    return "等待派发消息…";
  return undefined;
}

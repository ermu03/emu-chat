export type QueueItemState =
  | 'queued'
  | 'dispatching'
  | 'accepted'
  | 'reconciling'
  | 'done'
  | 'paused'
  | 'review_required'
  | 'rejected'
  | 'cancelled';

export const QUEUE_STATE_TRANSITIONS: Record<QueueItemState, readonly QueueItemState[]> = {
  queued: ['dispatching', 'paused', 'cancelled'],
  dispatching: ['accepted', 'rejected', 'paused', 'review_required', 'cancelled'],
  accepted: ['reconciling', 'paused', 'review_required'],
  reconciling: ['done', 'paused', 'review_required'],
  paused: ['queued', 'cancelled'],
  review_required: ['queued', 'cancelled'],
  rejected: [],
  cancelled: [],
  done: [],
} as const;

export function canTransitionQueueState(
  from: QueueItemState,
  to: QueueItemState
): boolean {
  if (from === to) return true;
  const allowed = QUEUE_STATE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function assertQueueTransition(
  from: QueueItemState,
  to: QueueItemState
): void {
  if (!canTransitionQueueState(from, to)) {
    throw new Error(`Invalid queue state transition from '${from}' to '${to}'`);
  }
}

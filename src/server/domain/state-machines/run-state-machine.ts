export type RunLocalState =
  | 'submitting'
  | 'accepted'
  | 'reconciling'
  | 'reconciled'
  | 'rejected'
  | 'review_required';

export const RUN_STATE_TRANSITIONS: Record<RunLocalState, readonly RunLocalState[]> = {
  submitting: ['accepted', 'rejected', 'review_required'],
  accepted: ['reconciling', 'review_required'],
  reconciling: ['reconciled', 'review_required'],
  reconciled: [],
  rejected: [],
  review_required: [],
} as const;

export function canTransitionRunState(
  from: RunLocalState,
  to: RunLocalState
): boolean {
  if (from === to) return true;
  const allowed = RUN_STATE_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export function assertRunTransition(
  from: RunLocalState,
  to: RunLocalState
): void {
  if (!canTransitionRunState(from, to)) {
    throw new Error(`Invalid run state transition from '${from}' to '${to}'`);
  }
}

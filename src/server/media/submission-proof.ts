import type Database from "better-sqlite3";
import type { QueueItemEntity } from "../db/schema-types.js";
import { AttachmentRefsSchema } from "../../shared/media-schemas.js";
import { parseMediaRunInput, sha256 } from "./manifest.js";

type SubmissionProof = Omit<
  NonNullable<ReturnType<typeof parseMediaRunInput>>,
  "displayText"
>;

export function hasSubmissionProof(
  db: Database.Database,
  proof: SubmissionProof,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM media_submission_proofs
    WHERE conversation_id=? AND operation_id=? AND session_id=?
      AND asset_ids_json=? AND user_text_sha256=? AND run_input_sha256=?`,
      )
      .get(
        proof.scopeId,
        proof.operationId,
        proof.sessionId,
        JSON.stringify(proof.assetIds),
        proof.userTextSha256,
        proof.runInputSha256,
      ),
  );
}

/** Only callers with a frozen local request or a verified plugin binding write proofs. */
export function recordSubmissionProof(
  db: Database.Database,
  proof: SubmissionProof,
  queueReferenceId?: string,
): boolean {
  db.prepare(
    `INSERT INTO media_submission_proofs
    (conversation_id,operation_id,session_id,asset_ids_json,user_text_sha256,run_input_sha256,queue_reference_id,created_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(conversation_id,operation_id) DO NOTHING`,
  ).run(
    proof.scopeId,
    proof.operationId,
    proof.sessionId,
    JSON.stringify(proof.assetIds),
    proof.userTextSha256,
    proof.runInputSha256,
    queueReferenceId ?? null,
    new Date().toISOString(),
  );
  // An operation's binding is immutable; a conflicting request cannot replace it.
  if (!hasSubmissionProof(db, proof)) return false;
  if (queueReferenceId)
    db.prepare(
      `UPDATE media_submission_proofs
      SET queue_reference_id=COALESCE(queue_reference_id,?)
      WHERE conversation_id=? AND operation_id=?`,
    ).run(queueReferenceId, proof.scopeId, proof.operationId);
  return true;
}

/** Backfill legacy rows before text is removed, checking the saved queue fingerprint. */
export function preserveFrozenSubmissionProof(
  db: Database.Database,
  item: QueueItemEntity,
): boolean {
  if (!item.payload_run_input) return false;
  const parsed = parseMediaRunInput(item.payload_run_input);
  if (
    !parsed ||
    parsed.scopeId !== item.conversation_id ||
    parsed.operationId !== item.operation_id ||
    parsed.sessionId !== item.dispatch_session_id
  )
    return false;
  let attachments;
  try {
    attachments = AttachmentRefsSchema.safeParse(
      JSON.parse(item.payload_attachments_json),
    );
  } catch {
    return false;
  }
  if (
    !attachments.success ||
    !attachments.data.length ||
    JSON.stringify(attachments.data.map((ref) => ref.asset_id)) !==
      JSON.stringify(parsed.assetIds) ||
    (item.payload_text !== null && item.payload_text !== parsed.displayText)
  )
    return false;
  const fingerprint = JSON.stringify({
    version: 1,
    text: parsed.displayText,
    attachments: attachments.data,
  });
  if (sha256(fingerprint) !== item.payload_sha256) return false;
  return recordSubmissionProof(db, parsed, `ref_queue_${item.id}`);
}

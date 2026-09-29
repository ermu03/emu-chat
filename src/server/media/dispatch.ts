import type Database from "better-sqlite3";
import type { QueueItemEntity } from "../db/schema-types.js";
import { StateConflictError } from "../domain/errors.js";
import type { AttachmentRef } from "../../shared/media-schemas.js";
import { MediaClient } from "./client.js";
import { makeMediaRunInput } from "./manifest.js";

/** The queue row is the durable control record; this preparation is idempotent. */
export class MediaDispatchService {
  constructor(
    private readonly db: Database.Database,
    private readonly client: MediaClient,
  ) {}

  async prepare(item: QueueItemEntity): Promise<string> {
    if (
      item.payload_text === null ||
      !item.dispatch_session_id ||
      item.state !== "dispatching"
    )
      throw new StateConflictError("Image queue payload is not dispatchable");
    const attachments = JSON.parse(
      item.payload_attachments_json,
    ) as AttachmentRef[];
    if (!attachments.length) return item.payload_text;
    const manifest = makeMediaRunInput({
      scopeId: item.conversation_id,
      operationId: item.operation_id,
      sessionId: item.dispatch_session_id,
      userText: item.payload_text,
      attachments,
    });
    if (item.payload_run_input && item.payload_run_input !== manifest.runInput)
      throw new StateConflictError(
        "Frozen image request does not match the queue payload",
      );

    await this.client.registerSession(
      item.conversation_id,
      item.dispatch_session_id,
    );
    for (const attachment of attachments) {
      const asset = await this.client.getAsset(
        item.conversation_id,
        attachment.asset_id,
      );
      if (asset.status !== "ready" || asset.sha256 !== attachment.sha256)
        throw new StateConflictError(
          "Image attachment is unavailable or changed",
        );
    }
    await this.client.putReference(
      item.conversation_id,
      `ref_queue_${item.id}`,
      {
        version: 1,
        kind: "queue",
        revision: 0,
        session_id: item.dispatch_session_id,
        asset_ids: attachments.map((attachment) => attachment.asset_id),
      },
    );
    await this.client.bindSubmission(item.conversation_id, item.operation_id, {
      version: 1,
      session_id: item.dispatch_session_id,
      asset_ids: attachments.map((attachment) => attachment.asset_id),
      user_text_sha256: manifest.userTextSha256,
      run_input_sha256: manifest.runInputSha256,
    });
    const result = this.db
      .prepare(
        `
      UPDATE queue_items SET payload_run_input=?,media_state='ready'
      WHERE id=? AND state='dispatching' AND dispatch_session_id=?
        AND (payload_run_input IS NULL OR payload_run_input=?)
    `,
      )
      .run(
        manifest.runInput,
        item.id,
        item.dispatch_session_id,
        manifest.runInput,
      );
    if (result.changes !== 1)
      throw new StateConflictError("Image queue item changed before dispatch");
    return manifest.runInput;
  }
}

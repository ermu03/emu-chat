import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ConversationRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { MediaBranchService } from "../../src/server/media/branch.js";
import { makeMediaRunInput } from "../../src/server/media/manifest.js";
import type { MediaClient } from "../../src/server/media/client.js";
import type { HermesAdapter } from "../../src/server/hermes/adapter.js";

describe("media branch recovery", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  const conversations = new ConversationRepository(db);
  conversations.insert({
    id: "cv_source",
    hermes_profile: "default",
    hermes_session_id: "ses_source",
  });
  conversations.insert({
    id: "cv_target",
    hermes_profile: "default",
    hermes_session_id: "ses_target",
  });
  afterEach(() => db.close());

  it("retains the source until copied image ownership survives a failed grant and retry", async () => {
    const input = makeMediaRunInput({
      scopeId: "cv_source",
      operationId: "op_input",
      sessionId: "ses_source",
      userText: "edit",
      attachments: [{ asset_id: "asset_input", sha256: "a".repeat(64) }],
    });
    const toolContent = JSON.stringify({
      success: true,
      image: "/cache/result.png",
    });
    const messages = {
      ses_source: [
        {
          id: 11,
          session_id: "ses_source",
          role: "user",
          content: input.runInput,
          timestamp: 1,
        },
        {
          id: 12,
          session_id: "ses_source",
          role: "tool",
          content: toolContent,
          tool_name: "image_generate",
          tool_call_id: "call_image",
          timestamp: 2,
        },
      ],
      ses_target: [
        {
          id: 21,
          session_id: "ses_target",
          role: "user",
          content: input.runInput,
          timestamp: 1,
        },
        {
          id: 22,
          session_id: "ses_target",
          role: "tool",
          content: toolContent,
          tool_name: "image_generate",
          tool_call_id: "call_image",
          timestamp: 2,
        },
      ],
    };
    const hermes = {
      getSessionMessages: vi.fn(
        async (
          session: keyof typeof messages,
          query: { offset: number; limit: number },
        ) => ({
          messages: messages[session].slice(
            query.offset,
            query.offset + query.limit,
          ),
        }),
      ),
    } as unknown as HermesAdapter;
    let failGrant = true;
    const grantAsset = vi.fn(async () => {
      if (failGrant) throw new Error("plugin offline");
    });
    const putReference = vi.fn(async () => {});
    const client = {
      isConfigured: () => true,
      registerSession: vi.fn(async () => {}),
      getSubmission: vi.fn(async () => ({
        scope_id: "cv_source",
        session_id: "ses_source",
        asset_ids: ["asset_input"],
        user_text_sha256: input.userTextSha256,
        run_input_sha256: input.runInputSha256,
      })),
      listAssets: vi.fn(async () => ({
        data: [
          {
            asset_id: "asset_output",
            source: {
              kind: "tool",
              session_id: "ses_source",
              tool_call_id: "call_image",
            },
          },
        ],
        next_cursor: null,
      })),
      grantAsset,
      putReference,
    } as unknown as MediaClient;
    const branch = new MediaBranchService(db, hermes, client);
    branch.record("cv_source", "ses_source", "cv_target", "ses_target", 2);
    await expect(branch.syncOne("cv_target")).rejects.toThrow("plugin offline");
    expect(branch.hasPendingSource("cv_source")).toBe(true);
    expect(() => conversations.delete("cv_source")).toThrow();

    db.prepare(
      "UPDATE conversations SET hermes_session_id='ses_source_compacted' WHERE id='cv_source'",
    ).run();
    db.prepare(
      "UPDATE conversations SET hermes_session_id='ses_target_compacted' WHERE id='cv_target'",
    ).run();
    failGrant = false;
    await branch.syncOne("cv_target");
    expect(branch.hasPendingSource("cv_source")).toBe(false);
    expect(grantAsset).toHaveBeenCalledWith(
      "cv_target",
      "asset_input",
      "cv_source",
    );
    expect(grantAsset).toHaveBeenCalledWith(
      "cv_target",
      "asset_output",
      "cv_source",
    );
    expect(putReference).toHaveBeenCalledTimes(2);
    const mappings = db
      .prepare(
        `SELECT target_message_id,asset_ids_json FROM media_branch_messages
      WHERE target_scope_id='cv_target' ORDER BY target_message_id`,
      )
      .all();
    expect(mappings).toEqual([
      { target_message_id: 21, asset_ids_json: '["asset_input"]' },
      { target_message_id: 22, asset_ids_json: '["asset_output"]' },
    ]);
    expect(conversations.delete("cv_source")).toBe(true);
  });
});

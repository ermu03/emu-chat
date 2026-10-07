import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/db/migrate.js";
import { ConversationRepository } from "../../src/server/db/repositories/conversation.repository.js";
import { MediaBranchService } from "../../src/server/media/branch.js";
import { makeMediaRunInput } from "../../src/server/media/manifest.js";
import type { MediaClient } from "../../src/server/media/client.js";
import type { HermesAdapter } from "../../src/server/hermes/adapter.js";
import {
  enqueueMediaSync,
  MediaSyncWorker,
} from "../../src/server/media/sync.js";
import { MediaUnavailableError } from "../../src/server/media/client.js";

describe("media branch recovery", () => {
  let db: Database.Database;
  let conversations: ConversationRepository;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    conversations = new ConversationRepository(db);
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
      ses_grandchild: [
        {
          id: 31,
          session_id: "ses_grandchild",
          role: "user",
          content: input.runInput,
          timestamp: 1,
        },
        {
          id: 32,
          session_id: "ses_grandchild",
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
    const permissions = new Map<string, Set<string>>([
      ["cv_source", new Set(["asset_input", "asset_output", "asset_uncopied"])],
    ]);
    const grantAsset = vi.fn(
      async (target: string, assetId: string, source: string) => {
        if (failGrant) throw new Error("plugin offline");
        if (!permissions.get(source)?.has(assetId))
          throw new Error("Source permission missing");
        const targetAssets = permissions.get(target) ?? new Set<string>();
        targetAssets.add(assetId);
        permissions.set(target, targetAssets);
        return { scope_id: target, asset_id: assetId };
      },
    );
    const putReference = vi.fn(async () => {});
    const client = {
      isConfigured: () => true,
      registerSession: vi.fn(async () => {}),
      getSubmission: vi.fn(async () => ({
        scope_id: "cv_source",
        operation_id: "op_input",
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
    conversations.insert({
      id: "cv_grandchild",
      hermes_profile: "default",
      hermes_session_id: "ses_grandchild",
    });
    branch.record(
      "cv_target",
      "ses_target",
      "cv_grandchild",
      "ses_grandchild",
      2,
    );
    await expect(branch.syncOne("cv_grandchild")).resolves.toBe("deferred");
    expect(branch.hasPendingSource("cv_target")).toBe(true);

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
    permissions.delete("cv_source");
    const submissions = vi.mocked(client.getSubmission).mock.calls.length;
    const lists = vi.mocked(client.listAssets).mock.calls.length;
    // A late uncopied resource must never be granted to C.
    permissions.get("cv_target")!.add("asset_uncopied");
    branch.record(
      "cv_target",
      "ses_target",
      "cv_grandchild",
      "ses_grandchild",
      2,
    );
    putReference.mockRejectedValueOnce(new MediaUnavailableError());
    await expect(branch.syncOne("cv_grandchild")).rejects.toBeInstanceOf(
      MediaUnavailableError,
    );
    expect(branch.hasPendingSource("cv_target")).toBe(true);
    const restarted = new MediaBranchService(db, hermes, client);
    await expect(restarted.syncOne("cv_grandchild")).resolves.toBe("done");
    expect(permissions.get("cv_grandchild")).toEqual(
      new Set(["asset_input", "asset_output"]),
    );
    expect(grantAsset).toHaveBeenCalledWith(
      "cv_grandchild",
      "asset_output",
      "cv_target",
    );
    expect(vi.mocked(client.getSubmission)).toHaveBeenCalledTimes(submissions);
    expect(vi.mocked(client.listAssets)).toHaveBeenCalledTimes(lists);
    expect(
      db
        .prepare(
          "SELECT target_message_id,asset_ids_json,source_operation_id FROM media_branch_messages WHERE target_scope_id='cv_grandchild' ORDER BY target_message_id",
        )
        .all(),
    ).toEqual([
      {
        target_message_id: 31,
        asset_ids_json: '["asset_input"]',
        source_operation_id: "op_input",
      },
      {
        target_message_id: 32,
        asset_ids_json: '["asset_output"]',
        source_operation_id: null,
      },
    ]);
    expect(conversations.delete("cv_target")).toBe(true);
    expect(permissions.get("cv_grandchild")?.has("asset_output")).toBe(true);
  });

  it("defers an in-flight branch until deletion is cancelled and discards late results after confirmed deletion", async () => {
    const hermes = {
      getSessionMessages: vi.fn(async (session: string) => ({
        messages: [
          {
            id: session === "ses_source" ? 11 : 21,
            session_id: session,
            role: "tool",
            content: '{"success":true,"image":"result.png"}',
            tool_name: "image_generate",
            tool_call_id: "call_image",
            timestamp: 1,
          },
        ],
      })),
    } as unknown as HermesAdapter;
    const grants: Array<() => void> = [];
    const client = {
      isConfigured: () => true,
      registerSession: vi.fn(async () => {}),
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
      grantAsset: vi.fn(
        (target: string, assetId: string) =>
          new Promise((resolve) => {
            grants.push(() => resolve({ scope_id: target, asset_id: assetId }));
          }),
      ),
      putReference: vi.fn(async () => {}),
    } as unknown as MediaClient;
    const branch = new MediaBranchService(db, hermes, client);
    branch.record("cv_source", "ses_source", "cv_target", "ses_target", 1);
    const flight = branch.syncOne("cv_target");
    expect(branch.syncOne("cv_target")).toBe(flight);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    conversations.beginDeletion("cv_target", "ses_target");
    grants.shift()!();
    await expect(flight).resolves.toBe("deferred");
    expect(client.putReference).not.toHaveBeenCalled();
    expect(branch.hasPendingSource("cv_source")).toBe(true);
    expect(
      db.prepare("SELECT count(*) AS count FROM media_branch_messages").get(),
    ).toEqual({ count: 0 });

    // A deferred target must not monopolize the worker's oldest slot.
    conversations.insert({
      id: "cv_other",
      hermes_profile: "default",
      hermes_session_id: "ses_other",
    });
    branch.record("cv_source", "ses_source", "cv_other", "ses_other", 0);
    branch.wake();
    await branch.stop();
    expect(
      db
        .prepare(
          "SELECT status FROM media_branch_pending WHERE target_scope_id='cv_other'",
        )
        .get(),
    ).toEqual({ status: "done" });

    conversations.setDeleteState("cv_target", "none");
    const restarted = new MediaBranchService(db, hermes, client);
    const retry = restarted.syncOne("cv_target");
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    grants.shift()!();
    await expect(retry).resolves.toBe("done");
    expect(client.putReference).toHaveBeenCalledTimes(1);
    expect(branch.hasPendingSource("cv_source")).toBe(false);

    conversations.insert({
      id: "cv_deleted",
      hermes_profile: "default",
      hermes_session_id: "ses_deleted",
    });
    restarted.record("cv_source", "ses_source", "cv_deleted", "ses_deleted", 1);
    const late = restarted.syncOne("cv_deleted");
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    conversations.beginDeletion("cv_deleted", "ses_deleted");
    expect(conversations.delete("cv_deleted")).toBe(true);
    grants.shift()!();
    await expect(late).resolves.toBe("deleted");
    expect(client.putReference).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          "SELECT 1 FROM media_branch_messages WHERE target_scope_id='cv_deleted'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT status FROM media_outbox WHERE scope_id='cv_deleted' AND kind='scope_delete'",
        )
        .get(),
    ).toEqual({ status: "pending" });
    expect(branch.hasPendingSource("cv_source")).toBe(false);
  });

  it("preserves deferred outbox work across restart and retains scope deletion until the plugin recovers", async () => {
    let releaseRegister: (() => void) | undefined;
    const client = {
      isConfigured: () => true,
      registerSession: vi.fn(async (scope: string) => {
        if (scope === "cv_target")
          await new Promise<void>((resolve) => {
            releaseRegister = resolve;
          });
      }),
      putReference: vi.fn(async () => {}),
      deleteScope: vi.fn(async () => {}),
    } as unknown as MediaClient;
    const payload = {
      reference_id: "ref_target",
      kind: "draft",
      revision: 1,
      session_id: "ses_target",
      asset_ids: ["asset_input"],
    };
    enqueueMediaSync(db, "target_ref", "cv_target", "reference_put", payload);
    enqueueMediaSync(db, "other_register", "cv_source", "register", {
      session_id: "ses_source",
    });
    const worker = new MediaSyncWorker(db, client);
    worker.wake();
    await vi.waitFor(() => expect(releaseRegister).toBeDefined());
    conversations.beginDeletion("cv_target", "ses_target");
    releaseRegister!();
    await worker.stop();
    expect(client.putReference).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT status,attempt_count FROM media_outbox WHERE id='target_ref'",
        )
        .get(),
    ).toEqual({ status: "pending", attempt_count: 0 });
    expect(
      db
        .prepare("SELECT status FROM media_outbox WHERE id='other_register'")
        .get(),
    ).toEqual({ status: "done" });

    // Failed deletion is still temporary and must retain the same payload.
    conversations.setDeleteState("cv_target", "failed", "UPSTREAM_UNAVAILABLE");
    db.prepare(
      "UPDATE media_outbox SET next_attempt_at='' WHERE id='target_ref'",
    ).run();
    const failedWorker = new MediaSyncWorker(db, client);
    failedWorker.wake();
    await failedWorker.stop();
    expect(client.putReference).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT status,payload_json FROM media_outbox WHERE id='target_ref'",
        )
        .get(),
    ).toEqual({ status: "pending", payload_json: JSON.stringify(payload) });

    conversations.setDeleteState("cv_target", "none");
    vi.mocked(client.registerSession).mockResolvedValue(undefined);
    db.prepare(
      "UPDATE media_outbox SET next_attempt_at='' WHERE id='target_ref'",
    ).run();
    const recovered = new MediaSyncWorker(db, client);
    recovered.wake();
    await recovered.stop();
    expect(client.putReference).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT status FROM media_outbox WHERE id='target_ref'").get(),
    ).toEqual({ status: "done" });

    enqueueMediaSync(db, "target_ref", "cv_target", "reference_put", {
      ...payload,
      revision: 2,
    });
    conversations.beginDeletion("cv_target", "ses_target");
    conversations.delete("cv_target");
    vi.mocked(client.deleteScope).mockRejectedValueOnce(
      new MediaUnavailableError(),
    );
    const deleting = new MediaSyncWorker(db, client);
    deleting.wake();
    await deleting.stop();
    expect(client.putReference).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT status FROM media_outbox WHERE id='target_ref'").get(),
    ).toEqual({ status: "done" });
    expect(
      db
        .prepare(
          "SELECT status FROM media_outbox WHERE scope_id='cv_target' AND kind='scope_delete'",
        )
        .get(),
    ).toEqual({ status: "pending" });
    db.prepare(
      "UPDATE media_outbox SET next_attempt_at='' WHERE kind='scope_delete'",
    ).run();
    const finalWorker = new MediaSyncWorker(db, client);
    finalWorker.wake();
    await finalWorker.stop();
    expect(client.deleteScope).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          "SELECT status FROM media_outbox WHERE scope_id='cv_target' AND kind='scope_delete'",
        )
        .get(),
    ).toEqual({ status: "done" });
  });
});

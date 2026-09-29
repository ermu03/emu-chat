import { z } from "zod";

export const MediaProtocolVersion = 1;

export const AttachmentRefSchema = z.object({
  asset_id: z.string().regex(/^asset_[A-Za-z0-9_-]{1,122}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const AttachmentRefsSchema = z
  .array(AttachmentRefSchema)
  .max(4)
  .refine(
    (items) =>
      new Set(items.map((item) => item.asset_id)).size === items.length,
    "Duplicate image attachment",
  );

export const MediaSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload"), upload_id: z.string() }),
  z.object({
    kind: z.literal("tool"),
    session_id: z.string(),
    turn_id: z.string().nullable(),
    tool_call_id: z.string(),
    output_index: z.number().int().nonnegative(),
  }),
]);

export const PluginAssetSchema = z.object({
  protocol_version: z.literal(MediaProtocolVersion),
  asset_id: AttachmentRefSchema.shape.asset_id,
  scope_id: z.string(),
  status: z.enum([
    "pending",
    "ready",
    "capture_failed",
    "unavailable",
    "deleted",
  ]),
  source: MediaSourceSchema,
  mime_type: z.string(),
  byte_size: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  sha256: z.string(),
  file_name: z.string(),
  capture_error: z.string().optional(),
});
export type PluginAsset = z.infer<typeof PluginAssetSchema>;

export const MediaAssetSchema = PluginAssetSchema.omit({
  protocol_version: true,
  scope_id: true,
}).extend({
  content_url: z.string(),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const MediaCapabilitiesSchema = z.object({
  protocol_version: z.literal(MediaProtocolVersion),
  limits: z.object({
    max_attachments: z.number().int().positive(),
    max_upload_bytes: z.number().int().positive(),
    max_capture_bytes: z.number().int().positive(),
    max_pixels: z.number().int().positive(),
    max_side_pixels: z.number().int().positive(),
    max_storage_bytes: z.number().int().positive(),
    mime_types: z.array(z.string()),
  }),
  vision: z.object({
    status: z.enum(["available", "unsupported", "unconfigured", "unknown"]),
    reason: z.string().nullable(),
    input_bridge: z.string().nullable(),
  }),
  generation: z.object({
    status: z.enum(["available", "unsupported", "unconfigured", "unknown"]),
    reason: z.string().nullable(),
  }),
  editing: z.object({
    status: z.enum(["available", "unsupported", "unconfigured", "unknown"]),
    reason: z.string().nullable(),
    input_bridge: z.string().nullable(),
    max_reference_images: z.number().int().nonnegative(),
  }),
});
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>;

export const PluginSubmissionSchema = z.object({
  protocol_version: z.literal(MediaProtocolVersion),
  scope_id: z.string(),
  operation_id: z.string(),
  session_id: z.string(),
  asset_ids: z.array(AttachmentRefSchema.shape.asset_id).max(4),
  user_text_sha256: AttachmentRefSchema.shape.sha256,
  run_input_sha256: AttachmentRefSchema.shape.sha256,
});

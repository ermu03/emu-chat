import type { FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { z } from "zod";
import {
  InvalidRequestError,
  PayloadTooLargeError,
} from "../../domain/errors.js";
import type { MediaService } from "../../media/service.js";

const ImageType = /^(image\/png|image\/jpeg|image\/webp)$/;
const MAX_UPLOAD = 8 * 1024 * 1024;

const ListQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().max(1024).optional(),
    operation_id: z.string().optional(),
    session_id: z.string().optional(),
    tool_call_id: z.string().optional(),
  })
  .strict();

export const mediaRoutes: FastifyPluginAsync<{
  mediaService: MediaService;
}> = async (fastify, opts) => {
  const { mediaService } = opts;
  // Keep image request bodies as streams; the global JSON body limit stays 128 KiB.
  fastify.addContentTypeParser(ImageType, (_request, payload, done) =>
    done(null, payload),
  );

  fastify.get<{ Params: { id: string } }>(
    "/conversations/:id/media/capabilities",
    async (request) => mediaService.capabilities(request.params.id),
  );

  fastify.post<{ Params: { id: string } }>(
    "/conversations/:id/media/uploads",
    {
      bodyLimit: MAX_UPLOAD + 1024,
    },
    async (request, reply) => {
      const mime =
        request.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase() ?? "";
      if (!ImageType.test(mime))
        throw new InvalidRequestError("只支持 PNG、JPEG 和 WebP 图片");
      const uploadId = request.headers["idempotency-key"];
      if (typeof uploadId !== "string")
        throw new InvalidRequestError("Missing upload identity");
      const fileName = request.headers["x-file-name"];
      if (typeof fileName !== "string")
        throw new InvalidRequestError("Missing image file name");
      const contentLength = Number(request.headers["content-length"] ?? 0);
      if (contentLength > MAX_UPLOAD)
        throw new PayloadTooLargeError("图片超过 8 MiB 限制");
      const source = request.body as Readable;
      let count = 0;
      let oversized = false;
      const bounded = Readable.from(
        (async function* () {
          for await (const chunk of source) {
            const bytes = chunk as Buffer;
            count += bytes.length;
            if (count > MAX_UPLOAD) {
              oversized = true;
              throw new PayloadTooLargeError("图片超过 8 MiB 限制");
            }
            yield bytes;
          }
        })(),
      );
      let decodedName: string;
      try {
        decodedName = decodeURIComponent(fileName);
      } catch {
        throw new InvalidRequestError("图片文件名编码无效");
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (request.raw.aborted) abort();
      request.raw.once("aborted", abort);
      try {
        const result = await mediaService.upload(
          request.params.id,
          uploadId,
          mime,
          decodedName,
          bounded,
          controller.signal,
        );
        return reply.status(201).send(result);
      } catch (error) {
        if (oversized) throw new PayloadTooLargeError("图片超过 8 MiB 限制");
        throw error;
      } finally {
        request.raw.off("aborted", abort);
      }
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    "/conversations/:id/media/assets",
    async (request) =>
      mediaService.listAssets(
        request.params.id,
        ListQuery.parse(request.query),
      ),
  );

  fastify.get<{ Params: { id: string; assetId: string } }>(
    "/conversations/:id/media/assets/:assetId",
    async (request) =>
      mediaService.getAsset(request.params.id, request.params.assetId),
  );

  fastify.get<{ Params: { id: string; assetId: string } }>(
    "/conversations/:id/media/assets/:assetId/content",
    async (request, reply) => {
      const response = await mediaService.getContent(
        request.params.id,
        request.params.assetId,
      );
      if (!response.body) throw new InvalidRequestError("图片内容为空");
      reply.header(
        "Content-Type",
        response.headers.get("content-type") ?? "application/octet-stream",
      );
      reply.header(
        "Content-Disposition",
        response.headers.get("content-disposition") ?? "inline",
      );
      reply.header("Cache-Control", "private, no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      if (response.headers.has("content-length"))
        reply.header("Content-Length", response.headers.get("content-length")!);
      return reply.send(
        Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
      );
    },
  );

  fastify.post<{ Params: { id: string; assetId: string } }>(
    "/conversations/:id/media/assets/:assetId/retry-capture",
    async (request, reply) => {
      await mediaService.retryCapture(
        request.params.id,
        request.params.assetId,
      );
      return reply.status(202).send({ accepted: true });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/conversations/:id/media/reconcile",
    async (request) => mediaService.reconcile(request.params.id),
  );
};

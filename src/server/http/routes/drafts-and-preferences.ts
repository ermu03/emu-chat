import { FastifyPluginAsync } from 'fastify';
import { DraftPreferencesService } from '../../services/draft-preferences-service.js';
import { putDraftRequestSchema, putPreferencesRequestSchema } from '../../../shared/api-schemas.js';

export interface DraftPreferencesRouteOptions {
  draftPreferencesService: DraftPreferencesService;
}

export const draftPreferencesRoutes: FastifyPluginAsync<DraftPreferencesRouteOptions> = async (
  fastify,
  opts
) => {
  const { draftPreferencesService } = opts;

  // GET /api/v1/conversations/:id/draft
  fastify.get<{ Params: { id: string } }>(
    '/conversations/:id/draft',
    async (request, reply) => {
      const { id } = request.params;
      const draft = draftPreferencesService.getDraft(id);
      return reply.status(200).send(draft);
    }
  );

  // PUT /api/v1/conversations/:id/draft
  fastify.put<{ Params: { id: string } }>(
    '/conversations/:id/draft',
    async (request, reply) => {
      const { id } = request.params;
      const body = putDraftRequestSchema.parse(request.body);
      const draft = draftPreferencesService.putDraft(id, body.content, body.expected_revision);
      return reply.status(200).send(draft);
    }
  );

  // GET /api/v1/preferences
  fastify.get('/preferences', async (_request, reply) => {
    const preferences = draftPreferencesService.getPreferences();
    return reply.status(200).send(preferences);
  });

  // PUT /api/v1/preferences
  fastify.put('/preferences', async (request, reply) => {
    const body = putPreferencesRequestSchema.parse(request.body);
    const preferences = draftPreferencesService.putPreferences(body);
    return reply.status(200).send(preferences);
  });
};

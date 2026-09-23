import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type ChannelRouter,
  type ChannelStore,
  type PersistentScheduler,
  type ScheduledDeliveryAdapter,
} from '@yuanpu-agent/runtime-kit';
import { RUNTIME_ROUTES } from '@yuanpu-agent/protocol';

export function createScheduledImDelivery(routers: readonly ChannelRouter[]): ScheduledDeliveryAdapter {
  return {
    supports: (target) => target.kind === 'channel'
      && Boolean(target.routeId && routers.some((router) => router.canDeliverScheduled(target.routeId!))),
    // WeCom proactive sends have no provider idempotency key. An uncertain receipt is never replayed.
    supportsIdempotency: () => false,
    async deliver({ target, output, signal }) {
      const router = target.routeId
        ? routers.find((candidate) => candidate.canDeliverScheduled(target.routeId!))
        : undefined;
      if (!router || !target.routeId) return { status: 'failed', code: 'target_unavailable' };
      return router.sendScheduled(target.routeId, output.message, signal);
    },
  };
}

export async function handleScheduledImHttp(input: {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  channelStore: ChannelStore;
  channels: readonly ChannelRouter[];
  scheduler: PersistentScheduler;
  readJsonBody(request: IncomingMessage): Promise<unknown>;
}): Promise<boolean> {
  const { request, response, url, channelStore, channels, scheduler, readJsonBody } = input;
  if (url.pathname === RUNTIME_ROUTES.channelScheduleTargets && request.method === 'GET') {
    const activeConnections = new Set(channels.map((router) => router.connectionId));
    response.end(JSON.stringify(channelStore.listPrivateContacts('wecom')
      .filter((contact) => activeConnections.has(contact.connectionId))));
    return true;
  }
  if (url.pathname === RUNTIME_ROUTES.channelScheduleTargets && request.method === 'POST') {
    const body = await readJsonBody(request);
    if (
      !body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1
      || typeof (body as { contactId?: unknown }).contactId !== 'string'
    ) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: 'An observed contactId is required.' }));
      return true;
    }
    const contactId = (body as { contactId: string }).contactId;
    const routeId = channels.map((router) => router.bindScheduledContact(contactId))
      .find((candidate) => candidate !== undefined);
    if (!routeId) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Private contact is not available for binding.' }));
      return true;
    }
    response.statusCode = 201;
    response.end(JSON.stringify({ routeId }));
    return true;
  }
  const targetPath = url.pathname.startsWith(`${RUNTIME_ROUTES.channelScheduleTargets}/`)
    ? url.pathname.slice(RUNTIME_ROUTES.channelScheduleTargets.length + 1)
    : undefined;
  if (targetPath && !targetPath.includes('/') && request.method === 'DELETE') {
    const targetId = decodeURIComponent(targetPath);
    const connectionId = channelStore.revokePrivateTarget(targetId);
    if (!connectionId) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'Scheduled IM target not found.' }));
      return true;
    }
    await Promise.all(channels
      .filter((router) => router.connectionId === connectionId)
      .map((router) => router.waitForScheduledTarget(targetId)));
    response.statusCode = 204;
    response.end();
    return true;
  }
  if (url.pathname === RUNTIME_ROUTES.schedules && request.method === 'POST') {
    try {
      const schedule = scheduler.create(await readJsonBody(request));
      response.statusCode = 201;
      response.end(JSON.stringify(schedule));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return true;
  }
  return false;
}

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who and what the current request is, available to any code it runs.
 *
 * Every log line written while handling a request picks these up
 * automatically, so a TVDB failure deep inside a list build still says which
 * request and which user it belonged to — without threading ids through every
 * function signature.
 */
export interface RequestContext {
  requestId: string;
  userId?: number;
  username?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The current request's context, or undefined outside a request (startup, timers). */
export function currentRequest(): RequestContext | undefined {
  return requestContext.getStore();
}

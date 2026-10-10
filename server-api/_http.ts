/**
 * Local HTTP request/response shapes.
 *
 * The API used to be typed against `@vercel/node`. This build runs its own
 * server inside the Electron main process, so the handlers use these plain
 * Node types instead. They mirror the small surface the handlers actually use:
 * query, body, headers, and a `status().json()` chain.
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

export type ApiRequest = IncomingMessage & {
  query: Record<string, string | string[] | undefined>;
  body: any;
  headers: IncomingHttpHeaders;
};

export type ApiResponse = ServerResponse & {
  status(code: number): ApiResponse;
  json(payload: unknown): ApiResponse;
  send(body?: unknown): ApiResponse;
  end(...args: any[]): any;
};
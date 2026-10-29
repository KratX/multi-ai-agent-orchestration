import type { AegisDatabase } from '../../db/client';
import type { RunEventRow, RunStatus } from '../../db/schema/runs';
import {
  AuthorizationError,
  type AuthenticatedActor,
} from '../../policies/authorization';
import {
  getRunDetailsForActor,
  listRunEventsAfterSequence,
  RunConstraintError,
} from './run-executor';

/**
 * Ticket SSE-001: Server-Sent Events (SSE) Replay Debugger & Cursor Stream Engine
 *
 * Implements Blueprint Section 5.4 & Section 6.3:
 * - Parses `Last-Event-ID` header or `?afterSequence=` query parameter into a monotonic
 *   `sequence_no` cursor (`>= 0`).
 * - Formats `run_events` rows into standard `text/event-stream` wire frames:
 *     id: <sequenceNo>
 *     event: <eventType>
 *     data: <JSON payload>
 * - Replays all missed events strictly greater than `afterSequence` (`sequence_no > cursor`)
 *   with zero duplicate frames on client reconnect.
 * - Enforces central RBAC (`run.view`) and returns `404` Problem Details on cross-tenant
 *   access (`Threat T-01` & `ADR-002`).
 */

export class InvalidSseCursorError extends Error {
  public readonly statusCode = 400;
  public readonly code = 'INVALID_SSE_CURSOR';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidSseCursorError';
  }
}

const TERMINAL_OR_PAUSED_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'waiting_approval',
]);

/**
 * Parses `Last-Event-ID` HTTP header or `afterSequence` query parameter into a non-negative integer cursor.
 */
export function parseLastEventIdCursor(input: {
  lastEventIdHeader?: string | null;
  afterSequenceParam?: string | number | null;
}): number {
  const raw =
    input.lastEventIdHeader !== undefined &&
    input.lastEventIdHeader !== null &&
    String(input.lastEventIdHeader).trim() !== ''
      ? String(input.lastEventIdHeader).trim()
      : input.afterSequenceParam !== undefined &&
          input.afterSequenceParam !== null &&
          String(input.afterSequenceParam).trim() !== ''
        ? String(input.afterSequenceParam).trim()
        : '0';

  if (!/^\d+$/.test(raw)) {
    throw new InvalidSseCursorError(
      `Invalid SSE sequence cursor "${raw}". Expected a non-negative integer.`
    );
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidSseCursorError(
      `Invalid SSE sequence cursor "${raw}". Expected a safe non-negative integer.`
    );
  }

  return parsed;
}

/**
 * Formats a `RunEventRow` into a standards-compliant Server-Sent Events (`text/event-stream`) frame.
 */
export function formatSseEventFrame(event: RunEventRow): string {
  const envelope = {
    id: event.id,
    runId: event.runId,
    organizationId: event.organizationId,
    sequenceNo: event.sequenceNo,
    eventType: event.eventType,
    payload: event.payload,
    createdAt:
      event.createdAt instanceof Date
        ? event.createdAt.toISOString()
        : String(event.createdAt),
  };

  return [
    `id: ${event.sequenceNo}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(envelope)}`,
    '',
    '',
  ].join('\n');
}

/**
 * Formats a terminal stream-end control event so SSE clients know whether the run is complete or paused.
 */
export function formatSseStreamEndFrame(input: {
  runId: string;
  status: RunStatus;
  lastSequenceNo: number;
  replayedCount: number;
}): string {
  const payload = {
    runId: input.runId,
    status: input.status,
    lastSequenceNo: input.lastSequenceNo,
    replayedCount: input.replayedCount,
    terminalOrPaused: TERMINAL_OR_PAUSED_RUN_STATUSES.has(input.status),
  };

  return [
    `event: run.stream_end`,
    `data: ${JSON.stringify(payload)}`,
    '',
    '',
  ].join('\n');
}

/**
 * Formats an SSE comment heartbeat frame to keep long-lived proxy connections alive.
 */
export function formatSseHeartbeatComment(timestampIso: string): string {
  return `: heartbeat ${timestampIso}\n\n`;
}

export interface StreamRunEventsRequest {
  organizationId: string;
  runId: string;
  lastEventIdHeader?: string | null;
  afterSequenceParam?: string | number | null;
}

/**
 * Builds a Web-standard `Response` (`Content-Type: text/event-stream`) that replays all
 * `run_events` after the client's `Last-Event-ID` / `afterSequence` cursor (`SSE-001`).
 */
export async function createRunEventsSseResponse(
  db: AegisDatabase,
  actor: AuthenticatedActor | null | undefined,
  request: StreamRunEventsRequest
): Promise<Response> {
  try {
    const afterSequence = parseLastEventIdCursor({
      lastEventIdHeader: request.lastEventIdHeader,
      afterSequenceParam: request.afterSequenceParam,
    });

    const details = await getRunDetailsForActor(
      db,
      actor,
      request.organizationId,
      request.runId
    );

    const events = await listRunEventsAfterSequence(
      db,
      actor,
      request.organizationId,
      request.runId,
      afterSequence
    );

    const lastSequenceNo =
      events.length > 0
        ? events[events.length - 1]!.sequenceNo
        : details.events.length > 0
          ? details.events[details.events.length - 1]!.sequenceNo
          : afterSequence;

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`retry: 1500\n: cursor=${afterSequence}\n\n`)
        );

        for (const ev of events) {
          controller.enqueue(encoder.encode(formatSseEventFrame(ev)));
        }

        controller.enqueue(
          encoder.encode(
            formatSseStreamEndFrame({
              runId: details.run.id,
              status: details.run.status,
              lastSequenceNo,
              replayedCount: events.length,
            })
          )
        );

        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-replay-after-sequence': String(afterSequence),
        'x-replayed-events-count': String(events.length),
      },
    });
  } catch (err) {
    if (err instanceof InvalidSseCursorError) {
      return Response.json(
        {
          type: 'https://aegis.runtime/errors/invalid-sse-cursor',
          title: 'Invalid SSE Sequence Cursor',
          status: 400,
          detail: err.message,
          code: err.code,
        },
        { status: 400 }
      );
    }

    if (err instanceof AuthorizationError) {
      const status = err.statusCode;
      return Response.json(
        {
          type: 'https://aegis.runtime/errors/authorization',
          title: status === 404 ? 'Resource Not Found' : 'Access Denied',
          status,
          detail: err.message,
          code: err.code,
        },
        { status }
      );
    }

    if (err instanceof RunConstraintError) {
      return Response.json(
        {
          type: 'https://aegis.runtime/errors/run-not-found',
          title: 'Run Not Found',
          status: err.statusCode,
          detail: err.message,
          code: err.code,
        },
        { status: err.statusCode }
      );
    }

    throw err;
  }
}

import type { NextFunction, Request, Response } from 'express';
import { correlationMiddleware } from './correlation.middleware';
import { getCorrelation } from './correlation';

function fakeReq(headers: Record<string, unknown>): Request {
  return { headers } as unknown as Request;
}

function fakeRes(): Response & { headers: Record<string, unknown> } {
  const headers: Record<string, unknown> = {};
  return {
    headers,
    setHeader(name: string, value: unknown) {
      headers[name] = value;
      return this;
    },
  } as unknown as Response & { headers: Record<string, unknown> };
}

describe('correlationMiddleware', () => {
  it('generates a request id and echoes it on the response', () => {
    // The response header is what lets the browser log the server's id
    // beside its own, and what a user can quote when reporting a problem.
    const res = fakeRes();
    let seen: string | undefined;
    correlationMiddleware(fakeReq({}), res, (() => {
      seen = getCorrelation()?.requestId;
    }) as NextFunction);

    expect(seen).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(seen);
  });

  it('IGNORES a client-supplied request id', () => {
    // The trust boundary. Accepting this would let a caller collapse
    // unrelated traffic into one apparent trace, or write a crafted value
    // into logs as though the server had issued it.
    const res = fakeRes();
    let seen: string | undefined;
    correlationMiddleware(
      fakeReq({ 'x-request-id': 'ATTACKER-CONTROLLED' }),
      res,
      (() => {
        seen = getCorrelation()?.requestId;
      }) as NextFunction,
    );

    expect(seen).not.toBe('ATTACKER-CONTROLLED');
    expect(res.headers['x-request-id']).not.toBe('ATTACKER-CONTROLLED');
  });

  it('carries valid client ids through into the context', () => {
    let seen: ReturnType<typeof getCorrelation>;
    correlationMiddleware(
      fakeReq({
        'x-session-id': 'sess-abc',
        'x-page-view-id': 'page-def',
        'x-client-request-id': 'client-ghi',
      }),
      fakeRes(),
      (() => {
        seen = getCorrelation();
      }) as NextFunction,
    );

    expect(seen?.sessionId).toBe('sess-abc');
    expect(seen?.pageViewId).toBe('page-def');
    expect(seen?.clientRequestId).toBe('client-ghi');
  });

  it('drops a header that would inject into a log line', () => {
    // Sanitisation at the Express boundary, where untrusted input actually
    // arrives -- not just in the helper's own unit test.
    let seen: ReturnType<typeof getCorrelation>;
    correlationMiddleware(
      fakeReq({ 'x-session-id': 'abc' + '\n' + 'level=error msg=forged' }),
      fakeRes(),
      (() => {
        seen = getCorrelation();
      }) as NextFunction,
    );

    expect(seen?.sessionId).toBeUndefined();
    // The request still proceeds: telemetry must never fail a request.
    expect(seen?.requestId).toBeTruthy();
  });

  it('drops a repeated header, which Express hands over as an array', () => {
    let seen: ReturnType<typeof getCorrelation>;
    correlationMiddleware(
      fakeReq({ 'x-session-id': ['a', 'b'] }),
      fakeRes(),
      (() => {
        seen = getCorrelation();
      }) as NextFunction,
    );
    expect(seen?.sessionId).toBeUndefined();
  });

  it('always calls next, even when every client id is rejected', () => {
    let called = false;
    correlationMiddleware(
      fakeReq({ 'x-session-id': '!!!', 'x-page-view-id': '' }),
      fakeRes(),
      (() => {
        called = true;
      }) as NextFunction,
    );
    expect(called).toBe(true);
  });
});

// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { CorrelationExceptionFilter } from './correlation-exception.filter';
import { runWithCorrelation } from './correlation';

/**
 * The filter that makes correlation ids worth collecting.
 *
 * Attaching ids to requests and never logging them -- which this feature
 * originally did -- means a browser error still cannot be matched to the
 * server log explaining it. These tests pin the two properties that make
 * that match possible: the ids reach the log line, and the log line stays
 * one parseable record no matter what the error message contains.
 */
describe('CorrelationExceptionFilter', () => {
  let filter: CorrelationExceptionFilter;
  let logged: string[];

  beforeEach(() => {
    filter = new CorrelationExceptionFilter();
    logged = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('RETHROWS, so nothing downstream changes behaviour', () => {
    // The filter only observes. Shaping a GraphQL error response is
    // Apollo's job, and taking it over here would change what every
    // client receives.
    const boom = new Error('kaboom');

    expect(() => filter.catch(boom)).toThrow(boom);
  });

  it('logs one JSON record carrying the error message', () => {
    // Rethrown by design, so every call site here has to expect it.
    expect(() => filter.catch(new Error('kaboom'))).toThrow();

    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({
      msg: 'request failed',
      error: 'kaboom',
    });
  });

  it('includes the correlation ids of the request that failed', () => {
    // The whole point of the filter: without these the log line cannot be
    // matched back to the browser error that reported it.
    runWithCorrelation(
      { requestId: 'req-1', sessionId: 'sess-1', pageViewId: 'pv-1' },
      () => {
        expect(() => filter.catch(new Error('kaboom'))).toThrow();
      },
    );

    expect(JSON.parse(logged[0])).toMatchObject({
      request_id: 'req-1',
      session_id: 'sess-1',
      page_view_id: 'pv-1',
    });
  });

  it('keeps a newline-bearing message on ONE log record', () => {
    // JSON.stringify rather than interpolation is deliberate: these lines
    // get grepped and parsed, and an error message containing a newline
    // would otherwise split one failure into two records -- or forge a
    // second, fake one.
    expect(() =>
      filter.catch(new Error('line one\nmsg=fake request')),
    ).toThrow();

    expect(logged[0].split('\n')).toHaveLength(1);
    expect(JSON.parse(logged[0]).error).toBe('line one\nmsg=fake request');
  });

  it('handles a thrown non-Error without losing it', () => {
    // GraphQL resolvers can reject with anything at all.
    expect(() => filter.catch('just a string')).toThrow('just a string');

    expect(JSON.parse(logged[0]).error).toBe('just a string');
  });
});

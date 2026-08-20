import { Catch, Logger, type ExceptionFilter } from '@nestjs/common';
import { correlationFields } from './correlation';

/**
 * Logs every unhandled error with the correlation ids of the request that
 * produced it, then rethrows so existing behaviour is unchanged.
 *
 * This is what makes the ids worth collecting. Attaching them to requests
 * and never logging them -- which is what this feature originally did --
 * means a browser error still cannot be matched to the server log that
 * explains it, and the whole point was to make that possible.
 *
 * Fields are flat and snake_cased so any log backend can index them
 * directly; see correlation.ts for why they are separate fields rather
 * than one composite id.
 *
 * Rethrows rather than formatting a response: GraphQL error shaping is
 * Apollo's job, and taking it over here would change what clients receive.
 * This filter only observes.
 */
@Catch()
export class CorrelationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Request');

  catch(exception: unknown): unknown {
    const fields = correlationFields();
    const message =
      exception instanceof Error ? exception.message : String(exception);

    // JSON rather than interpolation: these values end up grepped and
    // parsed, and a message with a newline would otherwise split a record.
    this.logger.error(
      JSON.stringify({ msg: 'request failed', error: message, ...fields }),
    );

    // Unchanged behaviour: whatever handled this before still does.
    throw exception;
  }
}

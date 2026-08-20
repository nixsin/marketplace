import { CORRELATION_HEADERS } from "./correlation";

/**
 * Reports a failed API call with the identifiers needed to trace it.
 *
 * The point of the whole correlation feature, and what was missing: the
 * ids were attached to outbound requests and then never used. A failure
 * logged without them cannot be matched to anything, so the documented
 * workflow -- take a browser error, find the server log that explains it
 * -- did not exist.
 *
 * Two ids, because they answer different questions:
 *   clientRequestId  always available, even when the request never
 *                    completed. If no server log carries it, the request
 *                    never arrived, and that absence IS the diagnosis.
 *   requestId        the server's own, read back from the response. Only
 *                    present when there was a response at all.
 *
 * console.error deliberately, not a vendor SDK: an error tracker has not
 * been chosen yet (#107), and this keeps the call sites correct now so
 * adopting one later is a change in this one function.
 */
export function reportApiFailure(
  operation: string,
  clientRequestId: string,
  error: unknown,
  response?: Response,
): void {
  // A cross-origin response only exposes headers named in
  // Access-Control-Expose-Headers. The API sets that, but a proxy or a
  // misconfiguration could strip it, so a missing value is normal rather
  // than exceptional.
  const requestId = response?.headers.get(CORRELATION_HEADERS.requestId) ?? undefined;

  console.error(`[api] ${operation} failed`, {
    client_request_id: clientRequestId,
    ...(requestId ? { request_id: requestId } : {}),
    ...(response ? { status: response.status } : { status: "no response" }),
    message: error instanceof Error ? error.message : String(error),
  });
}

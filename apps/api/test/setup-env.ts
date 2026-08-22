import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../.env.test') });

/**
 * WhatsApp delivery is FORCED OFF for every e2e run.
 *
 * The suite asserts that an inquiry is recorded FAILED because delivery is
 * unconfigured -- which was true only by accident, of whatever happened to be
 * in the runner's environment. A developer with real credentials exported
 * would have had these tests make an actual outbound request to Meta from a
 * test run, and then fail on assertions that no longer described what
 * happened.
 *
 * Deleted rather than set to empty strings: WhatsappService checks presence,
 * so an empty string would read the same here but not everywhere, and the
 * intent is "this variable is not set" rather than "it is set to nothing".
 */
for (const name of [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_TEMPLATE_NAME',
  'WHATSAPP_ALLOW_FREE_FORM',
]) {
  delete process.env[name];
}

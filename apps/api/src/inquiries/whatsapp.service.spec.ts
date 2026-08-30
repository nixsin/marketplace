// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import {
  INQUIRY_MESSAGE_MAX_LENGTH,
  WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH,
  WHATSAPP_ACCESS_TOKEN_ENV,
  WHATSAPP_API_VERSION,
  WHATSAPP_PHONE_NUMBER_ID_ENV,
} from '@medinstru/config';
import {
  WhatsappService,
  sanitizeTemplateParam,
  truncateByCodePoint,
} from './whatsapp.service';

// Fully configured now means all THREE: a template name is required
// alongside the credentials, because business-initiated messages cannot be
// sent as free-form text.
const CONFIGURED = {
  [WHATSAPP_ACCESS_TOKEN_ENV]: 'test-token',
  [WHATSAPP_PHONE_NUMBER_ID_ENV]: '123456',
  WHATSAPP_TEMPLATE_NAME: 'marketplace_inquiry',
} as unknown as NodeJS.ProcessEnv;

/** Credentials present, template absent -- the half-configured deployment. */
const NO_TEMPLATE = {
  [WHATSAPP_ACCESS_TOKEN_ENV]: 'test-token',
  [WHATSAPP_PHONE_NUMBER_ID_ENV]: '123456',
} as unknown as NodeJS.ProcessEnv;

// isE164 is NOT re-tested here. phone.spec.ts owns it, and this file's copy
// still asserted an eight-digit minimum -- the rule part 1 removed, because
// Saint Helena (+290 8123) and the Cook Islands (+682 1234) are seven digits
// end to end. A duplicated test of a shared function is how a fixed bug gets
// re-certified as correct somewhere else.
/**
 * global.fetch is saved and RESTORED by hand.
 *
 * jest.restoreAllMocks() only undoes spies it installed; a plain assignment to
 * a global is invisible to it, so the last mock installed here leaked into
 * whatever suite shared the worker next -- and a suite that makes no network
 * call at all is exactly the one that would not notice.
 */
const REAL_FETCH = global.fetch;

describe('WhatsappService', () => {
  let service: WhatsappService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new WhatsappService();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    // Silence the deliberate warn on the not-configured path.
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });

  describe('when credentials are absent', () => {
    it.each([[{}], [NO_TEMPLATE]])(
      'refuses to send when there is %#',
      async (env) => {
        // Asserted THROUGH sendInquiry, not through a separate isConfigured
        // predicate. That predicate existed, had its own tests, and was called
        // by nothing -- so it could have disagreed with the checks sendInquiry
        // actually performs and every test would still have passed. It is gone;
        // this asserts the behaviour that ships.
        const result = await service.sendInquiry(
          '+919876543210',
          { summary: 'hello', buyerMessage: 'q' },
          env,
        );

        expect(result.ok).toBe(false);
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('fails without throwing, and never calls the provider', async () => {
      // Throwing here would lose a real lead over a configuration gap: the
      // caller has already persisted the inquiry by this point.
      const result = await service.sendInquiry(
        '+919876543210',
        { summary: 'hello', buyerMessage: 'q' },
        {},
      );

      expect(result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names the missing variables but never a value', async () => {
      const result = await service.sendInquiry(
        '+919876543210',
        { summary: 'hello', buyerMessage: 'q' },
        { [WHATSAPP_ACCESS_TOKEN_ENV]: 'a-real-looking-secret' },
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain(WHATSAPP_PHONE_NUMBER_ID_ENV);
      // The whole point of reading credentials by name: a misconfiguration
      // cannot leak a partial secret into a log or an error string.
      expect(result.reason).not.toContain('a-real-looking-secret');
    });
  });

  it('rejects a malformed recipient before any network call', async () => {
    const result = await service.sendInquiry(
      '98765 43210',
      { summary: 'hello', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the pinned API version and returns the provider message id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'wamid.ABC' }] }),
    });

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.ABC' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Pinned, not "latest": an unpinned Graph API call changes behaviour
    // under us and we would learn about it from failed deliveries.
    expect(url).toContain(`/${WHATSAPP_API_VERSION}/123456/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token',
    );
    const body = JSON.parse(init.body as string) as { to: string };
    expect(body.to).toBe('+919876543210');
  });

  it('treats a provider rejection as a failure, not an exception', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { message: 'Invalid recipient' } }),
    });

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('400');
    expect(result.reason).toContain('Invalid recipient');
  });

  it('survives a provider error body that is not JSON', async () => {
    // A non-JSON error body is itself the useful signal; parsing it must not
    // throw over the top of the original failure.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: () => Promise.reject(new Error('not json')),
    });

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('502');
  });

  it('turns a network failure into an AMBIGUOUS result, not a throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );

    // AMBIGUOUS, not a definite failure: the request may have reached Meta
    // and been accepted before the response was lost. Recording it as FAILED
    // invites a retry that double-messages the seller.
    expect(result).toEqual({
      ok: false,
      ambiguous: true,
      reason: 'ECONNRESET',
    });
  });

  it.each<[unknown, string]>([
    [{}, 'no messages key'],
    [{ messages: [] }, 'empty messages array'],
    [{ messages: [{}] }, 'message without an id'],
    [null, 'null payload'],
  ])(
    'leaves an unexpected payload shape AMBIGUOUS (%#: %s)',
    async (payload) => {
      // This asserted `{ ok: true, providerMessageId: null }` -- "sent, id
      // unknown" -- on the reasoning that a shape change must not discard a
      // send that actually succeeded. True as far as it went, but it
      // conflated "we cannot read the id" with "it was accepted": a 2xx
      // proves only that some HTTP intermediary answered, which a proxy error
      // page does too.
      //
      // Ambiguous keeps both properties. The send is not discarded, and it is
      // not claimed either -- which matters once part 4 reports delivery to
      // the buyer, where SENT means someone is told their message arrived.
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      });

      const result = await service.sendInquiry(
        '+919876543210',
        { summary: 'hi', buyerMessage: 'q' },
        CONFIGURED,
      );

      expect(result).toMatchObject({ ok: false, ambiguous: true });
    },
  );
});

describe('a seller number written the way people write numbers', () => {
  // The asymmetry this covers was silent in BOTH directions: the buyer's
  // number is canonicalised, the seller's was only validated. A seller stored
  // as "+91 98765 43210" -- the exact example the buyer form advertises --
  // was reported uncontactable by Product.hasInquiryContact, so the form
  // never rendered, AND rejected here if a direct caller submitted anyway.
  // No error to anyone; the seller simply never heard from a buyer.
  let fetchMock: jest.Mock;
  const service = new WhatsappService();

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'wamid.1' }] }),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });

  it('is canonicalised before the request, not rejected', async () => {
    const result = await service.sendInquiry(
      '+91 98765 43210',
      { summary: 's', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(true);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { to: string };
    // The canonical form reaches Meta, which rejects anything else.
    expect(body.to).toBe('+919876543210');
  });

  it('still refuses a number that cannot be made valid', async () => {
    const result = await service.sendInquiry(
      'not-a-number',
      { summary: 's', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('sanitizeTemplateParam', () => {
  // Meta rejects a template parameter containing a newline, a tab, or more
  // than four consecutive spaces -- the whole message is refused, not just
  // the parameter. The composed inquiry is deliberately multi-line, so
  // without flattening every production send fails validation.
  it('flattens the newlines a composed inquiry is full of', () => {
    const flat = sanitizeTemplateParam('Product: X\nRef: p1\n\nFrom: Asha');
    expect(flat).not.toMatch(/[\r\n\t]/);
    expect(flat).toContain('Product: X');
    expect(flat).toContain('From: Asha');
  });

  it('collapses runs of whitespace', () => {
    expect(sanitizeTemplateParam('a      b')).toBe('a b');
    expect(sanitizeTemplateParam('a\t\t\tb')).not.toMatch(/\t/);
  });

  it('bounds the length', () => {
    expect(sanitizeTemplateParam('x'.repeat(5000)).length).toBeLessThanOrEqual(
      1024,
    );
  });
});

describe('WhatsappService template sends', () => {
  const WITH_TEMPLATE = {
    [WHATSAPP_ACCESS_TOKEN_ENV]: 'test-token',
    [WHATSAPP_PHONE_NUMBER_ID_ENV]: '123456',
    WHATSAPP_TEMPLATE_NAME: 'marketplace_inquiry',
  } as unknown as NodeJS.ProcessEnv;

  let service: WhatsappService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new WhatsappService();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'wamid.T' }] }),
    });
    global.fetch = fetchMock;
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });

  it('sends a TEMPLATE, not free-form text, when one is configured', async () => {
    // Business-initiated WhatsApp messages require an approved template.
    // Free-form text only works inside a 24-hour window the RECIPIENT opens
    // by messaging first -- which never happens here, because the
    // marketplace always speaks first. The original implementation sent
    // type:'text' and would have failed every real send while passing every
    // test.
    await service.sendInquiry(
      '+919876543210',
      { summary: 'Product: X\nFrom: Asha', buyerMessage: 'Is it available?' },
      WITH_TEMPLATE,
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as {
      type: string;
      template: {
        name: string;
        components: { parameters: { text: string }[] }[];
      };
    };
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('marketplace_inquiry');
    // The parameter must already be flattened by the time it is sent.
    expect(body.template.components[0].parameters[0].text).not.toMatch(/\n/);
  });

  it('REFUSES to send when no template is configured, rather than trying anyway', async () => {
    // The previous version of this test required a silent fallback to
    // free-form text. That was the bug: this flow is always
    // business-initiated, so Meta rejects free-form text, and a deployment
    // with credentials but no template would mark every inquiry FAILED while
    // an operator debugged provider errors for a missing env var.
    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      NO_TEMPLATE,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('WHATSAPP_TEMPLATE_NAME');
    // Refused BEFORE the request, not attempted and failed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends free-form text only behind the explicit opt-in', async () => {
    // For a known open service window in development -- never a fallback.
    await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      { ...NO_TEMPLATE, WHATSAPP_ALLOW_FREE_FORM: 'true' },
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { type: string; text: { preview_url: boolean } };
    expect(body.type).toBe('text');
    // Link previews off: the body already carries the canonical URL, and
    // Meta fetching it server-side adds latency for a preview the seller
    // does not need.
    expect(body.text.preview_url).toBe(false);
  });

  it('sends free-form text when the opt-in is set without a template', async () => {
    // The opt-in is a deliberate choice for a known open service window, so a
    // deployment using it does send -- just not a template. Asserted by the
    // request actually being made, rather than by a predicate agreeing that
    // it would be.
    await service.sendInquiry(
      '+919876543210',
      { summary: 'summary', buyerMessage: 'question' },
      { ...NO_TEMPLATE, WHATSAPP_ALLOW_FREE_FORM: 'true' },
    );

    expect(global.fetch).toHaveBeenCalled();
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as { body: string }).body,
    ) as { type: string };
    expect(body.type).toBe('text');
  });

  it('aborts a stalled provider rather than hanging the buyer', async () => {
    // Meta accepting the socket and never answering is what a bare fetch
    // waits on forever, leaving the row PENDING and the form spinning.
    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'TimeoutError',
    });
    fetchMock.mockRejectedValue(timeout);

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/timed out/);
  });

  it('passes an abort signal on every request', async () => {
    await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });
});

describe('template parameter budgets', () => {
  it("gives the buyer's message its own budget", async () => {
    // A 1000-character question used to lose its ending to the product
    // metadata in front of it -- silently, after the API had accepted it as
    // valid -- because both shared one parameter's budget.
    const service = new WhatsappService();
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ messages: [{ id: 'w' }] }),
    });
    global.fetch = fetchMock;

    const longMessage = 'q'.repeat(1000);
    await service.sendInquiry(
      '+919876543210',
      { summary: 'Product: X\nRef: p1\nFrom: Asha', buyerMessage: longMessage },
      {
        [WHATSAPP_ACCESS_TOKEN_ENV]: 't',
        [WHATSAPP_PHONE_NUMBER_ID_ENV]: '1',
        WHATSAPP_TEMPLATE_NAME: 'marketplace_inquiry',
      },
    );

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    ) as { template: { components: { parameters: { text: string }[] }[] } };
    const params = body.template.components[0].parameters;

    // Intact: the whole question survives, metadata notwithstanding.
    expect(params[1].text).toHaveLength(1000);
    expect(params[1].text.endsWith('q')).toBe(true);
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });
});

describe('a 200 that does not actually confirm a send', () => {
  // A 2xx proves only that some HTTP intermediary returned success -- a proxy
  // error page does too. Meta answers an accepted send with
  // `{ messages: [{ id }] }`; without one there is nothing to confirm.
  //
  // AMBIGUOUS rather than FAILED: Meta may genuinely have accepted it, and
  // FAILED invites a retry that double-messages the seller. This previously
  // recorded SENT with a null id, which is the one outcome definitely wrong
  // -- it claims certainty from an absence.
  const service = new WhatsappService();

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });

  const send = () =>
    service.sendInquiry(
      '+919876543210',
      { summary: 's', buyerMessage: 'q' },
      CONFIGURED,
    );

  it.each([
    ['an empty object', {}],
    ['an empty messages array', { messages: [] }],
    ['a message without an id', { messages: [{}] }],
    ['an unrecognised shape', { ok: 'yes' }],
  ])('leaves %s ambiguous, not sent', async (_label, body) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    });

    expect(await send()).toMatchObject({ ok: false, ambiguous: true });
  });

  it('leaves an unparseable body ambiguous, not sent', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('unexpected end of JSON')),
    });

    expect(await send()).toMatchObject({ ok: false, ambiguous: true });
  });
});

describe('a 200 whose body carries an error', () => {
  // Success is a property of the BODY, not the status line -- a lesson this
  // repo already documented INBOUND, where a GraphQL resolver failure arrives
  // as HTTP 200 with an `errors` array. Marking an inquiry SENT that was
  // never accepted is the highest-stakes error here: once the buyer is told
  // about delivery, it becomes a person waiting for a reply that is not
  // coming.
  const service = new WhatsappService();

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });

  it('is NOT reported as sent', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ error: { message: 'nope' } }),
    });

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 's', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result.ok).toBe(false);
  });

  it('still accepts a normal success body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ messages: [{ id: 'wamid.ok' }] }),
    });

    expect(
      await service.sendInquiry(
        '+919876543210',
        { summary: 's', buyerMessage: 'q' },
        CONFIGURED,
      ),
    ).toEqual({ ok: true, providerMessageId: 'wamid.ok' });
  });

  it('does not trip on a null error key', async () => {
    // `{ error: null }` is not an error, and treating it as one would refuse
    // a send the provider accepted.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ error: null, messages: [{ id: 'w.1' }] }),
    });

    expect(
      (
        await service.sendInquiry(
          '+919876543210',
          { summary: 's', buyerMessage: 'q' },
          CONFIGURED,
        )
      ).ok,
    ).toBe(true);
  });
});

describe('provider HTTP status classification', () => {
  let fetchMock: jest.Mock;
  const service = new WhatsappService();

  const respondWith = (status: number) => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: 'x',
      json: () => Promise.resolve({ error: { message: 'upstream said no' } }),
    });
    global.fetch = fetchMock;
  };

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });

  it.each([500, 502, 503, 504])(
    'treats %d as AMBIGUOUS, like a timeout',
    async (status) => {
      // Our own AbortSignal firing at 10s was "we do not know", while Meta's
      // gateway timing out at 9s and answering 504 was "definitely not sent".
      // Same physical situation, opposite conclusion -- and the FAILED one
      // invites a retry that puts the inquiry on the seller's phone twice.
      respondWith(status);

      const result = await service.sendInquiry(
        '+919876543210',
        { summary: 's', buyerMessage: 'q' },
        CONFIGURED,
      );

      expect(result).toMatchObject({ ok: false, ambiguous: true });
    },
  );

  it.each([400, 401, 403, 404, 429])(
    'keeps %d definite -- Meta answered, it did not fail to answer',
    async (status) => {
      // 429 included deliberately: being rate-limited is Meta rejecting the
      // request outright, which is a real answer rather than an absence of
      // one, so FAILED is the truthful record.
      respondWith(status);

      const result = await service.sendInquiry(
        '+919876543210',
        { summary: 's', buyerMessage: 'q' },
        CONFIGURED,
      );

      expect(result.ok).toBe(false);
      expect((result as { ambiguous?: boolean }).ambiguous).toBeFalsy();
    },
  );
});

describe('an accepted send whose body will not parse', () => {
  it('is AMBIGUOUS -- neither claimed as sent nor recorded as failed', async () => {
    // This asserted SUCCESS, reasoning that response.ok proves Meta accepted
    // the message and that falling through to the failure path would mark a
    // DELIVERED inquiry FAILED, whose retry duplicates.
    //
    // Half right. FAILED is indeed wrong, for exactly that reason. But so is
    // SENT: a 2xx proves only that some HTTP intermediary answered, and an
    // unparseable body confirms nothing at all -- it claims certainty from an
    // absence. Ambiguous avoids both, and it is the same answer a timeout
    // gets for the same reason.
    const service = new WhatsappService();
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON')),
    });

    const result = await service.sendInquiry(
      '+919876543210',
      { summary: 'hi', buyerMessage: 'q' },
      CONFIGURED,
    );

    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });

  afterEach(() => {
    global.fetch = REAL_FETCH;
    jest.restoreAllMocks();
  });
});

describe("a buyer's message survives sanitising intact", () => {
  // This replaces a test that compared INQUIRY_MESSAGE_MAX_LENGTH against
  // WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH and concluded the truncation gap was
  // unreachable. The constants were indeed ordered correctly -- and the
  // sanitiser expanded the string BETWEEN them, which a comparison of two
  // numbers cannot see. A fourteen-line spec list at the cap was silently
  // losing its ending, and the guard reported everything fine.
  //
  // So this measures the property instead of a proxy for it: real input,
  // through the real function, asserting nothing was cut.
  const atCap = (body: string) =>
    body + 'x'.repeat(Math.max(0, INQUIRY_MESSAGE_MAX_LENGTH - body.length));

  it.each([
    [
      'a fourteen-line spec list, which is an ordinary B2B inquiry',
      Array.from(
        { length: 14 },
        (_, i) => `Spec line ${i} with some detail about the requirement`,
      ).join('\n'),
    ],
    ['alternating characters and newlines', 'a\n'.repeat(500)],
    ['tabs throughout', 'a\t'.repeat(500)],
    ['no whitespace at all', 'x'.repeat(INQUIRY_MESSAGE_MAX_LENGTH)],
  ])('is not truncated: %s', (_label, body) => {
    const out = sanitizeTemplateParam(atCap(body));
    expect(out.length).toBeLessThan(WHATSAPP_TEMPLATE_PARAM_MAX_LENGTH);
  });

  it.each([
    ['U+000A LINE FEED', 0x000a],
    ['U+000D CARRIAGE RETURN', 0x000d],
    ['U+0009 TAB', 0x0009],
    ['U+000B VERTICAL TAB', 0x000b],
    ['U+000C FORM FEED', 0x000c],
    ['U+0085 NEXT LINE', 0x0085],
    ['U+00A0 NO-BREAK SPACE', 0x00a0],
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE', 0xfeff],
  ])('flattens a LONE %s', (_l, code) => {
    // "Lone" is the whole point. An earlier version paired an explicit class
    // for \r \n \t U+2028 U+2029 with a separate `\s{2,}` run collapse, so a
    // single vertical tab, form feed, no-break space or BOM matched neither
    // and survived. A QA probe here missed it by feeding two such characters
    // ADJACENTLY, which hits the run collapse and looks clean.
    //
    // Built from code points rather than pasted literals: the shell and the
    // editor both normalise these, and a literal turns the assertion into a
    // test of plain spaces that passes regardless.
    const ch = String.fromCharCode(code);
    expect(sanitizeTemplateParam(`a${ch}b`)).toBe('a b');
  });

  it.each([
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
  ])('flattens %s, which no control-character class catches', (_l, code) => {
    // Meta rejects a parameter containing a line break however it is spelled,
    // and these are Zl/Zp -- neither \p{Cc} nor \p{Cf}. Built by code point,
    // because pasting them into a literal lets an editor or a shell normalise
    // them away and the test then proves nothing.
    const ch = String.fromCharCode(code);
    expect(sanitizeTemplateParam(`a${ch}b`)).toBe('a b');
  });

  it('never expands, so the cap relationship actually holds', () => {
    // The invariant the constant comparison was standing in for. Flattening
    // may CONTRACT a run of whitespace; it must never grow the string, or the
    // 1000 < 1024 ordering stops meaning anything.
    for (const input of ['a\nb', 'a\n\n\nb', 'a\tb', 'a    b', 'plain']) {
      expect(sanitizeTemplateParam(input).length).toBeLessThanOrEqual(
        input.length,
      );
    }
  });

  it('truncates by code point when it does have to truncate', () => {
    // Only reachable now through the summary parameter or a raised cap, but
    // the cut must not split a surrogate pair either way.
    const cut = truncateByCodePoint('x'.repeat(1023) + '\u{1F600}', 1024);
    const unpaired =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(unpaired.test(cut)).toBe(false);
    expect([...cut]).toHaveLength(1024);
  });
});

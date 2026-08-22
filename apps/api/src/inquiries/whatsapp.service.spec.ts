import {
  WHATSAPP_ACCESS_TOKEN_ENV,
  WHATSAPP_API_VERSION,
  WHATSAPP_PHONE_NUMBER_ID_ENV,
} from '@medinstru/config';
import {
  WhatsappService,
  isE164,
  sanitizeTemplateParam,
} from './whatsapp.service';

const CONFIGURED = {
  [WHATSAPP_ACCESS_TOKEN_ENV]: 'test-token',
  [WHATSAPP_PHONE_NUMBER_ID_ENV]: '123456',
} as unknown as NodeJS.ProcessEnv;

describe('isE164', () => {
  it.each(['+919876543210', '+14155552671', '+441234567890'])(
    'accepts %s',
    (value) => expect(isE164(value)).toBe(true),
  );

  it.each([
    ['0919876543210', 'no leading plus'],
    ['+0919876543', 'leading zero after the plus'],
    ['+91987', 'too short'],
    ['+9198765432101234', 'too long'],
    ['+91 98765 43210', 'contains spaces'],
    ['', 'empty'],
  ])('rejects %s (%s)', (value) => expect(isE164(value)).toBe(false));
});

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

  afterEach(() => jest.restoreAllMocks());

  describe('when credentials are absent', () => {
    it('reports itself unconfigured', () => {
      expect(service.isConfigured({})).toBe(false);
      expect(service.isConfigured(CONFIGURED)).toBe(true);
    });

    it('fails without throwing, and never calls the provider', async () => {
      // Throwing here would lose a real lead over a configuration gap: the
      // caller has already persisted the inquiry by this point.
      const result = await service.sendInquiry('+919876543210', 'hello', {});

      expect(result.ok).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names the missing variables but never a value', async () => {
      const result = await service.sendInquiry('+919876543210', 'hello', {
        [WHATSAPP_ACCESS_TOKEN_ENV]: 'a-real-looking-secret',
      });

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
      'hello',
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

    const result = await service.sendInquiry('+919876543210', 'hi', CONFIGURED);

    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.ABC' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Pinned, not "latest": an unpinned Graph API call changes behaviour
    // under us and we would learn about it from failed deliveries.
    expect(url).toContain(`/${WHATSAPP_API_VERSION}/123456/messages`);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token',
    );
    const body = JSON.parse(init.body as string) as {
      to: string;
      text: { preview_url: boolean; body: string };
    };
    expect(body.to).toBe('+919876543210');
    expect(body.text.preview_url).toBe(false);
  });

  it('treats a provider rejection as a failure, not an exception', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: () => Promise.resolve({ error: { message: 'Invalid recipient' } }),
    });

    const result = await service.sendInquiry('+919876543210', 'hi', CONFIGURED);

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

    const result = await service.sendInquiry('+919876543210', 'hi', CONFIGURED);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('502');
  });

  it('turns a network failure into a failure result, not a throw', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await service.sendInquiry('+919876543210', 'hi', CONFIGURED);

    expect(result).toEqual({ ok: false, reason: 'ECONNRESET' });
  });

  it.each([
    [{}, 'no messages key'],
    [{ messages: [] }, 'empty messages array'],
    [{ messages: [{}] }, 'message without an id'],
    [null, 'null payload'],
  ])(
    'still reports success when the payload shape is unexpected (%#: %s)',
    async (payload) => {
      // A provider shape change must degrade to "sent, id unknown" rather
      // than discarding a send that actually succeeded.
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      });

      const result = await service.sendInquiry(
        '+919876543210',
        'hi',
        CONFIGURED,
      );

      expect(result).toEqual({ ok: true, providerMessageId: null });
    },
  );
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
      900,
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
  afterEach(() => jest.restoreAllMocks());

  it('sends a TEMPLATE, not free-form text, when one is configured', async () => {
    // Business-initiated WhatsApp messages require an approved template.
    // Free-form text only works inside a 24-hour window the RECIPIENT opens
    // by messaging first -- which never happens here, because the
    // marketplace always speaks first. The original implementation sent
    // type:'text' and would have failed every real send while passing every
    // test.
    await service.sendInquiry(
      '+919876543210',
      'Product: X\nFrom: Asha',
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

  it('falls back to text only when no template is configured', async () => {
    await service.sendInquiry('+919876543210', 'hi', CONFIGURED);

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
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

    const result = await service.sendInquiry('+919876543210', 'hi', CONFIGURED);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toMatch(/timed out/);
  });

  it('passes an abort signal on every request', async () => {
    await service.sendInquiry('+919876543210', 'hi', CONFIGURED);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });
});

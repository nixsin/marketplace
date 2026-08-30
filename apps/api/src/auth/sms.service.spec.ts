// `jest` is not a global under ESM -- Jest injects describe/it/expect but
// not the jest object itself, so it has to be imported explicitly.
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { SmsService } from './sms.service';

/**
 * The OTP delivery stub.
 *
 * It sends nothing, and the test that matters is about what it says while
 * not sending: the message must stay unmistakably a stub, because the one
 * way this file causes harm is by looking like it works. A future real
 * implementation replaces the body; if this test starts failing then, that
 * is the signal to revisit the wording rather than delete the assertion.
 */
describe('SmsService', () => {
  let service: SmsService;
  let warned: string[];

  beforeEach(() => {
    service = new SmsService();
    warned = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves without sending anything', async () => {
    await expect(
      service.sendOtp('+919000000001', '123456'),
    ).resolves.toBeUndefined();
  });

  it('marks itself a STUB so the log cannot be mistaken for delivery', async () => {
    await service.sendOtp('+919000000001', '123456');

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('[DEV STUB]');
  });

  it('warns rather than logging at info level', async () => {
    // Deliberate: an OTP that was never delivered is an operational
    // problem, and info-level output is scrolled past.
    const info = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => {});

    await service.sendOtp('+919000000001', '123456');

    expect(warned).toHaveLength(1);
    expect(info).not.toHaveBeenCalled();
  });
});

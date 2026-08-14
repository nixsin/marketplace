import { OtpStoreService } from './otp-store.service';

describe('OtpStoreService', () => {
  let store: OtpStoreService;

  beforeEach(() => {
    store = new OtpStoreService();
  });

  it('verifies a code that matches what was set', () => {
    store.set('+919876543210', '123456');
    expect(store.verify('+919876543210', '123456')).toBe(true);
  });

  it('rejects a wrong code', () => {
    store.set('+919876543210', '123456');
    expect(store.verify('+919876543210', '000000')).toBe(false);
  });

  it('rejects verification for a phone that never requested a code', () => {
    expect(store.verify('+919876543210', '123456')).toBe(false);
  });

  it('is single-use — a second verify attempt fails even with the right code', () => {
    store.set('+919876543210', '123456');
    expect(store.verify('+919876543210', '123456')).toBe(true);
    expect(store.verify('+919876543210', '123456')).toBe(false);
  });

  it('rejects an expired code', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    store.set('+919876543210', '123456');

    jest.setSystemTime(new Date('2026-01-01T00:06:00Z')); // 6 min later, TTL is 5 min
    expect(store.verify('+919876543210', '123456')).toBe(false);

    jest.useRealTimers();
  });

  it('scopes codes per phone number', () => {
    store.set('+919876543210', '111111');
    store.set('+919999999999', '222222');
    expect(store.verify('+919876543210', '222222')).toBe(false);
    expect(store.verify('+919999999999', '222222')).toBe(true);
  });
});

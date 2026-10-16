import { describe, expect, it } from 'vitest';
import { normalizeEmail } from '../src/auth/accounts';

describe('normalizeEmail (task 25 item 1 — anti-farming canonicalization)', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  User@Example.COM ')).toBe('user@example.com');
  });

  it('strips +tag sub-addressing on any domain', () => {
    expect(normalizeEmail('user+promo@example.com')).toBe('user@example.com');
    expect(normalizeEmail('sales+eu@company.co.uk')).toBe('sales@company.co.uk');
    // Distinct tags collapse to one identity.
    expect(normalizeEmail('u+a@x.com')).toBe(normalizeEmail('u+b@x.com'));
  });

  it('collapses dots in the local part for Gmail only', () => {
    expect(normalizeEmail('first.last@gmail.com')).toBe('firstlast@gmail.com');
    expect(normalizeEmail('first.last@googlemail.com')).toBe('firstlast@googlemail.com');
    // Dots are significant on other providers.
    expect(normalizeEmail('first.last@company.com')).toBe('first.last@company.com');
  });

  it('maps gmail dot + plus variants to a single identity', () => {
    const variants = [
      'johndoe@gmail.com',
      'john.doe@gmail.com',
      'j.o.h.n.d.o.e@gmail.com',
      'johndoe+shopping@gmail.com',
      'John.Doe+news@Gmail.com',
    ];
    const canonical = variants.map(normalizeEmail);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('johndoe@gmail.com');
  });

  it('does not empty the local part on pathological input', () => {
    expect(normalizeEmail('+tag@example.com')).toBe('+tag@example.com');
    expect(normalizeEmail('...@gmail.com')).toBe('...@gmail.com');
  });
});

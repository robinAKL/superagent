import { describe, expect, it } from 'vitest';
import { verifiedAddress } from '../src/auth.js';

describe('the address invitations are matched against', () => {
  it('is the sign-in name, never an unverified email claim', () => {
    expect(verifiedAddress({ preferred_username: 'ana@acme.co.nz', email: 'victim@other.co.nz' })).toBe('ana@acme.co.nz');
    expect(verifiedAddress({ upn: 'ana@acme.co.nz' })).toBe('ana@acme.co.nz');
    // An organisation can set any mail address on its own accounts: it proves nothing by itself.
    expect(verifiedAddress({ email: 'victim@other.co.nz' })).toBeNull();
    expect(verifiedAddress({ email: 'ana@acme.co.nz', xms_edov: true })).toBe('ana@acme.co.nz');
    expect(verifiedAddress({})).toBeNull();
  });
});

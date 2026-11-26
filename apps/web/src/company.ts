/** What the company directory says about the signed-in person (/api/v1/tenancy/me). */
export interface MeView {
  identity: { name: string; email: string | null };
  memberships: Array<{ tenantId: string; name: string; roles: string[] }>;
  directoryCompany: { id: string; name: string; autoJoin: boolean } | null;
  pendingRequest: { tenantId: string; name: string; createdAt: string } | null;
  invites: Array<{ id: string; tenantId: string; name: string; roles: string[] }>;
  current: string | null;
}

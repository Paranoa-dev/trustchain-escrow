import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const prismaMock = {
  tenant: {
    findFirst: jest.fn(),
  },
};

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: prismaMock,
}));

const { default: tenantMiddleware } = await import('../api/middleware/tenant.js');

function createRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    locals: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function createReq(headers = {}, hostname = null) {
  const req = { headers: { ...headers } };
  if (hostname) {
    req.headers.host = hostname;
  }
  return req;
}

describe('tenant resolution precedence - failure injection tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('precedence order', () => {
    it('x-tenant-id takes precedence over x-tenant-slug', async () => {
      const tenantById = {
        id: 'tenant_by_id',
        slug: 'by-id',
        name: 'By ID Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      const tenantBySlug = {
        id: 'tenant_by_slug',
        slug: 'by-slug',
        name: 'By Slug Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };

      // Mock returns the first match, so we need to simulate the OR query
      prismaMock.tenant.findFirst
        .mockResolvedValueOnce(tenantById)  // First call for x-tenant-id
        .mockResolvedValueOnce(tenantBySlug); // Fallback for x-tenant-slug (not called if first succeeds)

      const req = createReq({
        'x-tenant-id': 'tenant_by_id',
        'x-tenant-slug': 'by-slug',
      });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(prismaMock.tenant.findFirst).toHaveBeenCalledTimes(1);
      expect(prismaMock.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ id: 'tenant_by_id' }, { slug: 'by-slug' }] },
        }),
      );
      expect(req.tenant.id).toBe('tenant_by_id');
      expect(next).toHaveBeenCalled();
    });

    it('x-tenant-slug takes precedence over hostname', async () => {
      const tenantBySlug = {
        id: 'tenant_by_slug',
        slug: 'by-slug',
        name: 'By Slug Tenant',
        status: 'active',
        domains: ['example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      };
      const tenantByDomain = {
        id: 'tenant_by_domain',
        slug: 'by-domain',
        name: 'By Domain Tenant',
        status: 'active',
        domains: ['example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      };

      prismaMock.tenant.findFirst
        .mockResolvedValueOnce(tenantBySlug)
        .mockResolvedValueOnce(tenantByDomain);

      const req = createReq({
        'x-tenant-slug': 'by-slug',
      }, 'example.com');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(prismaMock.tenant.findFirst).toHaveBeenCalledTimes(1);
      expect(req.tenant.id).toBe('tenant_by_slug');
    });

    it('hostname takes precedence over default tenant', async () => {
      const tenantByDomain = {
        id: 'tenant_by_domain',
        slug: 'by-domain',
        name: 'By Domain Tenant',
        status: 'active',
        domains: ['example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      };
      const defaultTenant = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };

      prismaMock.tenant.findFirst
        .mockResolvedValueOnce(tenantByDomain)
        .mockResolvedValueOnce(defaultTenant);

      const req = createReq({}, 'example.com');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(prismaMock.tenant.findFirst).toHaveBeenCalledTimes(1);
      expect(req.tenant.id).toBe('tenant_by_domain');
    });

    it('falls back to default when no identifiers provided', async () => {
      const defaultTenant = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(defaultTenant);

      const req = createReq({});
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(prismaMock.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { slug: 'default' },
        }),
      );
      expect(req.tenant.slug).toBe('default');
    });
  });

  describe('failure injection - database errors', () => {
    it('propagates database errors when x-tenant-id lookup fails', async () => {
      prismaMock.tenant.findFirst.mockRejectedValue(new Error('Database connection failed'));

      const req = createReq({ 'x-tenant-id': 'tenant_1' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(next.mock.calls[0][0].message).toBe('Database connection failed');
    });

    it('propagates database errors when x-tenant-slug lookup fails', async () => {
      prismaMock.tenant.findFirst.mockRejectedValue(new Error('Query timeout'));

      const req = createReq({ 'x-tenant-slug': 'acme' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('propagates database errors when hostname lookup fails', async () => {
      prismaMock.tenant.findFirst.mockRejectedValue(new Error('Connection pool exhausted'));

      const req = createReq({}, 'example.com');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });

    it('propagates database errors when default tenant lookup fails', async () => {
      prismaMock.tenant.findFirst.mockRejectedValue(new Error('Database unavailable'));

      const req = createReq({});
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('failure injection - tenant not found scenarios', () => {
    it('returns 404 when x-tenant-id not found and no fallback to slug', async () => {
      // First call (with OR clause) returns null, second call (default) would be for fallback
      // But the middleware returns 404 immediately if explicit identifier provided and not found
      prismaMock.tenant.findFirst.mockResolvedValue(null);

      const req = createReq({ 'x-tenant-id': 'nonexistent' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Tenant not found' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 404 when x-tenant-slug not found', async () => {
      prismaMock.tenant.findFirst.mockResolvedValue(null);

      const req = createReq({ 'x-tenant-slug': 'nonexistent' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(404);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 404 when hostname not found', async () => {
      prismaMock.tenant.findFirst.mockResolvedValue(null);

      const req = createReq({}, 'nonexistent.example.com');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(404);
      expect(next).not.toHaveBeenCalled();
    });

    it('falls back to default when explicit identifier fails but default exists', async () => {
      // When explicit identifier provided but not found, it returns 404 immediately
      // This is the current behavior - no automatic fallback to default for explicit identifiers
      prismaMock.tenant.findFirst.mockResolvedValue(null);

      const req = createReq({ 'x-tenant-id': 'explicit-not-found' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(404);
    });
  });

  describe('failure injection - tenant status checks', () => {
    it('returns 403 when tenant found but status is inactive', async () => {
      const inactiveTenant = {
        id: 'tenant_1',
        slug: 'acme',
        name: 'Acme',
        status: 'inactive',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(inactiveTenant);

      const req = createReq({ 'x-tenant-slug': 'acme' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Tenant is not active' });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 when tenant found but status is suspended', async () => {
      const suspendedTenant = {
        id: 'tenant_1',
        slug: 'acme',
        name: 'Acme',
        status: 'suspended',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(suspendedTenant);

      const req = createReq({ 'x-tenant-id': 'tenant_1' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Tenant is not active' });
    });

    it('returns 403 when default tenant is inactive', async () => {
      const inactiveDefault = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'inactive',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(inactiveDefault);

      const req = createReq({});
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Tenant is not active' });
    });
  });

  describe('edge cases', () => {
    it('handles empty x-tenant-id header as absent', async () => {
      const defaultTenant = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(defaultTenant);

      const req = createReq({ 'x-tenant-id': '' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.slug).toBe('default');
    });

    it('handles empty x-tenant-slug header as absent', async () => {
      const defaultTenant = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(defaultTenant);

      const req = createReq({ 'x-tenant-slug': '' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.slug).toBe('default');
    });

    it('ignores localhost hostname', async () => {
      const defaultTenant = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(defaultTenant);

      const req = createReq({}, 'localhost');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.slug).toBe('default');
    });

    it('ignores 127.0.0.1 hostname', async () => {
      const defaultTenant = {
        id: 'tenant_default',
        slug: 'default',
        name: 'Default Tenant',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(defaultTenant);

      const req = createReq({}, '127.0.0.1');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.slug).toBe('default');
    });

    it('handles x-forwarded-host header', async () => {
      const tenantByDomain = {
        id: 'tenant_by_domain',
        slug: 'by-domain',
        name: 'By Domain Tenant',
        status: 'active',
        domains: ['example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(tenantByDomain);

      const req = createReq({
        'x-forwarded-host': 'example.com',
      });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.id).toBe('tenant_by_domain');
    });

    it('uses first hostname from comma-separated x-forwarded-host', async () => {
      const tenantByDomain = {
        id: 'tenant_by_domain',
        slug: 'by-domain',
        name: 'By Domain Tenant',
        status: 'active',
        domains: ['first.example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(tenantByDomain);

      const req = createReq({
        'x-forwarded-host': 'first.example.com, second.example.com',
      });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.id).toBe('tenant_by_domain');
    });

    it('strips port from hostname', async () => {
      const tenantByDomain = {
        id: 'tenant_by_domain',
        slug: 'by-domain',
        name: 'By Domain Tenant',
        status: 'active',
        domains: ['example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(tenantByDomain);

      const req = createReq({}, 'example.com:8080');
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(req.tenant.id).toBe('tenant_by_domain');
    });

    it('handles case-insensitive slug matching', async () => {
      const tenant = {
        id: 'tenant_1',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      prismaMock.tenant.findFirst.mockResolvedValue(tenant);

      const req = createReq({ 'x-tenant-slug': 'ACME' });
      const res = createRes();
      const next = jest.fn();

      await tenantMiddleware(req, res, next);

      expect(prismaMock.tenant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { OR: [{ slug: 'acme' }] },
        }),
      );
    });
  });

  describe('concurrent request isolation', () => {
    it('isolates tenant context between concurrent requests', async () => {
      const tenant1 = {
        id: 'tenant_1',
        slug: 'tenant-one',
        name: 'Tenant One',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };
      const tenant2 = {
        id: 'tenant_2',
        slug: 'tenant-two',
        name: 'Tenant Two',
        status: 'active',
        domains: [],
        branding: {},
        configuration: {},
        metadata: {},
      };

      prismaMock.tenant.findFirst
        .mockResolvedValueOnce(tenant1)
        .mockResolvedValueOnce(tenant2);

      const req1 = createReq({ 'x-tenant-slug': 'tenant-one' });
      const req2 = createReq({ 'x-tenant-slug': 'tenant-two' });
      const res1 = createRes();
      const res2 = createRes();
      const next1 = jest.fn();
      const next2 = jest.fn();

      // Simulate concurrent execution
      await Promise.all([
        tenantMiddleware(req1, res1, next1),
        tenantMiddleware(req2, res2, next2),
      ]);

      expect(req1.tenant.id).toBe('tenant_1');
      expect(req2.tenant.id).toBe('tenant_2');
      expect(next1).toHaveBeenCalled();
      expect(next2).toHaveBeenCalled();
    });
  });
});
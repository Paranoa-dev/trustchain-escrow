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

describe('tenant middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves a tenant from the request header and seeds async context', async () => {
    const tenant = {
      id: 'tenant_1',
      slug: 'acme',
      name: 'Acme',
      status: 'active',
      domains: ['acme.example.com'],
      branding: {},
      configuration: {},
      metadata: {},
    };
    prismaMock.tenant.findFirst.mockResolvedValue(tenant);

    const req = {
      headers: {
        'x-tenant-slug': 'acme',
      },
    };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(prismaMock.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ slug: 'acme' }] },
      }),
    );
    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Tenant-Slug']).toBe('acme');
  });

  it('falls back to the default tenant when no identifier is supplied', async () => {
    const tenant = {
      id: 'tenant_default',
      slug: 'default',
      name: 'Default Tenant',
      status: 'active',
      domains: [],
      branding: {},
      configuration: {},
      metadata: {},
    };
    prismaMock.tenant.findFirst.mockResolvedValue(tenant);

    const req = { headers: {} };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(prismaMock.tenant.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: 'default' },
      }),
    );
    expect(next).toHaveBeenCalled();
  });

  it('returns 404 when an explicit tenant identifier does not match a tenant', async () => {
    prismaMock.tenant.findFirst.mockResolvedValue(null);

    const req = {
      headers: {
        'x-tenant-id': 'missing-tenant',
      },
    };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Tenant not found' });
    expect(next).not.toHaveBeenCalled();
  });

  // ── Failure-injection tests for tenant resolution precedence (#437) ──────

  it('passes a prisma timeout to the error handler', async () => {
    const timeoutError = new Error('Prisma query timed out');
    timeoutError.code = 'P2024';
    prismaMock.tenant.findFirst.mockRejectedValue(timeoutError);

    const req = { headers: { 'x-tenant-slug': 'acme' } };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(timeoutError);
  });

  it('rejects malformed tenant data as inactive', async () => {
    prismaMock.tenant.findFirst.mockResolvedValue({
      id: null,
      slug: undefined,
      name: null,
      status: null,
      domains: null,
    });

    const req = { headers: { 'x-tenant-slug': 'acme' } };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Tenant is not active' });
    expect(next).not.toHaveBeenCalled();
  });

  it('recovers from a transient prisma failure on a subsequent request', async () => {
    prismaMock.tenant.findFirst
      .mockRejectedValueOnce(new Error('Temporary DB hiccup'))
      .mockResolvedValue({
        id: 'tenant_1',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        domains: ['acme.example.com'],
        branding: {},
        configuration: {},
        metadata: {},
      });

    const req = { headers: { 'x-tenant-slug': 'acme' } };
    const res = createRes();
    const next = jest.fn();

    // A transient failure surfaces via next(err).
    await tenantMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // A subsequent identical request succeeds once prisma recovers.
    const res2 = createRes();
    const next2 = jest.fn();
    await tenantMiddleware(req, res2, next2);
    expect(next2).toHaveBeenCalled();
    expect(res2.headers['X-Tenant-Slug']).toBe('acme');
  });

  it('passes a terminal database error to the error handler', async () => {
    const terminalError = new Error('Database connection refused');
    terminalError.code = 'P2003';
    prismaMock.tenant.findFirst.mockRejectedValue(terminalError);

    const req = { headers: { 'x-tenant-slug': 'acme' } };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(terminalError);
  });

  it('preserves existing public behavior outside tenant resolution precedence', async () => {
    const tenant = {
      id: 'tenant_1',
      slug: 'acme',
      name: 'Acme',
      status: 'active',
      domains: ['acme.example.com'],
      branding: {},
      configuration: {},
      metadata: {},
    };
    prismaMock.tenant.findFirst.mockResolvedValue(tenant);

    const req = { headers: { 'x-tenant-slug': 'acme' } };
    const res = createRes();
    const next = jest.fn();

    await tenantMiddleware(req, res, next);

    expect(prismaMock.tenant.findFirst).toHaveBeenCalledTimes(1);
    expect(req.tenant).toEqual(tenant);
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Tenant-Slug']).toBe('acme');
  });
});

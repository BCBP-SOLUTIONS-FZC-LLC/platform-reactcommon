import { describe, expect, it } from 'vitest';
import {
  buildGatewayDenyCodes,
  buildGatewayHeaders,
  buildHeaders,
  buildLogFields,
  buildMetricRegistry,
  buildProblemRules,
  buildProblemTypes,
  buildRedaction,
  buildRegistryVocab,
  buildResponseCases,
  buildTsConstants,
  diffRegistries,
  extractGoIntConsts,
  extractGoRegexp,
  extractLogFieldKeys,
  inlineSwaggerSchema,
  pascalCase,
  toJsonText,
  type ContractsExport,
  type Registry,
  type Swagger,
} from './contracts.ts';
import { SESSION_CONTEXT_CASES, TENANT_RESOLVE_CASES } from './iam-cases.ts';

const registry: Registry = {
  schema_version: 1,
  const_labels: ['domain', 'service', 'environment'],
  required_labels: { platform: ['domain', 'service', 'environment'] },
  prohibited_labels: ['user_id'],
  prohibited_label_suffixes: ['_id'],
  exempt_prefixes: ['go_'],
  bucket_presets: { request_duration: [0.1, 1] },
  labels: {
    domain: { values: ['iam', 'billing'] },
    environment: { values: ['dev', 'prod'] },
    service: { pattern: '^[a-z]+$' },
    version: { pattern: '^[0-9.]+$' },
  },
  metrics: [
    { name: 'platform_x_total', tier: 'platform', status: 'approved' },
    { name: 'old_total', tier: 'legacy', status: 'removed' },
    { name: 'old_kept_total', tier: 'legacy', status: 'deprecated' },
  ],
};

const exported: ContractsExport = {
  problem: {
    contentType: 'application/problem+json',
    defaultTypeBase: 'https://errors.company.com',
    timestampLayout: '2006-01-02T15:04:05Z',
    platformDomain: 'platform',
    codeRequestTimeout: 'REQUEST_TIMEOUT',
    maxRequestIdLength: 128,
    types: [
      { domain: 'platform', name: 'not-found', id: 'platform/not-found', title: 'Not Found', status: 404, code: 'NOT_FOUND' },
    ],
    typeForStatus: [
      { domain: '', name: '', id: '', title: 'Continue', status: 100, code: 'CONTINUE' },
      { domain: 'platform', name: 'not-found', id: 'platform/not-found', title: 'Not Found', status: 404, code: 'NOT_FOUND' },
    ],
  },
  headers: {
    request: { userId: 'x-user-id', tenantId: 'x-tenant-id', tenantRoles: 'x-tenant-roles', requestId: 'x-request-id' },
    response: { traceId: 'X-Trace-ID', requestId: 'X-Request-ID' },
    traceContext: ['traceparent', 'tracestate'],
  },
};

const transportGo = `
const (
	// MaxHeaderValueLen is the maximum length for identity header values.
	MaxHeaderValueLen = 256
	MaxRoleLen = 64
	MaxRolesHeaderLen = 4096
	MaxRoles = 64
	MaxRequestIDLen = 128
)`;
const validationGo = `
var roleTokenPattern = regexp.MustCompile(\`^[a-zA-Z0-9_-]+$\`)
var requestIDPattern = regexp.MustCompile(\`^[a-zA-Z0-9._-]+$\`)
`;
const loggingGo = `
			fields := map[string]interface{}{
				"trace_id":    traceID,
				"request_id":  requestID,
				"path":        label.HTTPRoute(c),
			}
			addIdentityLogFields(c, fields)`;

describe('registry contracts', () => {
  it('builds the identity vocabulary from the registry labels', () => {
    expect(buildRegistryVocab(registry, 'src')).toEqual({
      _generated: expect.stringContaining('from src.'),
      domains: ['iam', 'billing'],
      environments: ['dev', 'prod'],
      servicePattern: '^[a-z]+$',
      versionPattern: '^[0-9.]+$',
    });
  });

  it('fails when a vocabulary label is missing its values or pattern', () => {
    const broken = { ...registry, labels: { ...registry.labels, service: {} } };
    expect(() => buildRegistryVocab(broken, 'src')).toThrow('label service has no pattern');
  });

  it('keeps every metric except removed legacy ones', () => {
    const out = buildMetricRegistry(registry, 'src');
    expect(out.metrics.map((m) => m.name)).toEqual(['platform_x_total', 'old_kept_total']);
    expect(out.constLabels).toEqual(['domain', 'service', 'environment']);
  });

  it('rejects an unknown registry schema version', () => {
    expect(() => buildMetricRegistry({ ...registry, schema_version: 2 }, 'src')).toThrow('schema_version 2');
  });

  it('reports where two registry copies differ', () => {
    expect(diffRegistries(registry, registry)).toEqual([]);
    const copy: Registry = {
      ...registry,
      exempt_prefixes: [],
      labels: { ...registry.labels, domain: { values: ['iam'] } },
      metrics: [{ name: 'platform_x_total', tier: 'platform', status: 'proposed' }],
    };
    expect(diffRegistries(registry, copy)).toEqual([
      'exempt_prefixes',
      'labels.domain',
      'metrics.old_kept_total',
      'metrics.old_total',
      'metrics.platform_x_total',
    ]);
  });
});

describe('problem contracts', () => {
  it('maps about:blank statuses to a null id', () => {
    const out = buildProblemTypes(exported, 'src');
    expect(out.types).toEqual(exported.problem.types);
    expect(out.typeForStatus).toEqual([
      { status: 100, id: null, title: 'Continue', code: 'CONTINUE' },
      { status: 404, id: 'platform/not-found', title: 'Not Found', code: 'NOT_FOUND' },
    ]);
  });

  it('fails on an empty type registry', () => {
    expect(() => buildProblemTypes({ ...exported, problem: { ...exported.problem, types: [] } }, 'src')).toThrow(
      'no platform problem types',
    );
  });
});

describe('header contracts', () => {
  const sources = { export: 'e', transport: 't', validation: 'v' };

  it('combines exported names with the unexported limits and patterns', () => {
    const out = buildHeaders(exported, transportGo, validationGo, sources);
    expect(out.identity).toEqual({ userId: 'x-user-id', tenantId: 'x-tenant-id', tenantRoles: 'x-tenant-roles' });
    expect(out.limits).toEqual({
      headerValueMaxBytes: 256,
      requestIdMaxBytes: 128,
      roleMaxBytes: 64,
      rolesHeaderMaxBytes: 4096,
      maxRoles: 64,
    });
    expect(out.patterns).toEqual({ requestId: '^[a-zA-Z0-9._-]+$', roleToken: '^[a-zA-Z0-9_-]+$' });
  });

  it('fails when the internal request-id limit disagrees with the public one', () => {
    const other = { ...exported, problem: { ...exported.problem, maxRequestIdLength: 64 } };
    expect(() => buildHeaders(other, transportGo, validationGo, sources)).toThrow('differs from problem.MaxRequestIDLength');
  });

  it('fails loudly when a constant is missing or duplicated upstream', () => {
    expect(() => extractGoIntConsts('MaxRoles = 1', ['MaxRoleLen'], 'f.go')).toThrow('found 0');
    expect(() => extractGoIntConsts('MaxRoles = 1\nMaxRoles = 2', ['MaxRoles'], 'f.go')).toThrow('found 2');
  });

  it('fails loudly when a regexp is missing', () => {
    expect(() => extractGoRegexp('var other = regexp.MustCompile(`x`)', 'requestIDPattern', 'f.go')).toThrow('found 0');
  });
});

describe('log field contracts', () => {
  it('lists the request log fields in source order', () => {
    expect(extractLogFieldKeys(loggingGo, 'f.go')).toEqual(['trace_id', 'request_id', 'path']);
    expect(buildLogFields(loggingGo, 'f.go').correlation).toEqual({ traceId: 'trace_id', requestId: 'request_id' });
  });

  it('fails when the fields map or a correlation field is gone', () => {
    expect(() => extractLogFieldKeys('nothing here', 'f.go')).toThrow('fields map not found');
    expect(() => buildLogFields(loggingGo.replace('"request_id"', '"req_id"'), 'f.go')).toThrow('no request_id field');
  });
});

it('writes stable, newline-terminated JSON', () => {
  expect(toJsonText({ a: 1 })).toBe('{\n  "a": 1\n}\n');
});

const sanitizerGo = `
var sensitiveLogKeys = map[string]struct{}{
	"authorization": {},
	"session_id":    {},
}

func Sanitize(fields map[string]interface{}) map[string]interface{} {
	for k, v := range fields {
		if isSensitiveLogKey(k) {
			out[k] = "[REDACTED]"
			continue
		}
	}
}

func SanitizeString(s string) string {
	const maxLen = 256
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

func isSensitiveLogKey(key string) bool {
	k := strings.ToLower(strings.TrimSpace(key))
	return strings.Contains(k, "password") ||
		strings.Contains(k, "token") ||
		k == "key" || strings.HasSuffix(k, "_key")
}`;

describe('redaction contract', () => {
  it('reads every piece of the rule from the Go source', () => {
    expect(buildRedaction(sanitizerGo, 'f.go')).toEqual({
      _generated: expect.any(String),
      exactKeys: ['authorization', 'session_id'],
      substrings: ['password', 'token'],
      keySuffix: '_key',
      redacted: '[REDACTED]',
      stringMaxBytes: 256,
    });
  });

  it.each([
    ['the exact-key map', (s: string) => s.replace('var sensitiveLogKeys', 'var otherKeys'), 'sensitiveLogKeys not found'],
    ['the substrings', (s: string) => s.replaceAll('strings.Contains', 'contains'), 'no sensitive substrings'],
    ['the *_key rule', (s: string) => s.replace('strings.HasSuffix(k, "_key")', 'false'), 'key / *_key rule changed'],
    ['key normalisation', (s: string) => s.replace('strings.ToLower(strings.TrimSpace(key))', 'key'), 'normalisation'],
    ['the placeholder', (s: string) => s.replace('"[REDACTED]"', '"***"'), 'placeholder not found'],
    ['the length limit', (s: string) => s.replace('const maxLen = 256', 'const limit = 256'), 'maxLen not found'],
    ['control stripping', (s: string) => s.replace('unicode.IsControl(r)', 'r == 0'), 'no longer strips'],
  ])('fails when %s changes upstream', (_, mutate, message) => {
    expect(() => buildRedaction(mutate(sanitizerGo), 'f.go')).toThrow(message);
  });
});

describe('generated TypeScript constants', () => {
  it('emits as-const literals without the _generated headers', () => {
    const ts = buildTsConstants({ A: { _generated: 'x', list: ['a', 'b'] }, B: 3 }, ['src.json']);
    expect(ts).toContain('// Generated by scripts/sync-contracts.ts from src.json.');
    expect(ts).toContain('export const A = {\n  "list": [\n    "a",\n    "b"\n  ]\n} as const;');
    expect(ts).toContain('export const B = 3 as const;');
    expect(ts).not.toContain('_generated');
  });
});

const extensionsGo = `
var extensionNamePattern = regexp.MustCompile(\`^[A-Za-z][A-Za-z0-9_]{2,}$\`)

var standardMembers = []string{
	"type", "title", "status",
}`;
const clientGo = 'const MaxClientBodyBytes = 1 << 20\n';
const typesGo = `
var (
	slugPattern = regexp.MustCompile(\`^[a-z]+$\`)
	codePattern = regexp.MustCompile(\`^[A-Z]+$\`)
)`;
const ruleSources = { extensions: 'e.go', client: 'c.go', types: 't.go' };

describe('problem rules', () => {
  it('reads members, patterns and the body cap from the Go sources', () => {
    expect(buildProblemRules(extensionsGo, clientGo, typesGo, ruleSources)).toEqual({
      standardMembers: ['type', 'title', 'status'],
      extensionNamePattern: '^[A-Za-z][A-Za-z0-9_]{2,}$',
      maxClientBodyBytes: 1048576,
      slugPattern: '^[a-z]+$',
      codePattern: '^[A-Z]+$',
    });
    expect(buildProblemRules(extensionsGo, 'const MaxClientBodyBytes = 4096\n', typesGo, ruleSources).maxClientBodyBytes).toBe(4096);
  });

  it('fails when the cap becomes an expression it cannot read', () => {
    expect(() => buildProblemRules(extensionsGo, 'const MaxClientBodyBytes = 1 * MiB\n', typesGo, ruleSources)).toThrow('MaxClientBodyBytes');
  });

  it('adds the rules to problem-types.json and names platform types for PlatformProblemTypes', () => {
    const rules = buildProblemRules(extensionsGo, clientGo, typesGo, ruleSources);
    expect(buildProblemTypes(exported, 'src', rules, ['rules-src']).rules).toBe(rules);
    expect(pascalCase('not-found')).toBe('NotFound');
    expect(pascalCase('business-rule-violation')).toBe('BusinessRuleViolation');
    expect(pascalCase('conflict')).toBe('Conflict');
  });
});

const decisionGo = `
const (
	DenyUnresolvableSubject DenyReason = "DENY_UNRESOLVABLE_SUBJECT"
	DenyMFAStale            DenyReason = "DENY_MFA_STALE"
	DenyMalformedIdentity   DenyReason = "DENY_MALFORMED_IDENTITY"
	DenyServiceUnavailable  DenyReason = "DENY_SERVICE_UNAVAILABLE"
)

func (r DenyReason) HTTPStatus() int {
	switch r {
	case DenyMalformedIdentity:
		return 401
	case DenyServiceUnavailable:
		return 503
	case DenyUnresolvableSubject:
		return 403
	default:
		return 403
	}
}`;
const pinnedTest = `
func TestDenyCodes_Pinned(t *testing.T) {
	cases := []struct{}{
		{domain.DenyUnresolvableSubject, "DENY_UNRESOLVABLE_SUBJECT", 403},
		{domain.DenyMFAStale, "DENY_MFA_STALE", 403},
		{domain.DenyMalformedIdentity, "DENY_MALFORMED_IDENTITY", 401},
		{domain.DenyServiceUnavailable, "DENY_SERVICE_UNAVAILABLE", 503},
	}
}`;
const denySources = { decision: 'd.go', test: 'd_test.go' };

describe('gateway deny codes', () => {
  it('reads codes and statuses (with the default) and checks them against the pinned test', () => {
    expect(buildGatewayDenyCodes(decisionGo, pinnedTest, denySources).codes).toEqual([
      { code: 'DENY_UNRESOLVABLE_SUBJECT', status: 403 },
      { code: 'DENY_MFA_STALE', status: 403 },
      { code: 'DENY_MALFORMED_IDENTITY', status: 401 },
      { code: 'DENY_SERVICE_UNAVAILABLE', status: 503 },
    ]);
  });

  it('fails when a reason is added without a pin', () => {
    const added = decisionGo.replace(')\n', '\tDenyNew DenyReason = "DENY_NEW"\n)\n');
    expect(() => buildGatewayDenyCodes(added, pinnedTest, denySources)).toThrow('disagree');
  });

  it('fails when a status changes without the pin', () => {
    const changed = decisionGo.replace('return 401', 'return 403');
    expect(() => buildGatewayDenyCodes(changed, pinnedTest, denySources)).toThrow('disagree');
  });

  it('fails when the constants are gone', () => {
    expect(() => buildGatewayDenyCodes('const (\n)\n', pinnedTest, denySources)).toThrow('no DenyReason constants');
  });
});

describe('gateway injected headers', () => {
  const go = `
// InjectedHeaders are the trust-boundary headers this service injects on Allow.
const (
	HeaderTenantID     = "x-tenant-id"
	// a comment line
	HeaderUserID       = "x-user-id"
	HeaderPlan         = "x-plan"
)`;

  it('lists the headers in source order', () => {
    expect(buildGatewayHeaders(go, 'd.go').injected).toEqual(['x-tenant-id', 'x-user-id', 'x-plan']);
  });

  it('fails when the block or its headers are gone', () => {
    expect(() => buildGatewayHeaders('const ()', 'd.go')).toThrow('InjectedHeaders not found');
    expect(() => buildGatewayHeaders('// InjectedHeaders\nconst (\n)', 'd.go')).toThrow('no injected headers');
  });
});

describe('IAM response cases (swagger)', () => {
  const swagger: Swagger = {
    basePath: '/api/v1',
    paths: {
      '/x': { get: { responses: { '200': { schema: { $ref: '#/definitions/http.X' } } } } },
      '/none': { get: { responses: { '400': {} } } },
    },
    definitions: {
      'http.X': {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', example: 'e' },
          kind: { type: 'string', enum: ['a', 'b'] },
          n: { type: 'integer' },
          items: { type: 'array', items: { $ref: '#/definitions/http.Item' } },
        },
      },
      'http.Item': { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    },
  };
  const ok = { name: 'ok', response: { id: '0b7e4c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d', kind: 'a', n: 1, items: [{ ok: true }] } };

  it('inlines $refs and drops examples', () => {
    expect(inlineSwaggerSchema({ $ref: '#/definitions/http.X' }, swagger.definitions).properties!.items).toEqual({
      type: 'array',
      items: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    });
    expect(() => inlineSwaggerSchema({ $ref: '#/definitions/nope' }, swagger.definitions)).toThrow('not defined');
  });

  it('accepts fitting cases and records the full path', () => {
    const out = buildResponseCases(swagger, '/x', [ok], 'org swagger.json');
    expect(out.path).toBe('/api/v1/x');
    expect(out.cases).toEqual([ok]);
  });

  it.each([
    ['an unknown field', { extra: 1 }, '$.extra: not in the schema'],
    ['a bad enum', { kind: 'c' }, 'is not one of'],
    ['a bad uuid', { id: 'nope' }, '$.id: not a uuid'],
    ['a non-integer', { n: 1.5 }, '$.n: not an integer'],
    ['a missing required field', { items: [{}] }, '$.items[0].ok: required'],
    ['a wrong type', { items: {} }, '$.items: not an array'],
  ])('rejects %s', (_n, response, message) => {
    expect(() => buildResponseCases(swagger, '/x', [{ name: 'bad', response }], 'org swagger.json')).toThrow(message);
  });

  it('fails without a 200 schema, and on duplicate case names', () => {
    expect(() => buildResponseCases(swagger, '/none', [], 's')).toThrow('no 200 schema');
    expect(() => buildResponseCases(swagger, '/x', [ok, ok], 's')).toThrow('duplicated');
  });

  it('the SDK cases have unique names and an expected value each', () => {
    for (const cases of [TENANT_RESOLVE_CASES, SESSION_CONTEXT_CASES] as { name: string; expected: unknown }[][]) {
      expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
      for (const c of cases) expect(c.expected).not.toBeUndefined();
    }
  });
});

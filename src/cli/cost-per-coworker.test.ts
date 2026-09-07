import { afterEach, describe, expect, it } from 'vitest';

import {
  aggregateCoworkerCosts,
  buildCoworkerCostSql,
  parseCoworkerRows,
  periodToInterval,
  readCostPerCoworker,
} from './cost-per-coworker.js';

describe('periodToInterval', () => {
  it('maps day/hour shorthands to a Postgres interval literal', () => {
    expect(periodToInterval('30d')).toBe('30 days');
    expect(periodToInterval('24h')).toBe('24 hours');
    expect(periodToInterval('7 d')).toBe('7 days');
  });
  it('returns null when absent', () => {
    expect(periodToInterval(undefined)).toBeNull();
    expect(periodToInterval('')).toBeNull();
  });
  it('rejects malformed periods rather than ignoring them', () => {
    expect(() => periodToInterval('30 days')).toThrow(/--period/);
    expect(() => periodToInterval('abc')).toThrow(/--period/);
    expect(() => periodToInterval('30m')).toThrow(/--period/);
    expect(() => periodToInterval('1; drop table request_logs')).toThrow(/--period/);
  });
});

describe('buildCoworkerCostSql', () => {
  it('aggregates body usage per coworker × api × model, over successful non-count_tokens calls', () => {
    const sql = buildCoworkerCostSql({ intervalSql: null, groupId: null });
    expect(sql).toContain("r.extra_data ? 'x-litellm-response-cost-original' OR r.extra_data ? 'usage_source'");
    expect(sql).toContain("a.identifier LIKE 'ag-%'");
    expect(sql).toContain('r.status BETWEEN 200 AND 299');
    expect(sql).toContain("r.path NOT LIKE '%/count_tokens%'");
    expect(sql).toContain('JOIN agents a ON a.id = r.agent_id');
    expect(sql).toContain("count(*) FILTER (WHERE r.extra_data ? 'usage_input_tokens')");
    expect(sql).toContain("sum((r.extra_data->>'usage_cache_creation_1h_input_tokens')::bigint)");
    // flat cache-write tokens only from calls WITHOUT a TTL split (else double-counted)
    expect(sql).toContain("FILTER (WHERE NOT (r.extra_data ? 'usage_cache_creation_5m_input_tokens'))");
    expect(sql).toContain("GROUP BY a.identifier, a.name, r.extra_data->>'usage_api', r.extra_data->>'usage_model'");
    expect(sql).not.toContain('interval');
    expect(sql).not.toContain('a.identifier =');
  });
  it('adds a time window from a validated interval', () => {
    expect(buildCoworkerCostSql({ intervalSql: '7 days', groupId: null })).toContain(
      "r.created_at > now() - interval '7 days'",
    );
  });
  it('adds an equality filter only for an ag- id', () => {
    expect(buildCoworkerCostSql({ intervalSql: null, groupId: 'ag-1778288632732-akb54b' })).toContain(
      "a.identifier = 'ag-1778288632732-akb54b'",
    );
  });
});

// psql -tAc rows: identifier|name|usage_api|usage_model|calls|usage_calls|in|out|cache_read|cc_flat|cc_5m|cc_1h|header_usd
const ROWS = [
  'ag-1|Orchestrator|anthropic_messages_v1|claude-sonnet-5|10|10|1000000|100000|0|0|0|0|0.5',
  'ag-1|Orchestrator|||5|0|0|0|0|0|0|0|0.25', // header-only rows (before the body-usage gateway) → UNKNOWN
  'ag-2|slang-fixer|openai_responses_v1|gpt-5.6-sol-global|4|4|1000000|10000|400000|0|0|0|0.0',
  'ag-2|slang-fixer|anthropic_messages_v1|claude-ultra-9|2|2|100|10|0|0|0|0|0', // unpriced model → UNKNOWN
  'ag-3|Slang CI Babysitter|anthropic_messages_v1|anthropic.claude-haiku-4-5-20251001-v1:0|3|3|0|0|0|1000000|0|0|0.01',
].join('\n');

describe('parseCoworkerRows', () => {
  it('parses the 13-column aggregate, coercing numbers', () => {
    const rows = parseCoworkerRows(ROWS + '\n\n  \n');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      groupId: 'ag-1',
      name: 'Orchestrator',
      usageApi: 'anthropic_messages_v1',
      model: 'claude-sonnet-5',
      calls: 10,
      usageCalls: 10,
      input: 1000000,
      output: 100000,
      cacheRead: 0,
      cacheCreateFlat: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      headerUsd: 0.5,
    });
    expect(rows[1]).toMatchObject({
      groupId: 'ag-1',
      usageApi: '',
      model: '',
      calls: 5,
      usageCalls: 0,
      headerUsd: 0.25,
    });
  });
  it('skips malformed / non-ag lines and tolerates empty numeric cells', () => {
    const raw = [
      'garbage',
      'not-ag|x|||1|0|0|0|0|0|0|0|0',
      'ag-3||anthropic_messages_v1|m|5|5|||||||',
      'ag-4|n|a|m|nan|1|1|1|1|1|1|1|1',
    ].join('\n');
    const rows = parseCoworkerRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ groupId: 'ag-3', calls: 5, usageCalls: 5, input: 0, headerUsd: 0 });
  });
});

describe('aggregateCoworkerCosts', () => {
  const folderById = new Map([
    ['ag-1', 'orchestrator'],
    ['ag-2', 'slang-fixer'],
  ]);
  it('prices usage buckets with the NanoClaw table and books everything else as UNKNOWN', () => {
    const out = aggregateCoworkerCosts(parseCoworkerRows(ROWS), folderById);
    expect(out.map((c) => c.groupId)).toEqual(['ag-2', 'ag-1', 'ag-3']); // by costUsd desc
    const [fixer, orch, ci] = out;
    // OpenAI: input INCLUDES cached → 600k×5e-6 + 400k×5e-7 + 10k×3e-5 = 3.5 ; claude-ultra-9 unpriced
    expect(fixer).toMatchObject({
      folder: 'slang-fixer',
      calls: 6,
      pricedCalls: 4,
      unknownCalls: 2,
      costUsd: 3.5,
      headerCostUsd: 0,
      unpricedModels: ['claude-ultra-9'],
    });
    expect(fixer.tokens).toEqual({ input: 1000100, output: 10010, cacheRead: 400000, cacheCreate: 0 });
    // Anthropic sonnet-5: 1M×2e-6 + 100k×10e-6 = 3.0 ; the 5 header-only calls are UNKNOWN, never $0
    expect(orch).toMatchObject({
      folder: 'orchestrator',
      calls: 15,
      pricedCalls: 10,
      unknownCalls: 5,
      costUsd: 3,
      headerCostUsd: 0.75,
    });
    // raw Bedrock id resolves; flat cache-write 1M × 1.25e-6
    expect(ci).toMatchObject({
      folder: null,
      name: 'Slang CI Babysitter',
      calls: 3,
      pricedCalls: 3,
      unknownCalls: 0,
      costUsd: 1.25,
    });
    expect(ci.tokens.cacheCreate).toBe(1000000);
  });
  it('returns an empty list for no rows', () => {
    expect(aggregateCoworkerCosts([], folderById)).toEqual([]);
  });
});

const ORIG = process.env.ONECLI_PG_CONTAINER;
afterEach(() => {
  if (ORIG === undefined) delete process.env.ONECLI_PG_CONTAINER;
  else process.env.ONECLI_PG_CONTAINER = ORIG;
});

describe('readCostPerCoworker', () => {
  const folderById = new Map([
    ['ag-1', 'orchestrator'],
    ['ag-2', 'slang-fixer'],
  ]);

  it('reports configured:false (a no-op) when ONECLI_PG_CONTAINER is unset', async () => {
    delete process.env.ONECLI_PG_CONTAINER;
    const out = await readCostPerCoworker({}, { folderById, runPsql: async () => 'should-not-run' });
    expect(out.configured).toBe(false);
    expect(out.captured).toBe(false);
    expect(out.coworkers).toEqual([]);
    expect(out.basis).toBe('body-usage-tokens-x-nanoclaw-rates');
    expect(out.note).toMatch(/ONECLI_PG_CONTAINER/);
  });

  it('prices, totals, counts UNKNOWN calls, echoes the period and explains the unknowns', async () => {
    process.env.ONECLI_PG_CONTAINER = 'onecli-test-postgres-1';
    let seenSql = '';
    const out = await readCostPerCoworker(
      { period: '30d' },
      {
        folderById,
        runPsql: async (sql) => {
          seenSql = sql;
          return ROWS + '\n';
        },
      },
    );
    expect(seenSql).toContain("interval '30 days'");
    expect(out.configured).toBe(true);
    expect(out.captured).toBe(true);
    expect(out.period).toBe('30d');
    expect(out.coworkers.map((c) => [c.groupId, c.costUsd, c.unknownCalls])).toEqual([
      ['ag-2', 3.5, 2],
      ['ag-1', 3, 5],
      ['ag-3', 1.25, 0],
    ]);
    expect(out.totalUsd).toBeCloseTo(7.75, 6);
    expect(out.headerTotalUsd).toBeCloseTo(0.76, 6);
    expect(out.unknownCalls).toBe(7);
    expect(out.note).toMatch(/7 calls have UNKNOWN cost/);
    expect(out.note).toMatch(/NOT \$0/);
    expect(out.note).toMatch(/not backfilled/);
  });

  it('captured:false with a hint naming both gateway flags when nothing was logged', async () => {
    process.env.ONECLI_PG_CONTAINER = 'onecli-test-postgres-1';
    const out = await readCostPerCoworker({}, { folderById, runPsql: async () => '\n' });
    expect(out.configured).toBe(true);
    expect(out.captured).toBe(false);
    expect(out.note).toMatch(/ONECLI_CAPTURE_RESPONSE_HEADERS/);
    expect(out.note).toMatch(/ONECLI_CAPTURE_BODY_USAGE_HOSTS/);
  });

  it('surfaces a malformed --period as an error', async () => {
    process.env.ONECLI_PG_CONTAINER = 'onecli-test-postgres-1';
    await expect(readCostPerCoworker({ period: 'nonsense' }, { folderById, runPsql: async () => '' })).rejects.toThrow(
      /--period/,
    );
  });
});

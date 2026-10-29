import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCaseAssertions,
  evaluateSingleAssertion,
} from '../../src/server/modules/evals/eval-harness';
import {
  formatSseEventFrame,
  InvalidSseCursorError,
  parseLastEventIdCursor,
} from '../../src/server/modules/runs/sse-stream';

test('EVAL-001: exact_match and contains graders handle case sensitivity and whitespace', () => {
  const exactPass = evaluateSingleAssertion(
    { type: 'exact_match', expected: '42', ignoreCase: false },
    { actualOutput: '  42 \n', citations: [], calledTools: [] }
  );
  assert.equal(exactPass.passed, true);

  const exactFail = evaluateSingleAssertion(
    { type: 'exact_match', expected: 'Approved', ignoreCase: false },
    { actualOutput: 'approved', citations: [], calledTools: [] }
  );
  assert.equal(exactFail.passed, false);

  const exactIgnoreCase = evaluateSingleAssertion(
    { type: 'exact_match', expected: 'Approved', ignoreCase: true },
    { actualOutput: 'approved', citations: [], calledTools: [] }
  );
  assert.equal(exactIgnoreCase.passed, true);

  const containsPass = evaluateSingleAssertion(
    { type: 'contains', expectedSubstring: 'result is 144', ignoreCase: true },
    {
      actualOutput: 'The calculated RESULT IS 144 based on the tool output.',
      citations: [],
      calledTools: ['calculator'],
    }
  );
  assert.equal(containsPass.passed, true);
});

test('EVAL-001: json_schema grader validates required keys, primitive field types, and fenced JSON blocks', () => {
  const fencedJson = '```json\n{"decision":"approve","riskScore":12,"tags":["low"]}\n```';

  const schemaPass = evaluateSingleAssertion(
    {
      type: 'json_schema',
      requiredKeys: ['decision', 'riskScore', 'tags'],
      fieldTypes: {
        decision: 'string',
        riskScore: 'number',
        tags: 'array',
      },
    },
    { actualOutput: fencedJson, citations: [], calledTools: [] }
  );
  assert.equal(schemaPass.passed, true);

  const missingKeyFail = evaluateSingleAssertion(
    {
      type: 'json_schema',
      requiredKeys: ['decision', 'approverId'],
    },
    { actualOutput: fencedJson, citations: [], calledTools: [] }
  );
  assert.equal(missingKeyFail.passed, false);
  assert.match(missingKeyFail.message, /approverId/);

  const wrongTypeFail = evaluateSingleAssertion(
    {
      type: 'json_schema',
      requiredKeys: ['riskScore'],
      fieldTypes: { riskScore: 'boolean' },
    },
    { actualOutput: fencedJson, citations: [], calledTools: [] }
  );
  assert.equal(wrongTypeFail.passed, false);
  assert.match(wrongTypeFail.message, /expected type "boolean", got "number"/);
});

test('EVAL-001: citation_required and tool_called graders verify grounded provenance and tool traces', () => {
  const citationPass = evaluateSingleAssertion(
    {
      type: 'citation_required',
      minCitations: 1,
      documentId: 'doc-soc2',
      chunkId: 'chunk-soc2-0',
    },
    {
      actualOutput: 'Rotating keys every 90 days is required [chunk-soc2-0].',
      citations: [
        {
          chunkId: 'chunk-soc2-0',
          documentId: 'doc-soc2',
          documentTitle: 'SOC2 Security Policy',
          quote: 'API keys must be rotated every 90 days.',
        },
      ],
      calledTools: ['knowledge_search'],
    }
  );
  assert.equal(citationPass.passed, true);

  const citationFail = evaluateSingleAssertion(
    {
      type: 'citation_required',
      minCitations: 2,
    },
    {
      actualOutput: 'Only one citation attached.',
      citations: [
        {
          chunkId: 'chunk-soc2-0',
          documentId: 'doc-soc2',
          documentTitle: 'SOC2 Security Policy',
          quote: 'API keys must be rotated every 90 days.',
        },
      ],
      calledTools: ['knowledge_search'],
    }
  );
  assert.equal(citationFail.passed, false);

  const toolPass = evaluateSingleAssertion(
    { type: 'tool_called', toolName: 'calculator' },
    {
      actualOutput: '42',
      citations: [],
      calledTools: ['calculator'],
    }
  );
  assert.equal(toolPass.passed, true);

  const toolFail = evaluateSingleAssertion(
    { type: 'tool_called', toolName: 'knowledge_search' },
    {
      actualOutput: '42',
      citations: [],
      calledTools: ['calculator'],
    }
  );
  assert.equal(toolFail.passed, false);
});

test('EVAL-001: evaluateCaseAssertions computes fractional score and strict overall pass flag', () => {
  const summary = evaluateCaseAssertions(
    [
      { type: 'contains', expectedSubstring: '144' },
      { type: 'tool_called', toolName: 'calculator' },
      { type: 'citation_required', minCitations: 1 },
    ],
    {
      actualOutput: 'The answer is 144.',
      citations: [],
      calledTools: ['calculator'],
    }
  );

  assert.equal(summary.passed, false);
  assert.equal(summary.score, 0.6667);
  assert.equal(summary.assertionResults.length, 3);
});

test('SSE-001: parseLastEventIdCursor prioritizes Last-Event-ID header and rejects malformed cursors', () => {
  assert.equal(
    parseLastEventIdCursor({
      lastEventIdHeader: '7',
      afterSequenceParam: '2',
    }),
    7
  );
  assert.equal(
    parseLastEventIdCursor({
      lastEventIdHeader: null,
      afterSequenceParam: '4',
    }),
    4
  );
  assert.equal(parseLastEventIdCursor({}), 0);

  assert.throws(
    () => parseLastEventIdCursor({ lastEventIdHeader: '-1' }),
    (err: unknown) => err instanceof InvalidSseCursorError && err.statusCode === 400
  );
  assert.throws(
    () => parseLastEventIdCursor({ afterSequenceParam: 'abc' }),
    (err: unknown) => err instanceof InvalidSseCursorError && err.statusCode === 400
  );
});

test('SSE-001: formatSseEventFrame emits standard id, event, and JSON data wire format', () => {
  const frame = formatSseEventFrame({
    id: 'evt-1',
    organizationId: 'org-1',
    runId: 'run-1',
    sequenceNo: 3,
    eventType: 'step.model_completed',
    payload: { stepIndex: 1, status: 'succeeded' },
    createdAt: new Date('2026-10-29T12:00:00.000Z'),
  });

  assert.match(frame, /^id: 3\nevent: step\.model_completed\ndata: /);
  assert.ok(frame.endsWith('\n\n'));
  const dataLine = frame
    .split('\n')
    .find((line) => line.startsWith('data: '))!;
  const parsed = JSON.parse(dataLine.slice('data: '.length));
  assert.equal(parsed.sequenceNo, 3);
  assert.equal(parsed.eventType, 'step.model_completed');
  assert.deepEqual(parsed.payload, { stepIndex: 1, status: 'succeeded' });
});

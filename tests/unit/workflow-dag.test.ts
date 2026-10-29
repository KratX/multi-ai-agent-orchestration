import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkflowGraphSpec } from '../../src/server/db/schema/workflows';
import {
  computeWorkflowSnapshotHash,
  evaluateWorkflowCondition,
  validateWorkflowDag,
} from '../../src/server/modules/workflows/dag-validator';

test('WORKFLOW-001: validateWorkflowDag accepts a valid branching DAG and returns topological order', () => {
  const graph: WorkflowGraphSpec = {
    nodes: [
      { id: 'start-1', kind: 'start', label: 'Start' },
      {
        id: 'tool-calc',
        kind: 'tool',
        label: 'Calculate Risk Score',
        toolName: 'calculator',
        toolInput: { expression: '45 * 3' },
      },
      {
        id: 'cond-high-risk',
        kind: 'condition',
        label: 'Is Score > 100?',
        condition: { field: 'lastOutput', operator: 'gt', value: 100 },
      },
      {
        id: 'approval-sec',
        kind: 'approval',
        label: 'Security Lead Sign-off',
        approvalTitle: 'Approve High-Risk Action',
        approvalReason: 'Calculated score exceeds 100 threshold',
      },
      {
        id: 'agent-summary',
        kind: 'agent',
        label: 'Final Summary Agent',
      },
      { id: 'end-1', kind: 'end', label: 'Complete' },
    ],
    edges: [
      { id: 'e1', source: 'start-1', target: 'tool-calc' },
      { id: 'e2', source: 'tool-calc', target: 'cond-high-risk' },
      {
        id: 'e3',
        source: 'cond-high-risk',
        target: 'approval-sec',
        conditionLabel: 'true',
      },
      {
        id: 'e4',
        source: 'cond-high-risk',
        target: 'agent-summary',
        conditionLabel: 'false',
      },
      { id: 'e5', source: 'approval-sec', target: 'agent-summary' },
      { id: 'e6', source: 'agent-summary', target: 'end-1' },
    ],
  };

  const result = validateWorkflowDag(graph);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.topologicalOrder[0], 'start-1');
  assert.equal(
    result.topologicalOrder[result.topologicalOrder.length - 1],
    'end-1'
  );
  assert.ok(
    result.topologicalOrder.indexOf('cond-high-risk') <
      result.topologicalOrder.indexOf('approval-sec')
  );
  assert.ok(
    result.topologicalOrder.indexOf('approval-sec') <
      result.topologicalOrder.indexOf('agent-summary')
  );
});

test('WORKFLOW-001: validateWorkflowDag detects directed cycles and reports exact cyclePath', () => {
  const cyclicGraph: WorkflowGraphSpec = {
    nodes: [
      { id: 'start-1', kind: 'start', label: 'Start' },
      { id: 'agent-a', kind: 'agent', label: 'Agent A' },
      { id: 'agent-b', kind: 'agent', label: 'Agent B' },
      { id: 'end-1', kind: 'end', label: 'End' },
    ],
    edges: [
      { id: 'e1', source: 'start-1', target: 'agent-a' },
      { id: 'e2', source: 'agent-a', target: 'agent-b' },
      { id: 'e3', source: 'agent-b', target: 'agent-a' },
      { id: 'e4', source: 'agent-b', target: 'end-1' },
    ],
  };

  const result = validateWorkflowDag(cyclicGraph);
  assert.equal(result.valid, false);
  assert.ok(result.cyclePath);
  assert.deepEqual(result.cyclePath, ['agent-a', 'agent-b', 'agent-a']);
  assert.ok(
    result.errors.some((e) => e.includes('agent-a -> agent-b -> agent-a'))
  );
});

test('WORKFLOW-001: validateWorkflowDag rejects self-loops immediately', () => {
  const selfLoopGraph: WorkflowGraphSpec = {
    nodes: [
      { id: 'start-1', kind: 'start', label: 'Start' },
      { id: 'agent-a', kind: 'agent', label: 'Agent A' },
      { id: 'end-1', kind: 'end', label: 'End' },
    ],
    edges: [
      { id: 'e1', source: 'start-1', target: 'agent-a' },
      { id: 'e2', source: 'agent-a', target: 'agent-a' },
      { id: 'e3', source: 'agent-a', target: 'end-1' },
    ],
  };

  const result = validateWorkflowDag(selfLoopGraph);
  assert.equal(result.valid, false);
  assert.deepEqual(result.cyclePath, ['agent-a', 'agent-a']);
});

test('WORKFLOW-001: validateWorkflowDag rejects unreachable orphan nodes and dead-end nodes', () => {
  const brokenGraph: WorkflowGraphSpec = {
    nodes: [
      { id: 'start-1', kind: 'start', label: 'Start' },
      { id: 'agent-main', kind: 'agent', label: 'Main Agent' },
      { id: 'agent-orphan', kind: 'agent', label: 'Orphan Node' },
      { id: 'agent-deadend', kind: 'agent', label: 'Dead End Node' },
      { id: 'end-1', kind: 'end', label: 'End' },
    ],
    edges: [
      { id: 'e1', source: 'start-1', target: 'agent-main' },
      { id: 'e2', source: 'agent-main', target: 'end-1' },
      { id: 'e3', source: 'start-1', target: 'agent-deadend' },
      { id: 'e4', source: 'agent-orphan', target: 'end-1' },
    ],
  };

  const result = validateWorkflowDag(brokenGraph);
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((err) =>
      err.includes('Node "agent-orphan" is unreachable from start node')
    )
  );
  assert.ok(
    result.errors.some((err) =>
      err.includes(
        'Node "agent-deadend" is a dead-end with no directed path to any end node'
      )
    )
  );
});

test('WORKFLOW-002: evaluateWorkflowCondition evaluates operators deterministically and blocks prototype traversal', () => {
  const state = {
    lastOutput: '135',
    severity: 'critical-incident',
    metrics: { confidence: 0.92 },
  };

  assert.equal(
    evaluateWorkflowCondition(
      { field: 'lastOutput', operator: 'gt', value: 100 },
      state
    ),
    true
  );
  assert.equal(
    evaluateWorkflowCondition(
      { field: 'metrics.confidence', operator: 'lt', value: 0.5 },
      state
    ),
    false
  );
  assert.equal(
    evaluateWorkflowCondition(
      { field: 'severity', operator: 'contains', value: 'CRITICAL' },
      state
    ),
    true
  );
  assert.equal(
    evaluateWorkflowCondition(
      { field: '__proto__.toString', operator: 'equals', value: 'anything' },
      state
    ),
    false
  );
});

test('WORKFLOW-001: computeWorkflowSnapshotHash is canonical across node/edge reordering', () => {
  const g1: WorkflowGraphSpec = {
    nodes: [
      { id: 'start', kind: 'start', label: 'Start' },
      { id: 'agent', kind: 'agent', label: 'Agent' },
      { id: 'end', kind: 'end', label: 'End' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'agent' },
      { id: 'e2', source: 'agent', target: 'end' },
    ],
  };

  const g2: WorkflowGraphSpec = {
    nodes: [
      { id: 'end', kind: 'end', label: 'End' },
      { id: 'start', kind: 'start', label: 'Start' },
      { id: 'agent', kind: 'agent', label: 'Agent' },
    ],
    edges: [
      { id: 'e2', source: 'agent', target: 'end' },
      { id: 'e1', source: 'start', target: 'agent' },
    ],
  };

  assert.equal(
    computeWorkflowSnapshotHash(g1),
    computeWorkflowSnapshotHash(g2)
  );
});

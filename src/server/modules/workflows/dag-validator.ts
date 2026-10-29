import { createHash } from 'node:crypto';
import {
  CONDITION_OPERATORS,
  WORKFLOW_NODE_KINDS,
  type WorkflowConditionConfig,
  type WorkflowEdgeSpec,
  type WorkflowGraphSpec,
  type WorkflowNodeSpec,
} from '../../db/schema/workflows';

/**
 * Tickets WORKFLOW-001 & WORKFLOW-002: Directed Acyclic Workflow Graph Validator,
 * Cycle Detector, Topological Sorter & Safe Condition Evaluator
 *
 * Enforces Blueprint Section 6 & Threat Model T-04, T-07:
 * - Bounded graph size: `<= 25` nodes and `<= 50` edges per workflow.
 * - Cycle detection via 3-color DFS with exact cycle path diagnostics.
 * - Structural completeness: single `start` root, `>= 1` `end` sink, zero orphan
 *   nodes (unreachable from `start`), and zero dead-end nodes (unable to reach `end`).
 * - Safe deterministic condition evaluation with zero `eval()` or `Function()`.
 */

export const MAX_WORKFLOW_NODES = 25;
export const MAX_WORKFLOW_EDGES = 50;

export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  topologicalOrder: string[];
  cyclePath?: string[];
}

export class WorkflowDagValidationError extends Error {
  public readonly statusCode = 422;
  public readonly code = 'WORKFLOW_DAG_INVALID';
  public readonly errors: string[];
  public readonly cyclePath?: string[];

  constructor(message: string, errors: string[], cyclePath?: string[]) {
    super(message);
    this.name = 'WorkflowDagValidationError';
    this.errors = errors;
    this.cyclePath = cyclePath;
  }
}

/**
 * Validates a workflow directed acyclic graph (`WorkflowGraphSpec`), returning
 * structural errors, cycle paths (if any), and a deterministic topological sort.
 */
export function validateWorkflowDag(
  graph: WorkflowGraphSpec
): DagValidationResult {
  const errors: string[] = [];

  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return {
      valid: false,
      errors: ['Workflow graph must contain nodes and edges arrays.'],
      topologicalOrder: [],
    };
  }

  if (graph.nodes.length === 0) {
    return {
      valid: false,
      errors: ['Workflow graph must contain at least a start and end node.'],
      topologicalOrder: [],
    };
  }

  if (graph.nodes.length > MAX_WORKFLOW_NODES) {
    errors.push(
      `Workflow graph exceeds maximum allowed nodes (${graph.nodes.length} > ${MAX_WORKFLOW_NODES}).`
    );
  }

  if (graph.edges.length > MAX_WORKFLOW_EDGES) {
    errors.push(
      `Workflow graph exceeds maximum allowed edges (${graph.edges.length} > ${MAX_WORKFLOW_EDGES}).`
    );
  }

  const nodeById = new Map<string, WorkflowNodeSpec>();
  for (const node of graph.nodes) {
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    if (!id) {
      errors.push('Every workflow node must have a non-empty string id.');
      continue;
    }
    if (nodeById.has(id)) {
      errors.push(`Duplicate workflow node id "${id}".`);
      continue;
    }
    if (
      !WORKFLOW_NODE_KINDS.includes(
        node.kind as (typeof WORKFLOW_NODE_KINDS)[number]
      )
    ) {
      errors.push(`Node "${id}" has unsupported kind "${String(node.kind)}".`);
    }
    if (!node.label || node.label.trim().length === 0) {
      errors.push(`Node "${id}" must have a non-empty label.`);
    }
    nodeById.set(id, node);
  }

  const outgoingByNode = new Map<string, WorkflowEdgeSpec[]>();
  const incomingByNode = new Map<string, WorkflowEdgeSpec[]>();
  for (const nodeId of nodeById.keys()) {
    outgoingByNode.set(nodeId, []);
    incomingByNode.set(nodeId, []);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    const edgeId = typeof edge.id === 'string' ? edge.id.trim() : '';
    if (!edgeId) {
      errors.push('Every workflow edge must have a non-empty string id.');
    } else if (edgeIds.has(edgeId)) {
      errors.push(`Duplicate workflow edge id "${edgeId}".`);
    } else {
      edgeIds.add(edgeId);
    }

    if (!nodeById.has(edge.source)) {
      errors.push(
        `Edge "${edgeId || '?'}" references unknown source node "${edge.source}".`
      );
      continue;
    }
    if (!nodeById.has(edge.target)) {
      errors.push(
        `Edge "${edgeId || '?'}" references unknown target node "${edge.target}".`
      );
      continue;
    }

    if (edge.source === edge.target) {
      return {
        valid: false,
        errors: [
          ...errors,
          `Self-loop cycle detected on node "${edge.source}".`,
        ],
        topologicalOrder: [],
        cyclePath: [edge.source, edge.target],
      };
    }

    outgoingByNode.get(edge.source)?.push(edge);
    incomingByNode.get(edge.target)?.push(edge);
  }

  // 1. Detect directed cycles via 3-color DFS (0 = unvisited, 1 = visiting, 2 = visited)
  const color = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string>();
  const postOrder: string[] = [];

  for (const nodeId of nodeById.keys()) {
    color.set(nodeId, 0);
  }

  let detectedCycle: string[] | undefined;

  function dfs(currentId: string): boolean {
    color.set(currentId, 1);
    const outgoing = outgoingByNode.get(currentId) ?? [];
    for (const edge of outgoing) {
      const nextId = edge.target;
      const nextColor = color.get(nextId) ?? 0;
      if (nextColor === 1) {
        // Reconstruct cycle path: nextId -> ... -> currentId -> nextId
        const cycle: string[] = [nextId];
        let cursor: string | undefined = currentId;
        const revChain: string[] = [];
        while (cursor && cursor !== nextId) {
          revChain.push(cursor);
          cursor = parent.get(cursor);
        }
        revChain.reverse();
        cycle.push(...revChain, nextId);
        detectedCycle = cycle;
        return true;
      }
      if (nextColor === 0) {
        parent.set(nextId, currentId);
        if (dfs(nextId)) {
          return true;
        }
      }
    }
    color.set(currentId, 2);
    postOrder.push(currentId);
    return false;
  }

  for (const nodeId of nodeById.keys()) {
    if ((color.get(nodeId) ?? 0) === 0) {
      if (dfs(nodeId)) {
        break;
      }
    }
  }

  if (detectedCycle) {
    errors.push(`Directed cycle detected: ${detectedCycle.join(' -> ')}.`);
    return {
      valid: false,
      errors,
      topologicalOrder: [],
      cyclePath: detectedCycle,
    };
  }

  const topologicalOrder = [...postOrder].reverse();

  // 2. Verify start & end node invariants
  const startNodes = [...nodeById.values()].filter((n) => n.kind === 'start');
  const endNodes = [...nodeById.values()].filter((n) => n.kind === 'end');

  if (startNodes.length !== 1) {
    errors.push(
      `Workflow must have exactly 1 start node (found ${startNodes.length}).`
    );
  }

  if (endNodes.length < 1) {
    errors.push('Workflow must have at least 1 end node.');
  }

  for (const startNode of startNodes) {
    const inEdges = incomingByNode.get(startNode.id) ?? [];
    const outEdges = outgoingByNode.get(startNode.id) ?? [];
    if (inEdges.length > 0) {
      errors.push(
        `Start node "${startNode.id}" must have 0 incoming edges (found ${inEdges.length}).`
      );
    }
    if (outEdges.length === 0) {
      errors.push(
        `Start node "${startNode.id}" must have at least 1 outgoing edge.`
      );
    }
  }

  for (const endNode of endNodes) {
    const outEdges = outgoingByNode.get(endNode.id) ?? [];
    const inEdges = incomingByNode.get(endNode.id) ?? [];
    if (outEdges.length > 0) {
      errors.push(
        `End node "${endNode.id}" must have 0 outgoing edges (found ${outEdges.length}).`
      );
    }
    if (inEdges.length === 0) {
      errors.push(
        `End node "${endNode.id}" must have at least 1 incoming edge.`
      );
    }
  }

  // 3. Forward reachability from start node (detect orphan / unreachable nodes)
  if (startNodes.length === 1) {
    const reachableFromStart = new Set<string>();
    const queue: string[] = [startNodes[0].id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachableFromStart.has(current)) continue;
      reachableFromStart.add(current);
      for (const edge of outgoingByNode.get(current) ?? []) {
        if (!reachableFromStart.has(edge.target)) {
          queue.push(edge.target);
        }
      }
    }

    for (const nodeId of nodeById.keys()) {
      if (!reachableFromStart.has(nodeId)) {
        errors.push(`Node "${nodeId}" is unreachable from start node.`);
      }
    }
  }

  // 4. Backward reachability from end nodes (detect dead-end nodes)
  if (endNodes.length >= 1) {
    const canReachEnd = new Set<string>();
    const queue: string[] = endNodes.map((n) => n.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (canReachEnd.has(current)) continue;
      canReachEnd.add(current);
      for (const edge of incomingByNode.get(current) ?? []) {
        if (!canReachEnd.has(edge.source)) {
          queue.push(edge.source);
        }
      }
    }

    for (const node of nodeById.values()) {
      if (node.kind !== 'end' && !canReachEnd.has(node.id)) {
        errors.push(
          `Node "${node.id}" is a dead-end with no directed path to any end node.`
        );
      }
    }
  }

  // 5. Node-kind specific validation (condition nodes, approval nodes, tool nodes)
  for (const node of nodeById.values()) {
    const outEdges = outgoingByNode.get(node.id) ?? [];

    if (node.kind === 'condition') {
      if (!node.condition) {
        errors.push(`Condition node "${node.id}" is missing condition config.`);
      } else {
        if (!node.condition.field || node.condition.field.trim().length === 0) {
          errors.push(
            `Condition node "${node.id}" must specify a non-empty field name.`
          );
        }
        if (
          !CONDITION_OPERATORS.includes(
            node.condition.operator as (typeof CONDITION_OPERATORS)[number]
          )
        ) {
          errors.push(
            `Condition node "${node.id}" has invalid operator "${String(node.condition.operator)}".`
          );
        }
      }

      const labels = new Set(outEdges.map((e) => e.conditionLabel));
      if (!labels.has('true') || !labels.has('false')) {
        errors.push(
          `Condition node "${node.id}" must have outgoing edges for both "true" and "false" branches.`
        );
      }
    }

    if (node.kind === 'approval') {
      if (!node.approvalTitle || node.approvalTitle.trim().length === 0) {
        errors.push(
          `Approval node "${node.id}" must specify a non-empty approvalTitle.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    topologicalOrder: errors.length === 0 ? topologicalOrder : [],
  };
}

/**
 * Throws a `WorkflowDagValidationError` (`422`) if `graph` is not a valid DAG.
 */
export function assertValidWorkflowDag(
  graph: WorkflowGraphSpec
): DagValidationResult {
  const result = validateWorkflowDag(graph);
  if (!result.valid) {
    throw new WorkflowDagValidationError(
      result.errors[0] ?? 'Workflow graph validation failed.',
      result.errors,
      result.cyclePath
    );
  }
  return result;
}

/**
 * Safely resolves a dotted field path (`"metrics.score"` or `"status"`) against
 * a plain state object without prototype traversal.
 */
function resolveSafeFieldPath(
  context: Record<string, unknown>,
  fieldPath: string
): unknown {
  const parts = fieldPath.split('.').map((p) => p.trim());
  let current: unknown = context;
  for (const part of parts) {
    if (
      !part ||
      part === '__proto__' ||
      part === 'constructor' ||
      part === 'prototype'
    ) {
      return undefined;
    }
    if (
      current !== null &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, part)
    ) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Evaluates a workflow condition node deterministically with zero `eval()`.
 */
export function evaluateWorkflowCondition(
  condition: WorkflowConditionConfig,
  context: Record<string, unknown>
): boolean {
  const actual = resolveSafeFieldPath(context, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case 'equals':
      return actual === expected || String(actual) === String(expected);
    case 'not_equals':
      return actual !== expected && String(actual) !== String(expected);
    case 'contains':
      if (typeof actual === 'string') {
        return actual.toLowerCase().includes(String(expected).toLowerCase());
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    case 'gt': {
      const actualNum = Number(actual);
      const expectedNum = Number(expected);
      return (
        Number.isFinite(actualNum) &&
        Number.isFinite(expectedNum) &&
        actualNum > expectedNum
      );
    }
    case 'lt': {
      const actualNum = Number(actual);
      const expectedNum = Number(expected);
      return (
        Number.isFinite(actualNum) &&
        Number.isFinite(expectedNum) &&
        actualNum < expectedNum
      );
    }
    default:
      return false;
  }
}

/**
 * Computes a deterministic canonical SHA-256 snapshot hash for a workflow graph.
 * Sorting nodes and edges by `id` ensures node/edge array reordering does not
 * alter the hash when graph topology and configs are identical.
 */
export function computeWorkflowSnapshotHash(graph: WorkflowGraphSpec): string {
  const canonical = {
    nodes: [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        label: n.label,
        agentVersionId: n.agentVersionId ?? null,
        promptTemplate: n.promptTemplate ?? null,
        toolName: n.toolName ?? null,
        toolInput: n.toolInput ?? null,
        condition: n.condition ?? null,
        approvalTitle: n.approvalTitle ?? null,
        approvalReason: n.approvalReason ?? null,
        allowDeveloperDecision: Boolean(n.allowDeveloperDecision),
      })),
    edges: [...graph.edges]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        conditionLabel: e.conditionLabel ?? null,
      })),
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

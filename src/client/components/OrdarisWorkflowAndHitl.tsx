import React, { useState } from 'react';
import {
  GitBranch,
  Play,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Sparkles,
  Lock,
  ArrowRight,
  Cpu,
  Terminal,
  RefreshCw,
  Check,
  Layers,
  Info,
  Sliders,
} from 'lucide-react';

export interface WorkflowSummaryItem {
  id: string;
  slug: string;
  name: string;
  latestVersionNumber: number;
}

export interface ApprovalQueueItem {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decisionNote: string | null;
  createdAt: string;
}

export interface DagNodeSpec {
  id: string;
  label: string;
  type: 'transform' | 'tool' | 'condition' | 'approval' | 'agent';
  dependsOn: string[];
  description: string;
  configSummary: string;
  securityControl: string;
}

const STANDARD_6_NODE_DAG: DagNodeSpec[] = [
  {
    id: 'input-sanitize',
    label: '1. Input Sanitize',
    type: 'transform',
    dependsOn: [],
    description: 'Normalizes incoming incident/shipment telemetry and strips untrusted control sequences.',
    configSummary: 'transform: trim + normalize whitespace + validate schema envelope',
    securityControl: 'Threat T-03 Input Boundary Normalization',
  },
  {
    id: 'calc-risk',
    label: '2. Deterministic Risk Math',
    type: 'tool',
    dependsOn: ['input-sanitize'],
    description: 'Evaluates quantitative risk score via sandboxed arithmetic tool (`calc_math`).',
    configSummary: 'toolId: "calc_math", expression: riskOverrideExpression || "25 * 6"',
    securityControl: 'Threat T-04 Sandboxed Tool Allowlist + Zod Schema',
  },
  {
    id: 'branch-risk',
    label: '3. Conditional Risk Router',
    type: 'condition',
    dependsOn: ['calc-risk'],
    description: 'Routes execution based on quantitative risk threshold (`risk_score >= 100`).',
    configSummary: 'condition: calc_risk.output >= 100 ? "approval-high-risk" : "agent-summary"',
    securityControl: 'Deterministic Policy Gate Routing',
  },
  {
    id: 'approval-high-risk',
    label: '4. HITL Governance Gate',
    type: 'approval',
    dependsOn: ['branch-risk'],
    description: 'Pauses workflow execution in `waiting_approval` until an Owner or Admin signs off.',
    configSummary: 'requiredRole: ["owner", "admin"], timeoutMinutes: 60',
    securityControl: 'RBAC `approvals:decide` + Immutable Audit Event',
  },
  {
    id: 'agent-summary',
    label: '5. Agent Remediation Plan',
    type: 'agent',
    dependsOn: ['approval-high-risk'],
    description: 'Executes pinned agent snapshot with grounded RAG citations to produce the final action plan.',
    configSummary: 'agentSlug: tenant primary agent, untrustedContextTagging: true',
    securityControl: 'Pinned Agent Snapshot Hash + Citation Verification',
  },
  {
    id: 'notify-audit',
    label: '6. Cryptographic Audit Seal',
    type: 'transform',
    dependsOn: ['agent-summary'],
    description: 'Records final state transition and SHA-256 event hash into the append-only audit ledger.',
    configSummary: 'auditEvent: "workflow.execution.completed", outcome: "allowed"',
    securityControl: 'Append-Only Audit Ledger + Tenant FK',
  },
];

interface OrdarisWorkflowAndHitlProps {
  activeActorId: string;
  activeActorRole: 'owner' | 'admin' | 'developer' | 'viewer';
  activeOrgSlug: string;
  activeOrgName: string;
  workflows: WorkflowSummaryItem[];
  approvals: ApprovalQueueItem[];
  selectedEngine: string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onWorkspaceRefresh: () => Promise<void>;
  onNotify: (message: string, tone?: 'success' | 'error' | 'info') => void;
  onSelectRunToInspect?: (runId: string) => void;
}

export const OrdarisWorkflowAndHitl: React.FC<OrdarisWorkflowAndHitlProps> = ({
  activeActorRole,
  activeOrgSlug,
  activeOrgName,
  workflows,
  approvals,
  selectedEngine,
  apiFetch,
  onWorkspaceRefresh,
  onNotify,
  onSelectRunToInspect,
}) => {
  const isLogistics = activeOrgSlug.includes('beta');

  // Selected workflow & node inspector
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    workflows[0]?.id || '',
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string>('approval-high-risk');

  // Workflow execution preset state
  const [riskPresetMode, setRiskPresetMode] = useState<'high' | 'low' | 'custom'>('high');
  const [customRiskExpr, setCustomRiskExpr] = useState<string>('25 * 6');
  const [workflowTriggerNote, setWorkflowTriggerNote] = useState<string>(
    isLogistics
      ? 'Reefer container BIO-4429 temperature excursion (+6.4C for 47 mins) at Port of Rotterdam.'
      : 'Production containment: Isolate compromised edge subnet 10.42.8.0/24 after anomalous lateral movement.',
  );
  const [executingWorkflow, setExecutingWorkflow] = useState(false);
  const [lastWorkflowResult, setLastWorkflowResult] = useState<{
    status: string;
    runId: string;
    riskScoreLabel: string;
    pausedAtNodeId?: string | null;
    approvalRequestId?: string | null;
    completedNodes: string[];
  } | null>(null);

  // 3-Color DFS DAG Validator state
  const [validatingDag, setValidatingDag] = useState(false);
  const [dagValidationResult, setDagValidationResult] = useState<{
    mode: 'valid_dag' | 'cycle_test';
    valid: boolean;
    topologicalOrder?: string[];
    error?: string;
    nodeCount: number;
  } | null>(null);

  // HITL Approval Queue state
  const [approvalFilter, setApprovalFilter] = useState<'pending' | 'resolved' | 'all'>('pending');
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [batchApproving, setBatchApproving] = useState(false);

  const activeWorkflow =
    workflows.find((w) => w.id === selectedWorkflowId) || workflows[0] || null;
  const inspectedNode =
    STANDARD_6_NODE_DAG.find((n) => n.id === selectedNodeId) || STANDARD_6_NODE_DAG[3];

  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const resolvedApprovals = approvals.filter((a) => a.status !== 'pending');
  const visibleApprovals =
    approvalFilter === 'pending'
      ? pendingApprovals
      : approvalFilter === 'resolved'
        ? resolvedApprovals
        : approvals;

  const canExecuteWorkflow = activeActorRole !== 'viewer';
  const canDecideApproval = activeActorRole === 'owner' || activeActorRole === 'admin';

  const handleSelectPreset = (mode: 'high' | 'low') => {
    setRiskPresetMode(mode);
    if (mode === 'high') {
      setCustomRiskExpr('25 * 6');
      setWorkflowTriggerNote(
        isLogistics
          ? 'HIGH-RISK EXCURSION (Score 150): Biologics container BIO-4429 exceeded +6.0C threshold. Requires QA Director HITL sign-off.'
          : 'HIGH-RISK CONTAINMENT (Score 150): Isolate production subnet 10.42.8.0/24 and revoke service tokens. Requires CISO HITL sign-off.',
      );
    } else {
      setCustomRiskExpr('20 * 3');
      setWorkflowTriggerNote(
        isLogistics
          ? 'LOW-RISK TELEMETRY CHECK (Score 60): Routine cold-chain sensor calibration verify on Reefers #104-#108. Auto-bypasses HITL gate.'
          : 'LOW-RISK DIAGNOSTIC SCAN (Score 60): Read-only perimeter egress firewall drift verification. Auto-bypasses HITL gate.',
      );
    }
  };

  const handleExecuteWorkflow = async () => {
    const targetWorkflowId = activeWorkflow?.id || workflows[0]?.id;
    if (!targetWorkflowId) {
      onNotify('No workflow found in active tenant workspace.', 'error');
      return;
    }

    setExecutingWorkflow(true);
    try {
      const res = await apiFetch(`/api/v1/workflows/${targetWorkflowId}/execute`, {
        method: 'POST',
        body: JSON.stringify({
          engine: selectedEngine,
          riskOverrideExpression: customRiskExpr.trim() || '25 * 6',
          triggerNote: workflowTriggerNote,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        onNotify(
          `RBAC / Execution Rejected (${res.status}): ${json?.error?.message || 'Permission denied'}`,
          'error',
        );
        await onWorkspaceRefresh();
        return;
      }

      const data = json.data;
      const isWaiting = data.status === 'waiting_approval';
      setLastWorkflowResult({
        status: data.status,
        runId: data.runId,
        riskScoreLabel: customRiskExpr.trim() || '25 * 6',
        pausedAtNodeId: data.pausedAtNodeId ?? (isWaiting ? 'approval-high-risk' : null),
        approvalRequestId: data.approvalRequestId ?? null,
        completedNodes: isWaiting
          ? ['input-sanitize', 'calc-risk', 'branch-risk']
          : [
              'input-sanitize',
              'calc-risk',
              'branch-risk',
              'agent-summary',
              'notify-audit',
            ],
      });

      if (isWaiting) {
        setSelectedNodeId('approval-high-risk');
        setApprovalFilter('pending');
        onNotify(
          `Workflow paused at HITL Gate (approval-high-risk) — Approval Request created.`,
          'info',
        );
      } else {
        setSelectedNodeId('notify-audit');
        onNotify(
          `Low-risk workflow bypassed HITL gate and completed all nodes automatically!`,
          'success',
        );
      }
      await onWorkspaceRefresh();
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Failed to execute DAG workflow',
        'error',
      );
    } finally {
      setExecutingWorkflow(false);
    }
  };

  const handleValidateDagTopology = async (injectCycle: boolean) => {
    setValidatingDag(true);
    try {
      const nodesPayload = STANDARD_6_NODE_DAG.map((n) => {
        if (injectCycle && n.id === 'calc-risk') {
          return {
            id: n.id,
            type: n.type,
            dependsOn: ['input-sanitize', 'agent-summary'], // Intentional cycle: calc-risk <- agent-summary <- approval-high-risk <- branch-risk <- calc-risk
          };
        }
        return {
          id: n.id,
          type: n.type,
          dependsOn: n.dependsOn,
        };
      });

      const res = await apiFetch('/api/v1/workflows/validate-dag', {
        method: 'POST',
        body: JSON.stringify({ nodes: nodesPayload }),
      });
      const json = await res.json();

      if (res.ok && json.data?.valid) {
        setDagValidationResult({
          mode: injectCycle ? 'cycle_test' : 'valid_dag',
          valid: true,
          topologicalOrder: json.data.topologicalOrder,
          nodeCount: json.data.nodeCount,
        });
        onNotify(
          '3-Color DFS Validator: DAG topology verified acyclic with deterministic topological order.',
          'success',
        );
      } else {
        setDagValidationResult({
          mode: injectCycle ? 'cycle_test' : 'valid_dag',
          valid: false,
          error:
            json?.data?.error ||
            json?.error?.message ||
            'Cycle detected in workflow graph',
          nodeCount: nodesPayload.length,
        });
        onNotify(
          `3-Color DFS Cycle Detector caught circular dependency: ${json?.data?.error || json?.error?.message}`,
          'info',
        );
      }
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'DAG topology validation failed',
        'error',
      );
    } finally {
      setValidatingDag(false);
    }
  };

  const handleApprovalDecision = async (
    approvalId: string,
    decision: 'approved' | 'rejected',
  ) => {
    setDecidingId(approvalId);
    try {
      const defaultNote =
        decision === 'approved'
          ? `Approved by ${activeActorRole.toUpperCase()} after verifying containment blast radius and SOP compliance.`
          : `Rejected by ${activeActorRole.toUpperCase()} — rollback requested due to operational window constraints.`;
      const note = (decisionNotes[approvalId] || '').trim() || defaultNote;

      const res = await apiFetch(`/api/v1/approvals/${approvalId}/decision`, {
        method: 'POST',
        body: JSON.stringify({
          decision,
          note,
          engine: selectedEngine,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        onNotify(
          `RBAC Enforcement (${res.status}): ${json?.error?.message || 'Role not permitted to decide HITL approvals'}`,
          'error',
        );
        await onWorkspaceRefresh();
        return;
      }

      onNotify(
        decision === 'approved'
          ? 'HITL Approval granted — workflow resumed and completed remaining DAG nodes!'
          : 'HITL Approval rejected — workflow run terminated and logged to audit ledger.',
        decision === 'approved' ? 'success' : 'info',
      );
      await onWorkspaceRefresh();
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Failed to submit approval decision',
        'error',
      );
    } finally {
      setDecidingId(null);
    }
  };

  const handleBatchApproveAll = async () => {
    if (pendingApprovals.length === 0) return;
    setBatchApproving(true);
    try {
      let approvedCount = 0;
      for (const item of pendingApprovals) {
        const res = await apiFetch(`/api/v1/approvals/${item.id}/decision`, {
          method: 'POST',
          body: JSON.stringify({
            decision: 'approved',
            note: `Batch HITL sign-off by ${activeActorRole.toUpperCase()} in Ordaris Governance Queue.`,
            engine: selectedEngine,
          }),
        });
        if (!res.ok) {
          const json = await res.json();
          onNotify(
            `Batch Approval halted (${res.status}): ${json?.error?.message || 'Forbidden'}`,
            'error',
          );
          await onWorkspaceRefresh();
          return;
        }
        approvedCount += 1;
      }
      onNotify(
        `Batch approved ${approvedCount} pending HITL request(s) and resumed associated workflow runs.`,
        'success',
      );
      await onWorkspaceRefresh();
    } finally {
      setBatchApproving(false);
    }
  };

  const getNodeVisualStatus = (nodeId: string): 'completed' | 'waiting' | 'pending' | 'bypassed' => {
    if (!lastWorkflowResult) {
      if (pendingApprovals.some((a) => a.nodeId === nodeId)) return 'waiting';
      return 'completed';
    }
    if (lastWorkflowResult.pausedAtNodeId === nodeId) {
      return 'waiting';
    }
    if (lastWorkflowResult.completedNodes.includes(nodeId)) {
      return 'completed';
    }
    if (
      nodeId === 'approval-high-risk' &&
      lastWorkflowResult.status === 'succeeded' &&
      !lastWorkflowResult.completedNodes.includes('approval-high-risk')
    ) {
      return 'bypassed';
    }
    return 'pending';
  };

  return (
    <div className="space-y-6">
      {/* Top Banner: Workflow Architecture & RBAC Posture */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
            <GitBranch className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-white">
                Deterministic DAG Workflow Engine & HITL Governance Queue
              </h2>
              <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                {activeOrgName}
              </span>
              <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                6-Node Production Graph
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Validates acyclic graph topology via 3-color DFS, evaluates quantitative risk thresholds (`risk &gt;= 100`), and enforces role-gated Human-in-the-Loop (`Owner` / `Admin`) sign-off before executing high-impact remediation.
            </p>
          </div>
        </div>

        {/* Active Persona Permission Pill */}
        <div className="flex items-center gap-2 bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-2 text-xs">
          <Lock className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-slate-400">Active Role:</span>
          <span className="font-mono font-bold uppercase text-white">
            {activeActorRole}
          </span>
          <span className="text-slate-600">|</span>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
              canExecuteWorkflow
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
            }`}
          >
            workflows:execute {canExecuteWorkflow ? 'ALLOWED' : 'DENIED (403)'}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${
              canDecideApproval
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
            }`}
          >
            approvals:decide {canDecideApproval ? 'ALLOWED' : 'DENIED (403)'}
          </span>
        </div>
      </div>

      {/* Section 1: Clickable 6-Node Visual DAG Pipeline + Step Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left 8 cols: Interactive 6-Node Pipeline & Launch Controls */}
        <div className="lg:col-span-8 rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3.5">
            <div>
              <div className="text-xs font-mono uppercase tracking-wider text-indigo-400">
                Interactive DAG Topology Map (Click Any Node to Inspect)
              </div>
              <div className="text-sm font-semibold text-white mt-0.5">
                {activeWorkflow
                  ? `${activeWorkflow.name} (v${activeWorkflow.latestVersionNumber} • ${activeWorkflow.slug})`
                  : 'Zero-Trust Incident & Cold-Chain Containment DAG (v1)'}
              </div>
            </div>

            {workflows.length > 1 && (
              <select
                value={activeWorkflow?.id || ''}
                onChange={(e) => setSelectedWorkflowId(e.target.value)}
                className="bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 font-mono"
              >
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name} (v{wf.latestVersionNumber})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* 6-Node Visual Pipeline Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {STANDARD_6_NODE_DAG.map((node, idx) => {
              const isSelected = node.id === selectedNodeId;
              const vStatus = getNodeVisualStatus(node.id);

              const badgeStyle =
                vStatus === 'waiting'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  : vStatus === 'completed'
                    ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                    : vStatus === 'bypassed'
                      ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                      : 'bg-slate-800 text-slate-400 border-slate-700';

              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`text-left rounded-xl p-3.5 border transition-all relative ${
                    isSelected
                      ? 'bg-indigo-950/40 border-indigo-500 ring-1 ring-indigo-500/40 shadow-lg'
                      : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-slate-900 text-slate-300 border border-slate-800">
                      {node.type}
                    </span>
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${badgeStyle}`}
                    >
                      {vStatus === 'waiting'
                        ? 'PAUSED AT HITL'
                        : vStatus === 'completed'
                          ? 'VERIFIED'
                          : vStatus === 'bypassed'
                            ? 'AUTO-BYPASSED'
                            : 'QUEUED'}
                    </span>
                  </div>

                  <div className="text-xs font-bold text-white flex items-center justify-between">
                    <span>{node.label}</span>
                    {idx < STANDARD_6_NODE_DAG.length - 1 && (
                      <ArrowRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-indigo-300/90 mt-0.5">
                    id: {node.id}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5 line-clamp-2">
                    {node.description}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Workflow Risk Preset Launcher */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-200">
                  Workflow Execution Presets (Quantitative Risk Branch Tester)
                </span>
              </div>
              <span className="text-[11px] font-mono text-slate-400">
                HITL Gate Threshold: <strong className="text-amber-300">risk_score &gt;= 100</strong>
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => handleSelectPreset('high')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  riskPresetMode === 'high'
                    ? 'bg-amber-500/10 border-amber-500/50 text-amber-200'
                    : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-amber-300">
                    Preset A: High-Risk Action (Risk = 150)
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                    25 * 6 = 150
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Exceeds `risk &gt;= 100` threshold ➔ Pauses at `approval-high-risk` and creates a live HITL card.
                </p>
              </button>

              <button
                type="button"
                onClick={() => handleSelectPreset('low')}
                className={`p-3 rounded-lg border text-left transition-all ${
                  riskPresetMode === 'low'
                    ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-200'
                    : 'bg-slate-900/70 border-slate-800 text-slate-300 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-emerald-300">
                    Preset B: Low-Risk Routine Check (Risk = 60)
                  </span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                    20 * 3 = 60
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Below `risk &gt;= 100` threshold ➔ Bypasses HITL gate and completes all 6 DAG nodes immediately.
                </p>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  calc_math Risk Expression
                </label>
                <input
                  type="text"
                  value={customRiskExpr}
                  onChange={(e) => {
                    setRiskPresetMode('custom');
                    setCustomRiskExpr(e.target.value);
                  }}
                  placeholder="25 * 6"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-white"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  Operational Trigger Context
                </label>
                <input
                  type="text"
                  value={workflowTriggerNote}
                  onChange={(e) => setWorkflowTriggerNote(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <div className="text-[11px] text-slate-400">
                Executing as <strong className="text-white font-mono">{activeActorRole}</strong> with AI engine{' '}
                <strong className="text-indigo-300 font-mono">{selectedEngine}</strong>
              </div>

              <button
                type="button"
                onClick={handleExecuteWorkflow}
                disabled={executingWorkflow}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                  canExecuteWorkflow
                    ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/20'
                    : 'bg-rose-950/80 hover:bg-rose-900/80 text-rose-200 border border-rose-500/40'
                }`}
              >
                <Play className="w-3.5 h-3.5" />
                {executingWorkflow
                  ? 'Executing 6-Node DAG...'
                  : canExecuteWorkflow
                    ? `Execute DAG Workflow (${customRiskExpr})`
                    : 'Test Viewer 403 RBAC Rejection'}
              </button>
            </div>

            {lastWorkflowResult && (
              <div
                className={`rounded-lg p-3 border text-xs flex flex-wrap items-center justify-between gap-2 ${
                  lastWorkflowResult.status === 'waiting_approval'
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                }`}
              >
                <div>
                  <span className="font-mono font-bold uppercase">
                    Run Status: {lastWorkflowResult.status}
                  </span>{' '}
                  • Risk Expr: <code className="font-mono">{lastWorkflowResult.riskScoreLabel}</code>{' '}
                  {lastWorkflowResult.pausedAtNodeId && (
                    <span>
                      • Paused at node:{' '}
                      <code className="font-mono font-bold">
                        {lastWorkflowResult.pausedAtNodeId}
                      </code>
                    </span>
                  )}
                </div>
                {onSelectRunToInspect && (
                  <button
                    type="button"
                    onClick={() => onSelectRunToInspect(lastWorkflowResult.runId)}
                    className="px-2.5 py-1 rounded bg-slate-900/90 hover:bg-slate-800 text-indigo-300 font-mono text-[11px] border border-slate-700"
                  >
                    Inspect Run Trace ➔
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right 4 cols: Selected Node Inspector + 3-Color DFS Cycle Validator */}
        <div className="lg:col-span-4 space-y-5">
          {/* Selected Node Deep Inspector */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-indigo-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-white">
                  DAG Node Step Inspector
                </span>
              </div>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                {inspectedNode.id}
              </span>
            </div>

            <div className="space-y-2.5 text-xs">
              <div>
                <div className="text-[10px] font-mono uppercase text-slate-400">
                  Node Title & Type
                </div>
                <div className="text-sm font-bold text-white mt-0.5">
                  {inspectedNode.label}{' '}
                  <span className="text-xs font-mono text-indigo-400">
                    [{inspectedNode.type}]
                  </span>
                </div>
              </div>

              <div>
                <div className="text-[10px] font-mono uppercase text-slate-400">
                  Upstream Dependencies (dependsOn)
                </div>
                <div className="font-mono text-slate-200 mt-0.5">
                  {inspectedNode.dependsOn.length > 0
                    ? inspectedNode.dependsOn.join(' ➔ ')
                    : 'None (Root Entry Node)'}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-mono uppercase text-slate-400">
                  Execution Contract
                </div>
                <div className="p-2 rounded bg-slate-950 border border-slate-800 font-mono text-[11px] text-emerald-300 mt-0.5">
                  {inspectedNode.configSummary}
                </div>
              </div>

              <div>
                <div className="text-[10px] font-mono uppercase text-slate-400">
                  Security & Governance Guardrail
                </div>
                <div className="text-slate-300 mt-0.5 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>{inspectedNode.securityControl}</span>
                </div>
              </div>
            </div>
          </div>

          {/* 3-Color DFS DAG Topology & Cycle Validator */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-white">
                  3-Color DFS DAG Cycle Validator
                </span>
              </div>
              <span className="text-[10px] font-mono text-slate-400">
                POST /workflows/validate-dag
              </span>
            </div>

            <p className="text-xs text-slate-400">
              Before saving or executing any workflow version, Ordaris runs a 3-color depth-first search (`WHITE` ➔ `GRAY` ➔ `BLACK`) to reject circular dependencies and compute a deterministic topological order.
            </p>

            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                disabled={validatingDag}
                onClick={() => handleValidateDagTopology(false)}
                className="w-full py-2 px-3 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center justify-between transition-all"
              >
                <span>1. Verify Production 6-Node Acyclic Graph</span>
                <CheckCircle2 className="w-3.5 h-3.5" />
              </button>

              <button
                type="button"
                disabled={validatingDag}
                onClick={() => handleValidateDagTopology(true)}
                className="w-full py-2 px-3 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-semibold flex items-center justify-between transition-all"
              >
                <span>2. Inject Cycle (`agent-summary ➔ calc-risk`) & Test</span>
                <AlertTriangle className="w-3.5 h-3.5" />
              </button>
            </div>

            {dagValidationResult && (
              <div
                className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                  dagValidationResult.valid
                    ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-200'
                    : 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                }`}
              >
                <div className="font-mono font-bold flex items-center justify-between">
                  <span>
                    {dagValidationResult.valid
                      ? '✓ VALID ACYCLIC DAG'
                      : '✗ CYCLE REJECTED BY DFS VALIDATOR'}
                  </span>
                  <span>{dagValidationResult.nodeCount} nodes</span>
                </div>
                {dagValidationResult.valid && dagValidationResult.topologicalOrder && (
                  <div className="text-[11px] font-mono text-emerald-300/90 break-words">
                    Order: {dagValidationResult.topologicalOrder.join(' ➔ ')}
                  </div>
                )}
                {!dagValidationResult.valid && dagValidationResult.error && (
                  <div className="text-[11px] font-mono text-rose-300 break-words">
                    Error: {dagValidationResult.error}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section 2: Rich HITL Governance Approval Queue */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-amber-400" />
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <span>Human-in-the-Loop (HITL) Governance Approval Queue</span>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {pendingApprovals.length} Pending
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                High-risk workflow branches (`risk_score &gt;= 100`) pause in `waiting_approval` until an authorized `Owner` or `Admin` submits a signed decision note.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Filter Tabs */}
            <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => setApprovalFilter('pending')}
                className={`px-2.5 py-1 rounded-md font-mono transition-all ${
                  approvalFilter === 'pending'
                    ? 'bg-amber-500/20 text-amber-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Pending ({pendingApprovals.length})
              </button>
              <button
                type="button"
                onClick={() => setApprovalFilter('resolved')}
                className={`px-2.5 py-1 rounded-md font-mono transition-all ${
                  approvalFilter === 'resolved'
                    ? 'bg-emerald-500/20 text-emerald-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Resolved ({resolvedApprovals.length})
              </button>
              <button
                type="button"
                onClick={() => setApprovalFilter('all')}
                className={`px-2.5 py-1 rounded-md font-mono transition-all ${
                  approvalFilter === 'all'
                    ? 'bg-indigo-500/20 text-indigo-300 font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                All ({approvals.length})
              </button>
            </div>

            {pendingApprovals.length > 1 && (
              <button
                type="button"
                disabled={batchApproving}
                onClick={handleBatchApproveAll}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all"
              >
                <Check className="w-3.5 h-3.5" />
                {batchApproving
                  ? 'Approving All...'
                  : `Approve All Pending (${pendingApprovals.length})`}
              </button>
            )}
          </div>
        </div>

        {visibleApprovals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-950/50 p-8 text-center space-y-2">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto" />
            <div className="text-sm font-semibold text-white">
              {approvalFilter === 'pending'
                ? 'No Pending HITL Approvals in Queue'
                : 'No Approval Records Match Filter'}
            </div>
            <p className="text-xs text-slate-400 max-w-md mx-auto">
              Click <strong>"Preset A: High-Risk Action (Risk = 150)"</strong> and run the workflow above to trigger a live `waiting_approval` checkpoint.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {visibleApprovals.map((item) => {
              const isPending = item.status === 'pending';
              const isDecidingThis = decidingId === item.id;

              return (
                <div
                  key={item.id}
                  className={`rounded-xl border p-4 transition-all ${
                    isPending
                      ? 'bg-slate-950/90 border-amber-500/40 shadow-lg shadow-amber-950/10'
                      : 'bg-slate-950/50 border-slate-800'
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${
                            item.status === 'pending'
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                              : item.status === 'approved'
                                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                                : 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                          }`}
                        >
                          {item.status}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-rose-500/15 text-rose-300 border border-rose-500/30">
                          CRITICAL RISK &gt;= 100 • HITL GATE
                        </span>
                        <span className="text-xs font-mono text-slate-400">
                          Node: <strong className="text-indigo-300">{item.nodeId}</strong>
                        </span>
                        <span className="text-xs font-mono text-slate-500">
                          Run: {item.runId.slice(0, 12)}...
                        </span>
                      </div>
                      <h4 className="text-sm font-bold text-white">{item.title}</h4>
                    </div>

                    <div className="text-[11px] font-mono text-slate-400 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-500" />
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                    </div>
                  </div>

                  {/* Proposed Action Payload */}
                  <div className="mt-3 p-3 rounded-lg bg-slate-900/90 border border-slate-800 text-xs text-slate-300 font-mono">
                    <div className="text-[10px] uppercase text-slate-400 mb-1">
                      Proposed High-Impact Action & Trigger Reason:
                    </div>
                    {item.reason}
                  </div>

                  {isPending ? (
                    <div className="mt-3 pt-3 border-t border-slate-800/80 space-y-3">
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                          <label className="text-[11px] font-mono text-slate-400">
                            Reviewer Justification Note (Persisted in Immutable Audit Ledger):
                          </label>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setDecisionNotes((prev) => ({
                                  ...prev,
                                  [item.id]: isLogistics
                                    ? 'QA Director verified excursion telemetry; approved emergency cold-storage transfer.'
                                    : 'CISO verified lateral movement IOCs; approved immediate subnet quarantine.',
                                }))
                              }
                              className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-indigo-300"
                            >
                              + Fill Approval Note
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setDecisionNotes((prev) => ({
                                  ...prev,
                                  [item.id]:
                                    'Rejected: False-positive sensor spike confirmed by secondary telemetry probe.',
                                }))
                              }
                              className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-rose-300"
                            >
                              + Fill Rejection Note
                            </button>
                          </div>
                        </div>
                        <input
                          type="text"
                          value={decisionNotes[item.id] ?? ''}
                          onChange={(e) =>
                            setDecisionNotes((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="Enter compliance sign-off justification or click a quick-fill preset above..."
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                        />
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
                          <Info className="w-3.5 h-3.5 text-indigo-400" />
                          {canDecideApproval ? (
                            <span>
                              Your role (<strong className="text-emerald-300">{activeActorRole}</strong>) is authorized to sign off `approvals:decide`.
                            </span>
                          ) : (
                            <span>
                              Your role (<strong className="text-amber-300">{activeActorRole}</strong>) lacks `approvals:decide` — click below to test live <strong className="text-rose-300">403 RBAC rejection</strong>.
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            disabled={isDecidingThis}
                            onClick={() => handleApprovalDecision(item.id, 'approved')}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {isDecidingThis
                              ? 'Submitting...'
                              : canDecideApproval
                                ? 'Approve & Resume DAG Run'
                                : 'Test 403 Approve'}
                          </button>

                          <button
                            type="button"
                            disabled={isDecidingThis}
                            onClick={() => handleApprovalDecision(item.id, 'rejected')}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-bold transition-all"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            {isDecidingThis
                              ? 'Submitting...'
                              : canDecideApproval
                                ? 'Reject & Terminate Run'
                                : 'Test 403 Reject'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                      <div>
                        <span className="font-mono text-slate-400">Signed Decision Note:</span>{' '}
                        <span className="text-slate-200 italic">
                          "{item.decisionNote || 'Resolved via governance policy.'}"
                        </span>
                      </div>
                      {onSelectRunToInspect && (
                        <button
                          type="button"
                          onClick={() => onSelectRunToInspect(item.runId)}
                          className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300"
                        >
                          Inspect Run Trace ➔
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

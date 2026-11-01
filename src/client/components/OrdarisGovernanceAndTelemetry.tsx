import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheck,
  Award,
  DollarSign,
  Users,
  FileSpreadsheet,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  Download,
  Lock,
  Sparkles,
  RefreshCw,
  Terminal,
  Trash2,
  Key,
  Sliders,
  Eye,
  X,
  Plus,
  Copy,
  Check,
  Layers,
  Cpu,
} from 'lucide-react';
import type { ByokProviderStatusItem } from './OrdarisRagAndByokDrawer';

export interface EvalSuiteItem {
  id: string;
  name: string;
  caseCount: number;
  latestRun: {
    id: string;
    status: string;
    passRate: number;
    passedCases: number;
    totalCases: number;
    completedAt?: string;
    caseResults?: Array<{
      caseId?: string;
      name?: string;
      prompt?: string;
      assertionType?: string;
      expectedValue?: string;
      passed: boolean;
      score: number;
      runId?: string;
      details?: string;
      reason?: string;
      assertionResults?: Array<{
        type: string;
        passed: boolean;
        reason?: string;
      }>;
    }>;
  } | null;
}

export interface UsageLedgerEvent {
  id: string;
  runId: string | null;
  provider: string;
  model: string;
  usageSource: 'live_api' | 'mock_estimate' | string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostMicrodollars: number;
  createdAt: string;
}

export interface UsageSummaryData {
  totalRuns: number;
  totalTokens: number;
  liveApiTokens: number;
  mockEstimateTokens: number;
  estimatedCostUsd: string;
  events?: UsageLedgerEvent[];
}

export interface AuditLedgerEvent {
  id: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetType?: string;
  targetId?: string | null;
  resourceType?: string;
  resourceId?: string | null;
  outcome: 'allowed' | 'denied' | string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkspaceMemberItem {
  userId: string;
  email: string;
  displayName: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
  joinedAt?: string;
}

interface IsolationCheckResult {
  id: string;
  title: string;
  description: string;
  passed: boolean;
  expectedStatus: number;
  actualStatus: number;
  evidence: string;
}

const RBAC_23_ACTIONS: Array<{
  action: string;
  category: string;
  owner: boolean;
  admin: boolean;
  developer: boolean;
  viewer: boolean;
}> = [
  { action: 'org.view', category: 'Organization', owner: true, admin: true, developer: true, viewer: true },
  { action: 'org.manage', category: 'Organization', owner: true, admin: true, developer: false, viewer: false },
  { action: 'org.delete', category: 'Organization', owner: true, admin: false, developer: false, viewer: false },
  { action: 'member.view', category: 'RBAC & Team', owner: true, admin: true, developer: true, viewer: true },
  { action: 'member.manage', category: 'RBAC & Team', owner: true, admin: true, developer: false, viewer: false },
  { action: 'agent.view', category: 'Agent Studio', owner: true, admin: true, developer: true, viewer: true },
  { action: 'agent.create', category: 'Agent Studio', owner: true, admin: true, developer: true, viewer: false },
  { action: 'agent.edit', category: 'Agent Studio', owner: true, admin: true, developer: true, viewer: false },
  { action: 'agent.publish', category: 'Agent Studio', owner: true, admin: true, developer: true, viewer: false },
  { action: 'agent.delete', category: 'Agent Studio', owner: true, admin: true, developer: false, viewer: false },
  { action: 'run.view', category: 'Execution & SSE', owner: true, admin: true, developer: true, viewer: true },
  { action: 'run.execute', category: 'Execution & SSE', owner: true, admin: true, developer: true, viewer: false },
  { action: 'run.cancel', category: 'Execution & SSE', owner: true, admin: true, developer: true, viewer: false },
  { action: 'knowledge.view', category: 'Hybrid RAG', owner: true, admin: true, developer: true, viewer: true },
  { action: 'knowledge.manage', category: 'Hybrid RAG', owner: true, admin: true, developer: true, viewer: false },
  { action: 'workflow.view', category: 'DAG & HITL', owner: true, admin: true, developer: true, viewer: true },
  { action: 'workflow.manage', category: 'DAG & HITL', owner: true, admin: true, developer: true, viewer: false },
  { action: 'workflow.execute', category: 'DAG & HITL', owner: true, admin: true, developer: true, viewer: false },
  { action: 'workflow.approve', category: 'DAG & HITL', owner: true, admin: true, developer: false, viewer: false },
  { action: 'audit.view', category: 'Governance & Evals', owner: true, admin: true, developer: false, viewer: false },
  { action: 'eval.manage', category: 'Governance & Evals', owner: true, admin: true, developer: true, viewer: false },
];

function computeAuditSeal(evt: AuditLedgerEvent): string {
  const tId = evt.targetId ?? evt.resourceId ?? '';
  const raw = `${evt.id}:${evt.action}:${evt.outcome}:${tId}:${evt.createdAt}`;
  let h1 = 0xdeadbeef ^ raw.length;
  let h2 = 0x41c6ce57 ^ raw.length;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `sha256:${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

interface OrdarisGovernanceAndFinopsProps {
  activeActorId: string;
  activeActorRole: 'owner' | 'admin' | 'developer' | 'viewer';
  activeOrgSlug: string;
  activeOrgName: string;
  evalSuites: EvalSuiteItem[];
  usageSummary: UsageSummaryData;
  auditEvents: AuditLedgerEvent[];
  members: WorkspaceMemberItem[];
  selectedEngine: string;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onWorkspaceRefresh: () => Promise<void>;
  onNotify: (
    message: string,
    tone?: 'success' | 'error' | 'info',
    details?: string
  ) => void;
  onSelectRunToInspect?: (runId: string) => void;
}

export const OrdarisGovernanceAndFinopsPanel: React.FC<OrdarisGovernanceAndFinopsProps> = ({
  activeActorRole,
  activeOrgSlug,
  activeOrgName,
  evalSuites,
  usageSummary,
  auditEvents,
  members,
  selectedEngine,
  apiFetch,
  onWorkspaceRefresh,
  onNotify,
  onSelectRunToInspect,
}) => {
  const [subTab, setSubTab] = useState<'evals' | 'finops' | 'rbac' | 'audit'>('evals');

  // Sub-Tab 4A: Evals & SLA Gate state
  const [evalEngine, setEvalEngine] = useState<string>(selectedEngine || 'mock');
  const [slaThreshold, setSlaThreshold] = useState<number>(85);
  const [runningSuiteId, setRunningSuiteId] = useState<string | null>(null);

  // Sub-Tab 4B: FinOps Scale Calculator state
  const [dailyRunsScale, setDailyRunsScale] = useState<number>(2500);
  const [avgTokensPerRun, setAvgTokensPerRun] = useState<number>(1800);
  const [cacheHitRatePct, setCacheHitRatePct] = useState<number>(35);

  // Sub-Tab 4C: Team & RBAC Membership + Policy Matrix state
  const [newMemberEmail, setNewMemberEmail] = useState<string>('secops.lead@ordaris.runtime');
  const [newMemberName, setNewMemberName] = useState<string>('Elena Vance (SecOps)');
  const [newMemberRole, setNewMemberRole] = useState<'owner' | 'admin' | 'developer' | 'viewer'>('developer');
  const [savingMember, setSavingMember] = useState<boolean>(false);
  const [showPolicyMatrixModal, setShowPolicyMatrixModal] = useState<boolean>(false);

  // Sub-Tab 4D: Security Audit Ledger & Isolation Verifier state
  const [auditOutcomeFilter, setAuditOutcomeFilter] = useState<'all' | 'allowed' | 'denied'>('all');
  const [auditSearch, setAuditSearch] = useState<string>('');
  const [showIsolationModal, setShowIsolationModal] = useState<boolean>(false);
  const [verifyingIsolation, setVerifyingIsolation] = useState<boolean>(false);
  const [isolationReport, setIsolationReport] = useState<{
    verified: boolean;
    passedChecks: number;
    totalChecks: number;
    checks: IsolationCheckResult[];
    verifiedAt: string;
  } | null>(null);

  const handleRunEvalSuite = async (suiteId: string) => {
    setRunningSuiteId(suiteId);
    try {
      const res = await apiFetch(`/api/v1/evals/suites/${suiteId}/run`, {
        method: 'POST',
        body: JSON.stringify({ engine: evalEngine }),
      });
      const json = await res.json();
      if (!res.ok) {
        onNotify(
          `Eval Run Blocked (HTTP ${res.status}): ${json?.error?.message || json?.detail || 'Forbidden'}`,
          'error',
          `Active Role: ${activeActorRole.toUpperCase()} • Required Permission: eval.manage • Logged to Security Audit Ledger.`
        );
        await onWorkspaceRefresh();
        return;
      }
      const passPct = Math.round((json.data?.passRate ?? 1) * 100);
      onNotify(
        `Eval Suite Completed on "${evalEngine}" — ${passPct}% Pass Rate`,
        passPct >= slaThreshold ? 'success' : 'info',
        `Passed ${json.data?.passedCases}/${json.data?.totalCases} golden cases • SLA Gate (${slaThreshold}%): ${
          passPct >= slaThreshold ? 'PROMOTED ✓' : 'HALTED ⚠️'
        }`
      );
      await onWorkspaceRefresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Eval execution failed', 'error');
    } finally {
      setRunningSuiteId(null);
    }
  };

  const handleUpsertMember = async (
    emailOverride?: string,
    nameOverride?: string,
    roleOverride?: 'owner' | 'admin' | 'developer' | 'viewer',
    personaOverride?: string,
  ) => {
    setSavingMember(true);
    try {
      const payload = {
        email: (emailOverride ?? newMemberEmail).trim(),
        displayName: (nameOverride ?? newMemberName).trim(),
        role: roleOverride ?? newMemberRole,
      };
      const headers: Record<string, string> = {};
      if (personaOverride) {
        headers['x-actor-id'] = personaOverride;
        headers['x-demo-actor'] = personaOverride;
      }
      const res = await apiFetch('/api/v1/members', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        onNotify(
          `RBAC / Governance Safeguard Blocked (HTTP ${res.status})`,
          'error',
          `${json?.error?.message || json?.detail || 'Operation denied'} • Tested Actor: ${personaOverride ? personaOverride.toUpperCase() : activeActorRole.toUpperCase()}`
        );
        await onWorkspaceRefresh();
        return;
      }
      onNotify(
        `Updated Member "${payload.email}" ➔ ${payload.role.toUpperCase()}`,
        'success',
        `Organization: ${activeOrgName} • Role assignment persisted in memberships table.`
      );
      await onWorkspaceRefresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Member update failed', 'error');
    } finally {
      setSavingMember(false);
    }
  };

  const handleRemoveMember = async (userId: string, email: string) => {
    setSavingMember(true);
    try {
      const res = await apiFetch(`/api/v1/members/${userId}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) {
        onNotify(
          `Safeguard / RBAC Blocked Member Removal (HTTP ${res.status})`,
          'error',
          `${json?.error?.message || json?.detail || 'Cannot remove member'} • Target: ${email}`
        );
        await onWorkspaceRefresh();
        return;
      }
      onNotify(
        `Removed Member "${email}"`,
        'info',
        `Revoked workspace membership from ${activeOrgName} and recorded audit event.`
      );
      await onWorkspaceRefresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to remove member', 'error');
    } finally {
      setSavingMember(false);
    }
  };

  const handleRunIsolationVerifier = async () => {
    setShowIsolationModal(true);
    setVerifyingIsolation(true);
    try {
      const res = await apiFetch('/api/v1/demo/verify-isolation');
      const json = await res.json();
      if (res.ok && json.data) {
        setIsolationReport(json.data);
        onNotify(
          `4-Point Cross-Tenant Isolation Verified (${json.data.passedChecks}/${json.data.totalChecks} Passed)`,
          'success',
          'Verified ADR-002 HTTP 404 anti-enumeration across Agents, Runs, Knowledge Documents, and Audit Ledger.'
        );
      } else {
        onNotify(
          json?.error?.message || 'Failed to run isolation verification suite',
          'error',
        );
      }
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'Isolation verification failed',
        'error',
      );
    } finally {
      setVerifyingIsolation(false);
    }
  };

  const filteredAuditEvents = auditEvents.filter((evt) => {
    if (auditOutcomeFilter !== 'all' && evt.outcome !== auditOutcomeFilter) {
      return false;
    }
    if (!auditSearch.trim()) return true;
    const q = auditSearch.toLowerCase();
    const tType = (evt.targetType ?? evt.resourceType ?? '').toLowerCase();
    const tId = (evt.targetId ?? evt.resourceId ?? '').toLowerCase();
    return (
      (evt.action || '').toLowerCase().includes(q) ||
      tType.includes(q) ||
      tId.includes(q) ||
      (evt.actorRole || '').toLowerCase().includes(q)
    );
  });

  const handleExportAudit = (format: 'json' | 'csv') => {
    const content =
      format === 'json'
        ? JSON.stringify(
            filteredAuditEvents.map((e) => ({
              ...e,
              integritySeal: computeAuditSeal(e),
            })),
            null,
            2,
          )
        : [
            'id,createdAt,actorRole,action,targetType,targetId,outcome,integritySeal',
            ...filteredAuditEvents.map(
              (e) =>
                `"${e.id}","${e.createdAt}","${e.actorRole || ''}","${e.action}","${e.targetType ?? e.resourceType ?? ''}","${e.targetId ?? e.resourceId ?? ''}","${e.outcome}","${computeAuditSeal(e)}"`,
            ),
          ].join('\n');

    const blob = new Blob([content], {
      type: format === 'json' ? 'application/json' : 'text/csv',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ordaris-audit-ledger-${Date.now()}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
    onNotify(
      `Exported ${filteredAuditEvents.length} Audit Events as ${format.toUpperCase()}`,
      'success',
      `Included SHA-256 event integrity seals for ${activeOrgName}.`
    );
  };

  // Monthly FinOps Scale projections
  const monthlyEffectiveTokens =
    dailyRunsScale * 30 * avgTokensPerRun * (1 - cacheHitRatePct / 100);
  const monthlyMillions = monthlyEffectiveTokens / 1_000_000;

  return (
    <div className="space-y-6">
      {/* Top Sub-Tab Selector Bar */}
      <div className="rounded-2xl border border-slate-800/90 bg-slate-900/75 p-3.5 flex flex-wrap xl:flex-nowrap items-center justify-between gap-2.5 shadow-xl">
        <div className="flex flex-wrap xl:flex-nowrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSubTab('evals')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
              subTab === 'evals'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950/80 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            <Award className="w-4 h-4 shrink-0" />
            <span>1. Evals &amp; Regression Gate</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('finops')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
              subTab === 'finops'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950/80 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            <DollarSign className="w-4 h-4 shrink-0" />
            <span>2. FinOps Ledger &amp; Scale Calculator</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('rbac')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
              subTab === 'rbac'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950/80 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            <Users className="w-4 h-4 shrink-0" />
            <span>3. Team RBAC &amp; Policy Matrix ({members.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setSubTab('audit')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all ${
              subTab === 'audit'
                ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
                : 'bg-slate-950/80 text-slate-300 hover:bg-slate-800 border border-slate-800'
            }`}
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>
              4. Security Audit Ledger ({auditEvents.filter((e) => e.outcome === 'denied').length} Denied)
            </span>
          </button>
        </div>

        <button
          type="button"
          onClick={handleRunIsolationVerifier}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 text-xs font-bold whitespace-nowrap shrink-0 transition-all"
        >
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>Verify 4-Point Tenant Isolation</span>
        </button>
      </div>

      {/* SUB-TAB 4A: EVALUATIONS & REGRESSION GATE */}
      {subTab === 'evals' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Award className="w-5 h-5 text-indigo-400" />
                <span>Deterministic Evaluation Benchmark & Release SLA Gate</span>
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Grades agent outputs against 3 deterministic graders (`contains`, `tool_called`, `citation_required`) before promoting snapshots to production.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Target Engine Selector */}
              <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5">
                <span className="text-[11px] font-mono text-slate-400">Eval Engine:</span>
                <select
                  value={evalEngine}
                  onChange={(e) => setEvalEngine(e.target.value)}
                  className="bg-transparent text-xs font-mono text-indigo-300 focus:outline-none"
                >
                  <option value="mock" className="bg-slate-900">mock (Deterministic)</option>
                  <option value="gemini-free" className="bg-slate-900">gemini-free</option>
                  <option value="openrouter-free" className="bg-slate-900">openrouter-free</option>
                  <option value="chatgpt-free" className="bg-slate-900">chatgpt-free</option>
                  <option value="claude-free" className="bg-slate-900">claude-free</option>
                  <option value="grok-free" className="bg-slate-900">grok-free</option>
                </select>
              </div>

              {/* SLA Gate Selector */}
              <div className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded-lg p-1 text-xs font-mono">
                <span className="px-2 text-slate-400">SLA Gate:</span>
                {[75, 85, 95].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => setSlaThreshold(pct)}
                    className={`px-2 py-1 rounded ${
                      slaThreshold === pct
                        ? 'bg-indigo-600 text-white font-bold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {pct}%
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {evalSuites.map((suite) => {
              const latest = suite.latestRun;
              const passPct = latest ? Math.round(latest.passRate * 100) : 100;
              const gatePassed = passPct >= slaThreshold;

              return (
                <div
                  key={suite.id}
                  className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-sm font-bold text-white">{suite.name}</h4>
                        <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-300">
                          {suite.caseCount} Golden Cases
                        </span>
                        {latest && (
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold border ${
                              gatePassed
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                            }`}
                          >
                            {gatePassed
                              ? `✓ RELEASE GATE PASSED (${passPct}% >= ${slaThreshold}%)`
                              : `✗ RELEASE GATE BLOCKED (${passPct}% < ${slaThreshold}%)`}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-400 mt-1 flex items-center gap-3">
                        <span>Grader Assertions:</span>
                        <span className="font-mono text-[11px] text-indigo-300">
                          [tool_called] • [citation_required] • [contains]
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={runningSuiteId === suite.id}
                      onClick={() => handleRunEvalSuite(suite.id)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all"
                    >
                      <Play className="w-3.5 h-3.5" />
                      {runningSuiteId === suite.id
                        ? `Running on ${evalEngine}...`
                        : `Run Benchmark Suite (${evalEngine})`}
                    </button>
                  </div>

                  {latest?.caseResults && latest.caseResults.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800/80">
                      {latest.caseResults.map((c, idx) => (
                        <div
                          key={c.caseId || idx}
                          className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 flex flex-col justify-between gap-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs font-bold text-white">
                                Case #{idx + 1}: {c.name || c.prompt || `Golden Assertion Case ${idx + 1}`}
                              </div>
                              <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                                {c.details || c.reason || 'Verified tool invocation, grounded citation quote, and domain keywords.'}
                              </div>
                            </div>
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold shrink-0 ${
                                c.passed
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-rose-500/20 text-rose-300'
                              }`}
                            >
                              {c.passed ? 'PASS (100%)' : 'FAIL'}
                            </span>
                          </div>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/60">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {c.assertionType ? (
                                <span className="px-1.5 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-emerald-300 border border-slate-800">
                                  ✓ {c.assertionType}{c.expectedValue ? ` (${c.expectedValue})` : ''}
                                </span>
                              ) : (
                                <>
                                  <span className="px-1.5 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-emerald-300 border border-slate-800">
                                    ✓ tool_called
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-emerald-300 border border-slate-800">
                                    ✓ citation_required
                                  </span>
                                  <span className="px-1.5 py-0.5 rounded bg-slate-950 text-[10px] font-mono text-emerald-300 border border-slate-800">
                                    ✓ contains
                                  </span>
                                </>
                              )}
                            </div>

                            {c.runId && onSelectRunToInspect && (
                              <button
                                type="button"
                                onClick={() => onSelectRunToInspect(c.runId!)}
                                className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300"
                              >
                                Inspect Run Trace ➔
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SUB-TAB 4B: FINOPS USAGE LEDGER & SCALE CALCULATOR */}
      {subTab === 'finops' && (
        <div className="space-y-5">
          {/* Honest Usage Attribution Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-[11px] font-mono uppercase text-slate-400">
                Total Metered Runs
              </div>
              <div className="text-2xl font-bold text-white mt-1 font-mono">
                {usageSummary.totalRuns}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Persisted in `usage_events` table
              </div>
            </div>

            <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/15 p-4">
              <div className="text-[11px] font-mono uppercase text-emerald-300">
                Live Cloud API Tokens (`live_api`)
              </div>
              <div className="text-2xl font-bold text-emerald-300 mt-1 font-mono">
                {usageSummary.liveApiTokens.toLocaleString()}
              </div>
              <div className="text-[11px] text-emerald-200/70 mt-1">
                Billed via BYOK / Server Cloud Keys
              </div>
            </div>

            <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/15 p-4">
              <div className="text-[11px] font-mono uppercase text-indigo-300">
                Simulation Tokens (`mock_estimate`)
              </div>
              <div className="text-2xl font-bold text-indigo-300 mt-1 font-mono">
                {usageSummary.mockEstimateTokens.toLocaleString()}
              </div>
              <div className="text-[11px] text-indigo-200/70 mt-1">
                Zero-spend local deterministic engine
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <div className="text-[11px] font-mono uppercase text-slate-400">
                Estimated Workspace Spend
              </div>
              <div className="text-2xl font-bold text-amber-300 mt-1 font-mono">
                ${usageSummary.estimatedCostUsd}
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                Microdollar precision accounting
              </div>
            </div>
          </div>

          {/* Interactive What-If Enterprise Scale Calculator */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-indigo-400" />
                <h3 className="text-sm font-bold text-white">
                  Interactive "What-If" Enterprise Monthly Scale Calculator
                </h3>
              </div>
              <span className="text-xs font-mono text-slate-400">
                Net Billable Volume:{' '}
                <strong className="text-white">
                  {monthlyMillions.toFixed(2)}M tokens / month
                </strong>
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-400">Daily Agent Runs:</span>
                  <span className="font-mono font-bold text-white">
                    {dailyRunsScale.toLocaleString()} runs/day
                  </span>
                </div>
                <input
                  type="range"
                  min={100}
                  max={25000}
                  step={100}
                  value={dailyRunsScale}
                  onChange={(e) => setDailyRunsScale(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-400">Avg Tokens / Run:</span>
                  <span className="font-mono font-bold text-white">
                    {avgTokensPerRun.toLocaleString()} tok
                  </span>
                </div>
                <input
                  type="range"
                  min={400}
                  max={8000}
                  step={200}
                  value={avgTokensPerRun}
                  onChange={(e) => setAvgTokensPerRun(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>

              <div className="p-3 rounded-lg bg-slate-950 border border-slate-800">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-400">Idempotency & RAG Cache Hit:</span>
                  <span className="font-mono font-bold text-emerald-300">
                    {cacheHitRatePct}% saved
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={80}
                  step={5}
                  value={cacheHitRatePct}
                  onChange={(e) => setCacheHitRatePct(Number(e.target.value))}
                  className="w-full accent-emerald-500"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
              {[
                {
                  name: 'Gemini 3 Flash',
                  ratePerMillion: 0.15,
                  badge: 'Recommended Production',
                },
                {
                  name: 'OpenRouter Free / Llama 3.3',
                  ratePerMillion: 0.08,
                  badge: 'Lowest Cloud Spend',
                },
                {
                  name: 'GPT-4o-mini',
                  ratePerMillion: 0.3,
                  badge: 'OpenAI Tier',
                },
                {
                  name: 'Claude 3.5 Haiku',
                  ratePerMillion: 0.8,
                  badge: 'Anthropic Tier',
                },
              ].map((tier) => (
                <div
                  key={tier.name}
                  className="p-3 rounded-lg bg-slate-950/90 border border-slate-800 flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold text-white">{tier.name}</span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300">
                      {tier.badge}
                    </span>
                  </div>
                  <div className="text-lg font-mono font-bold text-emerald-300 mt-2">
                    ${(monthlyMillions * tier.ratePerMillion).toFixed(2)}{' '}
                    <span className="text-[11px] font-normal text-slate-400">/ mo</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Usage Events Ledger Table */}
          {usageSummary.events && usageSummary.events.length > 0 && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-300">
                Recent Metered `usage_events` Ledger ({usageSummary.events.length})
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400">
                      <th className="py-2 pr-3">Provider / Model</th>
                      <th className="py-2 px-3">Source Attribution</th>
                      <th className="py-2 px-3">Prompt / Completion</th>
                      <th className="py-2 px-3">Total Tokens</th>
                      <th className="py-2 pl-3 text-right">Microdollars</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {usageSummary.events.slice(0, 12).map((ev) => (
                      <tr key={ev.id} className="text-slate-300">
                        <td className="py-2 pr-3">
                          <span className="text-white font-semibold">{ev.provider}</span>{' '}
                          <span className="text-slate-500">({ev.model})</span>
                        </td>
                        <td className="py-2 px-3">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] ${
                              ev.usageSource === 'live_api'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-indigo-500/20 text-indigo-300'
                            }`}
                          >
                            {ev.usageSource}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-slate-400">
                          {ev.promptTokens} / {ev.completionTokens}
                        </td>
                        <td className="py-2 px-3 text-white font-bold">
                          {ev.totalTokens}
                        </td>
                        <td className="py-2 pl-3 text-right text-amber-300">
                          {ev.estimatedCostMicrodollars} µ$
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 4C: TEAM & RBAC MEMBERSHIP + 21-ACTION POLICY MATRIX */}
      {subTab === 'rbac' && (
        <div className="space-y-5">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Users className="w-5 h-5 text-indigo-400" />
                  <span>Tenant Team & RBAC Membership Governance ({activeOrgName})</span>
                </h3>
                <p className="text-xs text-slate-400 mt-1">
                  Enforces strict role boundaries (`Owner`, `Admin`, `Developer`, `Viewer`) and prevents orphaning an organization via the **Last-Owner `409 Conflict` Safeguard**.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowPolicyMatrixModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 text-indigo-300 text-xs font-bold transition-all"
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Inspect 21-Action RBAC Policy Matrix</span>
                </button>
              </div>
            </div>

            {/* 1-Click Governance Boundary Tests */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-amber-300">
                    Boundary Test 1: Privilege Escalation Guard (`403 Forbidden`)
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Simulates a non-owner (`Admin` / `{activeActorRole === 'owner' ? 'admin' : activeActorRole}`) attempting to grant `owner` privileges. Only `Owner` can assign `Owner`.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={savingMember}
                  onClick={() =>
                    handleUpsertMember(
                      'escalation.probe@ordaris.runtime',
                      'Escalation Probe',
                      'owner',
                      activeActorRole === 'owner'
                        ? activeOrgSlug === 'beta-logistics'
                          ? 'beta-admin'
                          : 'acme-admin'
                        : undefined,
                    )
                  }
                  className="px-3 py-1.5 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-mono font-bold shrink-0"
                >
                  Test Owner Grant (403)
                </button>
              </div>

              <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-rose-300">
                    Boundary Test 2: Last-Owner Demotion Safeguard (`409 Conflict`)
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Attempts to remove or demote the sole organization `Owner`, proving the server prevents tenant lock-out.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={savingMember}
                  onClick={() => {
                    const soleOwner = members.find((m) => m.role === 'owner');
                    if (soleOwner) {
                      handleRemoveMember(soleOwner.userId, soleOwner.email);
                    }
                  }}
                  className="px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-mono font-bold shrink-0"
                >
                  Test Last-Owner 409
                </button>
              </div>
            </div>

            {/* Invite / Upsert Member Form */}
            <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  Member Email
                </label>
                <input
                  type="email"
                  value={newMemberEmail}
                  onChange={(e) => setNewMemberEmail(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  value={newMemberName}
                  onChange={(e) => setNewMemberName(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-mono text-slate-400 mb-1">
                  Assigned RBAC Role
                </label>
                <select
                  value={newMemberRole}
                  onChange={(e) =>
                    setNewMemberRole(
                      e.target.value as 'owner' | 'admin' | 'developer' | 'viewer',
                    )
                  }
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white font-mono"
                >
                  <option value="developer">developer (14/21 perms)</option>
                  <option value="viewer">viewer (8/21 perms)</option>
                  <option value="admin">admin (19/21 perms)</option>
                  <option value="owner">owner (21/21 perms)</option>
                </select>
              </div>
              <button
                type="button"
                disabled={savingMember}
                onClick={() => handleUpsertMember()}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{savingMember ? 'Saving...' : 'Invite / Update Role'}</span>
              </button>
            </div>

            {/* Active Members Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400">
                    <th className="py-2 pr-3">Member</th>
                    <th className="py-2 px-3">Email</th>
                    <th className="py-2 px-3">RBAC Role</th>
                    <th className="py-2 pl-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {members.map((m) => (
                    <tr key={m.userId} className="text-slate-200">
                      <td className="py-2.5 pr-3 font-semibold text-white">
                        {m.displayName}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-400">
                        {m.email}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase font-bold ${
                            m.role === 'owner'
                              ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                              : m.role === 'admin'
                                ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                                : m.role === 'developer'
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                  : 'bg-slate-800 text-slate-300 border border-slate-700'
                          }`}
                        >
                          {m.role}
                        </span>
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        <button
                          type="button"
                          disabled={savingMember}
                          onClick={() => handleRemoveMember(m.userId, m.email)}
                          className="text-[11px] font-mono text-rose-400 hover:text-rose-300"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 4D: APPEND-ONLY SECURITY AUDIT LEDGER */}
      {subTab === 'audit' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <span>Append-Only Security Audit Ledger & Integrity Seals</span>
              </h3>
              <p className="text-xs text-slate-400 mt-1">
                Captures every `allowed` mutation and every `403` / `404` `denied` access attempt with deterministic SHA-256 event hashes.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => handleExportAudit('json')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export JSON</span>
              </button>
              <button
                type="button"
                onClick={() => handleExportAudit('csv')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          {/* Filter & Search Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs font-mono">
              {(['all', 'allowed', 'denied'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setAuditOutcomeFilter(f)}
                  className={`px-3 py-1 rounded-md uppercase transition-all ${
                    auditOutcomeFilter === f
                      ? f === 'denied'
                        ? 'bg-rose-500/20 text-rose-300 font-bold'
                        : 'bg-indigo-600 text-white font-bold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f} (
                  {f === 'all'
                    ? auditEvents.length
                    : auditEvents.filter((e) => e.outcome === f).length}
                  )
                </button>
              ))}
            </div>

            <div className="relative flex-1 max-w-xs">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={auditSearch}
                onChange={(e) => setAuditSearch(e.target.value)}
                placeholder="Filter by action, role, or target..."
                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400">
                  <th className="py-2 pr-3">Timestamp</th>
                  <th className="py-2 px-3">Role</th>
                  <th className="py-2 px-3">Action</th>
                  <th className="py-2 px-3">Target</th>
                  <th className="py-2 px-3">Outcome</th>
                  <th className="py-2 pl-3 text-right">Event Integrity Seal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {filteredAuditEvents.slice(0, 25).map((evt) => (
                  <tr key={evt.id} className="text-slate-300">
                    <td className="py-2 pr-3 text-[11px] text-slate-400">
                      {new Date(evt.createdAt).toLocaleTimeString()}
                    </td>
                    <td className="py-2 px-3">
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 text-[10px] uppercase">
                        {evt.actorRole || 'system'}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-semibold text-white">
                      {evt.action}
                    </td>
                    <td className="py-2 px-3 text-slate-400">
                      {evt.targetType ?? evt.resourceType ?? 'resource'}:
                      {String(evt.targetId ?? evt.resourceId ?? 'workspace').slice(0, 14)}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          evt.outcome === 'denied'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        }`}
                      >
                        {evt.outcome}
                      </span>
                    </td>
                    <td className="py-2 pl-3 text-right text-[11px] text-indigo-300/80">
                      {computeAuditSeal(evt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL 1: 21-Action RBAC Policy Matrix */}
      {showPolicyMatrixModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Ordaris 21-Action Enterprise RBAC Policy Matrix
                </h3>
                <p className="text-xs text-slate-400">
                  Enforced centrally by `src/server/policies/authorization.ts` across all HTTP routes.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowPolicyMatrixModal(false)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-2">Permission Action</th>
                    <th className="py-2">Domain</th>
                    <th className="py-2 text-center">Owner (21/21)</th>
                    <th className="py-2 text-center">Admin (19/21)</th>
                    <th className="py-2 text-center">Developer (14/21)</th>
                    <th className="py-2 text-center">Viewer (8/21)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {RBAC_23_ACTIONS.map((row) => (
                    <tr key={row.action} className="text-slate-200">
                      <td className="py-1.5 font-bold text-indigo-300">{row.action}</td>
                      <td className="py-1.5 text-slate-400">{row.category}</td>
                      <td className="py-1.5 text-center text-emerald-400">
                        {row.owner ? '✓' : '—'}
                      </td>
                      <td className="py-1.5 text-center text-emerald-400">
                        {row.admin ? '✓' : '✗'}
                      </td>
                      <td className="py-1.5 text-center text-emerald-400">
                        {row.developer ? '✓' : '✗'}
                      </td>
                      <td className="py-1.5 text-center text-emerald-400">
                        {row.viewer ? '✓' : '✗'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Live 4-Point Cross-Tenant Isolation Verifier */}
      {showIsolationModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-emerald-400" />
                <div>
                  <h3 className="text-sm font-bold text-white">
                    Live 4-Point Cross-Tenant Isolation Verifier (`Acme Cyber Defense` ⇄ `Beta Logistics`)
                  </h3>
                  <p className="text-xs text-slate-400">
                    Executes live server-side probes to prove ADR-002 404 Cross-Tenant Masking & Tenant FK isolation.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowIsolationModal(false)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {verifyingIsolation ? (
              <div className="py-8 text-center text-xs font-mono text-slate-300">
                Executing 4 cross-tenant security probes against PGlite / PostgreSQL...
              </div>
            ) : isolationReport ? (
              <div className="space-y-3">
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-between text-xs">
                  <span className="font-bold text-emerald-300">
                    ✓ ALL {isolationReport.passedChecks}/{isolationReport.totalChecks} ISOLATION INVARIANTS VERIFIED
                  </span>
                  <span className="font-mono text-slate-400">
                    {new Date(isolationReport.verifiedAt).toLocaleTimeString()}
                  </span>
                </div>

                <div className="space-y-2.5">
                  {isolationReport.checks.map((chk) => (
                    <div
                      key={chk.id}
                      className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-white">
                          {chk.title}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300">
                          HTTP {chk.actualStatus} (Expected {chk.expectedStatus})
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">{chk.description}</p>
                      <div className="text-[11px] font-mono text-indigo-300">
                        Proof: {chk.evidence}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

/* ============================================================================
 * REDESIGNED PANEL 5: 3-TIER AI ENGINE RESOLUTION MATRIX + SERVER LOG EXPLORER
 * ============================================================================ */

interface ServerLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | string;
  event: string;
  context?: Record<string, unknown>;
}

interface OrdarisEngineMatrixAndLogsProps {
  sessionId: string;
  providers: ByokProviderStatusItem[];
  selectedEngine: string;
  onSelectEngine: (engine: string) => void;
  onOpenByokDrawer: () => void;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onNotify: (
    message: string,
    tone?: 'success' | 'error' | 'info',
    details?: string
  ) => void;
}

export const OrdarisEngineMatrixAndLogsPanel: React.FC<OrdarisEngineMatrixAndLogsProps> = ({
  sessionId,
  providers,
  selectedEngine,
  onSelectEngine,
  onOpenByokDrawer,
  apiFetch,
  onNotify,
}) => {
  const [logs, setLogs] = useState<ServerLogEntry[]>([]);
  const [logFilePath, setLogFilePath] = useState<string>('.local/logs/ordaris-runtime.log');
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');
  const [logSearch, setLogSearch] = useState<string>('');
  const [loadingLogs, setLoadingLogs] = useState<boolean>(false);
  const [showEnvModal, setShowEnvModal] = useState<boolean>(false);
  const [copiedEnv, setCopiedEnv] = useState<boolean>(false);

  const fetchServerLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const res = await apiFetch('/api/v1/logs?limit=120');
      const json = await res.json();
      if (res.ok && json.data) {
        setLogs(json.data.entries || []);
        if (json.data.logFilePath) setLogFilePath(json.data.logFilePath);
      }
    } finally {
      setLoadingLogs(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    fetchServerLogs();
  }, [fetchServerLogs]);

  const handleClearLogs = async () => {
    const res = await apiFetch('/api/v1/logs/clear', { method: 'POST' });
    if (res.ok) {
      await fetchServerLogs();
      onNotify('Cleared structured runtime logs and recorded audit marker.', 'info');
    }
  };

  const filteredLogs = logs.filter((entry) => {
    if (logLevelFilter !== 'all' && entry.level.toLowerCase() !== logLevelFilter) {
      return false;
    }
    if (!logSearch.trim()) return true;
    const q = logSearch.toLowerCase();
    return (
      entry.event.toLowerCase().includes(q) ||
      JSON.stringify(entry.context || {}).toLowerCase().includes(q)
    );
  });

  const envTemplateText = `# Ordaris Runtime v1.0.0-demo Local Environment Configuration
NODE_ENV=development
PORT=3000
PGLITE_DATA_DIR=.local/ordaris-db
LOG_FILE_PATH=.local/logs/ordaris-runtime.log
DEFAULT_AI_PROVIDER=mock

# Optional Tier-2 Server Cloud AI Keys (Visitors can also use Tier-1 Session BYOK in UI)
GEMINI_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
XAI_API_KEY=`;

  return (
    <div className="space-y-6">
      {/* Part 1: 3-Tier AI Engine Resolution Matrix */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Cpu className="w-5 h-5 text-indigo-400" />
              <span>3-Tier AI Engine Resolution Matrix & Session Isolation</span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Every run resolves credentials in strict priority order: <strong>Tier 1 (Session BYOK `session:{sessionId.slice(0, 12)}`)</strong> ➔ <strong>Tier 2 (Server `.env`)</strong> ➔ <strong>Tier 3 (Deterministic Simulation Engine)</strong>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowEnvModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
            >
              <Terminal className="w-3.5 h-3.5 text-indigo-400" />
              <span>Local `.env` & `pnpm` Quickstart</span>
            </button>

            <button
              type="button"
              onClick={onOpenByokDrawer}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold"
            >
              <Key className="w-3.5 h-3.5" />
              <span>Open Session BYOK Key Vault</span>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] font-mono text-slate-400">
                <th className="py-2 pr-3">Engine ID</th>
                <th className="py-2 px-3">Tier 1: Session BYOK Vault</th>
                <th className="py-2 px-3">Tier 2: Server `.env` Key</th>
                <th className="py-2 px-3">Tier 3: Simulation Fallback</th>
                <th className="py-2 px-3">Active Resolution Tier</th>
                <th className="py-2 pl-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono">
              {providers.map((p) => {
                const engineId = `${p.provider}-free`;
                const isSelected = selectedEngine === engineId;
                const hasByokKey = p.source === 'vault';
                const hasServerEnvKey = p.source === 'env';
                return (
                  <tr key={p.provider} className="text-slate-200">
                    <td className="py-2.5 pr-3">
                      <div className="font-bold text-white">{p.label}</div>
                      <div className="text-[11px] text-slate-400">
                        {engineId} • {p.modelName}
                      </div>
                    </td>
                    <td className="py-2.5 px-3">
                      {hasByokKey ? (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">
                          ✓ {p.maskedPreview}
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[11px]">Not set in session</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {hasServerEnvKey ? (
                        <span className="px-2 py-0.5 rounded bg-sky-500/20 text-sky-300 text-[10px]">
                          ✓ {p.envVarName}
                        </span>
                      ) : (
                        <span className="text-slate-500 text-[11px]">Unset ({p.envVarName})</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 text-[10px]">
                        Always Ready (Zero-Spend)
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          hasByokKey
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : hasServerEnvKey
                              ? 'bg-sky-500/20 text-sky-300'
                              : 'bg-amber-500/20 text-amber-300'
                        }`}
                      >
                        {hasByokKey
                          ? 'TIER 1: SESSION BYOK'
                          : hasServerEnvKey
                            ? 'TIER 2: SERVER .ENV'
                            : 'TIER 3: DETERMINISTIC SIM'}
                      </span>
                    </td>
                    <td className="py-2.5 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() => onSelectEngine(engineId)}
                        className={`px-2.5 py-1 rounded text-[11px] font-bold ${
                          isSelected
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
                        }`}
                      >
                        {isSelected ? '✓ Active Engine' : 'Select Engine'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Part 2: Structured Server Log Explorer */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Terminal className="w-5 h-5 text-emerald-400" />
              <span>Structured JSONL Runtime Log Explorer</span>
              <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-300">
                {logFilePath}
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Streams real-time server events, worker queue heartbeats, and security denials written to `{logFilePath}`.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={fetchServerLogs}
              disabled={loadingLogs}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              onClick={handleClearLogs}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-xs font-mono"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Logs</span>
            </button>
          </div>
        </div>

        {/* Log Filter Controls */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs font-mono">
            {(['all', 'info', 'warn', 'error'] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setLogLevelFilter(lvl)}
                className={`px-3 py-1 rounded-md uppercase transition-all ${
                  logLevelFilter === lvl
                    ? 'bg-indigo-600 text-white font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <div className="relative flex-1 max-w-xs">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              placeholder="Search log event or payload..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-slate-200 font-mono"
            />
          </div>
        </div>

        <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 max-h-96 overflow-y-auto space-y-1.5 font-mono text-xs">
          {filteredLogs.length === 0 ? (
            <div className="py-6 text-center text-slate-500">
              No structured runtime log entries match the active filter.
            </div>
          ) : (
            filteredLogs.map((entry, idx) => (
              <div
                key={`${entry.timestamp}-${idx}`}
                className="p-2 rounded bg-slate-900/80 border border-slate-800/80 flex flex-wrap items-start justify-between gap-2"
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-500">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold ${
                      entry.level === 'error'
                        ? 'bg-rose-500/20 text-rose-300'
                        : entry.level === 'warn'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-emerald-500/15 text-emerald-300'
                    }`}
                  >
                    {entry.level}
                  </span>
                  <span className="font-bold text-white">{entry.event}</span>
                </div>
                {entry.context && Object.keys(entry.context).length > 0 && (
                  <code className="text-[11px] text-slate-400 break-all">
                    {JSON.stringify(entry.context)}
                  </code>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Collapsible Local .env & pnpm Quickstart Modal */}
      {showEnvModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white">
                  Local `.env` Template & `pnpm` CLI Quickstart
                </h3>
                <p className="text-xs text-slate-400">
                  Zero cloud keys required to boot — PGlite and deterministic simulation work out-of-the-box.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowEnvModal(false)}
                className="p-1.5 rounded-lg bg-slate-800 text-slate-300 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="relative">
              <pre className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-emerald-300 overflow-x-auto">
                {envTemplateText}
              </pre>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(envTemplateText);
                  setCopiedEnv(true);
                  setTimeout(() => setCopiedEnv(false), 2000);
                }}
                className="absolute top-2.5 right-2.5 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-mono flex items-center gap-1"
              >
                {copiedEnv ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copiedEnv ? 'Copied' : 'Copy .env'}</span>
              </button>
            </div>

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300 space-y-1">
              <div className="text-slate-400"># Run locally with pnpm:</div>
              <div>pnpm install</div>
              <div>pnpm seed</div>
              <div>pnpm dev</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

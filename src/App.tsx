import React, { useCallback, useEffect, useState } from 'react';
import {
  Download,
  Copy,
  Check,
  GitCommit,
  Terminal,
  FolderArchive,
  ShieldCheck,
  GitBranch,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Database,
  Radio,
  FileCode2,
  RefreshCw,
  Plus,
  Send,
} from 'lucide-react';
import { createZipBlob } from './utils/zip';

import statusContent from '../docs/implementation/STATUS.md?raw';
import architectureContent from '../docs/architecture.md?raw';
import threatModelContent from '../docs/threat-model.md?raw';
import adr001Content from '../docs/adr/ADR-001-local-first-free-tier.md?raw';
import adr002Content from '../docs/adr/ADR-002-tenant-isolation.md?raw';
import adr003Content from '../docs/adr/ADR-003-postgres-job-queue.md?raw';
import envExampleContent from '../.env.example?raw';
import envTsContent from './server/config/env.ts?raw';
import envTestContent from '../tests/unit/env.test.ts?raw';
import dockerComposeContent from '../docker-compose.yml?raw';
import healthRouteContent from './app/api/v1/health/route.ts?raw';
import healthRouteTestContent from '../tests/unit/health-route.test.ts?raw';
import packageJsonContent from '../package.json?raw';
import pnpmWorkspaceContent from '../pnpm-workspace.yaml?raw';
import tsconfigContent from '../tsconfig.json?raw';
import tenantSchemaContent from './server/db/schema/tenant.ts?raw';
import dbClientContent from './server/db/client.ts?raw';
import tenantSchemaTestContent from '../tests/integration/tenant-schema.test.ts?raw';
import authorizationContent from './server/policies/authorization.ts?raw';
import authorizationTestContent from '../tests/unit/authorization.test.ts?raw';
import tenantRepoContent from './server/db/repositories/tenant-repository.ts?raw';
import tenantIsolationTestContent from '../tests/security/tenant-isolation.test.ts?raw';
import agentsSchemaContent from './server/db/schema/agents.ts?raw';
import agentRepoContent from './server/db/repositories/agent-repository.ts?raw';
import agentVersionsTestContent from '../tests/integration/agent-versions.test.ts?raw';
import gitignoreContent from '../.gitignore?raw';
import modelProviderContent from './server/ai/model-provider.ts?raw';
import mockModelProviderTestContent from '../tests/unit/mock-model-provider.test.ts?raw';
import indexCssContent from './index.css?raw';
import mainTsxContent from './main.tsx?raw';
import zipTsContent from './utils/zip.ts?raw';
import appTsxContent from './App.tsx?raw';
import toolGatewayContent from './server/modules/tools/tool-gateway.ts?raw';
import toolGatewayTestContent from '../tests/unit/tool-gateway.test.ts?raw';
import runsSchemaContent from './server/db/schema/runs.ts?raw';
import runExecutorContent from './server/modules/runs/run-executor.ts?raw';
import runExecutorTestContent from '../tests/integration/run-executor.test.ts?raw';
import knowledgeSchemaContent from './server/db/schema/knowledge.ts?raw';
import chunkerContent from './server/modules/knowledge/chunker.ts?raw';
import knowledgeServiceContent from './server/modules/knowledge/knowledge-service.ts?raw';
import ragChunkerTestContent from '../tests/unit/rag-chunker.test.ts?raw';
import knowledgeRagTestContent from '../tests/integration/knowledge-rag.test.ts?raw';
import workflowsSchemaContent from './server/db/schema/workflows.ts?raw';
import dagValidatorContent from './server/modules/workflows/dag-validator.ts?raw';
import workflowEngineContent from './server/modules/workflows/workflow-engine.ts?raw';
import workflowDagTestContent from '../tests/unit/workflow-dag.test.ts?raw';
import workflowHitlAuditTestContent from '../tests/integration/workflow-hitl-audit.test.ts?raw';
import evalsSchemaContent from './server/db/schema/evals.ts?raw';
import evalHarnessContent from './server/modules/evals/eval-harness.ts?raw';
import sseStreamContent from './server/modules/runs/sse-stream.ts?raw';
import evalGradersTestContent from '../tests/unit/eval-graders.test.ts?raw';
import evalSseTestContent from '../tests/integration/eval-sse.test.ts?raw';
import demoSeedContent from './server/seed/demo-seed.ts?raw';
import flagshipE2eTestContent from '../tests/integration/flagship-e2e.test.ts?raw';
import readmeContent from '../README.md?raw';
import indexHtmlContent from '../index.html?raw';
import viteConfigContent from '../vite.config.ts?raw';
import ciWorkflowContent from '../.github/workflows/ci.yml?raw';
import healthServiceContent from './server/modules/health/health-service.ts?raw';
import geminiProviderContent from './server/ai/gemini-provider.ts?raw';
import workerMainContent from './server/worker/main.ts?raw';
import httpAppContent from './server/http/app.ts?raw';
import httpServerContent from './server/http/server.ts?raw';
import rootServerContent from '../server.ts?raw';
import geminiProviderTestContent from '../tests/unit/gemini-provider.test.ts?raw';
import persistenceFkTestContent from '../tests/integration/persistence-and-tenant-fk.test.ts?raw';
import httpApiWorkerTestContent from '../tests/integration/http-api-and-worker.test.ts?raw';

interface ProjectFile {
  step: string;
  ticket: string;
  path: string;
  filename: string;
  title: string;
  commitMessage: string;
  summary: string;
  content: string;
}

const COMPLETED_FILES: ProjectFile[] = [
  {
    step: 'Step 1.1 (File #1)',
    ticket: 'PLAN-001',
    path: 'docs/implementation/STATUS.md',
    filename: 'STATUS.md',
    title: 'Implementation Status & Full-Stack Verification Ledger',
    commitMessage: 'docs(plan): update STATUS.md with Phase A-H full-stack verification',
    summary: 'Tracks active phase, verified tickets, test evidence, and locks in the 9 MVP pillars.',
    content: statusContent,
  },
  {
    step: 'Step 1.2 (File #2)',
    ticket: 'PLAN-002',
    path: 'docs/architecture.md',
    filename: 'architecture.md',
    title: 'System Architecture, Layer Boundaries & Run Lifecycle',
    commitMessage: 'docs(arch): add system architecture and run state machine (PLAN-002)',
    summary: 'Defines inward dependency rules, transactional run+job enqueue, worker row leases, and the run state machine.',
    content: architectureContent,
  },
  {
    step: 'Step 1.3 (File #3)',
    ticket: 'PLAN-003',
    path: 'docs/threat-model.md',
    filename: 'threat-model.md',
    title: 'Security Threat Model & Trust Boundaries',
    commitMessage: 'docs(security): add threat model and T-01..T-07 mitigations (PLAN-003)',
    summary: 'Catalogs 7 concrete threat vectors (IDOR, indirect prompt injection, tool abuse, path traversal) and their server-enforced mitigations.',
    content: threatModelContent,
  },
  {
    step: 'Step 1.4 (File #4)',
    ticket: 'PLAN-004',
    path: 'docs/adr/ADR-001-local-first-free-tier.md',
    filename: 'ADR-001-local-first-free-tier.md',
    title: 'ADR-001: Local-First & Zero-Required-Spend Policy',
    commitMessage: 'docs(adr): add ADR-001 local-first free-tier constraints (PLAN-004)',
    summary: 'Documents why the platform uses deterministic MockModelProvider by default and avoids mandatory paid cloud dependencies.',
    content: adr001Content,
  },
  {
    step: 'Step 1.4b (File #4b)',
    ticket: 'PLAN-004',
    path: 'docs/adr/ADR-002-tenant-isolation.md',
    filename: 'ADR-002-tenant-isolation.md',
    title: 'ADR-002: Defense-in-Depth Multi-Tenant Isolation & 404 Masking',
    commitMessage: 'docs(adr): add ADR-002 multi-tenant isolation and 404 masking policy (PLAN-004)',
    summary: 'Documents three-layer tenant isolation: organization_id FKs, central RBAC 404 cross-tenant masking, and server-injected tool context.',
    content: adr002Content,
  },
  {
    step: 'Step 1.5 (File #5)',
    ticket: 'PLAN-004',
    path: 'docs/adr/ADR-003-postgres-job-queue.md',
    filename: 'ADR-003-postgres-job-queue.md',
    title: 'ADR-003: PostgreSQL Job Queue & Row Leases',
    commitMessage: 'docs(adr): add ADR-003 PostgreSQL FOR UPDATE SKIP LOCKED queue (PLAN-004)',
    summary: 'Details atomic run+job enqueue, FOR UPDATE SKIP LOCKED claiming, lease heartbeats, and expired-lease recovery.',
    content: adr003Content,
  },
  {
    step: 'Step 1.6a (File #6a)',
    ticket: 'REPO-003',
    path: '.env.example',
    filename: '.env.example',
    title: 'Environment Contract Template (.env.example)',
    commitMessage: 'chore(config): add PGLITE_DATA_DIR and AI_MODE=demo defaults in .env.example',
    summary: 'Safe placeholder environment variables showing how the platform runs in AI_MODE=demo with persistent PGLITE_DATA_DIR.',
    content: envExampleContent,
  },
  {
    step: 'Step 1.6b (File #6b)',
    ticket: 'REPO-003',
    path: 'src/server/config/env.ts',
    filename: 'env.ts',
    title: 'Zod Runtime Environment Validator (env.ts)',
    commitMessage: 'feat(config): add PGLITE_DATA_DIR and Zod environment validator (REPO-003)',
    summary: 'Parses and validates all runtime limits, PGLITE_DATA_DIR persistence path, AI_MODE=demo zero-key boot, and AI_MODE=provider key enforcement.',
    content: envTsContent,
  },
  {
    step: 'Step 1.7 (File #7)',
    ticket: 'REPO-003',
    path: 'tests/unit/env.test.ts',
    filename: 'env.test.ts',
    title: 'Unit Test Suite for Environment Validator',
    commitMessage: 'test(config): add unit tests for env validation and secret redaction (REPO-003)',
    summary: 'Verifies AI_MODE=demo zero-key boot, AI_MODE=provider key enforcement, numeric limits, and secret redaction.',
    content: envTestContent,
  },
  {
    step: 'Step 1.8 (File #8)',
    ticket: 'REPO-004',
    path: 'docker-compose.yml',
    filename: 'docker-compose.yml',
    title: 'Local PostgreSQL 16 Docker Compose Service',
    commitMessage: 'chore(db): add PostgreSQL 16 docker-compose with healthcheck (REPO-004)',
    summary: 'Defines reproducible local PostgreSQL 16 with persistent volume aegis_postgres_data and pg_isready healthcheck.',
    content: dockerComposeContent,
  },
  {
    step: 'Step 1.9 (File #9)',
    ticket: 'REPO-004',
    path: 'src/app/api/v1/health/route.ts',
    filename: 'route.ts',
    title: 'Health & Readiness Route Handler (route.ts)',
    commitMessage: 'feat(api): wire /api/v1/health route handler to real database readiness probe',
    summary: 'Executes a real SELECT 1 database readiness check via evaluateDatabaseReadiness() and returns RFC 9457 errors on failure.',
    content: healthRouteContent,
  },
  {
    step: 'Step 1.10 (File #10)',
    ticket: 'REPO-004',
    path: 'tests/unit/health-route.test.ts',
    filename: 'health-route.test.ts',
    title: 'Unit Test Suite for Health & Readiness Endpoint',
    commitMessage: 'test(api): add unit tests for /api/v1/health 200 and 503 states (REPO-004)',
    summary: 'Verifies 200 OK envelope, x-request-id correlation header, 503 database unready Problem Details, and secret redaction.',
    content: healthRouteTestContent,
  },
  {
    step: 'Step 1.11a (File #11a)',
    ticket: 'REPO-001',
    path: 'package.json',
    filename: 'package.json',
    title: 'Package Manifest & Full-Stack Scripts (package.json)',
    commitMessage: 'chore(repo): wire dev, dev:api, dev:worker, start, and test scripts in package.json',
    summary: 'Configures pnpm dev (server.ts), dev:api, dev:worker, start, start:worker, test, typecheck, and seed scripts.',
    content: packageJsonContent,
  },
  {
    step: 'Step 1.11b (File #11b)',
    ticket: 'REPO-005',
    path: 'src/server/db/schema/tenant.ts',
    filename: 'tenant.ts',
    title: 'Drizzle PostgreSQL Schema: Organizations, Users & Memberships',
    commitMessage: 'feat(db): add Drizzle PostgreSQL schema for organizations, users, and memberships (REPO-005)',
    summary: 'Defines organizations, users, and memberships tables with CHECK constraints, composite PK, and SQL migration 0001.',
    content: tenantSchemaContent,
  },
  {
    step: 'Step 1.12 (File #12)',
    ticket: 'REPO-005',
    path: 'src/server/db/client.ts',
    filename: 'client.ts',
    title: 'Drizzle ORM Database Client, File-Backed Persistence & Migration Runner',
    commitMessage: 'feat(db): wire file-backed PGLITE_DATA_DIR persistence and migrations 0001..0006',
    summary: 'Persists PostgreSQL tables on disk in PGLITE_DATA_DIR (.local/aegis-db), runs migrations 0001..0006, and provides real readiness probes.',
    content: dbClientContent,
  },
  {
    step: 'Step 1.13 (File #13)',
    ticket: 'REPO-005',
    path: 'tests/integration/tenant-schema.test.ts',
    filename: 'tenant-schema.test.ts',
    title: 'PostgreSQL Tenant Schema Integration Tests',
    commitMessage: 'test(db): add PostgreSQL integration tests for tenant schema constraints (REPO-005)',
    summary: 'Verifies user/org/membership inserts, duplicate slug rejection, blank name CHECK, invalid role CHECK, composite PK, cascade delete, and readiness probe.',
    content: tenantSchemaTestContent,
  },
  {
    step: 'Step 2.1 (File #14)',
    ticket: 'TENANT-002',
    path: 'src/server/policies/authorization.ts',
    filename: 'authorization.ts',
    title: 'Central RBAC & Tenant Boundary Policy Engine (authorization.ts)',
    commitMessage: 'feat(authz): add central RBAC and tenant boundary policy engine (TENANT-002)',
    summary: 'Enforces 4-role matrix (owner, admin, developer, viewer), cross-tenant 404 masking, admin-vs-owner boundary, and configurable developer approval gates.',
    content: authorizationContent,
  },
  {
    step: 'Step 2.2 (File #15)',
    ticket: 'TENANT-002',
    path: 'tests/unit/authorization.test.ts',
    filename: 'authorization.test.ts',
    title: 'Unit Test Suite for Central Authorization Policy Engine',
    commitMessage: 'test(authz): add unit tests for 4-role RBAC matrix and tenant isolation (TENANT-002)',
    summary: 'Verifies 401 unauthenticated denial, 404 cross-tenant denial even for owners, owner full access, admin boundaries, developer approval toggle, and viewer read-only limits.',
    content: authorizationTestContent,
  },
  {
    step: 'Step 2.3 (File #16)',
    ticket: 'TENANT-001 / TENANT-003',
    path: 'src/server/db/repositories/tenant-repository.ts',
    filename: 'tenant-repository.ts',
    title: 'Multi-Tenant Repository & Last-Owner Safeguard (tenant-repository.ts)',
    commitMessage: 'feat(tenant): add multi-tenant repository with atomic org creation and last-owner safeguard (TENANT-001, TENANT-003)',
    summary: 'Implements idempotent ensureUser(), transactional createOrganizationWithOwner(), resolveActorContext(), and last-owner demotion/removal protection.',
    content: tenantRepoContent,
  },
  {
    step: 'Step 2.4a (File #17)',
    ticket: 'TENANT-004',
    path: 'tests/security/tenant-isolation.test.ts',
    filename: 'tenant-isolation.test.ts',
    title: 'Multi-Tenant Isolation & Security Negative Tests',
    commitMessage: 'test(security): add multi-tenant isolation and last-owner negative tests (TENANT-004)',
    summary: 'Verifies idempotent user provisioning, cross-tenant 404 isolation, anti-spoofing membership resolution, admin-vs-owner privilege boundary, and last-owner safeguard.',
    content: tenantIsolationTestContent,
  },
  {
    step: 'Step 2.4b (File #18)',
    ticket: 'REPO-001',
    path: 'pnpm-workspace.yaml',
    filename: 'pnpm-workspace.yaml',
    title: 'pnpm v12 Workspace & Native Build Allowlist',
    commitMessage: 'chore(repo): add pnpm-workspace.yaml with allowBuilds for esbuild',
    summary: 'Configures pnpm v12 allowBuilds so native postinstall scripts execute cleanly without warnings.',
    content: pnpmWorkspaceContent,
  },
  {
    step: 'Step 2.4c (File #19)',
    ticket: 'REPO-002',
    path: 'tsconfig.json',
    filename: 'tsconfig.json',
    title: 'TypeScript 7 Bundler Configuration',
    commitMessage: 'chore(ts): configure tsconfig.json for src and tests typechecking',
    summary: 'Configures bundler module resolution and strict typechecking across src/ and tests/.',
    content: tsconfigContent,
  },
  {
    step: 'Step 3.1 (File #20)',
    ticket: 'AGENT-001 / AGENT-002',
    path: 'src/server/db/schema/agents.ts',
    filename: 'agents.ts',
    title: 'Drizzle PostgreSQL Schema: Mutable Agents & Immutable Agent Versions',
    commitMessage: 'feat(agents): add composite tenant foreign keys to agents and agent_versions schema',
    summary: 'Defines agents and agent_versions tables with composite (organization_id, agent_id) foreign keys, SHA-256 snapshot_hash, and SQL migration 0002.',
    content: agentsSchemaContent,
  },
  {
    step: 'Step 3.2 (File #21)',
    ticket: 'AGENT-001 / AGENT-002',
    path: 'src/server/db/repositories/agent-repository.ts',
    filename: 'agent-repository.ts',
    title: 'Agent Studio Repository & Immutable Version Publisher',
    commitMessage: 'feat(agents): add agent repository with SHA-256 snapshot hashing and atomic publishing',
    summary: 'Implements createAgentDraft(), updateAgentDraft(), deterministic computeAgentSnapshotHash(), and transactional publishAgentVersion().',
    content: agentRepoContent,
  },
  {
    step: 'Step 3.3 (File #22)',
    ticket: 'AGENT-001 / AGENT-002',
    path: 'tests/integration/agent-versions.test.ts',
    filename: 'agent-versions.test.ts',
    title: 'PostgreSQL Integration Tests for Agent Studio & Immutable Versions',
    commitMessage: 'test(agents): add integration tests for immutable agent versions and RBAC isolation',
    summary: 'Verifies tool allowlist & budget validation, v1 snapshot immutability when draft is edited, v2 publishing, viewer 403 block, and cross-tenant 404 isolation.',
    content: agentVersionsTestContent,
  },
  {
    step: 'Step 3.3b (File #23)',
    ticket: 'REPO-001',
    path: '.gitignore',
    filename: '.gitignore',
    title: 'Repository Git Ignore Rules (.gitignore)',
    commitMessage: 'chore(repo): add .gitignore excluding node_modules, .env, and .local',
    summary: 'Prevents committing node_modules/, .env*, dist/, .local/ runtime uploads, and coverage artifacts.',
    content: gitignoreContent,
  },
  {
    step: 'Step 3.4a (File #24)',
    ticket: 'AGENT-003',
    path: 'src/server/ai/model-provider.ts',
    filename: 'model-provider.ts',
    title: 'Provider-Neutral ModelProvider Interface & Deterministic MockModelProvider',
    commitMessage: 'feat(ai): wire createModelProvider to MockModelProvider and GeminiModelProvider',
    summary: 'Implements MockModelProvider (AI_MODE=demo), verifyModelCitations() anti-hallucination guard, deterministic embedText(), and createModelProvider() routing.',
    content: modelProviderContent,
  },
  {
    step: 'Step 3.4b (File #25)',
    ticket: 'AGENT-003',
    path: 'tests/unit/mock-model-provider.test.ts',
    filename: 'mock-model-provider.test.ts',
    title: 'Unit Test Suite for MockModelProvider & Citation Verifier',
    commitMessage: 'test(ai): add unit tests for MockModelProvider, citation verification, and embeddings',
    summary: 'Verifies 100% deterministic outputs, multi-step calculator & knowledge_search turns, fabricated citation stripping, and unit-normalized vector embeddings.',
    content: mockModelProviderTestContent,
  },
  {
    step: 'Step 3.5a (File #26)',
    ticket: 'REPO-002',
    path: 'src/index.css',
    filename: 'index.css',
    title: 'Tailwind CSS v4 Global Stylesheet (src/index.css)',
    commitMessage: 'chore(ui): add src/index.css with Tailwind v4 import',
    summary: 'Imports Tailwind CSS v4 for the React frontend.',
    content: indexCssContent,
  },
  {
    step: 'Step 3.5b (File #27)',
    ticket: 'REPO-002',
    path: 'src/main.tsx',
    filename: 'main.tsx',
    title: 'React 19 Application Entrypoint (src/main.tsx)',
    commitMessage: 'chore(ui): add src/main.tsx React root entrypoint',
    summary: 'Mounts the React application into #root.',
    content: mainTsxContent,
  },
  {
    step: 'Step 3.5c (File #28)',
    ticket: 'REPO-002',
    path: 'src/utils/zip.ts',
    filename: 'zip.ts',
    title: 'Zero-Dependency PKZIP Archive Builder (src/utils/zip.ts)',
    commitMessage: 'feat(utils): add zero-dependency zip archive generator preserving folder paths',
    summary: 'Generates standard .zip archives in-browser with full relative folder paths.',
    content: zipTsContent,
  },
  {
    step: 'Step 3.5d (File #29)',
    ticket: 'UI-001',
    path: 'src/App.tsx',
    filename: 'App.tsx',
    title: 'API-Backed Agent Studio & Operator Console + Repository Workbench (src/App.tsx)',
    commitMessage: 'feat(ui): connect Agent Studio and Operator Console to live /api/v1/* Express endpoints',
    summary: 'Connects Agent Studio, Run Launcher, HITL Approval Inbox, and SSE Replay Debugger to real /api/v1/* routes backed by PostgreSQL.',
    content: appTsxContent,
  },
  {
    step: 'Step 4.1a (File #30)',
    ticket: 'TOOL-001 / TOOL-002',
    path: 'src/server/modules/tools/tool-gateway.ts',
    filename: 'tool-gateway.ts',
    title: 'Safe Recursive-Descent Calculator & Server-Authorized ToolGateway',
    commitMessage: 'feat(tools): add recursive-descent calculator and server-authorized ToolGateway',
    summary: 'Implements evaluateSafeArithmetic() with zero eval()/Function(), enforces AgentVersionSnapshot.allowedTools, validates Zod schemas, and injects server-side organizationId.',
    content: toolGatewayContent,
  },
  {
    step: 'Step 4.1b (File #31)',
    ticket: 'TOOL-001 / TOOL-002',
    path: 'tests/unit/tool-gateway.test.ts',
    filename: 'tool-gateway.test.ts',
    title: 'Unit & Security Test Suite for Calculator & ToolGateway',
    commitMessage: 'test(tools): add unit and security tests for calculator and ToolGateway',
    summary: 'Verifies arithmetic precedence, injection payload rejection, unallowed tool blocking (Threat T-03), server-side organizationId override, and timeout budgets.',
    content: toolGatewayTestContent,
  },
  {
    step: 'Step 4.2a (File #32)',
    ticket: 'RUN-001 / QUEUE-001',
    path: 'src/server/db/schema/runs.ts',
    filename: 'runs.ts',
    title: 'Drizzle PostgreSQL Schema: Runs, Run Steps, Run Events & Job Queue',
    commitMessage: 'feat(runs): add composite tenant foreign keys to runs, run_steps, run_events, and job_queue',
    summary: 'Defines runs, run_steps, run_events, and job_queue with composite tenant foreign keys and SQL migration 0003.',
    content: runsSchemaContent,
  },
  {
    step: 'Step 4.2b (File #33)',
    ticket: 'RUN-002 / QUEUE-002',
    path: 'src/server/modules/runs/run-executor.ts',
    filename: 'run-executor.ts',
    title: 'Bounded Agent Runtime Executor & PostgreSQL SKIP LOCKED Worker',
    commitMessage: 'feat(runs): add bounded agent runtime executor and PostgreSQL job queue',
    summary: 'Implements transactional enqueueAgentRun(), FOR UPDATE SKIP LOCKED claimNextPendingJob(), recoverExpiredJobLeases(), and bounded executeAgentRun().',
    content: runExecutorContent,
  },
  {
    step: 'Step 4.2c (File #34)',
    ticket: 'RUN-001..002 / QUEUE-001..002',
    path: 'tests/integration/run-executor.test.ts',
    filename: 'run-executor.test.ts',
    title: 'PostgreSQL Integration Tests for Bounded Agent Runtime & Job Queue',
    commitMessage: 'test(runs): add PostgreSQL integration tests for run executor, job leases, and step budgets',
    summary: 'Verifies end-to-end multi-step calculator & RAG runs, idempotency key deduplication, maxSteps budget failure, expired lease recovery, and cross-tenant 404 isolation.',
    content: runExecutorTestContent,
  },
  {
    step: 'Step 5.1a (File #35)',
    ticket: 'RAG-001',
    path: 'src/server/db/schema/knowledge.ts',
    filename: 'knowledge.ts',
    title: 'Drizzle PostgreSQL Schema: Tenant Knowledge Documents & Chunks',
    commitMessage: 'feat(rag): add Drizzle schema and migration 0004 for knowledge_documents and document_chunks',
    summary: 'Defines knowledge_documents and document_chunks with composite tenant FK and PostgreSQL GIN tsvector index.',
    content: knowledgeSchemaContent,
  },
  {
    step: 'Step 5.1b (File #36)',
    ticket: 'RAG-002',
    path: 'src/server/modules/knowledge/chunker.ts',
    filename: 'chunker.ts',
    title: 'Deterministic Document Chunker, Path Sanitizer & Prompt-Injection Guard',
    commitMessage: 'feat(rag): add deterministic chunker, T-05 filename sanitizer, and T-03 untrusted context wrapper',
    summary: 'Implements sanitizeDisplayFilename(), generateOpaqueStorageKey(), chunkDocumentText(), detectPromptInjectionPatterns(), and wrapUntrustedKnowledgeChunk().',
    content: chunkerContent,
  },
  {
    step: 'Step 5.1c (File #37)',
    ticket: 'RAG-003',
    path: 'src/server/modules/knowledge/knowledge-service.ts',
    filename: 'knowledge-service.ts',
    title: 'Tenant-Isolated Knowledge Ingestion & Hybrid FTS + Vector Search Service',
    commitMessage: 'feat(rag): add tenant-isolated knowledge ingestion and hybrid FTS/vector search',
    summary: 'Implements transactional ingestKnowledgeDocument(), SHA-256 deduplication, hybrid PostgreSQL tsvector + vector cosine ranking, and createTenantKnowledgeRetriever().',
    content: knowledgeServiceContent,
  },
  {
    step: 'Step 5.1d (File #38)',
    ticket: 'RAG-002',
    path: 'tests/unit/rag-chunker.test.ts',
    filename: 'rag-chunker.test.ts',
    title: 'Unit & Security Test Suite for RAG Chunker & T-03/T-05 Guards',
    commitMessage: 'test(rag): add unit tests for deterministic chunker, path traversal guard, and prompt injection wrapper',
    summary: 'Verifies path traversal stripping, opaque storage keys, deterministic Markdown chunking, maxChunks budget, prompt-injection detection, and XML delimiter escaping.',
    content: ragChunkerTestContent,
  },
  {
    step: 'Step 5.1e (File #39)',
    ticket: 'RAG-001 / RAG-003',
    path: 'tests/integration/knowledge-rag.test.ts',
    filename: 'knowledge-rag.test.ts',
    title: 'PostgreSQL Integration Tests for Tenant Knowledge Base & Grounded RAG',
    commitMessage: 'test(rag): add PostgreSQL integration tests for hybrid search, tenant isolation, and grounded agent runs',
    summary: 'Verifies transactional ingestion, SHA-256 deduplication, hybrid FTS + vector ranking, strict zero-leakage cross-tenant isolation, and end-to-end grounded agent citations.',
    content: knowledgeRagTestContent,
  },
  {
    step: 'Step 6.1a (File #40)',
    ticket: 'WORKFLOW-001 / HITL-001 / AUDIT-001 / USAGE-001',
    path: 'src/server/db/schema/workflows.ts',
    filename: 'workflows.ts',
    title: 'Drizzle PostgreSQL Schema: Workflows, Versions, Approvals, Audit & Usage Ledgers',
    commitMessage: 'feat(workflows): add composite tenant foreign keys to approval_requests and usage_events',
    summary: 'Defines workflows, workflow_versions, approval_requests, audit_events, and usage_events with composite tenant foreign keys and SQL migration 0005.',
    content: workflowsSchemaContent,
  },
  {
    step: 'Step 6.1b (File #41)',
    ticket: 'WORKFLOW-001 / WORKFLOW-002',
    path: 'src/server/modules/workflows/dag-validator.ts',
    filename: 'dag-validator.ts',
    title: 'Directed Acyclic Workflow Validator, Cycle Detector & Safe Condition Evaluator',
    commitMessage: 'feat(workflows): add 3-color DFS cycle detector, topological sorter, and safe condition evaluator',
    summary: 'Enforces node/edge limits, detects directed cycles with exact cyclePath, checks start/end reachability, evaluates conditions without eval(), and hashes graphs canonically.',
    content: dagValidatorContent,
  },
  {
    step: 'Step 6.1c (File #42)',
    ticket: 'WORKFLOW-002 / HITL-001 / AUDIT-001 / USAGE-001',
    path: 'src/server/modules/workflows/workflow-engine.ts',
    filename: 'workflow-engine.ts',
    title: 'Workflow Execution Engine, HITL Pause/Resume Controller & Audit/Usage Ledgers',
    commitMessage: 'feat(workflows): add DAG workflow runner, waiting_approval HITL gates, security audit log, and usage ledger',
    summary: 'Executes workflow DAGs, pauses at approval nodes, enforces RBAC and 404 isolation on approval decisions, logs allowed/denied audit_events, and separates mock vs live usage.',
    content: workflowEngineContent,
  },
  {
    step: 'Step 6.1d (File #43)',
    ticket: 'WORKFLOW-001 / WORKFLOW-002',
    path: 'tests/unit/workflow-dag.test.ts',
    filename: 'workflow-dag.test.ts',
    title: 'Unit Test Suite for Workflow DAG Validator & Condition Evaluator',
    commitMessage: 'test(workflows): add unit tests for DAG cycle detection, reachability, condition evaluation, and snapshot hashing',
    summary: 'Verifies valid branching DAG topological sort, cycle path diagnostics, self-loop rejection, orphan/dead-end rejection, safe condition operators, and canonical hashing.',
    content: workflowDagTestContent,
  },
  {
    step: 'Step 6.1e (File #44)',
    ticket: 'WORKFLOW-002 / HITL-001 / AUDIT-001 / USAGE-001',
    path: 'tests/integration/workflow-hitl-audit.test.ts',
    filename: 'workflow-hitl-audit.test.ts',
    title: 'PostgreSQL Integration Tests for Workflows, HITL Approvals, Audit Trail & Usage Ledger',
    commitMessage: 'test(workflows): add PostgreSQL integration tests for HITL pause/resume, denied audit logs, and usage ledger',
    summary: 'Verifies immutable workflow versions, waiting_approval pause & admin resume, 404 cross-tenant isolation, 403 viewer/developer denied audit events, and mock vs live usage.',
    content: workflowHitlAuditTestContent,
  },
  {
    step: 'Step 7.1a (File #45)',
    ticket: 'EVAL-001',
    path: 'src/server/db/schema/evals.ts',
    filename: 'evals.ts',
    title: 'Drizzle PostgreSQL Schema: Automated Evaluation Suites, Cases, Experiments & Results',
    commitMessage: 'feat(evals): tighten composite tenant foreign keys in evals schema migration 0006',
    summary: 'Defines eval_suites, eval_cases, eval_experiments, and eval_case_results with composite (organization_id, agent_id, agent_version_id) foreign keys.',
    content: evalsSchemaContent,
  },
  {
    step: 'Step 7.1b (File #46)',
    ticket: 'EVAL-001',
    path: 'src/server/modules/evals/eval-harness.ts',
    filename: 'eval-harness.ts',
    title: 'Automated Evaluation Harness, Deterministic Graders & Version Regression Diff Engine',
    commitMessage: 'feat(evals): add deterministic assertion graders, experiment runner, and v1-vs-v2 regression comparator',
    summary: 'Implements exact_match, contains, json_schema, citation_required, and tool_called graders, createEvalSuite(), runEvalExperiment(), and compareEvalExperiments().',
    content: evalHarnessContent,
  },
  {
    step: 'Step 7.1c (File #47)',
    ticket: 'SSE-001',
    path: 'src/server/modules/runs/sse-stream.ts',
    filename: 'sse-stream.ts',
    title: 'Server-Sent Events (SSE) Replay Debugger & Last-Event-ID Cursor Stream Engine',
    commitMessage: 'feat(sse): add SSE event stream framing and Last-Event-ID cursor reconnect replay',
    summary: 'Implements parseLastEventIdCursor(), formatSseEventFrame(), and createRunEventsSseResponse() with RBAC and 404 cross-tenant isolation.',
    content: sseStreamContent,
  },
  {
    step: 'Step 7.1d (File #48)',
    ticket: 'EVAL-001 / SSE-001',
    path: 'tests/unit/eval-graders.test.ts',
    filename: 'eval-graders.test.ts',
    title: 'Unit Test Suite for Evaluation Assertion Graders & SSE Wire Protocol',
    commitMessage: 'test(evals): add unit tests for deterministic assertion graders and SSE cursor/frame formatting',
    summary: 'Verifies exact_match, contains, json_schema, citation_required, tool_called, fractional scoring, and Last-Event-ID cursor parsing.',
    content: evalGradersTestContent,
  },
  {
    step: 'Step 7.1e (File #49)',
    ticket: 'EVAL-001 / SSE-001',
    path: 'tests/integration/eval-sse.test.ts',
    filename: 'eval-sse.test.ts',
    title: 'PostgreSQL Integration Tests for Evaluation Experiments, Regression Diffs & SSE Replay',
    commitMessage: 'test(evals): add PostgreSQL integration tests for eval experiments, v1-vs-v2 regression detection, and SSE cursor replay',
    summary: 'Verifies 100% pass rate on Agent v1, regression detection when Agent v2 drops calculator tool, SSE reconnect replay with Last-Event-ID, and 403/404 isolation.',
    content: evalSseTestContent,
  },
  {
    step: 'Step 8.1a (File #50)',
    ticket: 'SEED-001',
    path: 'src/server/seed/demo-seed.ts',
    filename: 'demo-seed.ts',
    title: 'Deterministic Flagship Workspace Seed & Verification Runner (demo-seed.ts)',
    commitMessage: 'feat(seed): add deterministic multi-tenant flagship seed runner across all 9 MVP subsystems',
    summary: 'Provisions Acme Cyber Defense & Beta Logistics, 4 RBAC roles, RAG runbook chunks, Agent v1/v2 snapshots, HITL workflow run, Eval diff, and SSE cursor replay.',
    content: demoSeedContent,
  },
  {
    step: 'Step 8.1b (File #51)',
    ticket: 'SEED-001',
    path: 'tests/integration/flagship-e2e.test.ts',
    filename: 'flagship-e2e.test.ts',
    title: 'End-to-End Flagship Verification Test Suite',
    commitMessage: 'test(e2e): add flagship end-to-end PostgreSQL verification suite for seedFlagshipWorkspace',
    summary: 'Verifies end-to-end seeding, cross-tenant 404 isolation between Acme and Beta, v1-vs-v2 regression detection, SSE Last-Event-ID replay, and RBAC audit logs.',
    content: flagshipE2eTestContent,
  },
  {
    step: 'Step 8.1c (File #52)',
    ticket: 'DOCS-001',
    path: 'README.md',
    filename: 'README.md',
    title: 'Production Architecture, Threat Model & Full-Stack API Documentation (README.md)',
    commitMessage: 'docs(readme): document Express HTTP API endpoints, worker lifecycle, and PGlite persistence',
    summary: 'Documents the 9 verified subsystems, Express HTTP API table, background worker lifecycle, PGLITE_DATA_DIR persistence, and quickstart commands.',
    content: readmeContent,
  },
  {
    step: 'Step 8.2a (File #53)',
    ticket: 'BUILD-001',
    path: 'index.html',
    filename: 'index.html',
    title: 'Vite HTML Entry Point & OpenGraph Metadata (index.html)',
    commitMessage: 'chore(build): add index.html Vite entry point and OpenGraph metadata (BUILD-001)',
    summary: 'Provides the root HTML document and /src/main.tsx module entry required by pnpm dev and pnpm build.',
    content: indexHtmlContent,
  },
  {
    step: 'Step 8.2b (File #54)',
    ticket: 'BUILD-001',
    path: 'vite.config.ts',
    filename: 'vite.config.ts',
    title: 'Vite 8 + React 19 + Tailwind CSS v4 Build Configuration (vite.config.ts)',
    commitMessage: 'chore(build): add vite.config.ts with React and Tailwind v4 plugins (BUILD-001)',
    summary: 'Configures @vitejs/plugin-react, @tailwindcss/vite, and import.meta.dirname path aliasing for clean Vite 8 builds.',
    content: viteConfigContent,
  },
  {
    step: 'Step 8.2c (File #55)',
    ticket: 'CI-001',
    path: '.github/workflows/ci.yml',
    filename: 'ci.yml',
    title: 'GitHub Actions Continuous Integration Pipeline (.github/workflows/ci.yml)',
    commitMessage: 'ci(github): enforce frozen lockfile and repo hygiene check in GitHub Actions CI',
    summary: 'Runs repository secret/hygiene checks, pnpm install --frozen-lockfile, pnpm typecheck, pnpm test, pnpm seed, and pnpm build.',
    content: ciWorkflowContent,
  },
  {
    step: 'Step 9.1 (File #56)',
    ticket: 'PHASE-B',
    path: 'src/server/modules/health/health-service.ts',
    filename: 'health-service.ts',
    title: 'Framework-Neutral Liveness & Real Database Readiness Service (health-service.ts)',
    commitMessage: 'feat(health): add health-service executing real SELECT 1 database readiness probes',
    summary: 'Separates process liveness (/api/v1/health/live) from real PostgreSQL SELECT 1 readiness (/api/v1/health/ready).',
    content: healthServiceContent,
  },
  {
    step: 'Step 9.2 (File #57)',
    ticket: 'PHASE-F',
    path: 'src/server/ai/gemini-provider.ts',
    filename: 'gemini-provider.ts',
    title: 'Server-Only Live Gemini ModelProvider Adapter (gemini-provider.ts)',
    commitMessage: 'feat(ai): add server-side GeminiModelProvider adapter for AI_MODE=provider',
    summary: 'Implements ModelProvider using @google/genai on the server with timeout bounds, structured JSON tool calls, and verifyModelCitations().',
    content: geminiProviderContent,
  },
  {
    step: 'Step 9.3 (File #58)',
    ticket: 'PHASE-D',
    path: 'src/server/worker/main.ts',
    filename: 'main.ts',
    title: 'Background Job Queue Worker Process & Lease Recovery Loop (src/server/worker/main.ts)',
    commitMessage: 'feat(worker): add RuntimeWorker polling loop, lease recovery, and standalone CLI entrypoint',
    summary: 'Claims pending jobs via FOR UPDATE SKIP LOCKED, recovers expired leases, and handles SIGINT/SIGTERM graceful shutdown.',
    content: workerMainContent,
  },
  {
    step: 'Step 9.4 (File #59)',
    ticket: 'PHASE-C',
    path: 'src/server/http/app.ts',
    filename: 'app.ts',
    title: 'Express HTTP API Router & Mounted /api/v1/* Endpoints (src/server/http/app.ts)',
    commitMessage: 'feat(api): add Express HTTP API serving /api/v1/health, agents, runs, SSE stream, and approvals',
    summary: 'Mounts all /api/v1/* routes with Zod validation, membership-verified actor authentication, and RFC 9457 Problem Details error envelopes.',
    content: httpAppContent,
  },
  {
    step: 'Step 9.5 (File #60)',
    ticket: 'PHASE-C',
    path: 'src/server/http/server.ts',
    filename: 'server.ts',
    title: 'API Server CLI Entrypoint (src/server/http/server.ts)',
    commitMessage: 'feat(api): add src/server/http/server.ts API process entrypoint',
    summary: 'Provides the standalone dev:api / start:api entrypoint delegating to startAegisServer().',
    content: httpServerContent,
  },
  {
    step: 'Step 9.6 (File #61)',
    ticket: 'PHASE-C / PHASE-D',
    path: 'server.ts',
    filename: 'server.ts',
    title: 'Full-Stack Express + Worker + Vite Runtime Entrypoint (server.ts)',
    commitMessage: 'feat(server): add full-stack Express API, background RuntimeWorker, and Vite middleware server',
    summary: 'Boots persistent PGlite (.local/aegis-db), seeds the default workspace if empty, starts RuntimeWorker, and serves /api/v1/* + React UI on port 3000.',
    content: rootServerContent,
  },
  {
    step: 'Step 9.7 (File #62)',
    ticket: 'PHASE-F',
    path: 'tests/unit/gemini-provider.test.ts',
    filename: 'gemini-provider.test.ts',
    title: 'Unit & Contract Tests for Server-Side GeminiModelProvider (3/3 Passing)',
    commitMessage: 'test(ai): add offline mocked SDK contract tests for GeminiModelProvider',
    summary: 'Verifies AI_MODE=provider routing, structured response parsing, fabricated citation stripping, live token telemetry, and timeout bounds with zero network calls.',
    content: geminiProviderTestContent,
  },
  {
    step: 'Step 9.8 (File #63)',
    ticket: 'PHASE-B / PHASE-E',
    path: 'tests/integration/persistence-and-tenant-fk.test.ts',
    filename: 'persistence-and-tenant-fk.test.ts',
    title: 'Integration Tests for File-Backed Restart Persistence & SQL Composite Tenant FKs (2/2 Passing)',
    commitMessage: 'test(db): add file-backed PGlite restart persistence and direct SQL cross-tenant FK negative tests',
    summary: 'Proves file-backed PGlite retains data across restarts and PostgreSQL rejects direct SQL cross-tenant inserts across all child tables.',
    content: persistenceFkTestContent,
  },
  {
    step: 'Step 9.9 (File #64)',
    ticket: 'PHASE-C / PHASE-D',
    path: 'tests/integration/http-api-and-worker.test.ts',
    filename: 'http-api-and-worker.test.ts',
    title: 'HTTP API & Background Worker Integration Test Suite',
    commitMessage: 'test(api): add Express HTTP API, SSE cursor replay, and server-authorized HITL integration tests',
    summary: 'Exercises /api/v1/health/live, /ready, /workspace, /agents, /runs, /stream (Last-Event-ID), /approvals/:id/decision, and /audit-events over real HTTP requests.',
    content: httpApiWorkerTestContent,
  },
];

interface CurrentBatchItem {
  path: string;
  status: 'NEW' | 'UPDATED';
  changeReason: string;
}

const CURRENT_STEP_BATCH: CurrentBatchItem[] = [
  {
    path: 'server.ts',
    status: 'NEW',
    changeReason: 'Phase C/D: Full-stack Express API + RuntimeWorker + Vite entrypoint on port 3000.',
  },
  {
    path: 'src/server/http/app.ts',
    status: 'NEW',
    changeReason: 'Phase C: Express HTTP router mounting /api/v1/health/live, /ready, /workspace, /agents, /runs, /stream, /approvals, /knowledge, /workflows, /usage, and /audit-events.',
  },
  {
    path: 'src/server/http/server.ts',
    status: 'NEW',
    changeReason: 'Phase C: API process entrypoint for `pnpm dev:api` and `pnpm start:api`.',
  },
  {
    path: 'src/server/worker/main.ts',
    status: 'NEW',
    changeReason: 'Phase D: Background queue worker process (`RuntimeWorker`) with `FOR UPDATE SKIP LOCKED` claiming, expired lease recovery, and graceful shutdown.',
  },
  {
    path: 'src/server/modules/health/health-service.ts',
    status: 'NEW',
    changeReason: 'Phase B: Framework-neutral liveness and real PostgreSQL `SELECT 1` readiness probe service.',
  },
  {
    path: 'src/server/ai/gemini-provider.ts',
    status: 'UPDATED',
    changeReason: 'Phase F+: Multi-provider Free-Tier Cloud AI adapters for Google Gemini (`gemini-3-flash-preview`), OpenAI ChatGPT (`gpt-4o-mini`), Anthropic Claude (`claude-3-5-haiku-latest`), and xAI Grok (`grok-2-latest`).',
  },
  {
    path: 'tests/unit/gemini-provider.test.ts',
    status: 'UPDATED',
    changeReason: 'Phase F+: Offline contract tests for `GeminiModelProvider`, `OpenAIChatGPTModelProvider`, `AnthropicClaudeModelProvider`, and `XaiGrokModelProvider`.',
  },
  {
    path: 'tests/integration/persistence-and-tenant-fk.test.ts',
    status: 'NEW',
    changeReason: 'Phase B & E: File-backed PGlite restart persistence test + direct SQL cross-tenant composite FK negative tests.',
  },
  {
    path: 'tests/integration/http-api-and-worker.test.ts',
    status: 'NEW',
    changeReason: 'Phase C & D: End-to-end HTTP API, background worker, SSE cursor replay, and server-authorized HITL approval tests.',
  },
  {
    path: 'src/server/db/client.ts',
    status: 'UPDATED',
    changeReason: 'Phase B: Wired `getSharedDatabase()` to file-backed `PGLITE_DATA_DIR` (`.local/aegis-db`).',
  },
  {
    path: 'src/server/config/env.ts',
    status: 'UPDATED',
    changeReason: 'Phase F+: Added `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`, and `PGLITE_DATA_DIR` configuration.',
  },
  {
    path: '.env.example',
    status: 'UPDATED',
    changeReason: 'Phase F+: Documented free-tier API keys (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`) and `PGLITE_DATA_DIR`.',
  },
  {
    path: 'src/app/api/v1/health/route.ts',
    status: 'UPDATED',
    changeReason: 'Phase B: Wired `defaultReadinessCheck` to execute a real `SELECT 1` database query via `evaluateDatabaseReadiness()`.',
  },
  {
    path: 'src/server/ai/model-provider.ts',
    status: 'UPDATED',
    changeReason: 'Phase F+: Added `createLiveRuntimeModelProvider()` routing across Gemini, ChatGPT, Claude, and Grok free tiers.',
  },
  {
    path: 'src/server/modules/runs/run-executor.ts',
    status: 'UPDATED',
    changeReason: 'Phase F+: Records `usage_source="provider"` and inserts `provider_mode="live"` rows in `usage_events` when live AI runs complete.',
  },
  {
    path: 'src/server/db/schema/agents.ts',
    status: 'UPDATED',
    changeReason: 'Phase E: Added composite `(organization_id, agent_id)` foreign key and unique constraints to migration 0002.',
  },
  {
    path: 'src/server/db/schema/runs.ts',
    status: 'UPDATED',
    changeReason: 'Phase E: Added composite `(organization_id, agent_id, agent_version_id)` and `(organization_id, run_id)` foreign keys to migration 0003.',
  },
  {
    path: 'src/server/db/schema/workflows.ts',
    status: 'UPDATED',
    changeReason: 'Phase E: Added composite `(organization_id, run_id)` and `(organization_id, workflow_version_id)` foreign keys to migration 0005.',
  },
  {
    path: 'src/server/db/schema/evals.ts',
    status: 'UPDATED',
    changeReason: 'Phase E: Enforced composite `(organization_id, agent_id, agent_version_id)` FK and `ON DELETE CASCADE` on `eval_case_results` in migration 0006.',
  },
  {
    path: '.github/workflows/ci.yml',
    status: 'UPDATED',
    changeReason: 'Phase A: Enforced `pnpm install --frozen-lockfile` and repository hygiene check in GitHub Actions CI.',
  },
  {
    path: 'package.json',
    status: 'UPDATED',
    changeReason: 'Phase C/D: Added `dev`, `dev:api`, `dev:worker`, `start`, `start:api`, and `start:worker` scripts.',
  },
  {
    path: 'README.md',
    status: 'UPDATED',
    changeReason: 'Phase H: Documented full-stack Express API endpoints, background worker lifecycle, and persistent PGlite storage.',
  },
  {
    path: 'docs/implementation/STATUS.md',
    status: 'UPDATED',
    changeReason: 'Phase H: Recorded verified Phase A–H completion and test outputs.',
  },
  {
    path: 'index.html',
    status: 'NEW',
    changeReason: 'Phase A: Root HTML entry point for Vite.',
  },
  {
    path: 'vite.config.ts',
    status: 'NEW',
    changeReason: 'Phase A: Vite 8 + React + Tailwind v4 configuration.',
  },
  {
    path: 'src/App.tsx',
    status: 'UPDATED',
    changeReason: 'Phase G: Replaced simulated local state with live `/api/v1/*` HTTP requests to Express and PostgreSQL.',
  },
];

type ConsoleActorId = 'acme-owner' | 'acme-admin' | 'acme-dev' | 'acme-viewer' | 'beta-owner';

interface WorkspacePersona {
  id: ConsoleActorId;
  label: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  role: 'owner' | 'admin' | 'developer' | 'viewer';
}

interface WorkspaceAgent {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  draftSystemPrompt: string;
  draftToolAllowlist: string[];
  latestVersionNumber: number;
}

interface WorkspaceAgentVersion {
  id: string;
  agentId: string;
  versionNumber: number;
  snapshotHash: string;
  toolAllowlist: string[];
  systemPrompt: string;
}

interface WorkspaceRun {
  id: string;
  agentId: string;
  agentVersionId: string;
  status: string;
  inputPrompt: string;
  finalOutput: string | null;
  stepCount: number;
  toolCallCount: number;
  totalTokens: number;
  usageSource: string;
  citations: Array<{
    chunkId: string;
    documentId: string;
    documentTitle: string;
    quote: string;
  }>;
  createdAt: string;
}

interface WorkspaceApproval {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decisionNote: string | null;
  createdAt: string;
}

interface WorkspaceWorkflow {
  id: string;
  slug: string;
  name: string;
  latestVersionNumber: number;
}

interface WorkspaceAuditEvent {
  id: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: 'allowed' | 'denied';
  createdAt: string;
}

interface WorkspaceData {
  actor: {
    userId: string;
    organizationId: string;
    role: string;
  };
  storageMode: 'file' | 'memory';
  aiMode: string;
  aiProvider?: string;
  hasGeminiKey?: boolean;
  personas: WorkspacePersona[];
  agents: WorkspaceAgent[];
  agentVersions: WorkspaceAgentVersion[];
  runs: WorkspaceRun[];
  approvals: WorkspaceApproval[];
  workflows: WorkspaceWorkflow[];
  documents: Array<{ id: string; title: string; sourceFilename: string; storageKey: string; contentSha256: string }>;
  evalComparison: {
    baselinePassRate?: number;
    candidatePassRate?: number;
    baselineExperiment?: { passRate: number };
    candidateExperiment?: { passRate: number };
    passRateDelta: number;
    regressedCases?: Array<{ caseName: string; baselinePassed: boolean; candidatePassed: boolean }>;
  } | null;
  usageSummary: {
    mock: { runsCount: number; totalTokens: number; toolCallsCount: number };
    live: { runsCount: number; totalTokens: number; toolCallsCount: number };
  };
  auditEvents: WorkspaceAuditEvent[];
  canViewAudit: boolean;
}

type AiEngineChoice =
  | 'auto'
  | 'gemini-free'
  | 'chatgpt-free'
  | 'claude-free'
  | 'grok-free'
  | 'mock';

export default function App() {
  // Phase G: Agent Studio & Live Runtime Console is the default primary route
  const [activeView, setActiveView] = useState<'console' | 'workbench'>('console');
  const [selectedIndex, setSelectedIndex] = useState<number>(COMPLETED_FILES.length - 1);
  const [copiedType, setCopiedType] = useState<'content' | 'git' | 'batch-git' | null>(null);

  // Live API-backed state
  const [selectedActorId, setSelectedActorId] = useState<ConsoleActorId>('acme-admin');
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null);
  const [healthInfo, setHealthInfo] = useState<{
    database: string;
    engine: string;
    storageMode: string;
    latencyMs: number;
    aiMode: string;
    aiProvider?: string;
  } | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState<boolean>(true);
  const [apiBanner, setApiBanner] = useState<{
    kind: 'success' | 'error' | 'info';
    status: number;
    title: string;
    detail: string;
  } | null>(null);

  // Agent Run Launcher form state
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedAgentVersionId, setSelectedAgentVersionId] = useState<string>('');
  const [selectedAiEngine, setSelectedAiEngine] = useState<AiEngineChoice>('auto');
  const [runPromptInput, setRunPromptInput] = useState<string>(
    'Calculate (18 * 4) + 28 using calculator and search runbook for Severity 1 incident escalation'
  );
  const [runningAgentJob, setRunningAgentJob] = useState<boolean>(false);

  // New Agent Draft creation modal/inline form
  const [showNewAgentForm, setShowNewAgentForm] = useState<boolean>(false);
  const [newAgentName, setNewAgentName] = useState<string>('Cloud Cost Anomaly Auditor');
  const [newAgentSlug, setNewAgentSlug] = useState<string>('cloud-cost-auditor');
  const [newAgentPrompt, setNewAgentPrompt] = useState<string>(
    'You audit FinOps spend anomalies using calculator and knowledge_search.'
  );

  // Persisted SSE Stream Inspector state
  const [selectedStreamRunId, setSelectedStreamRunId] = useState<string>('');
  const [lastEventIdCursor, setLastEventIdCursor] = useState<number>(0);
  const [sseRawFrames, setSseRawFrames] = useState<string>('');
  const [loadingSse, setLoadingSse] = useState<boolean>(false);

  const activeFile = COMPLETED_FILES[selectedIndex] ?? COMPLETED_FILES[0]!;

  const batchFiles = CURRENT_STEP_BATCH.map((item) => {
    const index = COMPLETED_FILES.findIndex((f) => f.path === item.path);
    return {
      ...item,
      index,
      file: COMPLETED_FILES[index]!,
    };
  }).filter((item) => Boolean(item.file));

  const fetchHealthAndWorkspace = useCallback(
    async (actorId: ConsoleActorId) => {
      setLoadingWorkspace(true);
      try {
        const [healthRes, wsRes] = await Promise.all([
          fetch('/api/v1/health/ready'),
          fetch('/api/v1/workspace', {
            headers: { 'x-actor-id': actorId },
          }),
        ]);

        if (healthRes.ok) {
          const hJson = await healthRes.json();
          setHealthInfo({
            database: hJson.data.readiness.database,
            engine: hJson.data.readiness.engine,
            storageMode: hJson.data.readiness.storageMode ?? 'file',
            latencyMs: hJson.data.readiness.latencyMs,
            aiMode: hJson.data.runtime.aiMode,
            aiProvider: hJson.data.runtime.aiProvider,
          });
        }

        if (wsRes.ok) {
          const wsJson = await wsRes.json();
          const data: WorkspaceData = wsJson.data;
          setWorkspace(data);
          const defaultAgentId = selectedAgentId || data.agents[0]?.id || '';
          if (defaultAgentId && !selectedAgentId) {
            setSelectedAgentId(defaultAgentId);
          }
          if (defaultAgentId) {
            const versionsForAgent = data.agentVersions
              .filter((v) => v.agentId === defaultAgentId)
              .sort((a, b) => a.versionNumber - b.versionNumber);
            // Default to v1 when available so both calculator and knowledge_search are allowed
            const preferredVersion =
              versionsForAgent.find((v) => v.toolAllowlist.includes('calculator')) ??
              versionsForAgent[0];
            if (
              preferredVersion &&
              (!selectedAgentVersionId ||
                !versionsForAgent.some((v) => v.id === selectedAgentVersionId))
            ) {
              setSelectedAgentVersionId(preferredVersion.id);
            }
          }
          if (data.runs.length > 0 && !selectedStreamRunId) {
            setSelectedStreamRunId(data.runs[0]!.id);
          }
        } else {
          const problem = await wsRes.json();
          setApiBanner({
            kind: 'error',
            status: wsRes.status,
            title: problem.title ?? 'Workspace fetch failed',
            detail: problem.detail ?? 'Could not load workspace for actor.',
          });
        }
      } catch (err) {
        setApiBanner({
          kind: 'error',
          status: 503,
          title: 'API Connection Error',
          detail: err instanceof Error ? err.message : 'Failed to reach /api/v1/workspace',
        });
      } finally {
        setLoadingWorkspace(false);
      }
    },
    [selectedAgentId, selectedAgentVersionId, selectedStreamRunId]
  );

  useEffect(() => {
    void fetchHealthAndWorkspace(selectedActorId);
  }, [selectedActorId, fetchHealthAndWorkspace]);

  const fetchSseStreamForRun = useCallback(
    async (runId: string, cursor: number, actorId: ConsoleActorId) => {
      if (!runId) return;
      setLoadingSse(true);
      try {
        const headers: Record<string, string> = {
          'x-actor-id': actorId,
        };
        if (cursor > 0) {
          headers['Last-Event-ID'] = String(cursor);
        }
        const res = await fetch(`/api/v1/runs/${runId}/stream`, { headers });
        const text = await res.text();
        if (!res.ok) {
          setSseRawFrames(`HTTP ${res.status} Error:\n${text}`);
        } else {
          setSseRawFrames(text || ': stream closed (0 events after cursor)');
        }
      } catch (err) {
        setSseRawFrames(
          `SSE fetch error: ${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setLoadingSse(false);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedStreamRunId) {
      void fetchSseStreamForRun(selectedStreamRunId, lastEventIdCursor, selectedActorId);
    }
  }, [selectedStreamRunId, lastEventIdCursor, selectedActorId, fetchSseStreamForRun]);

  const handleResetWorkspaceSeed = async () => {
    setLoadingWorkspace(true);
    try {
      const res = await fetch('/api/v1/workspace/seed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ forceReset: true }),
      });
      const json = await res.json();
      if (res.ok) {
        setSelectedAgentId('');
        setSelectedAgentVersionId('');
        setSelectedStreamRunId('');
        setApiBanner({
          kind: 'success',
          status: 200,
          title: 'Workspace Re-Seeded in PostgreSQL (POST /api/v1/workspace/seed)',
          detail: `Provisioned Acme Cyber Defense & Beta Logistics and created pending HITL approval gate (${json.data.pendingApprovalId ?? 'ready'}).`,
        });
        await fetchHealthAndWorkspace(selectedActorId);
      }
    } finally {
      setLoadingWorkspace(false);
    }
  };

  const handleEnqueueAndRunAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    const targetAgentId = selectedAgentId || workspace?.agents[0]?.id;
    if (!targetAgentId) return;

    setRunningAgentJob(true);
    try {
      const res = await fetch(`/api/v1/agents/${targetAgentId}/runs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': selectedActorId,
        },
        body: JSON.stringify({
          inputPrompt: runPromptInput,
          agentVersionId: selectedAgentVersionId || undefined,
          aiEngine: selectedAiEngine,
          processImmediately: true,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setApiBanner({
          kind: 'error',
          status: res.status,
          title: `${payload.code ?? 'ERROR'}: ${payload.title ?? 'Run failed'}`,
          detail: payload.detail ?? 'Server rejected run creation.',
        });
      } else {
        const createdRunId: string = payload.data.run.id;
        const aiProviderUsed: string = payload.data.aiProvider ?? selectedAiEngine;
        setSelectedStreamRunId(createdRunId);
        setApiBanner({
          kind: 'success',
          status: res.status,
          title: `Live Run Processed via ${aiProviderUsed} (HTTP ${res.status} Accepted)`,
          detail: `Run ${createdRunId.slice(0, 8)}... transitioned queued -> running -> ${payload.data.run.status} (${payload.data.steps.length} steps, ${payload.data.run.totalTokens} tokens [${payload.data.run.usageSource}]).`,
        });
        await fetchHealthAndWorkspace(selectedActorId);
        await fetchSseStreamForRun(createdRunId, lastEventIdCursor, selectedActorId);
      }
    } finally {
      setRunningAgentJob(false);
    }
  };

  const handleCreateAndPublishAgent = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunningAgentJob(true);
    try {
      const createRes = await fetch('/api/v1/agents', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': selectedActorId,
        },
        body: JSON.stringify({
          name: newAgentName,
          slug: newAgentSlug,
          description: 'Created from Agent Studio UI over HTTP API',
          draftSystemPrompt: newAgentPrompt,
          draftToolAllowlist: ['calculator', 'knowledge_search'],
        }),
      });
      const createJson = await createRes.json();
      if (!createRes.ok) {
        setApiBanner({
          kind: 'error',
          status: createRes.status,
          title: `${createJson.code ?? 'ERROR'}: ${createJson.title ?? 'Failed to create agent'}`,
          detail: createJson.detail ?? 'Could not create agent draft.',
        });
        return;
      }

      const agentId = createJson.data.id;
      const pubRes = await fetch(`/api/v1/agents/${agentId}/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-actor-id': selectedActorId,
        },
        body: JSON.stringify({}),
      });
      const pubJson = await pubRes.json();
      if (pubRes.ok) {
        setShowNewAgentForm(false);
        setSelectedAgentId(agentId);
        setSelectedAgentVersionId(pubJson.data.version.id);
        setApiBanner({
          kind: 'success',
          status: 201,
          title: 'Agent Created & Published Immutable v1 Snapshot',
          detail: `Published ${createJson.data.slug} v1 (SHA-256: ${pubJson.data.version.snapshotHash.slice(0, 16)}...) in PostgreSQL.`,
        });
        await fetchHealthAndWorkspace(selectedActorId);
      }
    } finally {
      setRunningAgentJob(false);
    }
  };

  const handleDecideApproval = async (
    approvalId: string,
    decision: 'approved' | 'rejected',
    targetOrganizationId?: string
  ) => {
    const res = await fetch(`/api/v1/approvals/${approvalId}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': selectedActorId,
      },
      body: JSON.stringify({
        organizationId: targetOrganizationId,
        decision,
        aiEngine: selectedAiEngine,
        note: `Decision (${decision}) submitted from Operator Console by ${selectedActorId}`,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setApiBanner({
        kind: 'error',
        status: res.status,
        title: `HTTP ${res.status} (${json.code ?? 'DENIED'}): ${json.title ?? 'Approval Rejected by Server Policy'}`,
        detail: json.detail ?? 'Server policy denied approval decision.',
      });
      // Refresh workspace so newly recorded 'denied' audit_events row appears immediately
      await fetchHealthAndWorkspace(selectedActorId);
      return;
    }

    setApiBanner({
      kind: 'success',
      status: res.status,
      title: `HTTP ${res.status} OK — Approval ${json.data.approval.status.toUpperCase()} & Run ${json.data.run.status.toUpperCase()}`,
      detail: `Committed decision to approval_requests, appended 'allowed' to audit_events, and transitioned workflow run ${json.data.run.id.slice(0, 8)}... to '${json.data.run.status}'.`,
    });
    await fetchHealthAndWorkspace(selectedActorId);
  };

  const handleStartNewWorkflowRun = async () => {
    const wfId = workspace?.workflows[0]?.id;
    if (!wfId) return;

    const res = await fetch(`/api/v1/workflows/${wfId}/runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': selectedActorId,
      },
      body: JSON.stringify({
        inputPrompt: 'Evaluate emergency production key rotation (risk score 150 > threshold 100)',
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setApiBanner({
        kind: 'error',
        status: res.status,
        title: `HTTP ${res.status} (${json.code ?? 'ERROR'}): ${json.title ?? 'Workflow Run Failed'}`,
        detail: json.detail ?? 'Could not start workflow run.',
      });
      return;
    }

    setApiBanner({
      kind: 'info',
      status: 201,
      title: `Started Workflow Run (Status: ${json.data.run.status})`,
      detail: `Workflow paused at node 'approval-gate-1' and created pending approval_requests row ${json.data.pendingApproval?.id?.slice(0, 8) ?? ''}... in PostgreSQL.`,
    });
    await fetchHealthAndWorkspace(selectedActorId);
  };

  const handleTestCrossTenantIsolation = async () => {
    const acmePersona = workspace?.personas.find((p) => p.id === 'acme-owner');
    if (!acmePersona) return;

    const res = await fetch(
      `/api/v1/workspace?organizationId=${acmePersona.organizationId}`,
      {
        headers: { 'x-actor-id': 'beta-owner' },
      }
    );
    const problem = await res.json();
    setApiBanner({
      kind: res.status === 404 ? 'info' : 'error',
      status: res.status,
      title: `Cross-Tenant Probe Result: HTTP ${res.status} (${problem.code})`,
      detail: `${problem.detail} — Server masked cross-tenant resource with 404 Not Found per ADR-002.`,
    });
  };

  const triggerBlobDownload = (blob: Blob, downloadName: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadFile = (file: ProjectFile) => {
    const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
    triggerBlobDownload(blob, file.filename);
  };

  const handleDownloadSingleFileWithFolderZip = (file: ProjectFile) => {
    const zipBlob = createZipBlob([{ path: file.path, content: file.content }]);
    const baseName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    triggerBlobDownload(zipBlob, `${baseName}-with-folders.zip`);
  };

  const handleDownloadCurrentBatchZip = () => {
    const zipBlob = createZipBlob(
      batchFiles.map(({ file }) => ({
        path: file.path,
        content: file.content,
      }))
    );
    triggerBlobDownload(zipBlob, 'aegis-current-step-batch.zip');
  };

  const handleDownloadAllZip = () => {
    const zipBlob = createZipBlob(
      COMPLETED_FILES.map((file) => ({
        path: file.path,
        content: file.content,
      }))
    );
    triggerBlobDownload(zipBlob, 'aegis-full-repo-with-folders.zip');
  };

  const buildTerminalCommand = (file: ProjectFile) => {
    const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
    const mkdirPart = dir ? `mkdir -p "${dir}" && ` : '';
    const cleanRootDuplicate = dir ? `rm -f "./${file.filename}" && ` : '';
    return `${cleanRootDuplicate}${mkdirPart}cat << 'EOF' > "${file.path}"\n${file.content}\nEOF\ngit add "${file.path}" && git commit -m "${file.commitMessage}"`;
  };

  const buildBatchTerminalCommand = () => {
    const paths = batchFiles.map(({ file }) => `"${file.path}"`).join(' ');
    return `unzip -o ~/Downloads/aegis-current-step-batch.zip\npnpm typecheck && pnpm test && pnpm build\ngit add ${paths}\ngit commit -m "feat(runtime): wire Express HTTP API, background worker, file-backed PGlite, and composite tenant FKs"`;
  };

  const handleCopy = async (text: string, type: 'content' | 'git' | 'batch-git') => {
    await navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const currentPersona =
    workspace?.personas.find((p) => p.id === selectedActorId) ?? null;

  const activeAgentId = selectedAgentId || workspace?.agents[0]?.id || '';
  const availableAgentVersions = (workspace?.agentVersions ?? [])
    .filter((v) => v.agentId === activeAgentId)
    .sort((a, b) => a.versionNumber - b.versionNumber);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Top Bar */}
      <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
          <span className="font-semibold tracking-tight text-slate-900">
            Aegis Runtime
          </span>
          <span className="text-slate-300">/</span>
          <span className="text-xs font-mono bg-emerald-50 text-emerald-800 px-2.5 py-1 rounded border border-emerald-200 font-medium">
            {healthInfo
              ? `DB: ${healthInfo.database.toUpperCase()} (${healthInfo.engine} · ${healthInfo.storageMode}) · AI=${healthInfo.aiProvider ?? healthInfo.aiMode}`
              : 'Connecting to /api/v1/health/ready...'}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200">
            <button
              onClick={() => setActiveView('console')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 cursor-pointer ${
                activeView === 'console'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <Play className="w-3.5 h-3.5" />
              Agent Studio & Live Console
            </button>
            <button
              onClick={() => setActiveView('workbench')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 cursor-pointer ${
                activeView === 'workbench'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <FileCode2 className="w-3.5 h-3.5" />
              Repository Workbench ({COMPLETED_FILES.length} Files)
            </button>
          </div>

          <button
            onClick={handleDownloadCurrentBatchZip}
            className="px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <FolderArchive className="w-3.5 h-3.5" />
            Download Latest Batch .zip ({batchFiles.length})
          </button>

          <button
            onClick={handleDownloadAllZip}
            className="px-3 py-1.5 text-xs font-semibold text-slate-900 bg-emerald-400 rounded-lg hover:bg-emerald-300 transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Download Full Repo .zip ({COMPLETED_FILES.length})
          </button>
        </div>
      </header>

      {activeView === 'console' ? (
        <main className="flex-1 p-6 lg:p-8 max-w-7xl w-full mx-auto flex flex-col gap-6">
          {/* Live Online Free AI & Persistence Disclosure Banner */}
          <section className="bg-slate-900 text-white rounded-lg p-6 border border-slate-800">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-emerald-400">
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    LIVE EXPRESS API (/api/v1/*) · PERSISTED IN PGLITE POSTGRESQL ({workspace?.storageMode ?? 'file'}) · FREE-TIER CLOUD AI ({workspace?.aiProvider ?? 'gemini-3-flash-preview / gpt-4o-mini / claude-3-5-haiku / grok-2'})
                  </span>
                </div>
                <h1 className="text-xl font-bold tracking-tight mt-1">
                  Aegis Multi-Tenant Agent Studio, Workflow HITL Inbox & SSE Replay Console
                </h1>
                <p className="text-xs text-slate-300 mt-1 max-w-3xl">
                  Every action below executes a real HTTP request against Express (`src/server/http/app.ts`), enforces central RBAC (`src/server/policies/authorization.ts`), claims jobs via `RuntimeWorker`, and persists rows in PostgreSQL. Live runs execute real multi-step tool calls (`calculator` + `knowledge_search`) against free-tier cloud AI models (**Gemini 3 Flash**, **ChatGPT `gpt-4o-mini`**, **Claude 3.5 Haiku**, and **Grok 2**).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3 shrink-0">
                <div>
                  <label
                    htmlFor="actor-select"
                    className="block text-[11px] font-mono uppercase text-slate-400 mb-1"
                  >
                    Active Authenticated Identity (x-actor-id)
                  </label>
                  <select
                    id="actor-select"
                    value={selectedActorId}
                    onChange={(e) => setSelectedActorId(e.target.value as ConsoleActorId)}
                    className="bg-slate-800 border border-slate-700 text-white text-xs font-medium rounded-lg px-3 py-2 cursor-pointer"
                  >
                    <option value="acme-owner">Elena Vance (Acme Owner — Full Access)</option>
                    <option value="acme-admin">Marcus Sterling (Acme Admin — Ops & HITL)</option>
                    <option value="acme-dev">Priya Nair (Acme Developer — Build & Run)</option>
                    <option value="acme-viewer">Lucas Meyer (Acme Viewer — Read-Only)</option>
                    <option value="beta-owner">Sora Takahashi (Beta Logistics Owner — Cross-Tenant)</option>
                  </select>
                </div>

                <button
                  onClick={() => void handleResetWorkspaceSeed()}
                  disabled={loadingWorkspace}
                  className="px-3.5 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-lg border border-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer self-end"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingWorkspace ? 'animate-spin' : ''}`} />
                  Reset Demo Workspace
                </button>
              </div>
            </div>

            {currentPersona && (
              <div className="mt-4 pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-4 text-xs font-mono text-slate-300">
                <div className="flex flex-wrap items-center gap-4">
                  <span>
                    Organization: <strong className="text-white">{currentPersona.organizationName}</strong> ({currentPersona.organizationSlug})
                  </span>
                  <span>
                    Role: <strong className="text-emerald-400 uppercase">{currentPersona.role}</strong>
                  </span>
                  <span>
                    User ID: <span className="text-slate-400">{currentPersona.userId.slice(0, 12)}...</span>
                  </span>
                </div>
                {selectedActorId === 'beta-owner' && (
                  <button
                    onClick={() => void handleTestCrossTenantIsolation()}
                    className="px-3 py-1 text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/30 transition-colors cursor-pointer"
                  >
                    Probe Cross-Tenant Acme Access (Expect 404 TENANT_MISMATCH)
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Live Server Response Banner */}
          {apiBanner && (
            <section
              className={`rounded-lg p-4 border flex items-start justify-between gap-4 ${
                apiBanner.kind === 'error'
                  ? 'bg-red-50 border-red-200 text-red-900'
                  : apiBanner.kind === 'info'
                    ? 'bg-amber-50 border-amber-200 text-amber-900'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-900'
              }`}
            >
              <div className="flex items-start gap-2.5">
                {apiBanner.kind === 'error' ? (
                  <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                ) : apiBanner.kind === 'info' ? (
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="text-xs font-bold">{apiBanner.title}</div>
                  <div className="text-xs mt-0.5 font-mono">{apiBanner.detail}</div>
                </div>
              </div>
              <button
                onClick={() => setApiBanner(null)}
                className="text-xs font-mono underline opacity-75 hover:opacity-100 cursor-pointer"
              >
                Dismiss
              </button>
            </section>
          )}

          {/* Top 2-Column Grid: Agent Studio + Run Launcher AND HITL Approval Inbox */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Panel 1: Agent Studio & Live Run Launcher */}
            <section className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-blue-600" />
                  <h2 className="text-base font-bold text-slate-900">
                    1. Agent Studio & Durable Run Launcher
                  </h2>
                </div>
                <button
                  onClick={() => setShowNewAgentForm((prev) => !prev)}
                  className="px-2.5 py-1 text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 rounded border border-blue-200 flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {showNewAgentForm ? 'Cancel New Agent' : 'New Agent Draft'}
                </button>
              </div>

              {showNewAgentForm && (
                <form
                  onSubmit={(e) => void handleCreateAndPublishAgent(e)}
                  className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-col gap-3"
                >
                  <div className="text-xs font-bold text-slate-800">
                    Create & Publish New Agent Snapshot (POST /api/v1/agents + /publish)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <input
                      type="text"
                      value={newAgentName}
                      onChange={(e) => setNewAgentName(e.target.value)}
                      placeholder="Agent Name"
                      className="px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
                      required
                    />
                    <input
                      type="text"
                      value={newAgentSlug}
                      onChange={(e) => setNewAgentSlug(e.target.value)}
                      placeholder="agent-slug"
                      className="px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                      required
                    />
                  </div>
                  <textarea
                    value={newAgentPrompt}
                    onChange={(e) => setNewAgentPrompt(e.target.value)}
                    rows={2}
                    className="px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
                    required
                  />
                  <button
                    type="submit"
                    disabled={runningAgentJob}
                    className="self-start px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded hover:bg-slate-800 cursor-pointer"
                  >
                    Create Draft & Publish Immutable v1
                  </button>
                </form>
              )}

              <form onSubmit={(e) => void handleEnqueueAndRunAgent(e)} className="flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Target Agent ({workspace?.agents.length ?? 0} in {currentPersona?.organizationName ?? 'Tenant'})
                    </label>
                    <select
                      value={activeAgentId}
                      onChange={(e) => {
                        const nextAgentId = e.target.value;
                        setSelectedAgentId(nextAgentId);
                        const nextVersions = (workspace?.agentVersions ?? [])
                          .filter((v) => v.agentId === nextAgentId)
                          .sort((a, b) => a.versionNumber - b.versionNumber);
                        const preferred =
                          nextVersions.find((v) => v.toolAllowlist.includes('calculator')) ??
                          nextVersions[0];
                        setSelectedAgentVersionId(preferred?.id ?? '');
                      }}
                      className="w-full px-3 py-2 text-xs font-medium bg-slate-50 border border-slate-300 rounded-lg"
                    >
                      {(workspace?.agents ?? []).map((ag) => (
                        <option key={ag.id} value={ag.id}>
                          {ag.name} ({ag.slug})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Pinned Agent Version Snapshot
                    </label>
                    <select
                      value={selectedAgentVersionId}
                      onChange={(e) => setSelectedAgentVersionId(e.target.value)}
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg"
                    >
                      {availableAgentVersions.map((ver) => (
                        <option key={ver.id} value={ver.id}>
                          v{ver.versionNumber} — Tools: [{ver.toolAllowlist.join(', ')}]
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Free-Tier Cloud AI Engine (Gemini · ChatGPT · Claude · Grok)
                  </label>
                  <select
                    id="ai-engine-select"
                    value={selectedAiEngine}
                    onChange={(e) => setSelectedAiEngine(e.target.value as AiEngineChoice)}
                    className="w-full px-3 py-2 text-xs font-medium bg-emerald-50/70 border border-emerald-300 text-slate-900 rounded-lg"
                  >
                    <option value="auto">
                      Auto Multi-Provider Free Tier (Gemini 3 Flash · ChatGPT gpt-4o-mini · Claude 3.5 Haiku · Grok 2)
                    </option>
                    <option value="gemini-free">
                      Google Gemini Free Tier — gemini-3-flash-preview (@google/genai)
                    </option>
                    <option value="chatgpt-free">
                      OpenAI ChatGPT Free Tier — gpt-4o-mini (api.openai.com)
                    </option>
                    <option value="claude-free">
                      Anthropic Claude Free Tier — claude-3-5-haiku-latest (api.anthropic.com)
                    </option>
                    <option value="grok-free">
                      xAI Grok Free Tier — grok-2-latest (api.x.ai)
                    </option>
                    <option value="mock">
                      Deterministic Offline Mock Provider (aegis-mock-v1 — For Unit Tests Only)
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Run Input Prompt (Executes via ToolGateway + RuntimeWorker)
                  </label>
                  <textarea
                    value={runPromptInput}
                    onChange={(e) => setRunPromptInput(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-300 rounded-lg"
                    required
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-mono text-slate-500">
                    POST /api/v1/agents/:id/runs -&gt; 202 Accepted ({selectedAiEngine})
                  </span>
                  <button
                    type="submit"
                    disabled={runningAgentJob || (workspace?.agents.length ?? 0) === 0}
                    className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg flex items-center gap-1.5 cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" />
                    {runningAgentJob ? 'Running Live AI...' : 'Enqueue & Execute Live AI Run'}
                  </button>
                </div>
              </form>

              {/* Persisted Runs List */}
              <div className="border-t border-slate-100 pt-3">
                <div className="text-xs font-semibold text-slate-700 mb-2">
                  Persisted Tenant Runs in PostgreSQL ({workspace?.runs.length ?? 0})
                </div>
                <div className="flex flex-col gap-2 max-h-56 overflow-y-auto">
                  {(workspace?.runs ?? []).slice(0, 6).map((run) => (
                    <div
                      key={run.id}
                      onClick={() => setSelectedStreamRunId(run.id)}
                      className={`p-3 rounded-lg border text-xs cursor-pointer transition-colors ${
                        selectedStreamRunId === run.id
                          ? 'bg-blue-50/60 border-blue-300'
                          : 'bg-slate-50 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-slate-800">
                          Run {run.id.slice(0, 8)}...
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded font-mono text-[11px] font-semibold ${
                            run.status === 'succeeded'
                              ? 'bg-emerald-100 text-emerald-800'
                              : run.status === 'waiting_approval'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-slate-200 text-slate-800'
                          }`}
                        >
                          {run.status}
                        </span>
                      </div>
                      <div className="text-slate-600 mt-1 truncate">
                        Prompt: {run.inputPrompt}
                      </div>
                      {run.finalOutput && (
                        <div className="text-slate-900 font-medium mt-1 line-clamp-2 bg-white p-1.5 rounded border border-slate-200">
                          Output: {run.finalOutput}
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-1.5 text-[11px] font-mono text-slate-500">
                        <span>Steps: {run.stepCount}</span>
                        <span>Tools: {run.toolCallCount}</span>
                        <span>Citations: {run.citations?.length ?? 0}</span>
                        <span>Tokens: {run.totalTokens} ({run.usageSource})</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* Panel 2: HITL Workflow Approval Inbox */}
            <section className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-blue-600" />
                  <h2 className="text-base font-bold text-slate-900">
                    2. Human-in-the-Loop (HITL) Approval Inbox
                  </h2>
                </div>
                <button
                  onClick={() => void handleStartNewWorkflowRun()}
                  disabled={(workspace?.workflows.length ?? 0) === 0}
                  className="px-2.5 py-1 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded border border-slate-300 cursor-pointer"
                >
                  + Spawn Gated Workflow Run
                </button>
              </div>

              <p className="text-xs text-slate-600">
                Decisions call <span className="font-mono text-slate-800">POST /api/v1/approvals/:id/decision</span> on the Express server. Try clicking Approve while switched to <strong>Lucas Meyer (Acme Viewer)</strong> to trigger a real server-side <span className="font-mono text-red-700">403 Forbidden</span> and record an <span className="font-mono">outcome=&apos;denied&apos;</span> row in <span className="font-mono">audit_events</span>.
              </p>

              <div className="flex flex-col gap-3 max-h-96 overflow-y-auto">
                {(workspace?.approvals ?? []).length === 0 ? (
                  <div className="p-4 text-xs text-slate-500 bg-slate-50 rounded-lg border border-slate-200">
                    No approval requests in this organization.
                  </div>
                ) : (
                  (workspace?.approvals ?? []).map((approval) => (
                    <div
                      key={approval.id}
                      className="p-4 rounded-lg border border-slate-200 bg-slate-50 flex flex-col gap-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-900">
                          {approval.title}
                        </span>
                        <span
                          className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded ${
                            approval.status === 'pending'
                              ? 'bg-amber-100 text-amber-800'
                              : approval.status === 'approved'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {approval.status.toUpperCase()}
                        </span>
                      </div>
                      <div className="text-xs text-slate-600">{approval.reason}</div>
                      <div className="text-[11px] font-mono text-slate-500">
                        Approval ID: {approval.id.slice(0, 12)}... · Node: {approval.nodeId} · Run: {approval.runId.slice(0, 8)}...
                      </div>

                      {approval.status === 'pending' && (
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                          <button
                            onClick={() => void handleDecideApproval(approval.id, 'approved')}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors cursor-pointer"
                          >
                            Approve & Resume Run
                          </button>
                          <button
                            onClick={() => void handleDecideApproval(approval.id, 'rejected')}
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer"
                          >
                            Reject & Cancel Run
                          </button>
                        </div>
                      )}

                      {approval.decisionNote && (
                        <div className="text-[11px] font-mono text-slate-700 bg-white p-2 rounded border border-slate-200">
                          Decision Note: {approval.decisionNote}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          {/* Bottom 2-Column Grid: Live SSE Cursor Stream & Governance/Eval Ledger */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Panel 3: Live SSE Replay Debugger */}
            <section className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-blue-600" />
                  <h2 className="text-base font-bold text-slate-900">
                    3. Persisted SSE Stream & Last-Event-ID Replay
                  </h2>
                </div>
                <span className="text-xs font-mono text-slate-500">
                  GET /api/v1/runs/:id/stream
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-700">
                    Last-Event-ID Reconnect Cursor:
                  </span>
                  {[0, 1, 2, 3, 4].map((cursorVal) => (
                    <button
                      key={cursorVal}
                      onClick={() => setLastEventIdCursor(cursorVal)}
                      className={`px-2.5 py-1 text-xs font-mono font-semibold rounded border transition-colors cursor-pointer ${
                        lastEventIdCursor === cursorVal
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                      }`}
                    >
                      {cursorVal === 0 ? '0 (Full)' : `>${cursorVal}`}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] font-mono text-slate-500">
                  {loadingSse ? 'Streaming...' : `Run: ${selectedStreamRunId.slice(0, 8) || 'none'}...`}
                </span>
              </div>

              <pre className="bg-slate-950 text-emerald-300 p-4 rounded-lg text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto border border-slate-800 leading-relaxed">
                <code>{sseRawFrames || 'Select or execute a run to stream persisted SSE frames.'}</code>
              </pre>
            </section>

            {/* Panel 4: Eval v1-vs-v2 Regression Diff, Usage & Security Audit Trail */}
            <section className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-blue-600" />
                  <h2 className="text-base font-bold text-slate-900">
                    4. Eval Regression Diff, Usage & Security Audit Trail
                  </h2>
                </div>
                <span className="text-xs font-mono text-slate-500">
                  GET /api/v1/audit-events
                </span>
              </div>

              {workspace?.evalComparison && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
                  <div className="font-bold text-slate-900">
                    Automated Eval Regression Diff (Agent v1 vs Agent v2)
                  </div>
                  <div className="flex flex-wrap items-center gap-4 mt-1 font-mono">
                    <span className="text-emerald-700">
                      Baseline v1 Pass Rate: {workspace.evalComparison.baselinePassRate ?? workspace.evalComparison.baselineExperiment?.passRate ?? 100}%
                    </span>
                    <span className="text-red-700">
                      Candidate v2 Pass Rate: {workspace.evalComparison.candidatePassRate ?? workspace.evalComparison.candidateExperiment?.passRate ?? 50}% (Delta: {workspace.evalComparison.passRateDelta}%)
                    </span>
                  </div>
                </div>
              )}

              {workspace?.usageSummary && (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="font-mono text-slate-500 uppercase text-[11px]">
                      Simulated Usage (provider_mode=&apos;mock&apos;)
                    </div>
                    <div className="text-sm font-bold text-slate-900 mt-0.5 font-mono">
                      {workspace.usageSummary.mock.runsCount} runs · {workspace.usageSummary.mock.totalTokens} tokens
                    </div>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                    <div className="font-mono text-slate-500 uppercase text-[11px]">
                      Live Provider Usage (provider_mode=&apos;live&apos;)
                    </div>
                    <div className="text-sm font-bold text-slate-900 mt-0.5 font-mono">
                      {workspace.usageSummary.live.runsCount} runs · {workspace.usageSummary.live.totalTokens} tokens
                    </div>
                  </div>
                </div>
              )}

              <div>
                <div className="text-xs font-semibold text-slate-800 mb-2">
                  Append-Only Security Audit Ledger (`audit_events` — Owner/Admin Only)
                </div>
                {!workspace?.canViewAudit ? (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-900 font-mono">
                    HTTP 403 Forbidden (INSUFFICIENT_ROLE): Role &quot;{currentPersona?.role}&quot; is not permitted to perform action &quot;audit.view&quot;. Switch to Elena Vance (Owner) or Marcus Sterling (Admin) to inspect audit_events.
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto">
                    {workspace.auditEvents.map((ev) => (
                      <div
                        key={ev.id}
                        className="px-3 py-2 bg-slate-50 border border-slate-200 rounded text-xs font-mono flex items-center justify-between gap-2"
                      >
                        <span className="truncate">
                          [{ev.actorRole}] <strong>{ev.action}</strong> on {ev.resourceType}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[11px] font-bold shrink-0 ${
                            ev.outcome === 'allowed'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-red-100 text-red-800'
                          }`}
                        >
                          {ev.outcome.toUpperCase()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </main>
      ) : (
        /* Secondary View: Repository File Inspector & Step Batch .zip Exporter */
        <div className="flex-1 flex flex-col lg:flex-row">
          <aside className="w-full lg:w-80 bg-white border-r border-slate-200 p-5 flex flex-col gap-5 shrink-0">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Repository Files ({COMPLETED_FILES.length})
              </div>
              <p className="text-xs text-slate-600 mt-1">
                Inspect or export any source file or download the Phase A–H `.zip` batch with full folder paths.
              </p>
            </div>

            <div className="flex flex-col gap-1.5 max-h-[640px] overflow-y-auto pr-1">
              {COMPLETED_FILES.map((file, index) => {
                const isSelected = index === selectedIndex;
                const batchEntry = CURRENT_STEP_BATCH.find((b) => b.path === file.path);
                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedIndex(index)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-mono tabular-nums ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                        {file.step}
                      </span>
                      {batchEntry && (
                        <span
                          className={`text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded ${
                            batchEntry.status === 'NEW'
                              ? isSelected
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-emerald-50 text-emerald-700'
                              : isSelected
                                ? 'bg-amber-500/20 text-amber-300'
                                : 'bg-amber-50 text-amber-800'
                          }`}
                        >
                          {batchEntry.status}
                        </span>
                      )}
                    </div>
                    <div className="text-sm font-semibold mt-0.5 truncate">
                      {file.path}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="flex-1 p-6 lg:p-8 flex flex-col gap-6 min-w-0">
            <section className="bg-white border border-slate-200 rounded-lg p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200">
                <div>
                  <div className="text-xs font-semibold text-blue-700">
                    Phase A–H Full-Stack Integration Batch (.zip Preserves Folder Hierarchy)
                  </div>
                  <h2 className="text-lg font-bold text-slate-900 mt-0.5">
                    Phase A–H Closure Batch ({batchFiles.length} Files: API + Worker + Persistence + Composite FKs)
                  </h2>
                  <p className="text-xs text-slate-600 mt-1">
                    Click <span className="font-mono font-semibold text-slate-800">Download Batch .zip (With Folders)</span> and run <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">unzip -o ~/Downloads/aegis-current-step-batch.zip</span> in your repo root.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  <button
                    onClick={handleDownloadCurrentBatchZip}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <FolderArchive className="w-3.5 h-3.5" />
                    Download Batch .zip (With Folders)
                  </button>
                  <button
                    onClick={handleDownloadAllZip}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Full Repo .zip ({COMPLETED_FILES.length})
                  </button>
                  <button
                    onClick={() => handleCopy(buildBatchTerminalCommand(), 'batch-git')}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    {copiedType === 'batch-git' ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <GitCommit className="w-3.5 h-3.5" />
                    )}
                    {copiedType === 'batch-git' ? 'Copied Sync Command' : 'Copy Unzip + Commit Command'}
                  </button>
                </div>
              </div>
            </section>

            <section className="bg-white border border-slate-200 rounded-lg p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200">
                <div>
                  <div className="text-xs text-slate-500 font-mono">
                    {activeFile.step} · Ticket {activeFile.ticket} · Target Path: {activeFile.path}
                  </div>
                  <h2 className="text-xl font-bold text-slate-900 mt-1">
                    {activeFile.title}
                  </h2>
                  <p className="text-sm text-slate-600 mt-1">
                    {activeFile.summary}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  <button
                    onClick={() => handleDownloadSingleFileWithFolderZip(activeFile)}
                    className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 cursor-pointer"
                  >
                    <FolderArchive className="w-3.5 h-3.5" />
                    Download {activeFile.path} (.zip)
                  </button>
                  <button
                    onClick={() => handleDownloadFile(activeFile)}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Raw {activeFile.filename}
                  </button>
                  <button
                    onClick={() => handleCopy(buildTerminalCommand(activeFile), 'git')}
                    className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    {copiedType === 'git' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedType === 'git' ? 'Copied Command' : 'Copy cat + git commit'}
                  </button>
                </div>
              </div>

              <div className="mt-5">
                <pre className="bg-slate-950 text-slate-100 p-5 rounded-lg text-xs font-mono leading-relaxed overflow-x-auto max-h-[540px] overflow-y-auto border border-slate-800">
                  <code>{activeFile.content}</code>
                </pre>
              </div>
            </section>
          </main>
        </div>
      )}
    </div>
  );
}

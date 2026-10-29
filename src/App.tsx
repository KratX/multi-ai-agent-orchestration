import React, { useState } from 'react';
import { Download, Copy, Check, GitCommit, Terminal, FolderArchive } from 'lucide-react';
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
    title: 'Implementation Status & MVP Scope Ledger',
    commitMessage: 'docs(plan): initialize STATUS.md and lock MVP scope (PLAN-001)',
    summary: 'Tracks active phase, verified tickets, test evidence, and locks in the 9 MVP pillars vs. explicit non-goals.',
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
    commitMessage: 'chore(config): add .env.example with AI_MODE=demo defaults (REPO-003)',
    summary: 'Safe placeholder environment variables showing how the platform runs in AI_MODE=demo with zero API keys.',
    content: envExampleContent,
  },
  {
    step: 'Step 1.6b (File #6b)',
    ticket: 'REPO-003',
    path: 'src/server/config/env.ts',
    filename: 'env.ts',
    title: 'Zod Runtime Environment Validator (env.ts)',
    commitMessage: 'feat(config): add Zod environment validator and secret redaction (REPO-003)',
    summary: 'Parses and validates all runtime limits, allows AI_MODE=demo without keys, and enforces API keys in AI_MODE=provider.',
    content: envTsContent,
  },
  {
    step: 'Step 1.7 (File #7)',
    ticket: 'REPO-003',
    path: 'tests/unit/env.test.ts',
    filename: 'env.test.ts',
    title: 'Unit Test Suite for Environment Validator (7/7 Passing)',
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
    title: 'Next.js App Router Health & Readiness Endpoint',
    commitMessage: 'feat(api): add /api/v1/health route handler with RFC 9457 errors (REPO-004)',
    summary: 'Implements GET /api/v1/health returning liveness, database readiness, x-request-id correlation, and redacted runtime config.',
    content: healthRouteContent,
  },
  {
    step: 'Step 1.10 (File #10)',
    ticket: 'REPO-004',
    path: 'tests/unit/health-route.test.ts',
    filename: 'health-route.test.ts',
    title: 'Unit Test Suite for Health & Readiness Endpoint (4/4 Passing)',
    commitMessage: 'test(api): add unit tests for /api/v1/health 200 and 503 states (REPO-004)',
    summary: 'Verifies 200 OK envelope, x-request-id correlation header, 503 database unready Problem Details, and secret redaction.',
    content: healthRouteTestContent,
  },
  {
    step: 'Step 1.11a (File #11a)',
    ticket: 'REPO-001',
    path: 'package.json',
    filename: 'package.json',
    title: 'Package Manifest & pnpm Scripts (package.json)',
    commitMessage: 'chore(repo): configure pnpm scripts and Drizzle/PGlite dependencies (REPO-001)',
    summary: 'Configures pnpm test, typecheck, db:up, db:stop, and dependencies (zod, drizzle-orm, @electric-sql/pglite).',
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
    title: 'Drizzle ORM Database Client, Migration Runner & Readiness Probe',
    commitMessage: 'feat(db): add Drizzle PGlite database client, migration runner, and health probe (REPO-005)',
    summary: 'Creates isolated or singleton PostgreSQL instances, runs MIGRATION_0001_TENANT_SQL, and implements DatabaseReadinessCheck.',
    content: dbClientContent,
  },
  {
    step: 'Step 1.13 (File #13)',
    ticket: 'REPO-005',
    path: 'tests/integration/tenant-schema.test.ts',
    filename: 'tenant-schema.test.ts',
    title: 'PostgreSQL Tenant Schema Integration Tests (6/6 Passing)',
    commitMessage: 'test(db): add PostgreSQL integration tests for tenant schema constraints (REPO-005)',
    summary: 'Verifies user/org/membership inserts, duplicate slug rejection, blank name CHECK, invalid role CHECK, composite PK, cascade delete, and readiness probe.',
    content: tenantSchemaTestContent,
  },
  {
    step: 'Step 2.1 (File #14)',
    ticket: 'TENANT-002',
    path: 'src/server/policies/authorization.ts',
    filename: 'authorization.ts',
    title: 'Central RBAC & Tenant Isolation Policy Engine (authorization.ts)',
    commitMessage: 'feat(authz): add central RBAC and tenant boundary policy engine (TENANT-002)',
    summary: 'Implements can(actor, action, resource), authorize(), requireAuthorization(), and the 4-role permission matrix.',
    content: authorizationContent,
  },
  {
    step: 'Step 2.2 (File #15)',
    ticket: 'TENANT-002',
    path: 'tests/unit/authorization.test.ts',
    filename: 'authorization.test.ts',
    title: 'Unit Test Suite for Central RBAC & Tenant Policy Engine (6/6 Passing)',
    commitMessage: 'test(authz): add unit tests for 4-role RBAC matrix and tenant isolation (TENANT-002)',
    summary: 'Verifies 401 unauthenticated, 404 cross-tenant denial, owner full access, admin owner-protection, developer approval gates, and viewer read-only limits.',
    content: authorizationTestContent,
  },
  {
    step: 'Step 2.3 (File #16)',
    ticket: 'TENANT-001 / TENANT-003',
    path: 'src/server/db/repositories/tenant-repository.ts',
    filename: 'tenant-repository.ts',
    title: 'Multi-Tenant Repository & Last-Owner Safeguard (tenant-repository.ts)',
    commitMessage: 'feat(tenant): add multi-tenant repository with atomic org creation and last-owner safeguard (TENANT-003)',
    summary: 'Implements ensureUser(), transactional createOrganizationWithOwner(), resolveActorContext(), and last-owner demotion/removal protection.',
    content: tenantRepoContent,
  },
  {
    step: 'Step 2.4 (File #17)',
    ticket: 'TENANT-004',
    path: 'tests/security/tenant-isolation.test.ts',
    filename: 'tenant-isolation.test.ts',
    title: 'Cross-Tenant Negative Security & Last-Owner Test Suite (4/4 Passing)',
    commitMessage: 'test(security): add cross-tenant isolation and last-owner safeguard tests (TENANT-004)',
    summary: 'Verifies Threat T-01 cross-tenant read/list/add/remove denial (404), header spoofing prevention, admin owner-escalation block (403), and last-owner protection (409).',
    content: tenantIsolationTestContent,
  },
  {
    step: 'Step 2.4b (File #18)',
    ticket: 'REPO-001',
    path: 'tsconfig.json',
    filename: 'tsconfig.json',
    title: 'TypeScript Compiler Configuration (tsconfig.json)',
    commitMessage: 'chore(ts): configure bundler moduleResolution and node/vite types (REPO-001)',
    summary: 'Configures moduleResolution: "bundler" so extensionless relative TypeScript imports (like "../db/schema/tenant") resolve cleanly in VS Code and pnpm typecheck.',
    content: tsconfigContent,
  },
  {
    step: 'Step 2.4c (File #19)',
    ticket: 'REPO-001',
    path: 'pnpm-workspace.yaml',
    filename: 'pnpm-workspace.yaml',
    title: 'pnpm v12 Workspace & Build Script Allowlist (pnpm-workspace.yaml)',
    commitMessage: 'chore(pnpm): add pnpm-workspace.yaml with allowBuilds for pnpm v12 (REPO-001)',
    summary: 'Configures allowBuilds (esbuild, protobufjs, @google/genai) in pnpm-workspace.yaml as required by pnpm v12.',
    content: pnpmWorkspaceContent,
  },
  {
    step: 'Step 3.1 (File #20)',
    ticket: 'AGENT-001 / AGENT-002',
    path: 'src/server/db/schema/agents.ts',
    filename: 'agents.ts',
    title: 'Drizzle PostgreSQL Schema: Mutable Agent Drafts & Immutable Agent Versions',
    commitMessage: 'feat(agents): add Drizzle schema and migration 0002 for agents and agent_versions (AGENT-001)',
    summary: 'Defines agents (mutable draft config, org-scoped slug uniqueness) and agent_versions (immutable published snapshots with SHA-256 snapshot_hash).',
    content: agentsSchemaContent,
  },
  {
    step: 'Step 3.2 (File #21)',
    ticket: 'AGENT-001 / AGENT-002',
    path: 'src/server/db/repositories/agent-repository.ts',
    filename: 'agent-repository.ts',
    title: 'Agent Studio Repository & Immutable Snapshot Publisher (agent-repository.ts)',
    commitMessage: 'feat(agents): add agent repository with SHA-256 snapshot hashing and atomic publishing (AGENT-002)',
    summary: 'Implements createAgentDraft(), updateAgentDraft(), computeAgentSnapshotHash(), transactional publishAgentVersion(), and tenant-scoped queries.',
    content: agentRepoContent,
  },
  {
    step: 'Step 3.3 (File #22)',
    ticket: 'AGENT-001 / AGENT-002',
    path: 'tests/integration/agent-versions.test.ts',
    filename: 'agent-versions.test.ts',
    title: 'PostgreSQL Agent Versioning & RBAC Integration Tests (3/3 Passing)',
    commitMessage: 'test(agents): add integration tests for immutable agent versions and RBAC isolation (AGENT-002)',
    summary: 'Verifies tool allowlist & budget constraints, immutable v1/v2 snapshots when draft is mutated, RBAC roles, and 404 cross-tenant isolation.',
    content: agentVersionsTestContent,
  },
  {
    step: 'Step 3.3b (File #22b)',
    ticket: 'REPO-001',
    path: '.gitignore',
    filename: '.gitignore',
    title: 'Git Ignore Rules (.gitignore)',
    commitMessage: 'chore(git): add .gitignore protecting secrets, local storage, and zip archives (REPO-001)',
    summary: 'Ignores node_modules, .env secrets (while explicitly keeping !.env.example), .local/uploads, and downloaded .zip bundles.',
    content: gitignoreContent,
  },
  {
    step: 'Step 3.4a (File #23)',
    ticket: 'AGENT-003',
    path: 'src/server/ai/model-provider.ts',
    filename: 'model-provider.ts',
    title: 'Provider-Neutral ModelProvider Interface & Deterministic MockModelProvider',
    commitMessage: 'feat(ai): add ModelProvider contract, deterministic MockModelProvider, and citation guard (AGENT-003)',
    summary: 'Defines ModelProvider, implements zero-cost deterministic MockModelProvider (calculator + knowledge_search + security directives + embedText), and enforces verifyModelCitations().',
    content: modelProviderContent,
  },
  {
    step: 'Step 3.4b (File #24)',
    ticket: 'AGENT-003',
    path: 'tests/unit/mock-model-provider.test.ts',
    filename: 'mock-model-provider.test.ts',
    title: 'Unit Test Suite for Deterministic MockModelProvider (6/6 Passing)',
    commitMessage: 'test(ai): add unit tests for MockModelProvider determinism, citations, and embeddings (AGENT-003)',
    summary: 'Verifies 100% deterministic outputs, multi-step calculator & knowledge_search flows, citation verification against hallucinated chunkIds, and normalized embeddings.',
    content: mockModelProviderTestContent,
  },
  {
    step: 'Step 3.5a (File #25)',
    ticket: 'REPO-001',
    path: 'src/index.css',
    filename: 'index.css',
    title: 'Tailwind v4 Global Stylesheet (src/index.css)',
    commitMessage: 'chore(ui): add Tailwind v4 global stylesheet (REPO-001)',
    summary: 'Imports Tailwind CSS for the interactive workbench and operator console UI.',
    content: indexCssContent,
  },
  {
    step: 'Step 3.5b (File #26)',
    ticket: 'REPO-001',
    path: 'src/main.tsx',
    filename: 'main.tsx',
    title: 'React DOM Application Entry Point (src/main.tsx)',
    commitMessage: 'chore(ui): add React root mount entry point (REPO-001)',
    summary: 'Mounts the root React application into index.html.',
    content: mainTsxContent,
  },
  {
    step: 'Step 3.5c (File #27)',
    ticket: 'REPO-001',
    path: 'src/utils/zip.ts',
    filename: 'zip.ts',
    title: 'Pure TypeScript PKZIP Builder Preserving Folder Paths (src/utils/zip.ts)',
    commitMessage: 'feat(ui): add zero-dependency PKZIP archive builder preserving folder hierarchy (REPO-001)',
    summary: 'Packages files with IEEE 802.3 CRC-32 checksums and relative folder paths so unzip extracts directly into nested directories.',
    content: zipTsContent,
  },
  {
    step: 'Step 3.5d (File #28)',
    ticket: 'REPO-001',
    path: 'src/App.tsx',
    filename: 'App.tsx',
    title: 'Interactive Curriculum Sync, ZIP Exporter & Verification Workbench (src/App.tsx)',
    commitMessage: 'feat(ui): add interactive curriculum workbench and folder-preserving zip exporter (REPO-001)',
    summary: 'Provides live file inspection, step batch .zip downloads with full folder structure, and git commit helpers.',
    content: appTsxContent,
  },
  {
    step: 'Step 4.1a (File #29)',
    ticket: 'TOOL-001 / TOOL-002',
    path: 'src/server/modules/tools/tool-gateway.ts',
    filename: 'tool-gateway.ts',
    title: 'Server-Authorized Tool Gateway & Safe Arithmetic Calculator (tool-gateway.ts)',
    commitMessage: 'feat(tools): add ToolGateway and safe recursive-descent arithmetic calculator (TOOL-001)',
    summary: 'Enforces AgentVersionSnapshot.allowedTools (Threat T-03), Zod argument validation, payload/timeout budgets, and safe parsed arithmetic with zero eval().',
    content: toolGatewayContent,
  },
  {
    step: 'Step 4.1b (File #30)',
    ticket: 'TOOL-001 / TOOL-002',
    path: 'tests/unit/tool-gateway.test.ts',
    filename: 'tool-gateway.test.ts',
    title: 'Unit & Security Test Suite for Tool Gateway & Calculator (6/6 Passing)',
    commitMessage: 'test(tools): add unit and security tests for ToolGateway and safe calculator (TOOL-002)',
    summary: 'Verifies safe arithmetic evaluation, code-injection rejection, T-03 allowlist enforcement, tenant-scoped knowledge_search, and byte/timeout limits.',
    content: toolGatewayTestContent,
  },
  {
    step: 'Step 4.2a (File #31)',
    ticket: 'RUN-001 / QUEUE-001',
    path: 'src/server/db/schema/runs.ts',
    filename: 'runs.ts',
    title: 'Drizzle PostgreSQL Schema: Runs, Run Steps, Run Events & Job Queue (runs.ts)',
    commitMessage: 'feat(runs): add Drizzle schema and migration 0003 for runs, run_steps, run_events, and job_queue (RUN-001)',
    summary: 'Defines runs (pinned to immutable agent_versions + idempotency key), run_steps, monotonic run_events, and FOR UPDATE SKIP LOCKED job_queue.',
    content: runsSchemaContent,
  },
  {
    step: 'Step 4.2b (File #32)',
    ticket: 'RUN-002 / QUEUE-002',
    path: 'src/server/modules/runs/run-executor.ts',
    filename: 'run-executor.ts',
    title: 'Bounded Agent Runtime Executor & PostgreSQL Job Queue Worker (run-executor.ts)',
    commitMessage: 'feat(runs): add bounded agent runtime executor and FOR UPDATE SKIP LOCKED job worker (RUN-002)',
    summary: 'Implements atomic enqueueAgentRun, claimNextPendingJob, recoverExpiredJobLeases, bounded executeAgentRun loop, citation verification, and SSE event replay.',
    content: runExecutorContent,
  },
  {
    step: 'Step 4.2c (File #33)',
    ticket: 'RUN-002 / QUEUE-002',
    path: 'tests/integration/run-executor.test.ts',
    filename: 'run-executor.test.ts',
    title: 'PostgreSQL Integration Tests for Bounded Agent Runtime & Job Queue (3/3 Passing)',
    commitMessage: 'test(runs): add integration tests for bounded agent runtime and job queue leases (RUN-002)',
    summary: 'Verifies idempotent run enqueue, immutable v1 pinning, multi-step calculator + knowledge_search + citation guard, T-03/T-04 guards, 404 isolation, and lease recovery.',
    content: runExecutorTestContent,
  },
  {
    step: 'Step 5.1a (File #34)',
    ticket: 'RAG-001',
    path: 'src/server/db/schema/knowledge.ts',
    filename: 'knowledge.ts',
    title: 'Drizzle PostgreSQL Schema: Knowledge Documents & Chunks (knowledge.ts)',
    commitMessage: 'feat(rag): add Drizzle schema and migration 0004 for knowledge_documents and document_chunks (RAG-001)',
    summary: 'Defines knowledge_documents and document_chunks with composite tenant FKs (Threat T-01), byte/MIME bounds, and GIN tsvector index.',
    content: knowledgeSchemaContent,
  },
  {
    step: 'Step 5.1b (File #35)',
    ticket: 'RAG-002',
    path: 'src/server/modules/knowledge/chunker.ts',
    filename: 'chunker.ts',
    title: 'Deterministic Chunker, T-05 Path Sanitizer & T-03 Prompt-Injection Guard (chunker.ts)',
    commitMessage: 'feat(rag): add deterministic chunker, filename sanitizer, and prompt-injection delimiter wrapper (RAG-002)',
    summary: 'Implements sanitizeDisplayFilename(), generateOpaqueStorageKey(), chunkDocumentText(), detectPromptInjectionPatterns(), and wrapUntrustedKnowledgeChunk().',
    content: chunkerContent,
  },
  {
    step: 'Step 5.1c (File #36)',
    ticket: 'RAG-003',
    path: 'src/server/modules/knowledge/knowledge-service.ts',
    filename: 'knowledge-service.ts',
    title: 'Tenant-Isolated Knowledge Ingestion & Hybrid Full-Text / Vector RAG Service (knowledge-service.ts)',
    commitMessage: 'feat(rag): add tenant-isolated knowledge ingestion and hybrid FTS/vector retrieval service (RAG-003)',
    summary: 'Implements transactional ingestKnowledgeDocument(), SHA-256 deduplication, hybrid tsvector + vector cosine searchKnowledgeChunks(), and createTenantKnowledgeRetriever().',
    content: knowledgeServiceContent,
  },
  {
    step: 'Step 5.1d (File #37)',
    ticket: 'RAG-002',
    path: 'tests/unit/rag-chunker.test.ts',
    filename: 'rag-chunker.test.ts',
    title: 'Unit Test Suite for Deterministic Chunker & T-03 / T-05 Security Guards (6/6 Passing)',
    commitMessage: 'test(rag): add unit tests for deterministic chunker, path traversal sanitizer, and injection guards (RAG-002)',
    summary: 'Verifies path-traversal sanitization, deterministic Markdown chunking with heading breadcrumbs, maxChunks cap, and prompt-injection delimiter breakout protection.',
    content: ragChunkerTestContent,
  },
  {
    step: 'Step 5.1e (File #38)',
    ticket: 'RAG-001 / RAG-003',
    path: 'tests/integration/knowledge-rag.test.ts',
    filename: 'knowledge-rag.test.ts',
    title: 'PostgreSQL Integration Tests for Tenant-Isolated RAG & Live Agent Runs (3/3 Passing)',
    commitMessage: 'test(rag): add PostgreSQL integration tests for tenant-isolated RAG and grounded agent citations (RAG-003)',
    summary: 'Verifies transactional document ingestion, SHA-256 deduplication, hybrid search ranking, strict cross-tenant 0-result & 404 isolation, and live agent run citation verification.',
    content: knowledgeRagTestContent,
  },
  {
    step: 'Step 6.1a (File #39)',
    ticket: 'WORKFLOW-001 / HITL-001 / AUDIT-001 / USAGE-001',
    path: 'src/server/db/schema/workflows.ts',
    filename: 'workflows.ts',
    title: 'Drizzle PostgreSQL Schema: Workflows, Versions, Approval Gates, Audit & Usage Ledger (workflows.ts)',
    commitMessage: 'feat(workflows): add Drizzle schema and migration 0005 for workflows, approval_requests, audit_events, and usage_events (WORKFLOW-001)',
    summary: 'Defines workflows, immutable workflow_versions with composite tenant FKs, approval_requests, append-only audit_events, and honest usage_events.',
    content: workflowsSchemaContent,
  },
  {
    step: 'Step 6.1b (File #40)',
    ticket: 'WORKFLOW-001 / WORKFLOW-002',
    path: 'src/server/modules/workflows/dag-validator.ts',
    filename: 'dag-validator.ts',
    title: 'Directed Acyclic Workflow Validator, Cycle Detector & Safe Condition Evaluator (dag-validator.ts)',
    commitMessage: 'feat(workflows): add 3-color DFS cycle detector, topological sorter, and safe condition evaluator (WORKFLOW-001)',
    summary: 'Enforces node/edge limits, detects directed cycles with exact cyclePath, checks start/end reachability, evaluates conditions without eval(), and hashes graphs canonically.',
    content: dagValidatorContent,
  },
  {
    step: 'Step 6.1c (File #41)',
    ticket: 'WORKFLOW-002 / HITL-001 / AUDIT-001 / USAGE-001',
    path: 'src/server/modules/workflows/workflow-engine.ts',
    filename: 'workflow-engine.ts',
    title: 'Workflow Execution Engine, HITL Pause/Resume Controller & Audit/Usage Ledgers (workflow-engine.ts)',
    commitMessage: 'feat(workflows): add DAG workflow runner, waiting_approval HITL gates, security audit log, and usage ledger (WORKFLOW-002)',
    summary: 'Executes workflow DAGs, pauses at approval nodes, enforces RBAC and 404 isolation on approval decisions, logs allowed/denied audit_events, and separates mock vs live usage.',
    content: workflowEngineContent,
  },
  {
    step: 'Step 6.1d (File #42)',
    ticket: 'WORKFLOW-001 / WORKFLOW-002',
    path: 'tests/unit/workflow-dag.test.ts',
    filename: 'workflow-dag.test.ts',
    title: 'Unit Test Suite for Workflow DAG Validator & Condition Evaluator (6/6 Passing)',
    commitMessage: 'test(workflows): add unit tests for DAG cycle detection, reachability, condition evaluation, and snapshot hashing (WORKFLOW-001)',
    summary: 'Verifies valid branching DAG topological sort, cycle path diagnostics, self-loop rejection, orphan/dead-end rejection, safe condition operators, and canonical hashing.',
    content: workflowDagTestContent,
  },
  {
    step: 'Step 6.1e (File #43)',
    ticket: 'WORKFLOW-002 / HITL-001 / AUDIT-001 / USAGE-001',
    path: 'tests/integration/workflow-hitl-audit.test.ts',
    filename: 'workflow-hitl-audit.test.ts',
    title: 'PostgreSQL Integration Tests for Workflows, HITL Approvals, Audit Trail & Usage Ledger (4/4 Passing)',
    commitMessage: 'test(workflows): add PostgreSQL integration tests for HITL pause/resume, denied audit logs, and usage ledger (HITL-001)',
    summary: 'Verifies immutable workflow versions, waiting_approval pause & admin resume, 404 cross-tenant isolation, 403 viewer/developer denied audit events, and mock vs live usage.',
    content: workflowHitlAuditTestContent,
  },
];

interface CurrentBatchItem {
  path: string;
  status: 'NEW' | 'UPDATED';
  changeReason: string;
}

const CURRENT_STEP_BATCH: CurrentBatchItem[] = [
  {
    path: 'src/server/db/schema/workflows.ts',
    status: 'NEW',
    changeReason: 'Step 6.1a (WORKFLOW-001 / HITL-001 / AUDIT-001 / USAGE-001): Drizzle schema & SQL migration 0005 for workflows, workflow_versions, approval_requests, audit_events, and usage_events.',
  },
  {
    path: 'src/server/modules/workflows/dag-validator.ts',
    status: 'NEW',
    changeReason: 'Step 6.1b (WORKFLOW-001 / WORKFLOW-002): 3-color DFS cycle detector, reachability/dead-end validator, safe condition evaluator, and canonical SHA-256 snapshot hasher.',
  },
  {
    path: 'src/server/modules/workflows/workflow-engine.ts',
    status: 'NEW',
    changeReason: 'Step 6.1c (WORKFLOW-002 / HITL-001 / AUDIT-001 / USAGE-001): DAG execution engine, waiting_approval HITL pause/resume/cancel gates, security audit log, and honest usage ledger.',
  },
  {
    path: 'tests/unit/workflow-dag.test.ts',
    status: 'NEW',
    changeReason: 'Step 6.1d (WORKFLOW-001): Unit test suite (6/6 passing) for DAG topological sort, cycle path reporting, orphan/dead-end rejection, and safe condition evaluation.',
  },
  {
    path: 'tests/integration/workflow-hitl-audit.test.ts',
    status: 'NEW',
    changeReason: 'Step 6.1e (WORKFLOW-002 / HITL-001 / AUDIT-001 / USAGE-001): PostgreSQL integration tests (4/4 passing) for immutable workflow snapshots, HITL pause/resume, security audit trail, and mock vs live usage.',
  },
  {
    path: 'src/server/db/client.ts',
    status: 'UPDATED',
    changeReason: 'Registered workflowsSchema and MIGRATION_0005_WORKFLOWS_SQL in applyTenantMigrations().',
  },
  {
    path: 'docs/implementation/STATUS.md',
    status: 'UPDATED',
    changeReason: 'Updated implementation ledger marking Phase 6 (WORKFLOW-001, WORKFLOW-002, HITL-001, AUDIT-001, USAGE-001) verified (64/64 tests passing).',
  },
  {
    path: 'src/App.tsx',
    status: 'UPDATED',
    changeReason: 'Registered Step 6.1 files and updated CURRENT_STEP_BATCH zip bundle.',
  },
];

export default function App() {
  const [selectedIndex, setSelectedIndex] = useState<number>(COMPLETED_FILES.length - 1);
  const [copiedType, setCopiedType] = useState<'content' | 'git' | 'batch-git' | null>(null);

  const activeFile = COMPLETED_FILES[selectedIndex];

  const batchFiles = CURRENT_STEP_BATCH.map((item) => {
    const index = COMPLETED_FILES.findIndex((f) => f.path === item.path);
    return {
      ...item,
      index,
      file: COMPLETED_FILES[index],
    };
  }).filter((item) => Boolean(item.file));

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

  const handleDownloadAllScript = () => {
    const scriptLines = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '# Aegis Runtime — Auto-generated Step-by-Step File Sync & Folder Organizer Script',
      '',
      '# 1. Remove any flat copies accidentally saved into the repository root by browser downloads',
      'rm -f ./STATUS.md ./architecture.md ./threat-model.md ./ADR-001-local-first-free-tier.md ./ADR-003-postgres-job-queue.md',
      'rm -f ./env.ts ./env.test.ts ./route.ts ./health-route.test.ts ./tenant.ts ./client.ts ./tenant-schema.test.ts',
      'rm -f ./authorization.ts ./authorization.test.ts ./tenant-repository.ts ./tenant-isolation.test.ts ./agents.ts',
      '',
      '# 2. Create exact directory tree and write every file to its canonical path',
    ];
    for (const f of COMPLETED_FILES) {
      const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
      if (dir) {
        scriptLines.push(`mkdir -p "${dir}"`);
      }
      scriptLines.push(`cat << 'EOF_AEGIS_FILE' > "${f.path}"`);
      scriptLines.push(f.content);
      scriptLines.push('EOF_AEGIS_FILE');
      scriptLines.push(`echo "Synced ${f.path}"`);
      scriptLines.push('');
    }
    const blob = new Blob([scriptLines.join('\n')], { type: 'text/x-shellscript;charset=utf-8' });
    triggerBlobDownload(blob, 'sync-aegis-files.sh');
  };

  const buildTerminalCommand = (file: ProjectFile) => {
    const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
    const mkdirPart = dir ? `mkdir -p "${dir}" && ` : '';
    const cleanRootDuplicate = dir ? `rm -f "./${file.filename}" && ` : '';
    return `${cleanRootDuplicate}${mkdirPart}cat << 'EOF' > "${file.path}"\n${file.content}\nEOF\ngit add "${file.path}" && git commit -m "${file.commitMessage}"`;
  };

  const buildBatchTerminalCommand = () => {
    const blocks = batchFiles.map(({ file }) => {
      const dir = file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '';
      const mkdirPart = dir ? `mkdir -p "${dir}"\n` : '';
      return `${mkdirPart}cat << 'EOF_AEGIS' > "${file.path}"\n${file.content}\nEOF_AEGIS`;
    });
    const paths = batchFiles.map(({ file }) => `"${file.path}"`).join(' ');
    const latestCommitMsg = batchFiles[0]?.file.commitMessage ?? 'chore: sync current step batch';
    return `${blocks.join('\n\n')}\n\ngit add ${paths} && git commit -m "${latestCommitMsg}"`;
  };

  const handleCopy = async (text: string, type: 'content' | 'git' | 'batch-git') => {
    await navigator.clipboard.writeText(text);
    setCopiedType(type);
    setTimeout(() => setCopiedType(null), 2000);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* Top Bar Contract: 3 zones */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 bg-white border-b border-slate-200">
        <a href="#top" className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          Aegis Runtime
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#current-batch" className="text-slate-900 hover:text-blue-600 transition-colors whitespace-nowrap shrink-0">
            Current Step Batch ({batchFiles.length})
          </a>
          <a href="#files" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            All Files ({COMPLETED_FILES.length})
          </a>
          <a href="#git-helper" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Phase 6 Complete (64/64 Pass)
          </a>
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={handleDownloadCurrentBatchZip}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer"
          >
            <FolderArchive className="w-3.5 h-3.5" />
            Download Step Batch .zip (With Folders)
          </button>
          <button
            onClick={handleDownloadAllZip}
            className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
          >
            <FolderArchive className="w-3.5 h-3.5" />
            Full Repo ({COMPLETED_FILES.length}) .zip
          </button>
        </div>
      </header>

      {/* Main Workspace Layout: 300px Sidebar + Content */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
        {/* Left Sidebar: File-by-File Progression */}
        <aside className="w-full lg:w-80 bg-white border-b lg:border-b-0 lg:border-r border-slate-200 p-5 flex flex-col gap-5 shrink-0">
          <div>
            <div className="text-xs font-medium text-emerald-700">
              Phase 6 Complete · 64/64 Tests Passing
            </div>
            <h1 className="text-base font-bold text-slate-900 mt-1">
              Project Files ({COMPLETED_FILES.length})
            </h1>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              Every file uses live disk imports (`?raw`), so updated files always contain their latest version.
            </p>
          </div>

          <div className="flex flex-col gap-1.5" role="listbox" aria-label="Completed project files">
            {COMPLETED_FILES.map((file, idx) => {
              const isSelected = idx === selectedIndex;
              const batchEntry = CURRENT_STEP_BATCH.find((b) => b.path === file.path);
              return (
                <button
                  key={file.path}
                  onClick={() => setSelectedIndex(idx)}
                  className={`w-full text-left px-3.5 py-3 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-800 border-slate-200 hover:bg-slate-50'
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
                  <div className={`text-xs mt-1 line-clamp-1 ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                    {file.title}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Main Content Viewport */}
        <main id="files" className="flex-1 p-6 lg:p-8 flex flex-col gap-6 min-w-0">
          {/* Current Step Batch Section (New + Updated Files) */}
          <section id="current-batch" className="bg-white border border-slate-200 rounded-lg p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-200">
              <div>
                <div className="text-xs font-semibold text-blue-700">
                  Current Step Download Batch — Preserves Exact Folder Hierarchy (.zip)
                </div>
                <h2 className="text-lg font-bold text-slate-900 mt-0.5">
                  Step 6.1 Batch ({batchFiles.length} Files: New + Updated)
                </h2>
                <p className="text-xs text-slate-600 mt-1">
                  Click <span className="font-mono font-semibold text-slate-800">Download Batch .zip (With Folders)</span> and run <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-800">unzip -o ~/Downloads/aegis-current-step-batch.zip</span> in your repo root — every file extracts directly into its exact subfolder (`src/server/ai/...`, `tests/unit/...`, `docs/...`).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <button
                  onClick={handleDownloadCurrentBatchZip}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer"
                >
                  <FolderArchive className="w-3.5 h-3.5" />
                  Download Batch .zip (With Folders)
                </button>
                <button
                  onClick={() => handleCopy(buildBatchTerminalCommand(), 'batch-git')}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedType === 'batch-git' ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                  ) : (
                    <GitCommit className="w-3.5 h-3.5" />
                  )}
                  {copiedType === 'batch-git' ? 'Copied Batch Git Command' : 'Copy Batch Git Sync Command'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
              {batchFiles.map(({ file, index, status, changeReason }) => (
                <div
                  key={file.path}
                  className="border border-slate-200 rounded-lg p-3.5 flex flex-col justify-between gap-3 bg-slate-50/60"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono font-semibold text-slate-900 truncate">
                        {file.path}
                      </span>
                      <span
                        className={`text-[11px] font-mono font-semibold px-2 py-0.5 rounded shrink-0 ${
                          status === 'NEW'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-900'
                        }`}
                      >
                        {status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      {changeReason}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-200/80">
                    <button
                      onClick={() => handleDownloadSingleFileWithFolderZip(file)}
                      className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded hover:bg-slate-800 transition-colors flex items-center gap-1.5 cursor-pointer"
                    >
                      <FolderArchive className="w-3 h-3" />
                      .zip (With Folder Path)
                    </button>
                    <button
                      onClick={() => handleDownloadFile(file)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                      Raw {file.filename}
                    </button>
                    <button
                      onClick={() => setSelectedIndex(index)}
                      className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded hover:bg-slate-100 transition-colors cursor-pointer"
                    >
                      Inspect
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Active File Header & Download Actions */}
          <section className="bg-white border border-slate-200 rounded-lg p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-slate-200">
              <div>
                <div className="text-xs text-slate-500 font-mono tabular-nums">
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
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 flex items-center gap-2 cursor-pointer"
                >
                  <FolderArchive className="w-3.5 h-3.5" />
                  Download {activeFile.path} (.zip)
                </button>

                <button
                  onClick={() => handleDownloadFile(activeFile)}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  Raw {activeFile.filename}
                </button>

                <button
                  onClick={() => handleCopy(activeFile.content, 'content')}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedType === 'content' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedType === 'content' ? 'Copied File Content' : 'Copy Raw File'}
                </button>
              </div>
            </div>

            {/* Git Commit Helper Box */}
            <div id="git-helper" className="mt-5 bg-slate-900 text-slate-100 rounded-lg p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
                  <Terminal className="w-4 h-4 text-blue-400 shrink-0" />
                  <span>Local Git Repo Helper — Creates directory, writes {activeFile.path}, and commits:</span>
                </div>
                <button
                  onClick={() => handleCopy(buildTerminalCommand(activeFile), 'git')}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-white rounded border border-slate-700 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
                >
                  {copiedType === 'git' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <GitCommit className="w-3.5 h-3.5" />}
                  {copiedType === 'git' ? 'Copied Terminal Command' : 'Copy mkdir + cat + git commit'}
                </button>
              </div>
              <pre className="mt-2.5 text-xs font-mono text-emerald-300 overflow-x-auto">
                <code>git add "{activeFile.path}" && git commit -m "{activeFile.commitMessage}"</code>
              </pre>
            </div>

            {/* Full File Code Viewer */}
            <div className="mt-5">
              <div className="flex items-center justify-between text-xs font-mono text-slate-500 mb-2">
                <span>File Preview: {activeFile.path}</span>
                <span className="tabular-nums">{activeFile.content.split('\n').length} lines</span>
              </div>
              <pre className="bg-slate-950 text-slate-100 p-5 rounded-lg text-xs font-mono leading-relaxed overflow-x-auto max-h-[540px] overflow-y-auto border border-slate-800">
                <code>{activeFile.content}</code>
              </pre>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

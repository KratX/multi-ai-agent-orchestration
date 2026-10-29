import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './tenant';

/**
 * Ticket RAG-001: Multi-Tenant Knowledge Base Documents & Chunks Schema
 *
 * Implements Blueprint Section 4.1, Section 6.4 & Threat Model T-01, T-03, T-04, T-05:
 * 1. `knowledge_documents`: Tenant-scoped document catalog with sanitized display filenames,
 *    opaque UUID storage keys (`<orgId>/<uuid>.bin`), SHA-256 content checksums, MIME & byte bounds.
 * 2. `document_chunks`: Denormalized `organization_id` on every chunk row + composite foreign key
 *    `(organization_id, document_id) -> knowledge_documents(organization_id, id)` so cross-tenant
 *    chunk association is impossible at the PostgreSQL constraint level (`T-01`).
 * 3. Indexed for PostgreSQL full-text search (`to_tsvector('english', content)`) and deterministic
 *    vector cosine hybrid ranking (`embedding_json`).
 */

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

export const DOCUMENT_STATUSES = ['processing', 'ready', 'failed'] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const MAX_DOCUMENT_UPLOAD_BYTES = 10_485_760; // 10 MiB per Blueprint Section 6

export interface DocumentChunkMetadata {
  startCharOffset: number;
  endCharOffset: number;
  headingPath?: string[];
  sanitizedInjectionPatterns?: string[];
}

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sourceFilename: text('source_filename').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').$type<AllowedDocumentMimeType>().notNull(),
    status: text('status')
      .$type<DocumentStatus>()
      .notNull()
      .default('ready'),
    byteSize: integer('byte_size').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    chunkCount: integer('chunk_count').notNull().default(0),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('knowledge_documents_org_id_unique').on(
      table.organizationId,
      table.id
    ),
    unique('knowledge_documents_org_storage_key_unique').on(
      table.organizationId,
      table.storageKey
    ),
    index('idx_knowledge_documents_org_created').on(
      table.organizationId,
      table.createdAt
    ),
    index('idx_knowledge_documents_org_checksum').on(
      table.organizationId,
      table.checksumSha256
    ),
    check(
      'knowledge_documents_title_not_blank',
      sql`length(btrim(${table.title})) > 0`
    ),
    check(
      'knowledge_documents_mime_type_valid',
      sql`${table.mimeType} IN ('text/plain', 'text/markdown')`
    ),
    check(
      'knowledge_documents_status_valid',
      sql`${table.status} IN ('processing', 'ready', 'failed')`
    ),
    check(
      'knowledge_documents_byte_size_bounds',
      sql`${table.byteSize} > 0 AND ${table.byteSize} <= 10485760`
    ),
    check(
      'knowledge_documents_chunk_count_non_negative',
      sql`${table.chunkCount} >= 0`
    ),
  ]
);

export const documentChunks = pgTable(
  'document_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    embeddingJson: jsonb('embedding_json')
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    containsInjectionPattern: boolean('contains_injection_pattern')
      .notNull()
      .default(false),
    metadataJson: jsonb('metadata_json')
      .$type<DocumentChunkMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'document_chunks_org_document_fk',
      columns: [table.organizationId, table.documentId],
      foreignColumns: [knowledgeDocuments.organizationId, knowledgeDocuments.id],
    }).onDelete('cascade'),
    unique('document_chunks_document_chunk_index_unique').on(
      table.documentId,
      table.chunkIndex
    ),
    index('idx_document_chunks_org_doc').on(
      table.organizationId,
      table.documentId
    ),
    check(
      'document_chunks_chunk_index_non_negative',
      sql`${table.chunkIndex} >= 0`
    ),
    check(
      'document_chunks_content_not_blank',
      sql`length(btrim(${table.content})) > 0`
    ),
    check(
      'document_chunks_token_count_positive',
      sql`${table.tokenCount} > 0`
    ),
  ]
);

export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type NewKnowledgeDocumentRow = typeof knowledgeDocuments.$inferInsert;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type NewDocumentChunkRow = typeof documentChunks.$inferInsert;

export const MIGRATION_0004_KNOWLEDGE_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  byte_size INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_documents_org_id_unique UNIQUE (organization_id, id),
  CONSTRAINT knowledge_documents_org_storage_key_unique UNIQUE (organization_id, storage_key),
  CONSTRAINT knowledge_documents_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT knowledge_documents_mime_type_valid CHECK (mime_type IN ('text/plain', 'text/markdown')),
  CONSTRAINT knowledge_documents_status_valid CHECK (status IN ('processing', 'ready', 'failed')),
  CONSTRAINT knowledge_documents_byte_size_bounds CHECK (byte_size > 0 AND byte_size <= 10485760),
  CONSTRAINT knowledge_documents_chunk_count_non_negative CHECK (chunk_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_org_created
  ON knowledge_documents (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_org_checksum
  ON knowledge_documents (organization_id, checksum_sha256);

CREATE TABLE IF NOT EXISTS document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  embedding_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  contains_injection_pattern BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT document_chunks_org_document_fk
    FOREIGN KEY (organization_id, document_id)
    REFERENCES knowledge_documents(organization_id, id)
    ON DELETE CASCADE,
  CONSTRAINT document_chunks_document_chunk_index_unique UNIQUE (document_id, chunk_index),
  CONSTRAINT document_chunks_chunk_index_non_negative CHECK (chunk_index >= 0),
  CONSTRAINT document_chunks_content_not_blank CHECK (length(btrim(content)) > 0),
  CONSTRAINT document_chunks_token_count_positive CHECK (token_count > 0)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_org_doc
  ON document_chunks (organization_id, document_id);

CREATE INDEX IF NOT EXISTS idx_document_chunks_fts
  ON document_chunks USING GIN (to_tsvector('english', content));
`;

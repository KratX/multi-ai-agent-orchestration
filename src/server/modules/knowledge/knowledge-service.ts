import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { AegisDatabase } from '../../db/client';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  documentChunks,
  knowledgeDocuments,
  MAX_DOCUMENT_UPLOAD_BYTES,
  type AllowedDocumentMimeType,
  type DocumentChunkRow,
  type KnowledgeDocumentRow,
} from '../../db/schema/knowledge';
import {
  MockModelProvider,
  type ModelProvider,
  type RetrievedKnowledgeChunk,
} from '../../ai/model-provider';
import {
  requireAuthorization,
  type AuthenticatedActor,
} from '../../policies/authorization';
import type { KnowledgeSearchRetriever } from '../tools/tool-gateway';
import {
  chunkDocumentText,
  computeDocumentSha256,
  cosineSimilarity,
  generateOpaqueStorageKey,
  sanitizeDisplayFilename,
  wrapUntrustedKnowledgeChunk,
  type ChunkingOptions,
} from './chunker';

/**
 * Ticket RAG-003: Tenant-Isolated Knowledge Base Ingestion & Hybrid Full-Text / Vector Retrieval Service
 *
 * Implements Blueprint Section 6.4 & Threat Model T-01, T-02, T-03, T-04, T-05:
 * 1. `ingestKnowledgeDocument()`: Enforces RBAC (`document.upload`), MIME & byte limits (`10 MiB`),
 *    filename sanitization & opaque UUID storage keys (`T-05`), SHA-256 checksum deduplication,
 *    deterministic chunking (`RAG-002`), prompt-injection scanning (`T-03`), and atomic PostgreSQL
 *    transactional persistence of `knowledge_documents` + `document_chunks`.
 * 2. `searchKnowledgeChunks()`: Enforces mandatory `organization_id` tenant scoping (`T-01`),
 *    executes hybrid PostgreSQL `tsvector` full-text + deterministic vector cosine similarity
 *    ranking, and optionally wraps chunks in `<untrusted_knowledge_context>` XML delimiters (`T-03`).
 * 3. `createTenantKnowledgeRetriever()`: Adapts `searchKnowledgeChunks()` directly into the
 *    `KnowledgeSearchRetriever` contract consumed by `ToolGateway` and `executeAgentRun()`.
 */

export type KnowledgeErrorCode =
  | 'DOCUMENT_NOT_FOUND'
  | 'INVALID_DOCUMENT_INPUT'
  | 'UNSUPPORTED_MIME_TYPE'
  | 'DOCUMENT_TOO_LARGE'
  | 'CHUNK_LIMIT_EXCEEDED';

export class KnowledgeConstraintError extends Error {
  public readonly code: KnowledgeErrorCode;
  public readonly statusCode: 400 | 404 | 413 | 415 | 422;

  constructor(
    code: KnowledgeErrorCode,
    message: string,
    statusCode: 400 | 404 | 413 | 415 | 422 = 400
  ) {
    super(message);
    this.name = 'KnowledgeConstraintError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface IngestKnowledgeDocumentInput {
  organizationId: string;
  title: string;
  sourceFilename: string;
  mimeType: AllowedDocumentMimeType | string;
  content: string;
  deduplicateByChecksum?: boolean;
  chunkingOptions?: ChunkingOptions;
}

export interface IngestKnowledgeDocumentOptions {
  modelProvider?: ModelProvider;
  maxUploadBytes?: number;
}

export interface IngestKnowledgeDocumentResult {
  document: KnowledgeDocumentRow;
  chunks: DocumentChunkRow[];
  deduplicated: boolean;
  flaggedInjectionChunkCount: number;
}

export interface RankedKnowledgeChunk extends RetrievedKnowledgeChunk {
  chunkIndex: number;
  tokenCount: number;
  ftsScore: number;
  vectorScore: number;
  lexicalOverlapScore: number;
  containsInjectionPattern: boolean;
  wrappedContent: string;
}

export interface SearchKnowledgeChunksParams {
  organizationId: string;
  query: string;
  topK?: number;
  minScore?: number;
  wrapUntrustedDelimiters?: boolean;
}

export interface SearchKnowledgeChunksOptions {
  modelProvider?: ModelProvider;
}

function isAllowedMimeType(mime: string): mime is AllowedDocumentMimeType {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime);
}

function tokenizeQueryTerms(query: string): string[] {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'how',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'that',
    'the',
    'this',
    'to',
    'was',
    'what',
    'when',
    'where',
    'which',
    'who',
    'why',
    'with',
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !stopWords.has(t));
}

function computeLexicalOverlapScore(
  queryTerms: readonly string[],
  content: string,
  title: string
): number {
  if (queryTerms.length === 0) {
    return 0;
  }

  const hay = `${title} ${content}`.toLowerCase();
  let matched = 0;
  for (const term of queryTerms) {
    if (hay.includes(term)) {
      matched += 1;
    }
  }

  return Number((matched / queryTerms.length).toFixed(6));
}

/**
 * Ingests a plain-text or Markdown document into the tenant's knowledge base inside
 * an atomic PostgreSQL transaction.
 */
export async function ingestKnowledgeDocument(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  input: IngestKnowledgeDocumentInput,
  options: IngestKnowledgeDocumentOptions = {}
): Promise<IngestKnowledgeDocumentResult> {
  requireAuthorization(actor, 'document.upload', {
    organizationId: input.organizationId,
    resourceType: 'knowledge_document',
  });

  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length === 0 || trimmedTitle.length > 200) {
    throw new KnowledgeConstraintError(
      'INVALID_DOCUMENT_INPUT',
      'Document title must be between 1 and 200 characters.',
      422
    );
  }

  if (!isAllowedMimeType(input.mimeType)) {
    throw new KnowledgeConstraintError(
      'UNSUPPORTED_MIME_TYPE',
      `Unsupported document MIME type "${input.mimeType}". Allowed types: ${ALLOWED_DOCUMENT_MIME_TYPES.join(', ')}.`,
      415
    );
  }
  const validMimeType: AllowedDocumentMimeType = input.mimeType;

  const normalizedContent = input.content.replace(/\r\n/g, '\n');
  if (normalizedContent.trim().length === 0) {
    throw new KnowledgeConstraintError(
      'INVALID_DOCUMENT_INPUT',
      'Document content must not be empty or whitespace-only.',
      422
    );
  }

  const byteSize = Buffer.byteLength(normalizedContent, 'utf8');
  const maxUploadBytes = options.maxUploadBytes ?? MAX_DOCUMENT_UPLOAD_BYTES;
  if (byteSize > maxUploadBytes) {
    throw new KnowledgeConstraintError(
      'DOCUMENT_TOO_LARGE',
      `Document payload (${byteSize} bytes) exceeds maximum upload limit of ${maxUploadBytes} bytes.`,
      413
    );
  }

  const sanitizedFilename = sanitizeDisplayFilename(input.sourceFilename);
  const checksumSha256 = computeDocumentSha256(normalizedContent);

  if (input.deduplicateByChecksum !== false) {
    const [existingDoc] = await db
      .select()
      .from(knowledgeDocuments)
      .where(
        and(
          eq(knowledgeDocuments.organizationId, input.organizationId),
          eq(knowledgeDocuments.checksumSha256, checksumSha256)
        )
      )
      .limit(1);

    if (existingDoc) {
      const existingChunks = await db
        .select()
        .from(documentChunks)
        .where(
          and(
            eq(documentChunks.organizationId, input.organizationId),
            eq(documentChunks.documentId, existingDoc.id)
          )
        )
        .orderBy(asc(documentChunks.chunkIndex));

      const flaggedInjectionChunkCount = existingChunks.filter(
        (c) => c.containsInjectionPattern
      ).length;

      return {
        document: existingDoc,
        chunks: existingChunks,
        deduplicated: true,
        flaggedInjectionChunkCount,
      };
    }
  }

  let deterministicChunks;
  try {
    deterministicChunks = chunkDocumentText(
      normalizedContent,
      input.chunkingOptions
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to chunk document content.';
    if (message.includes('maximum allowed chunk count')) {
      throw new KnowledgeConstraintError('CHUNK_LIMIT_EXCEEDED', message, 422);
    }
    throw new KnowledgeConstraintError('INVALID_DOCUMENT_INPUT', message, 422);
  }

  const modelProvider = options.modelProvider ?? new MockModelProvider();
  const chunkEmbeddings: number[][] = [];
  for (const chunk of deterministicChunks) {
    const vector = await modelProvider.embedText(chunk.content);
    chunkEmbeddings.push(vector);
  }

  const storageKey = generateOpaqueStorageKey(input.organizationId);

  return db.transaction(async (tx) => {
    const [insertedDoc] = await tx
      .insert(knowledgeDocuments)
      .values({
        organizationId: input.organizationId,
        title: trimmedTitle,
        sourceFilename: sanitizedFilename,
        storageKey,
        mimeType: validMimeType,
        status: 'ready',
        byteSize,
        checksumSha256,
        chunkCount: deterministicChunks.length,
        createdByUserId: actor.userId,
      })
      .returning();

    if (!insertedDoc) {
      throw new Error('Failed to insert knowledge_documents row.');
    }

    const chunkValues = deterministicChunks.map((chunk, idx) => ({
      organizationId: input.organizationId,
      documentId: insertedDoc.id,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      embeddingJson: chunkEmbeddings[idx] ?? [],
      containsInjectionPattern: chunk.containsInjectionPattern,
      metadataJson: chunk.metadata,
    }));

    const insertedChunks = await tx
      .insert(documentChunks)
      .values(chunkValues)
      .returning();

    const orderedChunks = [...insertedChunks].sort(
      (a, b) => a.chunkIndex - b.chunkIndex
    );

    const flaggedInjectionChunkCount = orderedChunks.filter(
      (c) => c.containsInjectionPattern
    ).length;

    return {
      document: insertedDoc,
      chunks: orderedChunks,
      deduplicated: false,
      flaggedInjectionChunkCount,
    };
  });
}

/**
 * Searches tenant-scoped knowledge chunks using hybrid PostgreSQL `tsvector` full-text
 * rank + lexical term coverage + deterministic vector cosine similarity.
 *
 * Strictly enforces `WHERE document_chunks.organization_id = $1 AND knowledge_documents.organization_id = $1`.
 */
export async function searchKnowledgeChunks(
  db: AegisDatabase,
  params: SearchKnowledgeChunksParams,
  options: SearchKnowledgeChunksOptions = {}
): Promise<RankedKnowledgeChunk[]> {
  const organizationId = params.organizationId?.trim();
  if (!organizationId) {
    throw new KnowledgeConstraintError(
      'INVALID_DOCUMENT_INPUT',
      'Knowledge search requires a non-empty server-verified organizationId.',
      422
    );
  }

  const trimmedQuery = params.query.trim();
  if (!trimmedQuery) {
    return [];
  }

  const topK = Math.max(1, Math.min(10, params.topK ?? 3));
  const minScore = params.minScore ?? 0.05;
  const modelProvider = options.modelProvider ?? new MockModelProvider();
  const queryEmbedding = await modelProvider.embedText(trimmedQuery);
  const queryTerms = tokenizeQueryTerms(trimmedQuery);

  // Query only chunks belonging to this exact organizationId (`Threat T-01` defense-in-depth)
  const rows = await db
    .select({
      chunkId: documentChunks.id,
      documentId: documentChunks.documentId,
      documentTitle: knowledgeDocuments.title,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      tokenCount: documentChunks.tokenCount,
      embeddingJson: documentChunks.embeddingJson,
      containsInjectionPattern: documentChunks.containsInjectionPattern,
      ftsRank: sql<number>`ts_rank_cd(
        to_tsvector('english', ${documentChunks.content}),
        websearch_to_tsquery('english', ${trimmedQuery})
      )`,
    })
    .from(documentChunks)
    .innerJoin(
      knowledgeDocuments,
      and(
        eq(knowledgeDocuments.id, documentChunks.documentId),
        eq(knowledgeDocuments.organizationId, documentChunks.organizationId)
      )
    )
    .where(
      and(
        eq(documentChunks.organizationId, organizationId),
        eq(knowledgeDocuments.organizationId, organizationId),
        eq(knowledgeDocuments.status, 'ready')
      )
    );

  const scored: RankedKnowledgeChunk[] = [];

  for (const row of rows) {
    const ftsScore = Math.max(0, Number(row.ftsRank ?? 0));
    const lexicalOverlapScore = computeLexicalOverlapScore(
      queryTerms,
      row.content,
      row.documentTitle
    );
    const rawVectorCos = cosineSimilarity(
      queryEmbedding,
      Array.isArray(row.embeddingJson) ? row.embeddingJson : []
    );
    // Only positive vector correlation contributes
    const vectorScore = Math.max(0, rawVectorCos);

    // Hybrid weighted score: FTS + lexical term coverage + embedding similarity
    const combinedScore = Number(
      Math.min(
        1,
        ftsScore * 0.45 + lexicalOverlapScore * 0.4 + vectorScore * 0.15
      ).toFixed(6)
    );

    if (combinedScore < minScore) {
      continue;
    }

    const wrappedContent = wrapUntrustedKnowledgeChunk({
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      content: row.content,
      containsInjectionPattern: row.containsInjectionPattern,
    });

    scored.push({
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      chunkIndex: row.chunkIndex,
      content: params.wrapUntrustedDelimiters ? wrappedContent : row.content,
      wrappedContent,
      tokenCount: row.tokenCount,
      score: combinedScore,
      ftsScore: Number(ftsScore.toFixed(6)),
      vectorScore: Number(vectorScore.toFixed(6)),
      lexicalOverlapScore,
      containsInjectionPattern: row.containsInjectionPattern,
    });
  }

  scored.sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > 1e-9) {
      return scoreDiff;
    }
    return a.chunkIndex - b.chunkIndex;
  });

  return scored.slice(0, topK);
}

/**
 * Creates a `KnowledgeSearchRetriever` function bound to PostgreSQL (`AegisDatabase`)
 * for injection into `ToolGateway` (`knowledge_search` tool).
 */
export function createTenantKnowledgeRetriever(
  db: AegisDatabase,
  options: SearchKnowledgeChunksOptions & {
    wrapUntrustedDelimiters?: boolean;
    minScore?: number;
  } = {}
): KnowledgeSearchRetriever {
  return async ({ organizationId, query, topK }) => {
    const ranked = await searchKnowledgeChunks(
      db,
      {
        organizationId,
        query,
        topK,
        minScore: options.minScore,
        wrapUntrustedDelimiters: options.wrapUntrustedDelimiters,
      },
      { modelProvider: options.modelProvider }
    );

    return ranked.map((item) => ({
      chunkId: item.chunkId,
      documentId: item.documentId,
      documentTitle: item.documentTitle,
      content: item.content,
      score: item.score,
    }));
  };
}

/**
 * Lists all knowledge documents belonging to `organizationId` (newest first).
 */
export async function listKnowledgeDocuments(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  organizationId: string
): Promise<KnowledgeDocumentRow[]> {
  requireAuthorization(actor, 'document.view', {
    organizationId,
    resourceType: 'knowledge_document',
  });

  return db
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.organizationId, organizationId))
    .orderBy(desc(knowledgeDocuments.createdAt), asc(knowledgeDocuments.title));
}

/**
 * Retrieves a single knowledge document and its ordered chunks for `organizationId`.
 * Enforces cross-tenant `404` anti-enumeration (`Threat T-01`).
 */
export async function getKnowledgeDocumentWithChunks(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  organizationId: string,
  documentId: string
): Promise<{
  document: KnowledgeDocumentRow;
  chunks: DocumentChunkRow[];
}> {
  requireAuthorization(actor, 'document.view', {
    organizationId,
    resourceType: 'knowledge_document',
    resourceId: documentId,
  });

  const [document] = await db
    .select()
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.organizationId, organizationId),
        eq(knowledgeDocuments.id, documentId)
      )
    )
    .limit(1);

  if (!document) {
    throw new KnowledgeConstraintError(
      'DOCUMENT_NOT_FOUND',
      `Knowledge document "${documentId}" was not found in organization "${organizationId}".`,
      404
    );
  }

  const chunks = await db
    .select()
    .from(documentChunks)
    .where(
      and(
        eq(documentChunks.organizationId, organizationId),
        eq(documentChunks.documentId, documentId)
      )
    )
    .orderBy(asc(documentChunks.chunkIndex));

  return {
    document,
    chunks,
  };
}

/**
 * Deletes a tenant-owned knowledge document (and cascades to its `document_chunks`).
 * Enforces `document.delete` RBAC and returns `404` if the document belongs to another tenant.
 */
export async function deleteKnowledgeDocument(
  db: AegisDatabase,
  actor: AuthenticatedActor,
  organizationId: string,
  documentId: string
): Promise<{ deletedDocumentId: string }> {
  requireAuthorization(actor, 'document.delete', {
    organizationId,
    resourceType: 'knowledge_document',
    resourceId: documentId,
  });

  const deletedRows = await db
    .delete(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.organizationId, organizationId),
        eq(knowledgeDocuments.id, documentId)
      )
    )
    .returning({ id: knowledgeDocuments.id });

  if (deletedRows.length === 0) {
    throw new KnowledgeConstraintError(
      'DOCUMENT_NOT_FOUND',
      `Knowledge document "${documentId}" was not found in organization "${organizationId}".`,
      404
    );
  }

  return { deletedDocumentId: deletedRows[0]!.id };
}

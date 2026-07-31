/**
 * @fileoverview Per-file preparation, chunking, embedding, and storage within the indexing pipeline.
 */
import path from "node:path";
import { chunkFile } from "../chunker/factory.js";
import { uuid } from "../chunker/uuid.js";
import { isImageFile } from "../content/image.js";
import type { WorkspaceFile } from "../content/reader.js";
import type {
  Chunk,
  DescriptionProvider,
  EmbeddingProvider,
  KeywordIndex,
  VectorStore,
} from "../core/interfaces.js";
import { buildFileMetadataHeader } from "./metadata.js";
import { generateDescriptions, buildFallbackDescription } from "./description-stage.js";

/** Outcome of processing a single workspace file through the index pipeline. */
export interface WorkerResult {
  /** Canonical (normalized) file path relative to the store index. */
  normalizedPath: string;
  /** Content hash of the file at indexing time. */
  hash: string;
  /** Number of chunks produced for this file. */
  chunkCount: number;
  /** Human-readable label (relative path) shown in logs / progress. */
  fileLabel: string;
  /** Whether this file is new (not previously indexed). */
  isNew: boolean;
  /** Whether this file existed before and its content changed. */
  isModified: boolean;
  /** Whether the file hash matched the previous manifest entry. */
  isUnchanged: boolean;
  /** Whether the file is empty. */
  isEmpty: boolean;
  /** Whether the file is too small to justify chunking. */
  isTooSmall: boolean;
  /** Whether the file was removed from the index (deleted or errored). */
  isRemoved: boolean;
  /** Whether the file had at least one chunk stored. */
  hadChunks: boolean;
  /** Whether description generation failed for this file. */
  descriptionFailed?: boolean;
  /** Hash of the description config used when generating descriptions for this file. */
  descHash?: string;
}

/** Intermediate result after chunking a file but before embedding/storing. */
export interface PreparedFile {
  /** Canonical file path. */
  normalizedPath: string;
  /** Content hash at preparation time. */
  hash: string;
  /** Human-readable file label. */
  fileLabel: string;
  /** Whether the file already existed in a prior manifest. */
  isModified: boolean;
  /** If set, the file was resolved without chunking (empty, unchanged, etc.). */
  earlyResult?: WorkerResult;
  /** Chunks produced by the chunker (if any). */
  chunks?: Chunk[];
  /** Texts ready for embedding (prefixed with metadata). */
  textToEmbed?: string[];
  /** Whether description generation failed. */
  descriptionFailed?: boolean;
  /** Relative path from workspace root (used for embedding prefix). */
  relPath?: string;
  /** Assembled metadata header string for embedding context. */
  metaHeader?: string;
  /** Document prefix added to each embedded text. */
  docPrefix?: string;
  /** Whether the source file is an image. */
  isImageFile?: boolean;
  /** Hash of the description config used when generating descriptions. */
  descHash?: string;
}

/**
 * Build the list of text strings that will be sent to the embedding provider.
 * Each chunk is prefixed with the document prefix, relative path, metadata
 * header, and (if available) a description.
 *
 * @param chunks     - Chunks to build embedding texts from.
 * @param relPath    - Relative file path used as context prefix.
 * @param metaHeader - Assembled metadata header (file type, directory, etc.).
 * @param docPrefix  - Optional document-level prefix from configuration.
 * @param isImage    - Whether the source is an image (uses description only).
 * @returns An array of formatted text strings, one per chunk.
 */
export function buildTextsToEmbed(
  chunks: Chunk[],
  relPath: string,
  metaHeader: string,
  docPrefix: string,
  isImage: boolean,
): string[] {
  const textToEmbed: string[] = [];
  for (const chunk of chunks) {
    if (isImage) {
      textToEmbed.push(docPrefix + relPath + "\n\n" + chunk.description);
    } else {
      const desc = chunk.description ?? "";
      if (desc.trim().length > 0) {
        textToEmbed.push(docPrefix + relPath + "\n\n" + metaHeader + "\n\n" + desc + "\n\n" + chunk.content);
      } else {
        textToEmbed.push(docPrefix + relPath + "\n\n" + metaHeader + "\n\n" + chunk.content);
      }
    }
  }
  return textToEmbed;
}

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

interface ManifestFile {
  hash: string;
  chunkCount: number;
  indexedAt?: number;
  descHash?: string;
}

/**
 * Prepare a single workspace file for indexing: chunk the content, build
 * metadata, generate descriptions (inline or deferred), and assemble the
 * texts that will later be embedded.
 *
 * @param file                - Workspace file descriptor with content.
 * @param cwd                 - Workspace root directory.
 * @param previous            - Previous manifest entry for this file, if any.
 * @param config              - Indexing configuration (embedding prefix, chunking options).
 * @param keywordIndex        - Optional keyword index to populate during preparation.
 * @param descriptionProvider - Optional provider for AI-generated chunk descriptions.
 * @param logger              - Logger for diagnostic messages.
 * @param deferDescriptions   - When true, skip description generation and build
 *                              fallback descriptions instead; descriptions are
 *                              expected to be generated in a later global pass.
 * @param descHash            - Hash of the current description config. When the file
 *                              is unchanged and `previous.descHash === descHash`,
 *                              descriptions are skipped entirely (they already exist
 *                              in the vector store from a prior run).
 * @returns A prepared file descriptor ready for embedding and storage.
 */
export async function prepareFile(
  file: WorkspaceFile,
  cwd: string,
  previous: ManifestFile | undefined,
  config: {
    embedding: { documentPrefix?: string };
    chunking?: { nodeTypes?: Record<string, string[]> };
    description?: { maxContentChars?: number };
    indexing?: { maxSvgSizeBytes?: number };
  },
  keywordIndex: KeywordIndex | undefined,
  descriptionProvider: DescriptionProvider | undefined,
  logger: Logger,
  deferDescriptions?: boolean,
  descHash?: string,
): Promise<PreparedFile> {
  const fileLabel = path.relative(cwd, file.filePath).replace(/\\/g, "/");

  if (file.isEmpty) {
    return {
      normalizedPath: file.normalizedPath, hash: file.hash, fileLabel,
      isModified: false,
      earlyResult: {
        normalizedPath: file.normalizedPath, hash: file.hash, chunkCount: 0, fileLabel,
        isNew: false, isModified: false, isUnchanged: false, isEmpty: true, isTooSmall: false, isRemoved: !!previous, hadChunks: false,
      },
    };
  }

  if (file.isTooSmall) {
    return {
      normalizedPath: file.normalizedPath, hash: file.hash, fileLabel,
      isModified: false,
      earlyResult: {
        normalizedPath: file.normalizedPath, hash: file.hash, chunkCount: 0, fileLabel,
        isNew: false, isModified: false, isUnchanged: false, isEmpty: false, isTooSmall: true, isRemoved: !!previous, hadChunks: false,
      },
    };
  }

  if (previous && previous.hash === file.hash) {
    if (!descHash || previous.descHash === descHash) {
      return {
        normalizedPath: file.normalizedPath, hash: file.hash, fileLabel,
        isModified: false,
        earlyResult: {
          normalizedPath: file.normalizedPath, hash: file.hash, chunkCount: 0, fileLabel,
          isNew: false, isModified: false, isUnchanged: true, isEmpty: false, isTooSmall: false, isRemoved: false, hadChunks: false,
        },
      };
    }
    // File content is unchanged but description config changed — fall through to re-describe
    logger.debug(`  ${fileLabel} (unchanged but descHash differs — re-describing)`);
  }

  const isModified = !!previous;

  let chunks: Chunk[] | null;

  if (isImageFile(file.filePath) && file.content.trim().length > 0) {
    const imgExt = path.extname(file.filePath).toLowerCase();
    const imgRelPath = path.relative(cwd, file.filePath).replace(/\\/g, "/");
    const metaHeader = `[image] [${imgExt.slice(1)}] [${imgRelPath}]`;
    chunks = [{
      id: uuid(),
      content: metaHeader + " " + file.content,
      metadata: {
        filePath: file.filePath, startLine: 1, endLine: 1,
        language: "image", contentType: "image",
      },
    }];
  } else {
    chunks = await chunkFile(file.filePath, file.content, config.chunking?.nodeTypes, {
      maxSvgSizeBytes: config.indexing?.maxSvgSizeBytes,
    }).catch((err) => {
      logger.warn(`  ${fileLabel} (chunking failed: ${(err as Error).message})`);
      return null;
    });
  }

  if (chunks === null || chunks.length === 0) {
    if (chunks === null && previous) {
      return {
        normalizedPath: file.normalizedPath, hash: file.hash, fileLabel,
        isModified: false,
        earlyResult: {
          normalizedPath: file.normalizedPath, hash: file.hash, chunkCount: previous.chunkCount, fileLabel,
          isNew: false, isModified: false, isUnchanged: true, isEmpty: false, isTooSmall: false, isRemoved: false, hadChunks: true,
        },
      };
    }
    // No chunks from non-empty content: file may genuinely be chunk-less.
    // BUT if the content is empty and the file is unchanged (hash matches),
    // this is the re-describe fast-path edge — keep the old index entry
    // instead of deleting it (a delete would wipe previously-indexed chunks
    // just because we lacked content to re-chunk).
    if (previous && previous.hash === file.hash && file.content.trim().length === 0) {
      return {
        normalizedPath: file.normalizedPath, hash: file.hash, fileLabel,
        isModified: false,
        earlyResult: {
          normalizedPath: file.normalizedPath, hash: file.hash, chunkCount: previous.chunkCount, fileLabel,
          isNew: false, isModified: false, isUnchanged: true, isEmpty: false, isTooSmall: false, isRemoved: false, hadChunks: previous.chunkCount > 0,
        },
      };
    }
    return {
      normalizedPath: file.normalizedPath, hash: file.hash, fileLabel,
      isModified: false,
      earlyResult: {
        normalizedPath: file.normalizedPath, hash: file.hash, chunkCount: 0, fileLabel,
        isNew: false, isModified: false, isUnchanged: false, isEmpty: false, isTooSmall: false, isRemoved: true, hadChunks: false,
      },
    };
  }

  logger.debug(`  ${fileLabel}: ${chunks.length} chunks produced`);
  // Remove stale keyword entries for a previously-indexed revision of this
  // file (new UUIDs are generated for every chunk) so hybrid search never
  // surfaces old content and the persisted index stops growing unboundedly.
  if (previous) {
    keywordIndex?.removeByFilePath(file.normalizedPath);
  }
  keywordIndex?.addChunks(chunks);

  const docPrefix = config.embedding.documentPrefix ?? "";
  const relPath = path.relative(cwd, file.filePath).replace(/\\/g, "/");
  const isImage = isImageFile(file.filePath);
  const metaHeader = isImage ? "" : buildFileMetadataHeader(file.filePath, cwd, file.content);

  if (deferDescriptions) {
    for (const chunk of chunks) {
      if (isImage) {
        chunk.description = chunk.content;
      } else {
        chunk.description = buildFallbackDescription(chunk);
      }
    }
    return {
      normalizedPath: file.normalizedPath,
      hash: file.hash,
      fileLabel,
      isModified,
      chunks,
      relPath,
      metaHeader,
      docPrefix,
      isImageFile: isImage,
      descHash,
    };
  }

  let descriptionFailed = false;

  if (descriptionProvider) {
    const { descriptionMap, failures } = await generateDescriptions(chunks, descriptionProvider, logger, config.description?.maxContentChars);
    descriptionFailed = failures.length > 0;
    for (const chunk of chunks) {
      const batchDesc = descriptionMap.get(chunk.id);
      if (batchDesc && batchDesc.trim().length > 0) {
        chunk.description = batchDesc;
      } else if (!chunk.description) {
        chunk.description = buildFallbackDescription(chunk);
      }
    }
  } else {
    for (const chunk of chunks) {
      if (isImage) {
        chunk.description = chunk.content;
      } else {
        chunk.description = buildFallbackDescription(chunk);
      }
    }
  }

  const textToEmbed = buildTextsToEmbed(chunks, relPath, metaHeader, docPrefix, isImage);
  logger.debug(`  ${fileLabel}: textToEmbed ${textToEmbed.length} entries (descProvider: ${descriptionProvider ? "yes" : "no"})`);

  return {
    normalizedPath: file.normalizedPath,
    hash: file.hash,
    fileLabel,
    isModified,
    chunks,
    textToEmbed,
    descriptionFailed,
    descHash,
  };
}

/**
 * Store the chunks of a prepared file into the vector store, attaching their
 * computed embeddings.
 *
 * @param prep       - Prepared file descriptor (must have `chunks` and `textToEmbed`).
 * @param embeddings - Array of embedding vectors, one per chunk.
 * @param store      - Vector store to persist the chunks into.
 * @param logger     - Optional logger for diagnostic messages.
 * @returns A worker result summarizing what happened.
 */
export async function storeFileChunks(
  prep: PreparedFile,
  embeddings: number[][],
  store: VectorStore,
  _logger?: Logger,
): Promise<WorkerResult> {
  if (prep.earlyResult) return prep.earlyResult;
  if (!prep.chunks || !prep.textToEmbed) {
    return {
      normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0, fileLabel: prep.fileLabel,
      isNew: false, isModified: false, isUnchanged: false, isEmpty: false, isTooSmall: false, isRemoved: true, hadChunks: false,
    };
  }

  for (let i = 0; i < prep.chunks.length; i++) {
    const emb = embeddings[i];
    if (Array.isArray(emb) && emb.length > 0 && typeof emb[0] === "number") {
      prep.chunks[i]!.embedding = emb as number[];
    } else {
      prep.chunks[i]!.embedding = undefined;
    }
  }

  const validChunks = prep.chunks.filter((c) => c.embedding && c.embedding.length > 0);
  if (validChunks.length > 0) {
    await store.addChunks(validChunks);
  }

  return {
    normalizedPath: prep.normalizedPath,
    hash: prep.hash,
    chunkCount: prep.chunks.length,
    fileLabel: prep.fileLabel,
    isNew: !prep.isModified,
    isModified: prep.isModified,
    isUnchanged: false,
    isEmpty: false,
    isTooSmall: false,
    isRemoved: false,
    hadChunks: prep.chunks.length > 0,
    descriptionFailed: prep.descriptionFailed,
    descHash: prep.descHash,
  };
}

/**
 * Full end-to-end processing of a single file: prepare (chunk + describe),
 * embed, and store into the vector store. Handles deletions for modified
 * files before re-indexing.
 *
 * @param file                - Workspace file to process.
 * @param cwd                 - Workspace root directory.
 * @param previous            - Previous manifest entry, if any.
 * @param config              - Indexing configuration.
 * @param store               - Vector store to persist chunks into.
 * @param keywordIndex        - Optional keyword index to update.
 * @param embedder            - Embedding provider for vector generation.
 * @param descriptionProvider - Optional description provider for AI summaries.
 * @param logger              - Logger for diagnostic messages.
 * @returns A worker result describing the outcome.
 */
export async function processFile(
  file: WorkspaceFile,
  cwd: string,
  previous: ManifestFile | undefined,
  config: {
    embedding: { documentPrefix?: string };
    indexing: { embedBatchSize: number; embedConcurrency?: number; maxSvgSizeBytes?: number };
    chunking?: { nodeTypes?: Record<string, string[]> };
    description?: { maxContentChars?: number };
  },
  store: VectorStore,
  keywordIndex: KeywordIndex | undefined,
  embedder: EmbeddingProvider,
  descriptionProvider: DescriptionProvider | undefined,
  logger: Logger,
  descHash?: string,
): Promise<WorkerResult> {
  const prep = await prepareFile(file, cwd, previous, config, keywordIndex, descriptionProvider, logger, false, descHash);

  if (prep.earlyResult) {
    if ((prep.earlyResult.isEmpty || prep.earlyResult.isTooSmall) && prep.earlyResult.isRemoved) {
      await store.deleteByFilePath(prep.normalizedPath);
      keywordIndex?.removeByFilePath(prep.normalizedPath);
    }
    return prep.earlyResult;
  }

  if (!prep.textToEmbed || prep.textToEmbed.length === 0) {
    return {
      normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0, fileLabel: prep.fileLabel,
      isNew: false, isModified: false, isUnchanged: true, isEmpty: false, isTooSmall: false, isRemoved: false, hadChunks: false,
      descriptionFailed: prep.descriptionFailed,
    };
  }

  try {
    const { embedBatch } = await import("../embedder/factory.js");
    const embeddings = await embedBatch(embedder, prep.textToEmbed, config.indexing.embedBatchSize, "document", config.indexing.embedConcurrency ?? 1);
    const result = await storeFileChunks(prep, embeddings, store);
    return result;
  } catch (err) {
    logger.warn(`  ${prep.fileLabel} (embed/store failed: ${(err as Error).message})`);
    return {
      normalizedPath: prep.normalizedPath, hash: prep.hash, chunkCount: 0, fileLabel: prep.fileLabel,
      isNew: false, isModified: false, isUnchanged: false, isEmpty: false, isTooSmall: false, isRemoved: true, hadChunks: false,
      descriptionFailed: prep.descriptionFailed,
    };
  }
}

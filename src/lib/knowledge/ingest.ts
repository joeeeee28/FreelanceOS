/**
 * Knowledge ingestion.
 *
 * Takes a public resource and records what it was about. The deliberate
 * omission is the resource itself: there is no column for full content, and
 * adding one would be the wrong fix for any search shortcoming. A capped
 * attributed excerpt plus a link is what we keep.
 *
 * Runs additively, like the rest of the engine. Re-ingesting a URL updates its
 * classification rather than creating a second row, and never resurrects
 * something a person archived.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import { canonicalUrl } from "@/lib/discovery/canonical";
import { db } from "@/lib/db-client";
import { stripTags } from "@/lib/discovery/extract";
import {
  buildExcerpt,
  buildSummary,
  classifySourceType,
  classifyTopics,
  sanitiseText,
  scoreRelevance,
  servicesForTopics,
  type TopicMatch,
} from "./classify";

export interface KnowledgeInput {
  url: string;
  title?: string | null;
  /** Raw page text or HTML. Never stored as-is. */
  content?: string | null;
  sourceName?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  language?: string | null;
}

export interface IngestKnowledgeOptions {
  workspaceId: string;
  input: KnowledgeInput;
  now?: Date;
  client?: PrismaClient | Prisma.TransactionClient;
}

export type KnowledgeOutcome =
  | {
      kind: "CREATED" | "UPDATED";
      resourceId: string;
      topics: TopicMatch[];
      services: string[];
      relevanceScore: number;
    }
  | { kind: "SKIPPED"; reason: string };

/** Titles are metadata; a very long one is almost certainly page junk. */
const MAX_TITLE_CHARS = 300;

/**
 * Ingests one resource.
 *
 * Returns SKIPPED rather than throwing, so a batch is never derailed by one
 * malformed item.
 */
export async function ingestKnowledgeResource(
  options: IngestKnowledgeOptions,
): Promise<KnowledgeOutcome> {
  const { workspaceId, input } = options;
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  const canonical = canonicalUrl(input.url);
  if (canonical === null) {
    // Rejects mailto:, javascript:, data: and anything unparseable.
    return { kind: "SKIPPED", reason: "Unusable URL" };
  }

  // Crawled HTML is untrusted. Strip markup before it is read or stored.
  const text = input.content == null ? "" : sanitiseText(stripTags(input.content));
  const title = sanitiseText(input.title ?? "").slice(0, MAX_TITLE_CHARS);

  if (title === "" && text === "") {
    return { kind: "SKIPPED", reason: "Nothing to classify" };
  }

  // The title is weighted by being included in the text the classifier reads;
  // a term in the title is a much stronger indicator than one in the body.
  const topics = classifyTopics(`${title}. ${title}. ${text}`);
  const services = servicesForTopics(topics);

  const relevance = scoreRelevance({
    topics,
    services,
    publishedAt: input.publishedAt ?? null,
    now,
  });

  const existing = await client.knowledgeResource.findUnique({
    where: { workspaceId_canonicalUrl: { workspaceId, canonicalUrl: canonical } },
  });

  if (existing !== null && existing.archivedAt !== null) {
    // Someone archived this. Re-ingesting must not bring it back.
    return { kind: "SKIPPED", reason: "Resource is archived" };
  }

  const data = {
    title: title === "" ? canonical : title,
    url: input.url,
    sourceName: input.sourceName ?? null,
    sourceType: classifySourceType(input.url, title),
    author: input.author ?? null,
    publishedAt: input.publishedAt ?? null,
    summary: buildSummary(text),
    excerpt: buildExcerpt(text),
    language: input.language ?? null,
    entities: [] as Prisma.InputJsonValue,
    tags: topics.map((topic) => topic.slug) as Prisma.InputJsonValue,
    serviceRelevance: services as Prisma.InputJsonValue,
    relevanceScore: relevance.score,
    rationale: relevance.rationale as unknown as Prisma.InputJsonValue,
  };

  const resource =
    existing === null
      ? await client.knowledgeResource.create({
          data: { workspaceId, canonicalUrl: canonical, discoveredAt: now, ...data },
        })
      : await client.knowledgeResource.update({
          // discoveredAt is not touched: when we first saw it is history.
          where: { id: existing.id },
          data,
        });

  await linkTopics({ client, workspaceId, resourceId: resource.id, topics });

  return {
    kind: existing === null ? "CREATED" : "UPDATED",
    resourceId: resource.id,
    topics,
    services,
    relevanceScore: relevance.score,
  };
}

/** Creates any missing topics and attaches them to the resource. */
async function linkTopics(args: {
  client: PrismaClient | Prisma.TransactionClient;
  workspaceId: string;
  resourceId: string;
  topics: readonly TopicMatch[];
}): Promise<void> {
  const { client, workspaceId, resourceId, topics } = args;

  for (const topic of topics) {
    const record = await client.knowledgeTopic.upsert({
      where: { workspaceId_slug: { workspaceId, slug: topic.slug } },
      create: {
        workspaceId,
        slug: topic.slug,
        name: topic.slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      },
      update: {},
    });

    await client.knowledgeResourceTopic.upsert({
      where: {
        resourceId_topicId: { resourceId, topicId: record.id },
      },
      create: { resourceId, topicId: record.id, confidence: topic.confidence },
      update: { confidence: topic.confidence },
    });
  }

  // Topic links that no longer apply are removed, because a stale tag is a
  // wrong answer in search. The resource and the topic both survive; only the
  // association goes. This is not business data — it is derived metadata that
  // is recomputed on every ingest.
  const slugs = topics.map((topic) => topic.slug);
  await client.knowledgeResourceTopic.deleteMany({
    where: {
      resourceId,
      topic: slugs.length === 0 ? undefined : { slug: { notIn: slugs } },
    },
  });
}

export interface SearchOptions {
  workspaceId: string;
  query?: string;
  topicSlug?: string;
  serviceKey?: string;
  limit?: number;
}

/**
 * Searches the knowledge hub.
 *
 * Case-insensitive matching over title and our own summary — never over stored
 * full text, because there is none.
 */
export async function searchKnowledge(options: SearchOptions) {
  const { workspaceId } = options;
  const limit = Math.min(options.limit ?? 50, 200);

  const where: Prisma.KnowledgeResourceWhereInput = {
    workspaceId,
    archivedAt: null,
  };

  const query = options.query?.trim();
  if (query !== undefined && query !== "") {
    where.OR = [
      { title: { contains: query, mode: "insensitive" } },
      { summary: { contains: query, mode: "insensitive" } },
      { sourceName: { contains: query, mode: "insensitive" } },
    ];
  }

  if (options.topicSlug !== undefined) {
    where.topics = { some: { topic: { slug: options.topicSlug } } };
  }

  return db.knowledgeResource.findMany({
    where,
    include: { topics: { include: { topic: true } } },
    orderBy: [{ relevanceScore: "desc" }, { discoveredAt: "desc" }],
    take: limit,
  });
}

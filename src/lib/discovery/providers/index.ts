import { ProviderRegistry, type DiscoveryProvider } from "../provider";

import { websiteProvider } from "./website";
import { sitemapProvider } from "./sitemap";
import { feedProvider } from "./feed";
import { jobsProvider } from "./jobs";
import { manualCsvProvider } from "./manual-csv";
import {
  directoryProvider,
  publicMediaProvider,
  repositoryProvider,
} from "./directory";

/**
 * The providers that ship with FreelanceOS.
 *
 * Adding a source of businesses means writing one module and adding it to this
 * list. Nothing else in the pipeline knows which providers exist, so the engine
 * is never coupled to a particular scraper.
 *
 * Every provider here works without a paid API, an account or a proxy.
 */
export const BUILT_IN_PROVIDERS: readonly DiscoveryProvider[] = [
  websiteProvider,
  sitemapProvider,
  feedProvider,
  jobsProvider,
  directoryProvider,
  repositoryProvider,
  publicMediaProvider,
  manualCsvProvider,
];

/**
 * Builds a registry.
 *
 * A factory rather than a shared singleton so tests can register fakes without
 * leaking state between files.
 */
export function createProviderRegistry(
  providers: readonly DiscoveryProvider[] = BUILT_IN_PROVIDERS,
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

/** The default registry for application code. */
export const providerRegistry = createProviderRegistry();

export {
  websiteProvider,
  sitemapProvider,
  feedProvider,
  jobsProvider,
  directoryProvider,
  repositoryProvider,
  publicMediaProvider,
  manualCsvProvider,
};

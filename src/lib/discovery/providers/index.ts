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
import { placesProvider } from "./places";

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

/**
 * The registry the worker uses.
 *
 * `public-places` is registered here rather than in `BUILT_IN_PROVIDERS`
 * because it refuses caller-supplied URLs. The built-in list is the set of
 * providers that read whatever URL a source was configured with.
 */
export const providerRegistry = createProviderRegistry([
  ...BUILT_IN_PROVIDERS,
  placesProvider,
]);

export {
  websiteProvider,
  sitemapProvider,
  feedProvider,
  jobsProvider,
  directoryProvider,
  repositoryProvider,
  publicMediaProvider,
  manualCsvProvider,
  placesProvider,
};

import type {
  DiscoveryContext,
  DiscoveryProvider,
  DiscoveryResult,
} from "../provider";
import { emptyResult } from "../provider";
import { canonicalDomain } from "../canonical";
import { isObservableField, type DiscoveredEntity, type ObservedFact } from "../ingest";

/**
 * Manual / CSV provider.
 *
 * The zero-cost guarantee's backstop: whatever the network situation, a user
 * can always paste or upload a list and have it flow through exactly the same
 * normalisation, validation, resolution and provenance path as crawled data.
 *
 * Because a human typed or curated this, facts are recorded as MANUAL, which
 * gives them the highest confidence and makes them immune to being overwritten
 * by any crawler.
 */

/** Header names accepted for each field, lowercased. */
const HEADER_ALIASES: Record<string, string> = {
  name: "name",
  company: "name",
  "company name": "name",
  business: "name",
  website: "website",
  url: "website",
  site: "website",
  domain: "website",
  email: "email",
  "e-mail": "email",
  phone: "phone",
  telephone: "phone",
  mobile: "phone",
  country: "country",
  region: "region",
  state: "region",
  city: "city",
  town: "city",
  industry: "industry",
  sector: "industry",
  size: "companySize",
  "company size": "companySize",
  description: "description",
  notes: "description",
  linkedin: "linkedinUrl",
  instagram: "instagramUrl",
  facebook: "facebookUrl",
  youtube: "youtubeUrl",
};

export const MAX_CSV_ROWS = 5000;

/**
 * Parses CSV text into rows.
 *
 * Handles quoted fields, escaped quotes and embedded newlines, because real
 * exported CSV contains all three and a naive split would corrupt the data
 * silently.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Normalise line endings so CRLF files parse identically.
  const input = text.replace(/\r\n?/g, "\n");

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Flush the final field/row unless the file ended with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Maps a header row to field names, ignoring columns we do not understand. */
export function mapHeaders(header: string[]): (string | null)[] {
  return header.map((raw) => {
    const key = raw.trim().toLowerCase();
    return HEADER_ALIASES[key] ?? null;
  });
}

export interface ManualCsvConfig {
  /** Raw CSV text, including a header row. */
  csv?: string;
}

export const manualCsvProvider: DiscoveryProvider = {
  key: "manual-csv",
  label: "Manual / CSV import",
  category: "MANUAL",
  // The whole point: works with no network at all.
  requiresNetwork: false,
  description:
    "Imports a curated list. Values are recorded as manual entries, so automated discovery can never overwrite them.",

  async run(context: DiscoveryContext): Promise<DiscoveryResult> {
    const config = context.config as ManualCsvConfig;
    const result = emptyResult();

    if (typeof config.csv !== "string" || config.csv.trim() === "") {
      result.warnings.push("No CSV content supplied");
      return result;
    }

    const rows = parseCsv(config.csv);

    if (rows.length < 2) {
      result.warnings.push("CSV has no data rows");
      return result;
    }

    const fields = mapHeaders(rows[0]);

    if (!fields.includes("name") && !fields.includes("website")) {
      result.warnings.push(
        "CSV must contain a company name or website column",
      );
      return result;
    }

    const dataRows = rows.slice(1, MAX_CSV_ROWS + 1);

    if (rows.length - 1 > MAX_CSV_ROWS) {
      result.warnings.push(
        `Only the first ${MAX_CSV_ROWS} rows were imported`,
      );
    }

    for (const [index, row] of dataRows.entries()) {
      const values: Record<string, string> = {};

      for (const [column, field] of fields.entries()) {
        if (field === null) continue;
        const value = (row[column] ?? "").trim();
        if (value !== "") values[field] = value;
      }

      const name = values.name ?? null;
      const website = values.website ?? null;

      if (name === null && website === null) {
        result.warnings.push(`Row ${index + 2}: no name or website, skipped`);
        continue;
      }

      const facts: ObservedFact[] = [];

      for (const [field, value] of Object.entries(values)) {
        if (!isObservableField(field)) continue;
        facts.push({
          field,
          value,
          // A human curated this list, so it outranks anything a crawler finds.
          method: "MANUAL",
          locator: `csv:row-${index + 2}`,
          evidence: `Imported from CSV row ${index + 2}`,
          observedAt: context.now,
        });
      }

      const entity: DiscoveredEntity = {
        identity: {
          name,
          website,
          domain: canonicalDomain(website),
          email: values.email ?? null,
          phone: values.phone ?? null,
          country: values.country ?? null,
          city: values.city ?? null,
        },
        facts,
        sourceId: context.sourceId,
      };

      result.entities.push(entity);
    }

    return result;
  },
};

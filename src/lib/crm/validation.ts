import { z } from "zod";

const text = (length = 5000) =>
  z.string().trim().max(length);

const optionalText = (length = 5000) =>
  text(length).optional();

const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address.")
  .optional();

const URL_MESSAGE =
  "Enter a valid URL beginning with http:// or https://";

/**
 * A single check (rather than `.url().refine(...)`) so exactly one message is
 * reported per field. `z.string().url()` alone would accept schemes such as
 * `javascript:`, so the protocol is restricted explicitly.
 */
const optionalUrl = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    let parsed: URL;

    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: URL_MESSAGE });
      return;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: URL_MESSAGE });
    }
  })
  .optional();

/**
 * Lead fields a client is allowed to supply.
 *
 * Deliberately absent:
 *  - `score`        computed server-side by src/lib/crm/scoring.ts
 *  - `status`       changed only through validated pipeline transitions
 *  - `workspaceId`  always derived from requireUser()
 *  - timestamps     managed by Prisma
 *
 * `.strict()` makes a submission containing any of those a validation error
 * rather than silently ignoring it.
 */
/**
 * Update/qualification forms must be able to *clear* a field, so they accept
 * null (meaning "set to NULL") in addition to a value. `undefined` continues
 * to mean "leave unchanged".
 */
const nullableText = (length = 5000) => text(length).nullish();
const nullableEmail = optionalEmail.unwrap().nullish();
const nullableUrl = optionalUrl.unwrap().nullish();

export const leadSchema = z.object({
  companyName: text(200).min(1, "Company name is required."),
  contactName: optionalText(200),

  source: optionalText(100),
  website: optionalUrl,
  email: optionalEmail,
  phone: optionalText(50),

  country: optionalText(100),
  city: optionalText(100),
  industry: optionalText(150),
  companySize: optionalText(100),

  linkedinUrl: optionalUrl,
  instagramUrl: optionalUrl,
  facebookUrl: optionalUrl,

  websitePresent: z.boolean().nullable().optional(),
  websiteQuality: optionalText(100),

  advertisingActivity: optionalText(),
  contentActivity: optionalText(),

  serviceInterest: optionalText(300),
  painPoint: optionalText(),

  decisionMakerIdentified: z.boolean().default(false),
  qualificationNotes: optionalText(),
}).strict();

/**
 * Partial form used by edit; same exclusions as `leadSchema` (no score, no
 * status, no workspaceId) but nullable so fields can be cleared.
 */
export const leadUpdateSchema = z
  .object({
    companyName: text(200).min(1, "Company name is required.").optional(),
    contactName: nullableText(200),
    source: nullableText(100),
    website: nullableUrl,
    email: nullableEmail,
    phone: nullableText(50),
    country: nullableText(100),
    city: nullableText(100),
    industry: nullableText(150),
    companySize: nullableText(100),
    linkedinUrl: nullableUrl,
    instagramUrl: nullableUrl,
    facebookUrl: nullableUrl,
    websitePresent: z.boolean().nullable().optional(),
    websiteQuality: nullableText(100),
    advertisingActivity: nullableText(),
    contentActivity: nullableText(),
    serviceInterest: nullableText(300),
    painPoint: nullableText(),
    decisionMakerIdentified: z.boolean().optional(),
    qualificationNotes: nullableText(),
  })
  .strict();

/**
 * Qualification-only input. Separated so the qualification form cannot alter
 * unrelated commercial fields.
 */
export const qualificationSchema = z
  .object({
    // Omitted keys mean "unchanged"; the qualification form always submits
    // this one (a cleared checkbox posts `false`), but partial updates from
    // other call sites stay valid.
    decisionMakerIdentified: z.boolean().optional(),
    websitePresent: z.boolean().nullable().optional(),
    websiteQuality: nullableText(100),
    advertisingActivity: nullableText(),
    contentActivity: nullableText(),
    serviceInterest: nullableText(300),
    painPoint: nullableText(),
    qualificationNotes: nullableText(),
  })
  .strict();

/** A manually written timeline note. */
export const noteSchema = z
  .object({
    body: text(5000).min(1, "Write a note before saving."),
  })
  .strict();

export const contactSchema = z.object({
  leadId: z.string().min(1),

  firstName: optionalText(100),
  lastName: optionalText(100),
  fullName: text(200).min(1),

  jobTitle: optionalText(150),
  email: optionalEmail,
  phone: optionalText(50),
  linkedinUrl: optionalUrl,

  isDecisionMaker: z.boolean().default(false),
  isPrimary: z.boolean().default(false),

  notes: optionalText(),
}).strict();

/** Editing a contact cannot move it to a different lead or workspace. */
export const contactUpdateSchema = z
  .object({
    firstName: nullableText(100),
    lastName: nullableText(100),
    fullName: text(200).min(1, "Name is required.").optional(),
    jobTitle: nullableText(150),
    email: nullableEmail,
    phone: nullableText(50),
    linkedinUrl: nullableUrl,
    isDecisionMaker: z.boolean().optional(),
    isPrimary: z.boolean().optional(),
    notes: nullableText(),
  })
  .strict();

export const taskSchema = z.object({
  title: text(300).min(1),
  description: optionalText(),

  status: z
    .enum(["TODO", "IN_PROGRESS", "DONE", "CANCELLED"])
    .default("TODO"),

  priority: z
    .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
    .default("MEDIUM"),

  dueAt: z.coerce.date().nullable().optional(),
  leadId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
}).strict();

export const taskUpdateSchema = taskSchema.partial().strict();

export const followUpSchema = z.object({
  leadId: z.string().min(1),
  contactId: z.string().nullable().optional(),

  channel: z.enum([
    "EMAIL",
    "LINKEDIN",
    "INSTAGRAM",
    "FACEBOOK",
    "WHATSAPP",
    "PHONE",
    "UPWORK",
    "FIVERR",
    "CONTRA",
    "COLD_EMAIL",
    "REFERRAL",
    "OTHER",
  ]),

  sequence: z.enum([
    "INITIAL",
    "FU1",
    "FU2",
    "FU3",
    "NURTURE",
  ]),

  scheduledAt: z.coerce.date(),
  message: optionalText(10000),
}).strict();

/** Rescheduling/editing cannot move a follow-up to a different lead. */
export const followUpUpdateSchema = followUpSchema
  .omit({ leadId: true })
  .partial()
  .strict();

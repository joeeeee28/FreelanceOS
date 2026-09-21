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

export const leadSchema = z.object({
  companyName: text(200).min(1, "Company name is required."),
  contactName: optionalText(200),

  status: z.enum([
    "NEW",
    "RESEARCHING",
    "QUALIFIED",
    "OUTREACH_READY",
    "CONTACTED",
    "RESPONDED",
    "DISCOVERY_CALL",
    "PROPOSAL",
    "NEGOTIATION",
    "WON",
    "LOST",
    "NURTURE",
  ]).default("NEW"),

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

  score: z.coerce.number().int().min(0).max(100).default(0),
});

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
});

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
});

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
});

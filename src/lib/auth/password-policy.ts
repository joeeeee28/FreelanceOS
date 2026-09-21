import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(12, "Password must contain at least 12 characters.")
  .regex(/[a-z]/, "Include a lowercase letter.")
  .regex(/[A-Z]/, "Include an uppercase letter.")
  .regex(/[0-9]/, "Include a number.")
  .regex(/[^A-Za-z0-9]/, "Include a special character.");

import "server-only";
import { randomBytes } from "node:crypto";

export function randomOpaqueToken() {
  return randomBytes(32).toString("hex");
}

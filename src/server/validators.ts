import { z } from "zod";

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(32)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Letters, numbers, . _ - only");

export const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(256);

export const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");

export const avatarSchema = z.string().regex(/^[a-z0-9]+:[a-z]+$/, "Invalid avatar");

export const mediaTypeSchema = z.enum(["movie", "tv"]);

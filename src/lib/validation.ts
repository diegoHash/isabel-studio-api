import { z } from "zod";
import { DATE_RE, TIME_RE, isValidDate } from "./time";
import { SERVICES } from "./services";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g;

/** Limpia texto libre: quita caracteres de control/bidi y signos < > (defensa en profundidad contra XSS). */
export function cleanText(input: string): string {
  return input.normalize("NFC").replace(CONTROL_CHARS, "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
}

/** Normaliza celular colombiano a 10 dígitos (acepta +57, espacios, guiones). */
export function normalizePhone(input: string): string {
  let digits = input.replace(/[\s().-]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (/^57\d{10}$/.test(digits)) digits = digits.slice(2);
  return digits;
}

const dateField = z
  .string()
  .regex(DATE_RE, "Fecha inválida")
  .refine(isValidDate, "Fecha inválida");
const timeField = z.string().regex(TIME_RE, "Hora inválida");

const serviceIds = SERVICES.map((s) => s.id) as [string, ...string[]];

export const nameField = z
  .string({ error: "Escribe tu nombre" })
  .transform(cleanText)
  .pipe(
    z
      .string()
      .min(2, "Escribe tu nombre completo")
      .max(80, "El nombre es demasiado largo")
      .regex(/^\p{L}[\p{L}\p{M}'’ .-]*$/u, "El nombre solo puede tener letras y espacios"),
  );

export const phoneField = z
  .string({ error: "Escribe tu celular" })
  .transform(normalizePhone)
  .pipe(z.string().regex(/^3\d{9}$/, "Escribe un celular colombiano válido (10 dígitos)"));

const optionalEmail = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.union([z.literal(""), z.email("Correo inválido").max(120, "Correo demasiado largo")]))
  .transform((v) => (v === "" ? null : v))
  .nullish()
  .transform((v) => v ?? null);

const optionalNotes = z
  .string()
  .transform(cleanText)
  .pipe(z.string().max(300, "Máximo 300 caracteres"))
  .transform((v) => (v === "" ? null : v))
  .nullish()
  .transform((v) => v ?? null);

export const createAppointmentSchema = z.strictObject({
  serviceIds: z
    .array(z.enum(serviceIds, { error: "Servicio inválido" }), { error: "Elige al menos un servicio" })
    .min(1, "Elige al menos un servicio")
    .max(8, "Máximo 8 servicios por cita")
    .transform((ids) => [...new Set(ids)]),
  date: dateField,
  time: timeField,
  name: nameField,
  phone: phoneField,
  email: optionalEmail,
  notes: optionalNotes,
  /** Honeypot: los humanos no lo ven ni lo llenan. */
  website: z.string().max(200).optional(),
});

export const adminCreateAppointmentSchema = createAppointmentSchema.omit({ website: true });

export const loginSchema = z.strictObject({
  password: z.string().min(1).max(200),
});

export const updateStatusSchema = z.strictObject({
  status: z.enum(["pendiente", "atendida"]),
});

export const dayOverrideSchema = z.strictObject({
  open: z.boolean(),
  note: z
    .string()
    .transform(cleanText)
    .pipe(z.string().max(120))
    .transform((v) => (v === "" ? null : v))
    .nullish()
    .transform((v) => v ?? null),
});

export const slotOverrideSchema = z.strictObject({ open: z.boolean() });

export const settingsSchema = z.strictObject({
  slots: z
    .array(timeField)
    .min(1, "Agrega al menos una hora")
    .max(24)
    .transform((arr) => [...new Set(arr)].sort()),
  workDays: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .transform((arr) => [...new Set(arr)].sort()),
});

export const rangeQuerySchema = z.object({
  from: dateField,
  to: dateField,
});

export function formatZodError(err: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

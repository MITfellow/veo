/**
 * zod → JSON Schema, for the tool specs handed to the model.
 *
 * §36 says the schema is the single definition. A registry that advertises
 * `parameters: {type: 'object'}` violates that in the most expensive way:
 * the model has to guess argument names, guesses wrong, and the call fails
 * validation — so the schema exists but does no work at the one boundary
 * where it would have prevented the error.
 *
 * Written by hand rather than adding `zod-to-json-schema`, because this
 * needs to cover exactly the constructs our own tools use (§36: no
 * dependency without justification, and this one is ~100 lines). Anything
 * it does not understand degrades to `{}` — "unconstrained" — which is the
 * safe direction: the input schema still rejects a bad call at runtime.
 */
import { z } from 'zod';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  format?: string;
  minimum?: number;
  maximum?: number;
}

/** Unwrap the wrappers that do not change the shape, keeping any default. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean; default?: unknown } {
  let inner = schema;
  let optional = false;
  let dflt: { value: unknown } | undefined;

  for (;;) {
    if (inner instanceof z.ZodOptional) {
      optional = true;
      inner = inner.unwrap() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodDefault) {
      optional = true;
      dflt = { value: (inner._def.defaultValue as () => unknown)() };
      inner = inner._def.innerType as z.ZodTypeAny;
    } else if (inner instanceof z.ZodEffects) {
      inner = inner.innerType() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodBranded || inner instanceof z.ZodReadonly) {
      inner = inner.unwrap() as z.ZodTypeAny;
    } else if (inner instanceof z.ZodCatch) {
      inner = inner._def.innerType as z.ZodTypeAny;
    } else {
      break;
    }
  }
  return dflt === undefined ? { inner, optional } : { inner, optional, default: dflt.value };
}

export function jsonSchemaOf(schema: z.ZodTypeAny): JsonSchema {
  const { inner } = unwrap(schema);
  const described = inner.description;
  const out = body(inner);
  if (described !== undefined && out.description === undefined) out.description = described;
  return out;
}

function body(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: 'string' };
    for (const check of schema._def.checks) {
      if (check.kind === 'email' || check.kind === 'url' || check.kind === 'uuid') {
        out.format = check.kind;
      }
    }
    return out;
  }
  if (schema instanceof z.ZodNumber) return { type: schema.isInt ? 'integer' : 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodNull) return { type: 'null' };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...(schema.options as string[])] };
  if (schema instanceof z.ZodNativeEnum) {
    return { enum: Object.values(schema.enum as Record<string, unknown>) };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: jsonSchemaOf(schema.element as z.ZodTypeAny) };
  }
  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: jsonSchemaOf(schema.valueSchema as z.ZodTypeAny),
    };
  }
  if (schema instanceof z.ZodNullable) {
    const base = jsonSchemaOf(schema.unwrap() as z.ZodTypeAny);
    return { anyOf: [base, { type: 'null' }] };
  }
  if (schema instanceof z.ZodUnion) {
    return {
      anyOf: (schema.options as z.ZodTypeAny[]).map((option) => jsonSchemaOf(option)),
    };
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return {
      anyOf: [...(schema.options as z.ZodTypeAny[])].map((option) => jsonSchemaOf(option)),
    };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const { optional, default: dflt } = unwrap(value);
      const property = jsonSchemaOf(value);
      if (dflt !== undefined) property.default = dflt;
      properties[key] = property;
      // A field with a default is NOT required of the model — that is the
      // entire point of the default.
      if (!optional && !value.isOptional()) required.push(key);
    }

    const out: JsonSchema = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    // Unknown keys are a typo the model should see rejected, not ignored.
    out.additionalProperties = false;
    return out;
  }

  // Unrecognised: unconstrained here, still validated at the real boundary.
  return {};
}

import fs from "node:fs";
import path from "node:path";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = valueType(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

function decodePointerPart(value) {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(document, pointer, label) {
  if (pointer === "" || pointer === "#") return document;
  if (!pointer.startsWith("#/")) {
    throw new Error(`${label} 使用了不支持的 JSON Pointer：${pointer}`);
  }
  return pointer.slice(2).split("/").reduce((current, encoded) => {
    const key = decodePointerPart(encoded);
    if (!current || !Object.prototype.hasOwnProperty.call(current, key)) {
      throw new Error(`${label} 引用了不存在的位置：${pointer}`);
    }
    return current[key];
  }, document);
}

function loadSchema(schemaPath, cache) {
  const absolute = path.resolve(schemaPath);
  if (!cache.has(absolute)) {
    cache.set(absolute, JSON.parse(fs.readFileSync(absolute, "utf8")));
  }
  return {path: absolute, document: cache.get(absolute)};
}

function resolveReference(reference, currentSchemaPath, currentSchema, cache) {
  if (reference.startsWith("#")) {
    return {
      schema: resolvePointer(currentSchema, reference, currentSchemaPath),
      schemaPath: currentSchemaPath,
      rootSchema: currentSchema,
    };
  }
  const hashIndex = reference.indexOf("#");
  const filePart = hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
  const pointer = hashIndex >= 0 ? reference.slice(hashIndex) : "#";
  if (
    !filePart
    || path.isAbsolute(filePart)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(filePart)
    || filePart.includes("\\")
  ) {
    throw new Error(`${currentSchemaPath} 使用了不允许的外部 schema 引用：${reference}`);
  }
  const target = path.resolve(path.dirname(currentSchemaPath), ...filePart.split("/"));
  const relative = path.relative(path.dirname(currentSchemaPath), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${currentSchemaPath} 的 schema 引用越过了合同目录：${reference}`);
  }
  const loaded = loadSchema(target, cache);
  return {
    schema: resolvePointer(loaded.document, pointer, target),
    schemaPath: target,
    rootSchema: loaded.document,
  };
}

function validateFormat(value, format) {
  if (format === "date-time") {
    return typeof value === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
      && !Number.isNaN(Date.parse(value));
  }
  return true;
}

function validateNode(
  value,
  schema,
  schemaPath,
  rootSchema,
  cache,
  location,
  errors,
) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${location} 不允许出现`);
    return;
  }
  if (schema.$ref) {
    const resolved = resolveReference(schema.$ref, schemaPath, rootSchema, cache);
    validateNode(
      value,
      resolved.schema,
      resolved.schemaPath,
      resolved.rootSchema,
      cache,
      location,
      errors,
    );
    return;
  }
  if (schema.if) {
    const conditionErrors = [];
    validateNode(
      value,
      schema.if,
      schemaPath,
      rootSchema,
      cache,
      location,
      conditionErrors,
    );
    const branch = conditionErrors.length === 0 ? schema.then : schema.else;
    if (branch) {
      validateNode(
        value,
        branch,
        schemaPath,
        rootSchema,
        cache,
        location,
        errors,
      );
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf) {
      validateNode(value, part, schemaPath, rootSchema, cache, location, errors);
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const candidates = schema.oneOf.map((candidate) => {
      const candidateErrors = [];
      validateNode(
        value,
        candidate,
        schemaPath,
        rootSchema,
        cache,
        location,
        candidateErrors,
      );
      return candidateErrors;
    });
    if (candidates.filter((candidate) => candidate.length === 0).length !== 1) {
      errors.push(`${location} 必须且只能符合 oneOf 的一个分支`);
      return;
    }
  }

  const expected = schema.type == null
    ? null
    : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (expected && !expected.some((item) => typeMatches(value, item))) {
    errors.push(`${location} 类型应为 ${expected.join(" / ")}，实际为 ${valueType(value)}`);
    return;
  }
  if (
    Object.prototype.hasOwnProperty.call(schema, "const")
    && canonical(value) !== canonical(schema.const)
  ) {
    errors.push(`${location} 必须等于 ${canonical(schema.const)}`);
  }
  if (
    Array.isArray(schema.enum)
    && !schema.enum.some((candidate) => canonical(candidate) === canonical(value))
  ) {
    errors.push(`${location} 不在允许值 ${schema.enum.map(canonical).join(" / ")} 中`);
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < Number(schema.minLength)) {
      errors.push(`${location} 长度不能小于 ${schema.minLength}`);
    }
    if (schema.pattern != null && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${location} 不符合格式 ${schema.pattern}`);
    }
    if (schema.format && !validateFormat(value, schema.format)) {
      errors.push(`${location} 不符合 ${schema.format} 格式`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum != null && value < Number(schema.minimum)) {
      errors.push(`${location} 不能小于 ${schema.minimum}`);
    }
    if (schema.maximum != null && value > Number(schema.maximum)) {
      errors.push(`${location} 不能大于 ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum != null && value <= Number(schema.exclusiveMinimum)) {
      errors.push(`${location} 必须大于 ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum != null && value >= Number(schema.exclusiveMaximum)) {
      errors.push(`${location} 必须小于 ${schema.exclusiveMaximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < Number(schema.minItems)) {
      errors.push(`${location} 至少需要 ${schema.minItems} 项`);
    }
    if (schema.maxItems != null && value.length > Number(schema.maxItems)) {
      errors.push(`${location} 至多允许 ${schema.maxItems} 项`);
    }
    if (schema.uniqueItems === true) {
      const encoded = value.map(canonical);
      if (new Set(encoded).size !== encoded.length) errors.push(`${location} 不能包含重复项`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(
        item,
        schema.items,
        schemaPath,
        rootSchema,
        cache,
        `${location}[${index}]`,
        errors,
      ));
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${location}.${key} 是必填字段`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        validateNode(
          item,
          properties[key],
          schemaPath,
          rootSchema,
          cache,
          `${location}.${key}`,
          errors,
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} 不是当前合同字段`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(
          item,
          schema.additionalProperties,
          schemaPath,
          rootSchema,
          cache,
          `${location}.${key}`,
          errors,
        );
      }
    }
  }
}

export function validateJsonSchema(document, schemaPath) {
  const cache = new Map();
  const loaded = loadSchema(schemaPath, cache);
  const errors = [];
  validateNode(
    document,
    loaded.document,
    loaded.path,
    loaded.document,
    cache,
    "$",
    errors,
  );
  return errors;
}

export function assertJsonSchema(document, schemaPath, label = "JSON 合同") {
  const errors = validateJsonSchema(document, schemaPath);
  if (errors.length) {
    throw new Error(`${label} 未通过 ${path.basename(schemaPath)}：\n- ${errors.join("\n- ")}`);
  }
}

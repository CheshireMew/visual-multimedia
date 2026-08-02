import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EDITABLE_MEDIA_SCHEMA_PATH = path.resolve(
  SCRIPT_DIR,
  "..",
  "schemas",
  "editable-media.v5.schema.json"
);

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = valueType(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  if (expected === "object") return actual === "object";
  return actual === expected;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function resolveReference(rootSchema, reference) {
  if (!reference.startsWith("#/")) {
    throw new Error(`editable-media v5 schema 只允许本地引用：${reference}`);
  }
  return reference.slice(2).split("/").reduce((current, encoded) => {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || !Object.prototype.hasOwnProperty.call(current, key)) {
      throw new Error(`editable-media v5 schema 引用了不存在的位置：${reference}`);
    }
    return current[key];
  }, rootSchema);
}

function validateNode(value, schema, rootSchema, location, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${location} 不允许出现`);
    return;
  }
  if (schema.$ref) {
    validateNode(value, resolveReference(rootSchema, schema.$ref), rootSchema, location, errors);
    return;
  }

  const expectedTypes = schema.type == null
    ? null
    : (Array.isArray(schema.type) ? schema.type : [schema.type]);
  if (expectedTypes && !expectedTypes.some((expected) => typeMatches(value, expected))) {
    errors.push(
      `${location} 类型应为 ${expectedTypes.join(" / ")}，实际为 ${valueType(value)}`
    );
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")
    && canonical(value) !== canonical(schema.const)) {
    errors.push(`${location} 必须等于 ${canonical(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => canonical(candidate) === canonical(value))) {
    errors.push(`${location} 不在允许值 ${schema.enum.map(canonical).join(" / ")} 中`);
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < Number(schema.minLength)) {
      errors.push(`${location} 不能为空`);
    }
    if (schema.pattern != null && !(new RegExp(schema.pattern, "u")).test(value)) {
      errors.push(`${location} 不符合格式 ${schema.pattern}`);
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
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const encoded = canonical(item);
        if (seen.has(encoded)) {
          errors.push(`${location} 不能包含重复项`);
          break;
        }
        seen.add(encoded);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => {
        validateNode(item, schema.items, rootSchema, `${location}[${index}]`, errors);
      });
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
        validateNode(item, properties[key], rootSchema, `${location}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${location}.${key} 不是 editable-media v5 字段`);
      } else if (
        schema.additionalProperties
        && typeof schema.additionalProperties === "object"
      ) {
        validateNode(
          item,
          schema.additionalProperties,
          rootSchema,
          `${location}.${key}`,
          errors
        );
      }
    }
  }
}

export function readEditableMediaSchema() {
  return JSON.parse(fs.readFileSync(EDITABLE_MEDIA_SCHEMA_PATH, "utf8"));
}

export function validateEditableMediaSchema(document) {
  const schema = readEditableMediaSchema();
  const errors = [];
  validateNode(document, schema, schema, "$", errors);
  return errors;
}

export function resolvePackageReference(packageRoot, value, label = "本地路径") {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} 必须使用 /：${value}`);
  }
  const filePart = value.split(/[?#]/, 1)[0];
  if (
    /^(?:[a-z]+:)?\/\//i.test(filePart)
    || path.posix.isAbsolute(filePart)
    || /^[A-Za-z]:/.test(filePart)
    || filePart.split("/").includes("..")
  ) {
    throw new Error(`${label} 必须位于网页包内：${value}`);
  }
  const root = path.resolve(packageRoot);
  const resolved = path.resolve(root, ...filePart.split("/"));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} 必须位于网页包内：${value}`);
  }
  return resolved;
}

export function normalizeEditableMediaTarget(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) throw new Error(`目标不存在：${absolute}`);
  const stat = fs.statSync(absolute);
  const manifestPath = stat.isDirectory()
    ? path.join(absolute, "editable-media.json")
    : absolute;
  if (path.basename(manifestPath) !== "editable-media.json") {
    throw new Error("目标必须是网页包目录或 editable-media.json");
  }
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到清单：${manifestPath}`);
  return {
    packageRoot: path.dirname(manifestPath),
    manifestPath,
  };
}

export function readEditableMediaPackage(target) {
  const normalized = normalizeEditableMediaTarget(target);
  const manifest = JSON.parse(fs.readFileSync(normalized.manifestPath, "utf8"));
  const errors = validateEditableMediaSchema(manifest);
  if (errors.length) {
    throw new Error(`editable-media v5 schema 未通过：\n- ${errors.join("\n- ")}`);
  }
  return {
    ...normalized,
    manifest,
  };
}

function assertNoLinks(root, current = root) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new Error(`网页包不能包含符号链接：${path.relative(root, target)}`);
    }
    if (entry.isDirectory()) assertNoLinks(root, target);
  }
}

export function assertEditableMediaPackageClosed(packageRoot, manifest) {
  const root = path.resolve(packageRoot);
  assertNoLinks(root);
  const references = [
    ["entry", manifest.entry],
    ["media_sources", manifest.media_sources],
    ...(manifest.resources || []).map(
      (value, index) => [`resources[${index}]`, value]
    ),
  ];
  const resolved = [];
  for (const [label, value] of references) {
    const target = resolvePackageReference(root, value, label);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`${label} 指向的包内文件不存在：${value}`);
    }
    resolved.push(target);
  }

  const mediaSourcesPath = resolvePackageReference(
    root,
    manifest.media_sources,
    "media_sources"
  );
  const mediaSources = JSON.parse(fs.readFileSync(mediaSourcesPath, "utf8"));
  for (const source of mediaSources.sources || []) {
    const label = `素材 ${source.id || "未命名"} 的 file`;
    const target = resolvePackageReference(root, source.file, label);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`${label} 指向的包内文件不存在：${source.file}`);
    }
    resolved.push(target);
  }
  return Array.from(new Set(resolved));
}

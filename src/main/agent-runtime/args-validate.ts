/**
 * args-validate.ts — 工具入参的 JSON Schema 子集校验（P0 修复）。
 *
 * 模型提供的 tool 参数只完成 JSON 解析就被执行（run-loop 原实现），
 * 恶意/异常参数（目录穿越 ID、错误类型、多余字段）可能直达文件系统。
 * 本模块在每次 execute 前做真正校验：
 * - required 字段必须存在；
 * - 已声明字段按 type / enum / pattern 校验；
 * - 未声明字段一律剔除（不传给 execute，防攻击面扩大）；
 * - 空/非对象参数按失败处理。
 *
 * 支持的子集覆盖当前全部工具 schema：object + properties + required +
 * type(string/boolean/number/integer) + enum + pattern。
 */

export type ArgsSchema = {
  type: 'object';
  properties?: Record<string, { type?: 'string' | 'boolean' | 'number' | 'integer'; enum?: unknown[]; pattern?: string }>;
  required?: string[];
};

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

function checkValue(value: unknown, prop: { type?: 'string' | 'boolean' | 'number' | 'integer'; enum?: unknown[]; pattern?: string }): boolean {
  if (value === undefined || value === null) return true;
  if (prop.type) {
    switch (prop.type) {
      case 'string':
        if (typeof value !== 'string') return false;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return false;
        break;
      case 'number':
      case 'integer':
        if (typeof value !== 'number' || (prop.type === 'integer' && !Number.isInteger(value))) return false;
        break;
    }
  }
  if (prop.enum && !prop.enum.includes(value)) return false;
  if (prop.pattern && (typeof value !== 'string' || !new RegExp(prop.pattern).test(value))) return false;
  return true;
}

/** 校验并净化工具入参；不合法返回失败原因（不抛异常）。 */
export function validateToolArgs(schema: ArgsSchema, rawArgs: unknown): ValidationResult {
  if (schema.type !== 'object') return { ok: false, message: 'schema 必须是 object 类型' };
  if (rawArgs === null || rawArgs === undefined || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, message: '参数必须是对象' };
  }
  const source = rawArgs as Record<string, unknown>;
  const props = schema.properties ?? {};
  for (const key of schema.required ?? []) {
    if (!(key in source) || source[key] === undefined || source[key] === null) {
      return { ok: false, message: `缺少必填参数: ${key}` };
    }
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!(key in props)) continue; // 未声明字段剔除
    if (value === undefined || value === null) continue;
    if (!checkValue(value, props[key])) {
      return { ok: false, message: `参数 ${key} 不合法（类型/枚举/格式不符）` };
    }
    cleaned[key] = value;
  }
  return { ok: true, args: cleaned };
}

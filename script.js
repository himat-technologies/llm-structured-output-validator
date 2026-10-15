/* ==========================================================================
   LLM Structured Output & JSON Schema Validator
   HiMat Technologies - https://himat.co.in
   --------------------------------------------------------------------------
   Vanilla JavaScript. Runs entirely in the browser.
   - No backend, no network calls with your data, no eval()/Function().
   - Uses Ajv (loaded from cdnjs) only for JSON Schema validation.

   The file is split into:
     1. Small helpers
     2. String-aware scanner utilities
     3. JSON repair engine
     4. Ajv validation + error formatting
     5. Guardrail code generators
     6. Presets
     7. UI wiring
   ========================================================================== */

(function () {
  'use strict';

  /* ============================================================
     1. Small helpers
     ============================================================ */

  // Is this value a plain object (not null, not an array)?
  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  // Try to parse text as JSON. Never throws.
  function tryParse(text) {
    try {
      return { ok: true, data: JSON.parse(text), error: null };
    } catch (e) {
      return { ok: false, data: undefined, error: e && e.message ? e.message : String(e) };
    }
  }

  // Return the previous non-whitespace character, or null.
  function lastNonSpace(text, idx) {
    for (let i = idx; i >= 0; i--) {
      if (!/\s/.test(text[i])) return text[i];
    }
    return null;
  }

  // Return the next non-whitespace character, or null.
  function nextNonSpace(text, idx) {
    for (let i = idx; i < text.length; i++) {
      if (!/\s/.test(text[i])) return text[i];
    }
    return null;
  }

  /* ============================================================
     2. String-aware scanner utilities
     These let us move through text while ignoring characters that
     are inside quoted strings, so we never "repair" text inside
     a legitimate string value.
     ============================================================ */

  // Given a string opening quote at `start`, return the index of the
  // matching closing quote (handling escaped chars), or -1.
  function findStringEnd(text, start) {
    const quote = text[start];
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) return i;
      i++;
    }
    return -1;
  }

  // Given an opening brace/bracket at `start`, return the index of the
  // matching closer (skipping strings), or -1 if unbalanced.
  function findMatchingBracket(text, start) {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const end = findStringEnd(text, i);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return -1;
  }

  // Find the first complete { ... } or [ ... ] region, skipping over
  // strings so braces inside quoted text are ignored.
  function extractJSONRegion(text) {
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const end = findStringEnd(text, i);
        if (end !== -1) { i = end + 1; continue; }
      }
      if (ch === '{' || ch === '[') {
        const end = findMatchingBracket(text, i);
        if (end !== -1) {
          return { found: true, text: text.slice(i, end + 1) };
        }
      }
      i++;
    }
    return { found: false, text: text };
  }

  /* ============================================================
     3. JSON repair engine
     Each step is conservative. If we cannot fix something safely,
     we say so instead of guessing.
     ============================================================ */

  // Step 1: remove Markdown code fences such as ```json ... ```
  function stripFences(text) {
    return text.replace(/```[ \t]*(?:json|javascript|js)?[ \t]*/gi, '');
  }

  // Step 2: remove // line comments and /* block */ comments, but only
  // when they are outside quoted strings.
  function stripComments(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const end = findStringEnd(text, i);
        if (end === -1) { out += text.slice(i); break; }
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (ch === '/' && text[i + 1] === '/') {
        let j = i + 2;
        while (j < text.length && text[j] !== '\n') j++;
        i = j;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        let j = i + 2;
        while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
        i = j < text.length ? j + 2 : text.length;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // Step 3: remove commas that appear right before a closing } or ],
  // ignoring commas inside strings.
  function removeTrailingCommas(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const end = findStringEnd(text, i);
        if (end === -1) { out += text.slice(i); break; }
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (ch === ',') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (j < text.length && (text[j] === '}' || text[j] === ']')) {
          i++; // drop the trailing comma
          continue;
        }
      }
      out += ch;
      i++;
    }
    return out;
  }

  // Build a double-quoted JSON string from the inner text of a
  // single-quoted string, escaping what JSON requires.
  function buildDoubleQuoted(inner) {
    let res = '"';
    for (let k = 0; k < inner.length; k++) {
      const c = inner[k];
      if (c === '\\') {
        const n = inner[k + 1];
        if (n === "'") { res += "'"; k++; }
        else if (n === '"') { res += '\\"'; k++; }
        else if (n === '\\') { res += '\\\\'; k++; }
        else if (n === undefined) { res += '\\\\'; }
        else { res += '\\' + n; k++; } // keep \n, \t, \uXXXX, etc.
      } else if (c === '"') {
        res += '\\"';
      } else {
        res += c;
      }
    }
    return res + '"';
  }

  // Step 4: convert single-quoted strings to double quotes, but only
  // when the surrounding characters make the intent clear.
  function convertSingleQuotes(text) {
    let out = '';
    let i = 0;
    let changed = false;
    let ambiguous = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        const end = findStringEnd(text, i);
        if (end === -1) { out += text.slice(i); break; }
        out += text.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (ch === "'") {
        const end = findStringEnd(text, i);
        if (end === -1) {
          ambiguous = true; // unterminated quote: cannot be sure
          out += ch;
          i++;
          continue;
        }
        const prev = lastNonSpace(text, i - 1);
        const next = nextNonSpace(text, end + 1);
        const prevOk = prev === null || ':,[{'.indexOf(prev) !== -1;
        const nextOk = next === null || ':,}]'.indexOf(next) !== -1;
        if (prevOk || nextOk) {
          out += buildDoubleQuoted(text.slice(i + 1, end));
          changed = true;
        } else {
          ambiguous = true;
          out += text.slice(i, end + 1); // leave it untouched
        }
        i = end + 1;
        continue;
      }
      out += ch;
      i++;
    }
    return { text: out, changed: changed, safe: !ambiguous, ambiguous: ambiguous };
  }

  // Step 5: add missing closing brackets. Refuses when the structure is
  // ambiguous (extra or mismatched closers, unterminated strings).
  function balanceBrackets(text) {
    const stack = [];
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        const end = findStringEnd(text, i);
        if (end === -1) {
          return { ok: false, reason: 'unterminated string' };
        }
        i = end + 1;
        continue;
      }
      if (ch === '{' || ch === '[') {
        stack.push(ch);
      } else if (ch === '}' || ch === ']') {
        const expected = ch === '}' ? '{' : '[';
        if (stack.length === 0) {
          return { ok: false, reason: 'extra closing bracket' };
        }
        if (stack[stack.length - 1] !== expected) {
          return { ok: false, reason: 'mismatched brackets' };
        }
        stack.pop();
      }
      i++;
    }
    if (stack.length === 0) return { ok: true, text: text, added: 0 };
    let added = '';
    for (let k = stack.length - 1; k >= 0; k--) {
      added += stack[k] === '{' ? '}' : ']';
    }
    return { ok: true, text: text + added, added: stack.length };
  }

  // Full repair pipeline. Returns:
  //   { ok, data, text, repairs: [...], warnings: [...], error }
  function repairAndParse(raw) {
    const result = { ok: false, data: undefined, text: raw, repairs: [], warnings: [], error: null };

    if (typeof raw !== 'string' || raw.trim() === '') {
      result.error = 'Input is empty. Paste some LLM output first.';
      return result;
    }

    let text = raw;
    let parsed = tryParse(text);
    if (parsed.ok) {
      result.ok = true; result.data = parsed.data; result.text = text;
      return result;
    }

    // Step 1: markdown fences
    const noFence = stripFences(text);
    if (noFence !== text) {
      text = noFence.trim();
      result.repairs.push('Removed Markdown code fence (```json / ```).');
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    }

    // Step 2: surrounding explanatory text
    const region = extractJSONRegion(text);
    if (region.found && region.text.trim() !== text.trim()) {
      text = region.text.trim();
      result.repairs.push('Removed surrounding explanatory text; kept the first complete JSON value.');
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    }

    // Step 3: JavaScript-style comments
    const noComments = stripComments(text);
    if (noComments !== text) {
      text = noComments;
      result.repairs.push('Removed JavaScript-style comments (// and /* */).');
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    }

    // Step 4: trailing commas
    const noTrailing = removeTrailingCommas(text);
    if (noTrailing !== text) {
      text = noTrailing;
      result.repairs.push('Removed trailing commas before closing braces/brackets.');
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    }

    // Step 5: single quotes -> double quotes
    const sq = convertSingleQuotes(text);
    if (sq.changed) {
      text = sq.text;
      result.repairs.push('Converted single-quoted strings to standard double quotes.');
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    }
    if (sq.ambiguous) {
      result.warnings.push('Some single quotes could not be converted safely (ambiguous position). Fix them manually if parsing fails.');
    }

    // Step 6: balance missing brackets
    const bal = balanceBrackets(text);
    if (bal.ok && bal.added > 0) {
      text = bal.text;
      result.repairs.push('Added ' + bal.added + ' missing closing bracket(s) to balance the structure.');
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    } else if (!bal.ok) {
      result.warnings.push('Could not balance brackets automatically (' + bal.reason + '). Manual correction required.');
    }

    // Final attempt: now that brackets are balanced, the JSON value may be
    // isolatable from surrounding prose (this handles prose + missing brace).
    const region2 = extractJSONRegion(text);
    if (region2.found && region2.text.trim() !== text.trim()) {
      text = region2.text.trim();
      const alreadyNoted = result.repairs.some(function (r) {
        return r.indexOf('explanatory text') !== -1;
      });
      if (!alreadyNoted) {
        result.repairs.push('Removed surrounding explanatory text; kept the first complete JSON value.');
      }
      parsed = tryParse(text);
      if (parsed.ok) { return finish(result, text, parsed.data); }
    }

    // Still broken: report honestly, do not guess.
    result.text = text;
    const finalTry = tryParse(text);
    result.error = finalTry.error || parsed.error || 'Unable to repair into valid JSON.';
    return result;
  }

  function finish(result, text, data) {
    result.ok = true;
    result.text = text;
    result.data = data;
    result.error = null;
    return result;
  }

  /* ============================================================
     4. Ajv validation + error formatting
     ============================================================ */

  // Resolve the Ajv constructor for the chosen schema version.
  function getAjvCtor(version) {
    if (typeof window === 'undefined') return null;
    const g = version === 'draft2020' ? window.ajv2020 : window.ajv7;
    if (!g) return null;
    return g.default || g; // UMD bundles expose the class on .default
  }

  // Validate `data` against `schema`. Never throws.
  function validateAgainstSchema(data, schema, version) {
    const Ctor = getAjvCtor(version);
    if (!Ctor) {
      return {
        status: 'error',
        errors: [],
        message: 'Validation library (Ajv) is not loaded. Check your internet connection; Ajv is loaded from cdnjs.'
      };
    }

    let ajv;
    try {
      ajv = new Ctor({ allErrors: true, strict: false, validateFormats: false });
    } catch (e) {
      return { status: 'error', errors: [], message: 'Could not initialize the validator: ' + e.message };
    }

    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (e) {
      return { status: 'error', errors: [], message: 'Invalid JSON Schema: ' + e.message };
    }

    let valid;
    try {
      valid = validate(data);
    } catch (e) {
      return { status: 'error', errors: [], message: 'Validation failed: ' + e.message };
    }

    if (valid) return { status: 'valid', errors: [] };
    const errors = (validate.errors || []).map(formatAjvError);
    return { status: 'invalid', errors: errors };
  }

  // Turn an Ajv instancePath such as /items/0/price into $.items[0].price
  function jsonPath(instancePath, params) {
    let path = '$';
    if (instancePath) {
      instancePath.split('/').slice(1).forEach(function (seg) {
        seg = seg.replace(/~1/g, '/').replace(/~0/g, '~');
        if (/^\d+$/.test(seg)) path += '[' + seg + ']';
        else path += '.' + seg;
      });
    }
    if (params && params.missingProperty) path += '.' + params.missingProperty;
    if (params && params.additionalProperty) path += '.' + params.additionalProperty;
    return path;
  }

  // Friendly name for the actual data type of a value.
  function actualType(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  // Convert one Ajv error into a readable { path, keyword, message }.
  function formatAjvError(err) {
    const p = err.params || {};
    let message;
    switch (err.keyword) {
      case 'required':
        message = 'Missing required property "' + p.missingProperty + '".';
        break;
      case 'type':
        message = 'Expected type "' + p.type + '" but got "' + actualType(err.data) + '".';
        break;
      case 'enum':
        message = 'Value is not one of the allowed values: ' +
          (p.allowedValues || []).map(function (v) { return JSON.stringify(v); }).join(', ') + '.';
        break;
      case 'additionalProperties':
        message = 'Additional property "' + p.additionalProperty + '" is not allowed here.';
        break;
      case 'const':
        message = 'Value must equal ' + JSON.stringify(p.allowedValue) + '.';
        break;
      case 'minimum': message = 'Value must be >= ' + p.limit + '.'; break;
      case 'maximum': message = 'Value must be <= ' + p.limit + '.'; break;
      case 'exclusiveMinimum': message = 'Value must be > ' + p.limit + '.'; break;
      case 'exclusiveMaximum': message = 'Value must be < ' + p.limit + '.'; break;
      case 'minLength': message = 'String is shorter than the minimum length of ' + p.limit + '.'; break;
      case 'maxLength': message = 'String is longer than the maximum length of ' + p.limit + '.'; break;
      case 'minItems': message = 'Array has fewer than ' + p.limit + ' required item(s).'; break;
      case 'maxItems': message = 'Array has more than the allowed ' + p.limit + ' item(s).'; break;
      case 'pattern': message = 'String does not match the required pattern ' + p.pattern + '.'; break;
      default:
        message = err.message ? err.message : 'Failed keyword "' + err.keyword + '".';
    }
    return { path: jsonPath(err.instancePath, p), keyword: err.keyword, message: message };
  }

  /* ============================================================
     5. Guardrail code generators
     These are illustrative examples, not executed or tested.
     ============================================================ */

  // Turn a schema title/id into a PascalCase identifier.
  function constName(schema) {
    const raw = (schema && (schema.title || schema.$id)) || 'LlmOutput';
    let name = String(raw)
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
      .join('');
    if (!name) name = 'LlmOutput';
    if (/^[0-9]/.test(name)) name = 'Schema' + name;
    return name;
  }

  // Convert a (basic) JSON Schema fragment into a Zod expression.
  function schemaToZod(schema, level) {
    level = level || 0;
    const pad = '  '.repeat(level);
    const padChild = '  '.repeat(level + 1);

    if (!isPlainObject(schema)) return 'z.any()';

    if (Array.isArray(schema.enum) && schema.enum.length) {
      return 'z.enum([' + schema.enum.map(function (v) { return JSON.stringify(v); }).join(', ') + '])';
    }

    let type = schema.type;
    if (Array.isArray(type)) type = type.filter(function (t) { return t !== 'null'; })[0];

    switch (type) {
      case 'string': return 'z.string()';
      case 'number': return 'z.number()';
      case 'integer': return 'z.number().int()';
      case 'boolean': return 'z.boolean()';
      case 'array':
        return 'z.array(' + schemaToZod(schema.items || {}, level) + ')';
      case 'object': {
        const props = schema.properties || {};
        const keys = Object.keys(props);
        if (!keys.length) return 'z.object({})';
        const required = schema.required || [];
        const inner = keys.map(function (k) {
          let expr = schemaToZod(props[k], level + 1);
          if (props[k] && typeof props[k].description === 'string') {
            expr += '.describe(' + JSON.stringify(props[k].description) + ')';
          }
          const optional = required.indexOf(k) === -1;
          return padChild + JSON.stringify(k) + ': ' + expr + (optional ? '.optional()' : '');
        }).join(',\n');
        return 'z.object({\n' + inner + '\n' + pad + '})';
      }
      default:
        return 'z.any()';
    }
  }

  function generateZodCode(schema) {
    if (!isPlainObject(schema)) {
      return [
        '// No valid JSON Schema loaded.',
        '// Paste a schema in the editor and copy this snippet again.',
        '',
        'import { z } from "zod";',
        '',
        'export const LlmOutputSchema = z.any();'
      ].join('\n');
    }
    const name = constName(schema);
    return [
      'import { z } from "zod";',
      '',
      '// Generated example (not executed or tested). Adjust as needed.',
      'export const ' + name + 'Schema = ' + schemaToZod(schema, 0) + ';',
      '',
      'export type ' + name + 'Data = z.infer<typeof ' + name + 'Schema>;',
      '',
      'export function parseLlmOutput(raw: string): ' + name + 'Data {',
      '  // Basic cleanup; for robust repair, run the JSON through the validator tool first.',
      '  const cleaned = raw.replace(/```json|```/g, "").trim();',
      '  const json = JSON.parse(cleaned);',
      '  return ' + name + 'Schema.parse(json);',
      '}'
    ].join('\n');
  }

  function generatePythonCode(schema) {
    if (!isPlainObject(schema)) {
      return [
        'import json',
        'from jsonschema import validate',
        '',
        '# No valid JSON Schema loaded. Paste a schema in the editor, then copy',
        '# this snippet again to embed it automatically.',
        'SCHEMA = {}  # replace with your JSON Schema dictionary',
        '',
        'def parse_llm_output(raw_text: str) -> dict:',
        '    text = raw_text.replace("```json", "").replace("```", "").strip()',
        '    data = json.loads(text)',
        '    validate(instance=data, schema=SCHEMA)',
        '    return data'
      ].join('\n');
    }
    const schemaJson = JSON.stringify(schema, null, 4);
    return [
      'import json',
      'import re',
      'from jsonschema import validate',
      '',
      '# Target schema, embedded from the editor (raw string keeps JSON escapes).',
      "SCHEMA = json.loads(r'''" + schemaJson + "''')",
      '',
      'def parse_llm_output(raw_text: str) -> dict:',
      '    """Clean common LLM JSON issues, then validate against SCHEMA."""',
      '    text = raw_text.strip()',
      '    # 1. Strip markdown code fences.',
      '    text = re.sub(r"```(?:json|javascript|js)?", "", text, flags=re.I).strip()',
      '    # 2. Keep the first JSON value if there is surrounding prose.',
      '    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]',
      '    if starts:',
      '        text = text[min(starts):]',
      '    ends = [text.rfind("}"), text.rfind("]")]',
      '    text = text[:max(ends) + 1]',
      '    # 3. Remove JavaScript comments and trailing commas.',
      '    text = re.sub(r"//[^\\n]*", "", text)',
      '    text = re.sub(r",(\\s*[}\\]])", r"\\1", text)',
      '    data = json.loads(text)',
      '    validate(instance=data, schema=SCHEMA)',
      '    return data'
    ].join('\n');
  }

  function generateLangChainCode(schema) {
    const head = [
      'from langchain_core.output_parsers import StructuredOutputParser, ResponseSchema',
      'from langchain_openai import ChatOpenAI',
      ''
    ];

    let responseLines;
    const props = (isPlainObject(schema) && isPlainObject(schema.properties)) ? schema.properties : null;

    if (props && Object.keys(props).length) {
      const typeMap = {
        string: 'string', number: 'number', integer: 'integer',
        boolean: 'boolean', array: 'array', object: 'object'
      };
      responseLines = Object.keys(props).map(function (key) {
        const prop = props[key] || {};
        let desc = prop.description || ('Field "' + key + '"');
        if (Array.isArray(prop.enum)) {
          desc = 'One of: ' + prop.enum.join(', ') + (prop.description ? ' - ' + prop.description : '');
        }
        const t = typeMap[prop.type] || 'string';
        return '    ResponseSchema(name=' + JSON.stringify(key) +
          ', description=' + JSON.stringify(desc) +
          ', type=' + JSON.stringify(t) + '),';
      });
    } else {
      responseLines = [
        '    ResponseSchema(name="field_name", description="Describe this field", type="string"),'
      ];
    }

    return head.concat([
      'response_schemas = [',
      responseLines.join('\n'),
      ']',
      '',
      'parser = StructuredOutputParser.from_response_schemas(response_schemas)',
      'format_instructions = parser.get_format_instructions()',
      '',
      'llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)',
      'chain = llm | parser',
      '',
      '# prompt = "Extract the structured data from: ..."',
      'result = chain.invoke(prompt + "\\n\\n" + format_instructions)  # dict',
      'print(result)'
    ]).join('\n');
  }

  /* ============================================================
     6. Presets
     ============================================================ */

  const PRESETS = {
    ecommerce: {
      label: 'E-Commerce Order Extraction',
      short: 'Order ID, customer, items, total, status',
      color: '#4c8dff',
      description: 'Extract line items, total price, customer details and order status. Ships with intentionally broken JSON (Markdown fence + trailing commas).',
      version: 'draft7',
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'Order',
        type: 'object',
        additionalProperties: false,
        properties: {
          order_id: { type: 'string', description: 'Unique order identifier' },
          customer_email: { type: 'string', description: 'Customer email address' },
          total_amount: { type: 'number', description: 'Total checkout amount' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sku: { type: 'string' },
                quantity: { type: 'integer' },
                price: { type: 'number' }
              },
              required: ['sku', 'quantity', 'price']
            }
          },
          status: { type: 'string', enum: ['pending', 'processing', 'shipped', 'delivered'] }
        },
        required: ['order_id', 'customer_email', 'total_amount', 'items', 'status']
      },
      output: [
        'Here is the extracted order:',
        '',
        '```json',
        '{',
        '  "order_id": "ORD-2026-9912",',
        '  "customer_email": "jane.doe@example.com",',
        '  "total_amount": 149.95,',
        '  "items": [',
        '    { "sku": "ITEM-A1", "quantity": 2, "price": 49.99, },',
        '    { "sku": "ITEM-B2", "quantity": 1, "price": 49.97 }',
        '  ],',
        '  "status": "processing",',
        '}',
        '```'
      ].join('\n')
    },

    rag: {
      label: 'RAG Citation & Source List',
      short: 'Answer, sources, citations, confidence',
      color: '#34d399',
      description: 'A cited answer with source document references, citation indices and a confidence score. This preset is valid and conforms to its schema.',
      version: 'draft7',
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'RagAnswer',
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', description: 'The grounded answer text' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                snippet: { type: 'string' }
              },
              required: ['title', 'url']
            }
          },
          citations: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Indices of the sources referenced in the answer'
          },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence score from 0 to 1' }
        },
        required: ['answer', 'sources', 'confidence']
      },
      output: [
        '{',
        '  "answer": "The Eiffel Tower is 330 metres tall and was completed in 1889 [1].",',
        '  "sources": [',
        '    { "title": "Eiffel Tower Facts", "url": "https://example.com/eiffel", "snippet": "The tower stands 330m tall." },',
        '    { "title": "History of the Eiffel Tower", "url": "https://example.com/history" }',
        '  ],',
        '  "citations": [1, 2],',
        '  "confidence": 0.92',
        '}'
      ].join('\n')
    },

    agent: {
      label: 'AI Agent Tool Execution',
      short: 'Action, success, payload, timestamp',
      color: '#f59e0b',
      description: 'An agent tool call with action name, success flag, payload and timestamp. This preset is valid JSON but intentionally violates the schema.',
      version: 'draft7',
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'ToolExecution',
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['search_database', 'send_email', 'update_crm'] },
          success: { type: 'boolean' },
          payload: { type: 'object' },
          timestamp: { type: 'string', description: 'ISO-8601 timestamp' }
        },
        required: ['action', 'success', 'payload', 'timestamp']
      },
      output: [
        '{',
        '  "action": "delete_all_records",',
        '  "success": "true",',
        '  "payload": { "query": "SELECT * FROM users" },',
        '  "timestamp": "2026-10-15T12:00:00Z",',
        '  "executed_by": "agent-01"',
        '}'
      ].join('\n')
    },

    support: {
      label: 'Customer Support Classification',
      short: 'Category, sentiment, priority, resolution',
      color: '#ec4899',
      description: 'Ticket category, sentiment score, priority and recommended resolution. Ships with intentionally broken JSON (single quotes, JS comment, missing brace).',
      version: 'draft7',
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: 'SupportTicket',
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', enum: ['billing', 'technical', 'account', 'shipping', 'other'] },
          sentiment_score: { type: 'number', minimum: -1, maximum: 1, description: 'Sentiment from -1 to 1' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          recommended_resolution: { type: 'string' }
        },
        required: ['category', 'sentiment_score', 'priority', 'recommended_resolution']
      },
      output: [
        'Here is the classification:',
        '{',
        "  // ticket classification",
        "  'category': 'billing',",
        "  'sentiment_score': -0.6,",
        "  'priority': 'high',",
        "  'recommended_resolution': 'Refund the duplicate charge and confirm via email.'"
      ].join('\n')
    }
  };

  // A standalone broken example for the "Load Broken Example" button.
  const BROKEN_EXAMPLE = [
    'Sure! Here is the JSON you asked for:',
    '',
    '```json',
    '{',
    "  'name': 'Example service',",
    "  'enabled': true, // keep this true",
    "  'retries': 3,",
    "  'tags': ['alpha', 'beta',],",
    '}',
    '```'
  ].join('\n');

  // Sample schema used by "Load Sample Schema".
  const SAMPLE_SCHEMA = PRESETS.ecommerce.schema;

  /* ============================================================
     7. UI wiring
     ============================================================ */

  const els = {};
  const state = { lastText: '', lastPretty: '' };

  // Cache DOM references.
  function cacheEls() {
    els.presetGrid = document.getElementById('presetGrid');
    els.presetDesc = document.getElementById('presetDesc');
    els.schemaInput = document.getElementById('schemaInput');
    els.schemaVersion = document.getElementById('schemaVersion');
    els.outputInput = document.getElementById('outputInput');
    els.loadSampleSchemaBtn = document.getElementById('loadSampleSchemaBtn');
    els.clearSchemaBtn = document.getElementById('clearSchemaBtn');
    els.validateBtn = document.getElementById('validateBtn');
    els.repairBtn = document.getElementById('repairBtn');
    els.clearInputBtn = document.getElementById('clearInputBtn');
    els.loadBrokenBtn = document.getElementById('loadBrokenBtn');

    els.statusBanner = document.getElementById('statusBanner');
    els.syntaxStatus = document.getElementById('syntaxStatus');
    els.schemaStatus = document.getElementById('schemaStatus');
    els.repairSection = document.getElementById('repairSection');
    els.repairList = document.getElementById('repairList');
    els.repairCount = document.getElementById('repairCount');
    els.errorSection = document.getElementById('errorSection');
    els.errorList = document.getElementById('errorList');
    els.errorCount = document.getElementById('errorCount');
    els.warnSection = document.getElementById('warnSection');
    els.warningList = document.getElementById('warningList');
    els.warningCount = document.getElementById('warningCount');

    els.repairedOutput = document.getElementById('repairedOutput');
    els.copyJsonBtn = document.getElementById('copyJsonBtn');
    els.downloadJsonBtn = document.getElementById('downloadJsonBtn');

    els.codePython = document.getElementById('codePython');
    els.codeZod = document.getElementById('codeZod');
    els.codeLangChain = document.getElementById('codeLangChain');

    els.year = document.getElementById('year');
  }

  // ---- tabs ----
  function setupTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () { activateTab(tab); });
      tab.addEventListener('keydown', function (e) {
        const idx = tabs.indexOf(tab);
        if (e.key === 'ArrowRight') { e.preventDefault(); activateTab(tabs[(idx + 1) % tabs.length], true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); activateTab(tabs[(idx - 1 + tabs.length) % tabs.length], true); }
      });
    });
  }

  function activateTab(tab, focus) {
    document.querySelectorAll('.tab').forEach(function (t) {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.id !== tab.dataset.tab);
    });
    if (focus) tab.focus();
  }

  function showTab(panelId) {
    const tab = document.querySelector('.tab[data-tab="' + panelId + '"]');
    if (tab) activateTab(tab);
  }

  // ---- diagnostics rendering ----
  function resetDiagnostics() {
    setStatus('status-empty', 'Ready. Click "Validate Output" or "Auto-Repair JSON".');
    els.syntaxStatus.textContent = 'Not checked';
    els.syntaxStatus.className = 'diag-value muted';
    els.schemaStatus.textContent = 'Not checked';
    els.schemaStatus.className = 'diag-value muted';
    els.repairSection.classList.add('hidden');
    els.errorSection.classList.add('hidden');
    els.warnSection.classList.add('hidden');
    els.repairList.innerHTML = '';
    els.errorList.innerHTML = '';
    els.warningList.innerHTML = '';
  }

  function setStatus(cls, text) {
    els.statusBanner.className = 'status-banner ' + cls;
    els.statusBanner.textContent = text;
  }

  function renderList(ul, section, countEl, items) {
    ul.innerHTML = '';
    if (!items.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    countEl.textContent = String(items.length);
    items.forEach(function (item) {
      const li = document.createElement('li');
      if (item.path) {
        const span = document.createElement('span');
        span.className = 'path';
        span.textContent = item.path;
        li.appendChild(span);
        li.appendChild(document.createTextNode(' \u2014 ' + item.message));
      } else {
        li.textContent = item.message;
      }
      ul.appendChild(li);
    });
  }

  // Parse the schema editor content. Returns { ok, schema, error }.
  function parseSchemaInput() {
    const raw = els.schemaInput.value;
    if (raw.trim() === '') return { ok: false, empty: true, schema: null, error: null };
    const parsed = tryParse(raw);
    if (!parsed.ok) return { ok: false, empty: false, schema: null, error: parsed.error };
    if (!isPlainObject(parsed.data)) {
      return { ok: false, empty: false, schema: null, error: 'A JSON Schema must be a JSON object.' };
    }
    return { ok: true, empty: false, schema: parsed.data, error: null };
  }

  // Main action: parse/repair the output and validate against the schema.
  function processOutput(focusRepaired) {
    resetDiagnostics();

    const outputRaw = els.outputInput.value;
    const schemaRes = parseSchemaInput();
    const repairs = [];
    const warnings = [];

    // ---- 1. parse / repair output ----
    let data = null;
    let syntaxState = 'empty'; // empty | valid | repaired | invalid
    let parseError = null;

    if (outputRaw.trim() === '') {
      syntaxState = 'empty';
    } else {
      const direct = tryParse(outputRaw.trim());
      if (direct.ok) {
        data = direct.data;
        syntaxState = 'valid';
      } else {
        const rep = repairAndParse(outputRaw);
        rep.repairs.forEach(function (r) { repairs.push(r); });
        rep.warnings.forEach(function (w) { warnings.push(w); });
        if (rep.ok) {
          data = rep.data;
          syntaxState = 'repaired';
          state.lastText = rep.text;
        } else {
          parseError = rep.error || 'Could not parse the JSON.';
          syntaxState = 'invalid';
          state.lastText = rep.text;
        }
      }
    }

    // ---- 2. schema validation ----
    let schemaState = 'skipped'; // skipped | valid | invalid | error
    let schemaErrors = [];
    let schemaNote = null;
    const canValidate = (data !== null) && (syntaxState === 'valid' || syntaxState === 'repaired');

    if (schemaRes.error) {
      schemaState = 'error';
      schemaNote = 'Schema is not valid JSON: ' + schemaRes.error;
    } else if (schemaRes.empty) {
      schemaState = 'skipped';
      schemaNote = 'No schema provided. Only JSON syntax was checked.';
      warnings.push('No JSON Schema provided. Paste a schema to check required properties, types and enums.');
    } else if (canValidate) {
      const result = validateAgainstSchema(data, schemaRes.schema, els.schemaVersion.value);
      if (result.status === 'valid') {
        schemaState = 'valid';
      } else if (result.status === 'invalid') {
        schemaState = 'invalid';
        schemaErrors = result.errors;
      } else {
        schemaState = 'error';
        schemaNote = result.message;
      }
    }

    // ---- 3. render syntax status ----
    if (syntaxState === 'empty') {
      els.syntaxStatus.textContent = 'Empty \u2014 nothing to parse';
      els.syntaxStatus.className = 'diag-value muted';
    } else if (syntaxState === 'valid') {
      els.syntaxStatus.textContent = 'Valid JSON';
      els.syntaxStatus.className = 'diag-value ok';
    } else if (syntaxState === 'repaired') {
      els.syntaxStatus.textContent = 'Valid after automatic repair (' + repairs.length + ' repair' + (repairs.length === 1 ? '' : 's') + ')';
      els.syntaxStatus.className = 'diag-value warn';
    } else {
      els.syntaxStatus.textContent = 'Invalid \u2014 could not parse or safely repair';
      els.syntaxStatus.className = 'diag-value bad';
    }

    // ---- 4. render schema status ----
    if (schemaState === 'skipped') {
      els.schemaStatus.textContent = 'Skipped (' + (schemaRes.empty ? 'no schema' : 'no parsed JSON') + ')';
      els.schemaStatus.className = 'diag-value muted';
    } else if (schemaState === 'valid') {
      els.schemaStatus.textContent = 'Valid \u2014 output conforms to the schema';
      els.schemaStatus.className = 'diag-value ok';
    } else if (schemaState === 'invalid') {
      els.schemaStatus.textContent = 'Invalid \u2014 ' + schemaErrors.length + ' schema error' + (schemaErrors.length === 1 ? '' : 's');
      els.schemaStatus.className = 'diag-value bad';
    } else {
      els.schemaStatus.textContent = 'Schema could not be used';
      els.schemaStatus.className = 'diag-value bad';
    }

    // ---- 5. overall status ----
    if (syntaxState === 'empty') {
      setStatus('status-empty', 'No LLM output provided. Paste raw output to validate.');
    } else if (syntaxState === 'invalid') {
      setStatus('status-invalid', 'Invalid \u2014 the JSON could not be parsed or safely repaired. See errors below.');
    } else if (schemaState === 'error') {
      setStatus('status-invalid', 'Schema problem \u2014 fix the JSON Schema and try again.');
    } else if (schemaState === 'skipped') {
      setStatus('status-valid', 'JSON is syntactically valid. Add a schema to verify its structure.');
    } else if (schemaState === 'valid') {
      if (syntaxState === 'repaired') {
        setStatus('status-repaired', 'Repaired & valid \u2014 ' + repairs.length + ' repair' + (repairs.length === 1 ? '' : 's') + ' applied and the output conforms to the schema.');
      } else {
        setStatus('status-valid', 'Valid \u2014 the JSON conforms to the schema.');
      }
    } else if (schemaState === 'invalid') {
      const prefix = syntaxState === 'repaired' ? 'Repaired, but invalid \u2014 ' : 'Invalid \u2014 ';
      setStatus('status-invalid', prefix + 'parsed successfully but failed schema validation (' + schemaErrors.length + ' error' + (schemaErrors.length === 1 ? '' : 's') + ').');
    }

    // ---- 6. errors & warnings ----
    const errorItems = [];
    if (parseError) {
      errorItems.push({ path: '$', message: 'JSON parse error: ' + parseError });
    }
    schemaErrors.forEach(function (e) { errorItems.push(e); });

    if (schemaNote && schemaState === 'error') {
      errorItems.push({ path: '$.$schema', message: schemaNote });
    }

    renderList(els.repairList, els.repairSection, els.repairCount,
      repairs.map(function (r) { return { message: r }; }));
    renderList(els.errorList, els.errorSection, els.errorCount, errorItems);
    renderList(els.warningList, els.warnSection, els.warningCount,
      warnings.map(function (w) { return { message: w }; }));

    // ---- 7. repaired JSON tab ----
    let pretty = '';
    if (data !== null) {
      pretty = JSON.stringify(data, null, 2);
    } else if (state.lastText) {
      pretty = state.lastText.trim();
    }
    state.lastPretty = pretty;

    if (!pretty) {
      els.repairedOutput.textContent = 'No parsed JSON yet. Run "Validate Output" or "Auto-Repair JSON".';
      els.repairedOutput.classList.add('empty-state');
    } else if (data !== null) {
      els.repairedOutput.textContent = pretty;
      els.repairedOutput.classList.remove('empty-state');
    } else {
      els.repairedOutput.textContent = pretty + '\n\n/* NOTE: this text is NOT valid JSON and could not be repaired. */';
      els.repairedOutput.classList.remove('empty-state');
    }

    if (focusRepaired && data !== null) {
      showTab('panel-repaired');
    } else {
      showTab('panel-diagnostics');
    }
  }

  // Regenerate the guardrail code snippets from the current schema.
  function updateGuardrails() {
    const parsed = parseSchemaInput();
    const schema = parsed.ok ? parsed.schema : null;
    els.codePython.textContent = generatePythonCode(schema);
    els.codeZod.textContent = generateZodCode(schema);
    els.codeLangChain.textContent = generateLangChainCode(schema);
  }

  // ---- clipboard ----
  function flashCopied(btn) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(function () {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1400);
  }

  function fallbackCopy(text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      flashCopied(btn);
    } catch (e) {
      window.alert('Copy failed. Please select the text and copy it manually.');
    }
    document.body.removeChild(ta);
  }

  function copyText(text, btn) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flashCopied(btn); },
        function () { fallbackCopy(text, btn); }
      );
    } else {
      fallbackCopy(text, btn);
    }
  }

  // ---- download ----
  function downloadJSON() {
    const text = state.lastPretty;
    if (!text) {
      window.alert('Nothing to download yet. Run a validation or repair first.');
      return;
    }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'repaired-output.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- presets ----
  // Build one colourful, clickable card per preset scenario.
  function renderPresetCards() {
    Object.keys(PRESETS).forEach(function (key) {
      const preset = PRESETS[key];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'preset-card';
      card.dataset.preset = key;
      card.style.setProperty('--card-color', preset.color || '#4c8dff');

      const dot = document.createElement('span');
      dot.className = 'preset-dot';
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = preset.label;
      const short = document.createElement('span');
      short.className = 'preset-short';
      short.textContent = preset.short || '';
      card.appendChild(dot);
      card.appendChild(name);
      card.appendChild(short);

      card.addEventListener('click', function () { loadPreset(key); });
      els.presetGrid.appendChild(card);
    });
  }

  function loadPreset(key) {
    const preset = PRESETS[key];
    if (!preset) return;
    els.schemaInput.value = JSON.stringify(preset.schema, null, 2);
    els.outputInput.value = preset.output;
    els.schemaVersion.value = preset.version || 'draft7';
    els.presetDesc.textContent = preset.description;
    Array.prototype.forEach.call(
      document.querySelectorAll('.preset-card'),
      function (c) { c.classList.toggle('active', c.dataset.preset === key); }
    );
    resetDiagnostics();
    state.lastText = '';
    state.lastPretty = '';
    els.repairedOutput.textContent = 'No parsed JSON yet. Run "Validate Output" or "Auto-Repair JSON".';
    els.repairedOutput.classList.add('empty-state');
    updateGuardrails();
    showTab('panel-diagnostics');
  }

  // ---- init ----
  function initUI() {
    cacheEls();

    if (els.year) els.year.textContent = String(new Date().getFullYear());

    setupTabs();

    // Presets
    renderPresetCards();

    // Schema editor
    els.loadSampleSchemaBtn.addEventListener('click', function () {
      els.schemaInput.value = JSON.stringify(SAMPLE_SCHEMA, null, 2);
      els.schemaVersion.value = 'draft7';
      updateGuardrails();
    });
    els.clearSchemaBtn.addEventListener('click', function () {
      els.schemaInput.value = '';
      updateGuardrails();
    });
    els.schemaInput.addEventListener('input', debounce(updateGuardrails, 350));
    els.schemaVersion.addEventListener('change', updateGuardrails);

    // Output editor
    els.validateBtn.addEventListener('click', function () { processOutput(false); });
    els.repairBtn.addEventListener('click', function () { processOutput(true); });
    els.clearInputBtn.addEventListener('click', function () {
      els.outputInput.value = '';
      state.lastText = '';
      state.lastPretty = '';
      resetDiagnostics();
      els.repairedOutput.textContent = 'No parsed JSON yet. Run "Validate Output" or "Auto-Repair JSON".';
      els.repairedOutput.classList.add('empty-state');
      showTab('panel-diagnostics');
    });
    els.loadBrokenBtn.addEventListener('click', function () {
      els.outputInput.value = BROKEN_EXAMPLE;
      state.lastText = '';
      state.lastPretty = '';
      resetDiagnostics();
      showTab('panel-diagnostics');
    });

    // Repaired JSON actions
    els.copyJsonBtn.addEventListener('click', function () { copyText(state.lastPretty, els.copyJsonBtn); });
    els.downloadJsonBtn.addEventListener('click', downloadJSON);

    // Guardrail copy buttons
    document.querySelectorAll('[data-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const target = document.getElementById(btn.dataset.copy);
        if (target) copyText(target.textContent, btn);
      });
    });

    // Initial guardrail code from any pre-filled schema.
    updateGuardrails();
    resetDiagnostics();
  }

  // Simple debounce for the schema input handler.
  function debounce(fn, wait) {
    let timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, wait);
    };
  }

  /* ============================================================
     Expose pure functions for testing, and start the UI in a browser.
     ============================================================ */

  if (typeof window !== 'undefined') {
    window.ValidatorCore = {
      tryParse: tryParse,
      extractJSONRegion: extractJSONRegion,
      stripFences: stripFences,
      stripComments: stripComments,
      removeTrailingCommas: removeTrailingCommas,
      convertSingleQuotes: convertSingleQuotes,
      balanceBrackets: balanceBrackets,
      repairAndParse: repairAndParse,
      validateAgainstSchema: validateAgainstSchema,
      formatAjvError: formatAjvError,
      jsonPath: jsonPath,
      schemaToZod: schemaToZod,
      generateZodCode: generateZodCode,
      generatePythonCode: generatePythonCode,
      generateLangChainCode: generateLangChainCode,
      PRESETS: PRESETS,
      SAMPLE_SCHEMA: SAMPLE_SCHEMA,
      BROKEN_EXAMPLE: BROKEN_EXAMPLE
    };
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initUI);
    } else {
      initUI();
    }
  }
})();

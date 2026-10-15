# LLM Structured Output & JSON Schema Validator

A small, fully working, **100% client-side** web tool that validates, debugs, and
auto-repairs raw LLM output (from ChatGPT, Claude, DeepSeek, Llama, and others)
against a JSON Schema.

Built by **HiMat Technologies** with plain HTML, CSS, and vanilla JavaScript.
No backend, no build step, no login, no API key, and no tracking.

- Live demo: https://himat.tech/free-tools/llm-structured-output-validator
- Website: https://himat.co.in
- GitHub: https://github.com/Himat-developers
- LinkedIn: https://www.linkedin.com/in/himat-technologies-14b1051b4

---

## 1. What this project does

Large Language Models often return JSON wrapped in Markdown fences, with trailing
commas, JavaScript comments, single quotes, or missing closing braces. This tool:

1. Lets you paste a **JSON Schema** (the rules your data must follow).
2. Lets you paste **raw LLM output** (which may be messy or invalid).
3. Safely **repairs** common JSON problems when it can do so without guessing.
4. **Validates** the result against the schema.
5. Shows clear **diagnostics**, the **repaired JSON**, and ready-to-copy
   **guardrail code** for Python, TypeScript (Zod), and LangChain.

Everything runs in your browser. Nothing is uploaded anywhere.

---

## 2. Features

- **JSON Schema editor** supporting Draft 7 and Draft 2020-12, with:
  - required properties
  - types: `string`, `number`, `integer`, `boolean`, `object`, `array`
  - `enum`s, nested objects, and array item validation
  - `additionalProperties` checking
  - a **Load Sample Schema** button and a **Clear Schema** button
  - a version dropdown
- **Raw LLM output editor** that accepts Markdown fences, prose, trailing commas,
  comments, single quotes, missing braces, and other common issues.
- **Automatic JSON repair engine** in vanilla JS (see section 7).
- **Schema validation** with readable error paths such as `$.items[0].price`.
- **Results dashboard** with three tabs:
  - **Diagnostics** — status, repairs, errors, warnings
  - **Repaired JSON** — clean, indented output with **Copy JSON** and **Download JSON**
  - **Guardrail Code** — Python, TypeScript (Zod), and LangChain snippets, each with **Copy Code**
- **Four colourful production preset cards**, two of which ship with intentionally broken JSON.
- **Responsive** two-column desktop layout that stacks on mobile.
- **Privacy-first**: no backend, no storage, no `eval()`.

---

## 3. Folder structure

```text
llm-structured-output-validator/
├── index.html   # Page structure: header, editors, presets, tabs, footer
├── style.css    # All styling (responsive, developer-tool look)
├── script.js    # All logic: repair engine, validation, UI wiring
└── README.md    # This file
```

That is the entire project. There is nothing to compile or install.

---

## 4. How to run the project locally

### Option A — Open the file directly (simplest)

1. Download or clone this folder.
2. Double-click **`index.html`**, or right-click it and choose *Open with → your browser*.
3. The tool opens and works immediately.

> Because everything runs in the browser, no local server is required.

### Option B — Use a tiny local server (optional)

Some editors prefer serving files over HTTP. From inside the project folder run any
of the following, then open the printed URL (for example `http://localhost:8000`):

```bash
# Node.js (uses the optional package.json in this folder)
npm run dev

# Python 3
python -m http.server 8000

# Or any static server
npx serve .
```

`npm run dev` serves the folder at **http://localhost:8000**. It needs Node.js and
downloads the tiny `serve` package on first run, so it requires an internet
connection once. The project itself still needs no build step.

### Internet connection

On first load the page fetches the **Ajv** validation library from the free cdnjs
CDN. This needs an internet connection. If the CDN is unavailable, the page still
loads and the repair engine still works, but schema validation is disabled and a
clear message is shown.

---

## 5. How to use JSON Schema validation

1. Choose your schema version in the **Version** dropdown:
   - **Draft 7** (most common)
   - **Draft 2020-12**
2. Paste your JSON Schema into the **Target JSON Schema** box, or click
   **Load Sample Schema**.
3. Paste your raw LLM output into the **Raw LLM Output** box.
4. Click **Validate Output**.
5. Read the **Diagnostics** tab:
   - **JSON Syntax** — was the output valid JSON?
   - **Schema Validation** — did it match the schema?
   - **Errors** — each problem with its JSON path, for example:
     - `$.customer_email` — Missing required property "customer_email".
     - `$.items[0].quantity` — Expected type "integer" but got "string".
     - `$.status` — Value is not one of the allowed values: "pending", ...
     - `$.executed_by` — Additional property "executed_by" is not allowed here.

A success message is only shown when **both** parsing and schema validation pass.

---

## 6. How to use automatic repair

1. Paste messy output (or click **Load Broken Example**).
2. Click **Auto-Repair JSON**.
3. Look at the **Diagnostics** tab to see **which repairs were applied**, and open
   the **Repaired JSON** tab to copy or download the cleaned result.

The repair engine handles (when it is safe to do so):

1. Markdown code fences (```` ```json ... ``` ````)
2. Surrounding explanatory text (keeps the first complete JSON value)
3. JavaScript-style comments (`//` and `/* */`)
4. Trailing commas before `}` or `]`
5. Some single-quoted strings → double-quoted strings
6. Missing closing braces/brackets (only when the structure is unambiguous)

It will **never** invent values, add properties, or change the meaning of your data.
If it cannot repair something safely, it says so and asks you to fix it manually.
See section 12 for the specific cases that cannot be repaired automatically.

---

## 7. Supported schema versions and limitations

**Supported:**

- JSON Schema **Draft 7**
- JSON Schema **Draft 2020-12**

Both are provided by the Ajv library (loaded from cdnjs). For Draft 7 the tool uses
the `ajv7` bundle; for Draft 2020-12 it uses the `ajv2020` bundle.

**Limitations:**

- `format` keywords (for example `"format": "email"`) are **not** enforced, because
  the optional `ajv-formats` plugin is not loaded. The tool focuses on structure
  (types, required, enums, arrays, nested objects, additional properties).
- Very unusual schemas (remote `$ref`, custom vocabularies, JTD) are not supported.
- If you pick a schema version that does not match your schema's `$schema`, the
  compiler may report an error; switch the dropdown to the correct version.

---

## 8. How to use the preset examples

Click a **preset card** in the **Production Scenario Presets** section:

1. **E-Commerce Order Extraction** — order ID, customer email, total amount, items
   (SKU, quantity, price), and order status. *Ships broken* (Markdown fence +
   trailing commas) so you can test repair.
2. **RAG Citation & Source List** — answer, source documents, citation indices, and
   confidence score. *Valid and conforming.*
3. **AI Agent Tool Execution** — action name, success flag, payload, and timestamp.
   *Valid JSON that intentionally violates the schema*, so you can test diagnostics.
4. **Customer Support Classification** — ticket category, sentiment score, priority,
   and recommended resolution. *Ships broken* (single quotes, a JS comment, a missing
   brace) so you can test repair.

Loading a preset fills both editors, sets the schema version, highlights the card,
and refreshes the guardrail code.

---

## 9. How to copy or download results

- **Copy JSON** — copies the repaired/parsed JSON (from the **Repaired JSON** tab).
- **Download JSON** — downloads a `repaired-output.json` file.
- **Copy Code** — each guardrail snippet (Python, TypeScript/Zod, LangChain) has its
  own copy button in the **Guardrail Code** tab.

The generated code snippets are **examples only**. They have not been executed or
tested by this tool. Review them before using them in production.

---

## 10. Privacy and the CDN dependency

- Your schema and LLM output are processed **entirely in your browser**.
- There is **no backend server** and **no network transmission** of your data.
- There are **no analytics, no tracking, no cookies, and no API keys**.
- Nothing is written to `localStorage` or `sessionStorage`. Closing the tab clears
  everything.
- Pasted content is **never executed**. This project does not use `eval()` or the
  `Function` constructor.

**CDN dependency:** the only external resources are two Ajv bundles loaded from
cdnjs (`ajv7.bundle.min.js` and `ajv2020.bundle.min.js`). They are separate from the
validation logic and only provide the JSON Schema compiler. They require an internet
connection on first load. When they are not available, the repair engine still works
and a notice is shown in the Diagnostics panel.

---

## 11. Testing performed

The project was verified with two throwaway harnesses (not shipped): a Node.js
harness for the repair engine, validation, and code generators (31 checks), and a
jsdom harness that loads `index.html`, runs `script.js`, and clicks every control
(21 checks). Together, **52 automated checks passed**. The cases covered were:

1. Valid JSON that matches the schema — passes.
2. Valid JSON that violates the schema — reports required/type/enum/additional errors.
3. JSON wrapped in Markdown fences — fence removed.
4. JSON with trailing commas — commas removed.
5. JSON missing a closing brace — brace added.
6. JSON with malformed/single quotes — quotes converted when safe.
7. Invalid schema syntax — reported clearly.
8. Empty schema and empty output — handled without errors.
9. Nested arrays and objects — paths reported correctly.
10. All four preset scenarios — behave as documented.
11. Copy and download handlers — reviewed against the Clipboard/Blob/DOM APIs (browser-only).
12. Mobile responsiveness — CSS breakpoint at 900px and 560px reviewed.

---

## 12. Known limitations and future improvements

**Known limitations**

- The repair engine is **conservative on purpose**. It will not fix:
  - ambiguous or unbalanced quotes (for example an odd number of `'` characters),
  - mismatched or extra closing brackets,
  - genuinely truncated or missing values,
  - missing commas between elements,
  - duplicate or otherwise contradictory information.
  In these cases it reports an error and asks you to fix it manually.
- `format` keywords are not enforced (see section 7).
- Single-quote conversion uses a heuristic; it is skipped when the quote position is
  ambiguous so it never silently changes the meaning of your data.

**Future improvements**

- Optional `ajv-formats` support for `email`, `date-time`, `uri`, and other formats.
- Smarter single-quote and missing-comma repair with a confidence indicator.
- More presets and additional guardrail languages.
- Line/column highlighting of the first parse error.

---

## 13. Tech notes

- Plain HTML, CSS, and vanilla JavaScript. No frameworks, no build tools.
- Third-party library: [Ajv](https://ajv.js.org/) (JSON Schema validator), loaded
  from cdnjs.
- All state lives in memory only.

---

## 14. Connect with HiMat Technologies

- Live demo: https://himat.tech/free-tools/llm-structured-output-validator
- Website: https://himat.co.in
- GitHub: https://github.com/Himat-developers
- LinkedIn: https://www.linkedin.com/in/himat-technologies-14b1051b4
- Instagram: https://www.instagram.com/himat_technologies?stkn=djdmcGxweWtwYWI0
- Facebook: https://www.facebook.com/people/Himat-technologies/61593829197445/
- Email: info@himat.co.in
- Phone: +91 94452 34023

© HiMat Technologies. All rights reserved.

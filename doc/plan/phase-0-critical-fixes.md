# Phase 0: Critical Fixes

**Duration:** 1 day  |  **Priority:** High (security + correctness)

Apply these fixes to the **current** `src/web/ui/index.html` monolith before the architecture refactor begins. Fixing these now ensures the new Preact codebase doesn't inherit known bugs.

---

## 0.1 — Fix `escapeHtml()` XSS

**File:** `src/web/ui/index.html` — search for the `escapeHtml` function (~line 162)

**Current:** Only escapes `&`, `<`, `>`.
```javascript
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

**Problem:** Quotes (`"`, `'`) are not escaped. The function is used inside attribute values like `data-id="${escapeHtml(id)}"` and `data-file="${escapeHtml(f.filePath)}"`. A file path or chunk ID containing a `"` can break out of the attribute and inject HTML.

**Fix:**
```javascript
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

**Verification:** In the running UI, check that a chunk whose `id` contains `"` renders without breaking the `data-id` attribute.

---

## 0.2 — Escape chunk description and content in detail pane

**File:** `src/web/ui/index.html` ~line 547

**Current:**
```javascript
<div class="text-sm text-slate-300 mt-2">${c.description}</div>
```

**Problem:** `c.description` may contain user-controlled text (file path chunks, LLM-generated descriptions). It's inserted as raw HTML without escaping.

**Fix:**
```javascript
<div class="text-sm text-slate-300 mt-2">${escapeHtml(c.description)}</div>
```

Also check all other places where `c.description` and `c.content` are injected:
- Description card (~line 547)
- Code panel (~line 554)
- Search result descriptions (~line 782)
- Chunk row table cells (~lines 438, 442)

---

## 0.3 — Remove stale console.log

**File:** `src/web/ui/index.html` ~line 1023

**Current:**
```javascript
console.log('[Compare] clicked, selected ids:', ids);
```

**Fix:** Delete this line. It's development debris and should not ship.

---

## 0.4 — Fix invalid Tailwind class

**File:** `src/web/ui/index.html` ~line 42

**Current:**
```html
<aside id="sidebar" class="w-64 bg-slate-900/50 ..." style="background:#0f172a;">
```

**Problem:** The inline `style` overrides the `bg-slate-900/50` class, suggesting the class alone didn't produce the intended color. Either the intended class was `bg-slate-900` (solid) or the inline style is the actual intent. Given that `#0f172a` is `slate-900`, the fix is to use the class directly.

**Fix:**
```html
<aside id="sidebar" class="w-64 bg-slate-900 ...">
```

---

## 0.5 — Expand CORS allowed methods

**File:** `src/web/api.ts` ~line 88

**Current:**
```typescript
"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
```

**Problem:** New Phase 2+ endpoints may need `PUT` (reindex, config updates). Better to proactively allow it.

**Fix:**
```typescript
"Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
```

---

## 0.6 — Fix doc/implementation drift in webui.md

**File:** `doc/webui.md`

**Problem:** The documentation describes a "Compare" view ("Side-by-side comparison of 2–3 chunks") and a checkbox column in the Chunks table. Neither exists. Also documents `bg-slate-850` as a valid class (it's not in Tailwind).

**Fix:** Add a note at the top of `doc/webui.md`:

> > **Note:** The Compare view and Chunks checkbox column are planned but not yet implemented. See [Phase 3](../plan/phase-3-chunk-comparison.md) of the UI Next Level plan.

And fix the class reference:
> > **Note:** `bg-slate-850` was replaced with `bg-slate-900`.

---

## Verification Checklist

| # | Test | Expected |
|---|---|---|
| 0.1 | Set chunk ID to `test"onclick="alert(1)` via DB | `data-id` renders as `test&quot;onclick=&quot;alert(1)`, no alert |
| 0.2 | Set chunk description to `<script>alert(1)</script>` via DB | Description renders as plain text, not HTML |
| 0.3 | Open browser console | No `[Compare] clicked` log message |
| 0.4 | Inspect sidebar in devtools | Only the `bg-slate-900` class applied, `background:#0f172a` absent |
| 0.5 | `curl -X OPTIONS http://127.0.0.1:3210/api/ -v` | `Allow-Methods` includes `PUT` |
| 0.6 | Read `doc/webui.md` | Disclaimers present at top |

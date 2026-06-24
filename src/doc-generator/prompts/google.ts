import type { DocSymbol } from "../types.js";

const STYLE_RULES = [
  "1. Use `/** ... */` block comments — never `//` or `/*`.",
  "2. First line is a standalone summary sentence ending with a period.",
  "3. Describe WHAT the symbol does and WHY, not HOW it does it.",
  "4. Blank line between summary and body (if body is needed).",
  "5. For TypeScript: Omit `{type}` in @param/@returns — types are in the code.",
  "6. For JavaScript/Python/PHP: ALWAYS include `{type}` in @param and @returns.",
  "7. `@param name - Description` — one line per parameter, dash before description.",
  "8. `@returns Description` — describe the return value, not just the type.",
  "9. `@throws {ErrorType} Condition` — only when the code explicitly throws.",
  "10. For properties/fields: use a single-line `/** Description */` when possible.",
  "11. For constructors: describe what the constructor initializes, @param each argument.",
  "12. For enums: document the enum itself, not individual values (unless each value needs explanation).",
  "13. Do NOT add comments inside function/method bodies.",
  "14. Do NOT restate the obvious (e.g., `/** Sets the name. */` on `setName()`).",
  "15. Be concise — ≤2 sentences per tag description.",
];

export function buildGoogleSystemPrompt(language: string, _symbols: DocSymbol[]): string {
  return [
    "You are a code documentation expert that strictly follows the Google JSDoc style guide.",
    "",
    "## Documentation Rules",
    "",
    ...STYLE_RULES,
    "",
    "## Language-Specific Notes",
    ...getLanguageSpecificRules(language),
    "",
    "## Output Format",
    "",
    "For each symbol, return the complete `/** ... */` comment block that should be inserted before it.",
    "Separate multiple comment blocks with two newlines.",
    "Do NOT output the symbol code itself.",
    "Do NOT output anything else — only the comment blocks.",
    "Every comment block must start with `/**` on its own line and end with `*/` on its own line.",
  ].join("\n");
}

function getLanguageSpecificRules(language: string): string[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return [
        "- TypeScript: omit `{type}` in @param/@returns; use `@param name - Desc`",
        "- JavaScript: include `{type}` → `@param {string} name - Desc`",
      ];
    case "python":
      return [
        "- Use Google-style docstrings with triple double-quotes (`\"\"\"...\"\"\"`)",
        "- Include types in @param and @returns: `@param {str} name - Description`",
        "- Use `@raises {Type} Condition` instead of `@throws`",
      ];
    case "java":
      return [
        "- Include `{type}` in @param and @returns",
        "- Use `{@inheritDoc}` for overrides when applicable",
      ];
    case "go":
      return [
        "- Go uses `// Comment` style (not `/** */`)",
        "- Comment starts with the symbol name: `// FunctionName does X.`",
        "- Use full sentences. Period at end.",
      ];
    case "rust":
      return [
        "- Use `///` line comments or `//!` for module-level docs",
        "- First line is summary: `/// Brief summary.`",
        "- Use `///` for each line of documentation",
      ];
    case "c":
    case "cpp":
      return [
        "- For C/C++, use `/** ... */` block comments (Doxygen-compatible preferred)",
        "- Include `@param`, `@returns`, `@throws` with `{type}` annotations",
      ];
    case "csharp":
      return [
        "- Use `/// <summary>...</summary>` XML doc comments",
        "- Include `<param name=\"x\">Description</param>`, `<returns>Desc</returns>`",
      ];
    case "ruby":
      return [
        "- Use `#` line comments for documentation",
        "- Describe what the method/class does",
      ];
    case "kotlin":
      return [
        "- Use `/** ... */` block comments (KotlinDoc style)",
        "- Include `@param name Description`, `@return Description`",
      ];
    case "swift":
      return [
        "- Use `///` line comments (Swift-markup style)",
        "- Colon after parameter: `- Parameter name: Description`",
        "- Returns: `- Returns: Description`",
      ];
    case "php":
      return [
        "- Use `/** ... */` block comments (PHPDoc style)",
        "- Include `{type}` in @param and @returns",
        "- Use `@param type $name Description` (with `$` prefix)",
      ];
    default:
      return [];
  }
}

export function buildUserMessageForSymbols(
  filePath: string,
  language: string,
  symbols: DocSymbol[],
  fileContent: string,
): string {
  const sections: string[] = [
    `File: ${filePath}`,
    `Language: ${language}`,
    "",
    "## Symbols needing documentation",
    "",
  ];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (!sym) continue;
    sections.push(`### Symbol ${i + 1}: ${sym.name} (${sym.kind})`);
    sections.push(`Lines: ${sym.startLine}\u2013${sym.endLine}`);
    sections.push("");
    sections.push("```" + language);
    sections.push(sym.signature);
    sections.push("```");
    sections.push("");
  }

  sections.push("## Full file content for context");
  sections.push("");
  sections.push("```" + language);
  sections.push(fileContent);
  sections.push("```");

  return sections.join("\n");
}

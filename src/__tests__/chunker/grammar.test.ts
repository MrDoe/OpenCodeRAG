import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { walkTree } from "../../chunker/grammar.js";

interface MockNode {
  type: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  children: MockNode[];
  previousSibling: MockNode | null;
  namedChildren: MockNode[];
}

function makeNode(
  type: string,
  startIndex: number,
  endIndex: number,
  startRow: number,
  endRow: number,
  children: MockNode[] = []
): MockNode {
  const namedChildren = children.filter((c) =>
    !["def", ":", "(", ")", "{", "}", "pass", "return"].includes(c.type)
  );
  const node: MockNode = {
    type,
    startIndex,
    endIndex,
    startPosition: { row: startRow },
    endPosition: { row: endRow },
    children,
    previousSibling: null,
    namedChildren,
  };
  // Link siblings
  for (let i = 0; i < children.length; i++) {
    if (i > 0) children[i]!.previousSibling = children[i - 1]!;
  }
  return node;
}

describe("walkTree", () => {
  it("returns empty array for leaf node", () => {
    const node = makeNode("identifier", 0, 5, 0, 0);
    const result = walkTree(node as never, new Set(["function"]), "hello");
    assert.deepStrictEqual(result, []);
  });

  it("does not match at depth 0 (root node type is ignored)", () => {
    const node = makeNode("function_declaration", 0, 20, 0, 2, [
      makeNode("identifier", 5, 10, 0, 0),
    ]);
    const result = walkTree(
      node as never,
      new Set(["function_declaration"]),
      "function hello() {}"
    );
    // Root node type matches but depth=0 → not collected
    assert.deepStrictEqual(result, []);
  });

  it("matches node at depth 1 when type is in nodeTypes", () => {
    const child = makeNode("function_declaration", 0, 20, 1, 3);
    const root = makeNode("program", 0, 20, 0, 3, [child]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "function hello() {}"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, "function_declaration");
  });

  it("recurses into children to find matching node", () => {
    const grandchild = makeNode("function_declaration", 0, 20, 2, 5);
    const child = makeNode("block", 0, 20, 1, 5, [grandchild]);
    const root = makeNode("program", 0, 20, 0, 5, [child]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "function hello() {}"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, "function_declaration");
  });

  it("respects maxDepth parameter", () => {
    const deep = makeNode("function_declaration", 0, 20, 3, 5);
    const mid = makeNode("block", 0, 20, 2, 5, [deep]);
    const child = makeNode("class", 0, 20, 1, 5, [mid]);
    const root = makeNode("program", 0, 20, 0, 5, [child]);

    // Default maxDepth=10: searches depths 0–10 → reaches depth 3
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "content"
    );
    assert.equal(result.length, 1);

    // maxDepth=2: searches depths 0–2 → won't reach depth 3
    const resultShallow = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "content",
      2
    );
    assert.deepStrictEqual(resultShallow, []);
  });

  it("finds multiple matching nodes at same depth", () => {
    const fn1 = makeNode("function_declaration", 0, 10, 1, 1);
    const fn2 = makeNode("function_declaration", 11, 21, 2, 2);
    const root = makeNode("program", 0, 21, 0, 2, [fn1, fn2]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "fn1() {} fn2() {}"
    );
    assert.equal(result.length, 2);
  });

  it("extracts correct text from source using startIndex/endIndex", () => {
    const source = "function hello() { return 'world'; }";
    const child = makeNode("function_declaration", 0, source.length, 1, 1);
    const root = makeNode("program", 0, source.length, 0, 1, [child]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      source
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.text, source);
  });

  it("sets correct 1-indexed line numbers from row positions", () => {
    const child = makeNode("function_declaration", 10, 50, 5, 8);
    const root = makeNode("program", 0, 60, 0, 10, [child]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "some\ncontent\nhere\nmore\nstuff\nfunction foo() {\n  return 1;\n}\n"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.startLine, 6); // row 5 + 1
    assert.equal(result[0]!.endLine, 9); // row 8 + 1
  });

  it("returns empty array when no node types match within maxDepth", () => {
    const child = makeNode("variable_declaration", 0, 10, 1, 1);
    const root = makeNode("program", 0, 10, 0, 1, [child]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration", "class_declaration"]),
      "let x = 1;"
    );
    assert.deepStrictEqual(result, []);
  });

  it("empty nodeTypes set returns nothing", () => {
    const child = makeNode("function_declaration", 0, 10, 1, 1);
    const root = makeNode("program", 0, 10, 0, 1, [child]);
    const result = walkTree(root as never, new Set(), "function foo() {}");
    assert.deepStrictEqual(result, []);
  });

  it("stops recursing once a matching node is found (no grandchildren)", () => {
    const grandchild = makeNode("method_definition", 5, 15, 3, 4);
    const classNode = makeNode("class_declaration", 0, 20, 1, 5, [grandchild]);
    const root = makeNode("program", 0, 20, 0, 5, [classNode]);
    // class_declaration matches at depth 1 → stops, never reaches grandchild
    const result = walkTree(
      root as never,
      new Set(["class_declaration", "method_definition"]),
      "class A { foo() {} }"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, "class_declaration");
  });

  it("descends into a matching node when descend is true", () => {
    const grandchild = makeNode("method_definition", 5, 15, 3, 4);
    const classNode = makeNode("class_declaration", 0, 20, 1, 5, [grandchild]);
    const root = makeNode("program", 0, 20, 0, 5, [classNode]);
    // With descend the class is still reported, and its method is reached.
    const result = walkTree(
      root as never,
      new Set(["class_declaration", "method_definition"]),
      "class A { foo() {} }",
      10,
      0,
      undefined,
      true
    );
    assert.deepEqual(result.map((n) => n.type), ["class_declaration", "method_definition"]);
  });

  it("preserves correct startIndex and endIndex in result", () => {
    const child = makeNode("function_declaration", 5, 15, 1, 2);
    const root = makeNode("program", 0, 20, 0, 3, [child]);
    const result = walkTree(
      root as never,
      new Set(["function_declaration"]),
      "01234function foo()0123456789"
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]!.startIndex, 5);
    assert.equal(result[0]!.endIndex, 15);
  });

  describe("leadingDoc extraction", () => {
    function makeSiblingNodes(
      commentText: string,
      fnText: string,
      fnType = "function_declaration",
      commentType = "comment",
      rootType = "program",
    ) {
      const src = commentText + fnText;
      const comment = makeNode(commentType, 0, commentText.length, 0, 0);
      const fn = makeNode(fnType, commentText.length, src.length, 1, 2);
      const root = makeNode(rootType, 0, src.length, 0, 2, [comment, fn]);
      return { src, comment, fn, root };
    }

    it("extracts leading single-line // comment", () => {
      const { src, root } = makeSiblingNodes("// hello world\n", "function foo() {}");
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "hello world");
    });

    it("extracts leading /* */ block comment", () => {
      const { src, root } = makeSiblingNodes("/* hello */\n", "function foo() {}");
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "hello");
    });

    it("extracts leading /** JSDoc */ block comment", () => {
      const { src, root } = makeSiblingNodes(
        "/**\n * JSDoc\n */\n", "function foo() {}",
      );
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.ok(result[0]!.leadingDoc!.includes("JSDoc"));
    });

    it("extracts leading # comment (Python style)", () => {
      const { src, root } = makeSiblingNodes(
        "# helper function\n", "def foo():\n    pass",
        "function_definition", "comment", "module",
      );
      const result = walkTree(root as never, new Set(["function_definition"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "helper function");
    });

    it("extracts leading -- comment (SQL style)", () => {
      const { src, root } = makeSiblingNodes("-- helper function\n", "SELECT * FROM t");
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "helper function");
    });

    it("extracts leading ; comment (INI style)", () => {
      const { src, root } = makeSiblingNodes("; server config\n", "[server]", "section");
      const result = walkTree(root as never, new Set(["section"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "server config");
    });

    it("extracts leading % comment (LaTeX style)", () => {
      const { src, root } = makeSiblingNodes("% This is a section\n", "\\section{Intro}", "section");
      const result = walkTree(root as never, new Set(["section"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "This is a section");
    });

    it("extracts multiple consecutive comments", () => {
      const src = "// copyright\n// description\nfunction foo() {}";
      const c1 = makeNode("comment", 0, 14, 0, 0);
      const c2 = makeNode("comment", 14, 30, 1, 1);
      const fn = makeNode("function_declaration", 30, src.length, 2, 3);
      const root = makeNode("program", 0, src.length, 0, 3, [c1, c2, fn]);
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.ok(result[0]!.leadingDoc!.includes("copyright"));
      assert.ok(result[0]!.leadingDoc!.includes("description"));
    });

    it("does not extract unrelated comments (not directly preceding)", () => {
      const src = "function bar() {}\n// for foo\nfunction foo() {}";
      const otherFn = makeNode("function_declaration", 0, 17, 0, 1);
      const comment = makeNode("comment", 18, 28, 2, 2);
      const fn = makeNode("function_declaration", 29, src.length, 3, 4);
      const root = makeNode("program", 0, src.length, 0, 4, [otherFn, comment, fn]);
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 2);
      const foo = result.find((n) => n.text.includes("foo"));
      assert.ok(foo);
      assert.equal(foo.leadingDoc, "for foo");
      const bar = result.find((n) => n.text.includes("bar"));
      assert.ok(bar);
      assert.equal(bar.leadingDoc, undefined);
    });

    it("extracts leading HTML/XML comment", () => {
      const { src, root } = makeSiblingNodes(
        "<!-- main content -->\n", "<div>hello</div>",
        "element", "Comment", "document",
      );
      const result = walkTree(root as never, new Set(["element"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "main content");
    });

    it("extracts Kotlin line_comment", () => {
      const { src, root } = makeSiblingNodes(
        "// helper function\n", "fun foo() {}",
        "function_declaration", "line_comment",
      );
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "helper function");
    });

    it("extracts Swift multiline_comment", () => {
      const { src, root } = makeSiblingNodes(
        "/* helper */\n", "func foo() {}",
        "function_declaration", "multiline_comment",
      );
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "helper");
    });

    it("extracts SQL marginalia (block comment)", () => {
      const { src, root } = makeSiblingNodes(
        "/* helper */\n", "SELECT",
        "function_declaration", "marginalia",
      );
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "helper");
    });

    it("returns undefined when no preceding comment exists", () => {
      const src = "function foo() {}";
      const fn = makeNode("function_declaration", 0, src.length, 1, 2);
      const root = makeNode("program", 0, src.length, 0, 2, [fn]);
      const result = walkTree(root as never, new Set(["function_declaration"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, undefined);
    });

    it("extracts Python docstring from function body", () => {
      const src = "def foo():\n  \"\"\"Does something.\"\"\"\n  pass";
      const quoteText = '"""Does something."""';
      const quoteStart = src.indexOf(quoteText);
      const docString = makeNode("string", quoteStart, quoteStart + quoteText.length, 1, 1);
      const expr = makeNode("expression_statement", 10, src.length, 1, 2, [docString]);
      const block = makeNode("block", 10, src.length, 1, 2, [expr]);
      const name = makeNode("identifier", 4, 7, 0, 0);
      const params = makeNode("parameters", 7, 9, 0, 0);
      const colon = makeNode(":", 9, 10, 0, 0);
      const fn = makeNode("function_definition", 0, src.length, 0, 2, [name, params, colon, block]);
      const root = makeNode("module", 0, src.length, 0, 2, [fn]);
      const result = walkTree(root as never, new Set(["function_definition"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "Does something.");
    });

    it("extracts Python class docstring from class body", () => {
      const src = "class Foo:\n  \"\"\"A class.\"\"\"\n  pass";
      const quoteText = '"""A class."""';
      const quoteStart = src.indexOf(quoteText);
      const docString = makeNode("string", quoteStart, quoteStart + quoteText.length, 1, 1);
      const expr = makeNode("expression_statement", 9, src.length, 1, 2, [docString]);
      const block = makeNode("block", 9, src.length, 1, 2, [expr]);
      const name = makeNode("identifier", 6, 9, 0, 0);
      const colon = makeNode(":", 9, 10, 0, 0);
      const cls = makeNode("class_definition", 0, src.length, 0, 2, [name, colon, block]);
      const root = makeNode("module", 0, src.length, 0, 2, [cls]);
      const result = walkTree(root as never, new Set(["class_definition"]), src);
      assert.equal(result.length, 1);
      assert.ok(result[0]!.leadingDoc!.includes("A class."));
    });

    it("extracts leading Python docstring (module-level expression_statement)", () => {
      const src = "\"\"\"Module docstring.\"\"\"\ndef foo():\n  pass";
      const quoteText = '"""Module docstring."""';
      const docString = makeNode("string", 0, quoteText.length, 0, 0);
      const expr = makeNode("expression_statement", 0, quoteText.length, 0, 0, [docString]);
      const fn = makeNode("function_definition", quoteText.length + 1, src.length, 1, 2);
      const root = makeNode("module", 0, src.length, 0, 2, [expr, fn]);
      const result = walkTree(root as never, new Set(["function_definition"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "Module docstring.");
    });

    it("extracts Rust triple-slash doc comment", () => {
      const { src, root } = makeSiblingNodes("/// Does something\n", "fn foo() {}", "function_item");
      const result = walkTree(root as never, new Set(["function_item"]), src);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.leadingDoc, "Does something");
    });
  });
});

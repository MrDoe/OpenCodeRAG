import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { DocxChunker, extractDocxText } from "../../chunker/docx.js";
import { getChunker } from "../../chunker/factory.js";

/**
 * Build a minimal but structurally valid .docx archive around a document body.
 * @param inner - Markup placed inside `<w:body>`.
 * @returns The .docx file bytes.
 */
function makeDocx(inner: string): Buffer {
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${inner}</w:body></w:document>`;
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types/>`),
      "word/document.xml": strToU8(document),
    }),
  );
}

describe("extractDocxText", () => {
  it("extracts paragraph text separated by blank lines", () => {
    const buf = makeDocx(
      `<w:p><w:r><w:t>First.</w:t></w:r></w:p><w:p><w:r><w:t>Second.</w:t></w:r></w:p>`,
    );
    const text = extractDocxText(buf);
    assert.equal(text, "First.\n\nSecond.\n\n");
  });

  it("concatenates multiple runs within one paragraph without separators", () => {
    const buf = makeDocx(`<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>`);
    assert.equal(extractDocxText(buf), "Hello world\n\n");
  });

  it("preserves w:tab and w:br", () => {
    const buf = makeDocx(
      `<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>`,
    );
    assert.equal(extractDocxText(buf), "A\tB\nC\n\n");
  });

  it("decodes XML entities", () => {
    const buf = makeDocx(
      `<w:p><w:r><w:t>a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;</w:t></w:r></w:p>`,
    );
    assert.equal(extractDocxText(buf), `a & b <c> "d" A B\n\n`);
  });

  it("preserves leading and trailing spaces in w:t", () => {
    const buf = makeDocx(`<w:p><w:r><w:t xml:space="preserve">  pad  </w:t></w:r></w:p>`);
    assert.equal(extractDocxText(buf), "  pad  \n\n");
  });

  it("keeps table cell text as separate paragraphs", () => {
    const buf = makeDocx(
      `<w:tbl><w:tr>` +
        `<w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>` +
        `<w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>` +
        `</w:tr></w:tbl>`,
    );
    assert.equal(extractDocxText(buf), "A1\n\nB1\n\n");
  });

  it("ignores deleted text and text outside paragraphs", () => {
    const buf = makeDocx(
      `<w:t>ORPHAN</w:t><w:p><w:r><w:delText>GONE</w:delText></w:r><w:r><w:t>Kept</w:t></w:r></w:p>`,
    );
    assert.equal(extractDocxText(buf), "Kept\n\n");
  });

  it("keeps unicode intact", () => {
    const buf = makeDocx(`<w:p><w:r><w:t>caf\u00e9 \u2014 \u4f60\u597d</w:t></w:r></w:p>`);
    assert.equal(extractDocxText(buf), "caf\u00e9 \u2014 \u4f60\u597d\n\n");
  });

  it("returns empty string for a document with no text", () => {
    assert.equal(extractDocxText(makeDocx(`<w:p/>`)), "");
  });

  it("throws for an archive without word/document.xml", () => {
    const buf = Buffer.from(zipSync({ "readme.txt": strToU8("nope") }));
    assert.throws(() => extractDocxText(buf), /missing "word\/document\.xml"/);
  });

  it("throws for a non-ZIP buffer", () => {
    assert.throws(() => extractDocxText(Buffer.from("definitely not a zip")));
  });

  it("refuses to inflate an oversized document.xml (zip bomb guard)", () => {
    // A highly compressible body: small on disk, enormous once inflated.
    const bomb = `<!--${"A".repeat(80 * 1024 * 1024)}-->`;
    const buf = makeDocx(`<w:p><w:r><w:t>x</w:t></w:r></w:p>${bomb}`);
    assert.throws(() => extractDocxText(buf), /too large/);
  });

  it("feeds the chunker end-to-end with correct line metadata", async () => {
    const long = "Sentence ".repeat(40).trim();
    const buf = makeDocx(
      `<w:p><w:r><w:t>${long}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>${long}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>${long}</w:t></w:r></w:p>`,
    );
    const chunks = await new DocxChunker().chunk("t.docx", extractDocxText(buf));
    assert.equal(chunks.length, 3);
    assert.deepStrictEqual(
      chunks.map((c) => [c.metadata.startLine, c.metadata.endLine]),
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );
  });
});

describe("DocxChunker", () => {
  const chunker = new DocxChunker();

  it("returns empty array for empty content", async () => {
    const chunks = await chunker.chunk("test.docx", "");
    assert.deepStrictEqual(chunks, []);
  });

  it("returns empty array for whitespace-only content", async () => {
    const chunks = await chunker.chunk("test.docx", "   \n  \n   ");
    assert.deepStrictEqual(chunks, []);
  });

  it("creates single chunk for single paragraph", async () => {
    const chunks = await chunker.chunk("test.docx", "Hello world. This is a single paragraph.");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.metadata.startLine, 1);
    assert.equal(chunks[0]!.metadata.endLine, 1);
    assert.equal(chunks[0]!.metadata.language, "docx");
    assert.equal(chunks[0]!.metadata.filePath, "test.docx");
  });

  it("splits content by double-newline paragraphs when above grouping threshold", async () => {
    const para = Array.from({ length: 40 }, (_, i) => `This is sentence ${i + 1} in a paragraph that should be long enough to avoid grouping.`).join(" ");
    const content = `${para}\n\n${para}\n\n${para}`;
    const chunks = await chunker.chunk("test.docx", content);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0]!.metadata.startLine, 1);
    assert.equal(chunks[1]!.metadata.startLine, 2);
    assert.equal(chunks[2]!.metadata.startLine, 3);
  });

  it("groups small consecutive paragraphs together", async () => {
    const content = "Small A.\n\nSmall B.\n\nSmall C.\n\nLarge paragraph with enough text to pass the grouping threshold. " +
      "This one should be on its own because it is large enough.\n\nSmall D.";
    const chunks = await chunker.chunk("test.docx", content);
    assert(chunks.length <= 4);
    assert(chunks[0]!.content.includes("Small A."));
    assert(chunks[0]!.content.includes("Small C."));
  });

  it("handles oversized paragraph as its own chunk", async () => {
    const oversized = "A".repeat(5000);
    const chunks = await chunker.chunk("test.docx", oversized);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.content, oversized);
  });

  it("splits multiple paragraphs when total exceeds MAX_CHUNK_CHARS", async () => {
    const para = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} in a paragraph that is just long enough.`).join(" ");
    const manyParas = Array.from({ length: 8 }, () => para).join("\n\n");
    const chunks = await chunker.chunk("test.docx", manyParas);
    assert(chunks.length > 1);
  });

  it("generates unique ids for each chunk", async () => {
    const content = "One.\n\nTwo.\n\nThree.";
    const chunks = await chunker.chunk("test.docx", content);
    const ids = new Set(chunks.map((c) => c.id));
    assert.equal(ids.size, chunks.length);
  });

  it("sets correct language property", () => {
    assert.equal(chunker.language, "docx");
  });

  it("has correct file extensions", () => {
    assert.deepStrictEqual(chunker.fileExtensions, [".docx"]);
  });
});

describe("DocxChunker — factory registration", () => {
  it("is registered in factory for .docx extension", () => {
    const chunker = getChunker("document.docx");
    assert.ok(chunker, "should return a chunker for .docx");
    assert.equal(chunker!.language, "docx");
  });
});

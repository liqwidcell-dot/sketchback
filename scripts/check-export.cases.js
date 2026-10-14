/**
 * Cases for `npm run check:export` (see scripts/check-export.mjs).
 *
 * This file is appended to a copy of `src/main.tsx`, so it runs in that
 * module's scope: it can call `sanitizeFileName`, `rewriteWikilinks`,
 * `exportIdeaTree` and friends directly, and it drives the real
 * `MemoryPlatform` (whose `written`/`copied` maps are the assertions).
 *
 * Top-level `const`/`function` names here must not collide with the app's.
 */

const failures = [];
let checks = 0;

function check(name, ok, detail) {
  checks += 1;
  if (!ok) failures.push(detail ? `${name} — ${detail}` : name);
}

function eq(name, actual, expected) {
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/** A one-paragraph ProseMirror doc, the shape a `text` block stores. */
const para = (text, marks) => ({
  type: "doc",
  content: [
    { type: "paragraph", content: [marks ? { type: "text", text, marks } : { type: "text", text }] },
  ],
});

async function runTests() {
  /* 1. Filename sanitiser ------------------------------------------------ */
  eq("sanitize: strips hostile chars", sanitizeFileName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'), "abcdefghijklmn");
  eq("sanitize: collapses whitespace", sanitizeFileName("  two   words  "), "two words");
  eq("sanitize: trailing dots and spaces", sanitizeFileName("note... "), "note");
  eq("sanitize: all-hostile falls back", sanitizeFileName("///"), "Untitled");
  eq("sanitize: empty falls back", sanitizeFileName("   "), "Untitled");
  eq("sanitize: caps length", sanitizeFileName("x".repeat(200)).length, 80);
  eq("sanitize: keeps ordinary unicode", sanitizeFileName("Café — notes"), "Café — notes");
  eq("sanitize: keeps a legal bang", sanitizeFileName("Main!"), "Main!");

  /* 2. Uniquifier -------------------------------------------------------- */
  {
    const used = new Set();
    eq("unique: first keeps the name", uniqueFileName("Note", used), "Note");
    eq("unique: second gets a suffix", uniqueFileName("Note", used), "Note 2");
    eq("unique: case-insensitive", uniqueFileName("note", used), "note 3");
  }

  /* 3. Wikilink parsing (plan §13) --------------------------------------- */
  eq("parse: bare", parseWikilinkBody("Note"), { target: "Note", heading: null, alias: null });
  eq("parse: alias", parseWikilinkBody("Note|shown"), { target: "Note", heading: null, alias: "shown" });
  eq("parse: heading", parseWikilinkBody("Note#Bit"), { target: "Note", heading: "Bit", alias: null });
  eq(
    "parse: heading and alias",
    parseWikilinkBody("Note#Bit|shown"),
    { target: "Note", heading: "Bit", alias: "shown" },
  );

  /* 4. What the serializer actually emits — the finding that shaped the
        design. `[` and `]` are backslash-escaped, so matching the raw form
        would find nothing at all. ----------------------------------------- */
  {
    const md = markdownManager().serialize(para("See [[Other Idea]] and [[One|two]] here"));
    console.log("SERIALIZER:", JSON.stringify(md));
    check("serializer: brackets are escaped", md.includes("\\[\\[Other Idea\\]\\]"), md);
    check(
      "serializer: escaped form is what we match",
      extractWikilinks(md).length === 2,
      JSON.stringify(extractWikilinks(md)),
    );
    eq(
      "serializer: extracted targets",
      extractWikilinks(md).map((link) => [link.target, link.alias, link.embed]),
      [
        ["Other Idea", null, false],
        ["One", "two", false],
      ],
    );
  }

  /* 4b. Escaped characters inside a link body must round-trip, including the
         HTML entities the serializer emits before escaping. --------------- */
  {
    const md = markdownManager().serialize(para("[[snake_case]] and [[Mum & Dad]] and [[a*b]]"));
    console.log("ESCAPED BODIES:", JSON.stringify(md));
    eq(
      "extract: unescapes the body",
      extractWikilinks(md).map((link) => link.target),
      ["snake_case", "Mum & Dad", "a*b"],
    );
  }

  /* 4c. A wikilink inside code is NOT escaped, and must be left alone. --- */
  {
    const resolve = (target) => (target === "Other Idea" ? "Other Idea.md" : null);
    const blank = () => ({ rewritten: 0, kept: [], unresolved: [], missing: [] });

    const fenced = markdownManager().serialize({
      type: "doc",
      content: [{ type: "codeBlock", content: [{ type: "text", text: "see [[Other Idea]]" }] }],
    });
    const fencedStats = blank();
    const fencedOut = rewriteWikilinks(fenced, resolve, fencedStats);
    console.log("FENCED:", JSON.stringify(fencedOut));
    check("code: fenced block is untouched", fencedOut.includes("[[Other Idea]]"), fencedOut);
    check("code: fenced block is not linked", !fencedOut.includes(".md)"), fencedOut);
    eq("code: fenced block counts nothing", [fencedStats.rewritten, fencedStats.unresolved.length], [0, 0]);

    const inline = markdownManager().serialize(para("[[Other Idea]]", [{ type: "code" }]));
    const inlineStats = blank();
    const inlineOut = rewriteWikilinks(inline, resolve, inlineStats);
    console.log("INLINE CODE:", JSON.stringify(inlineOut));
    check("code: inline code is untouched", inlineOut.includes("[[Other Idea]]"), inlineOut);
    eq("code: inline code counts nothing", inlineStats.rewritten, 0);
  }

  /* 5. Link rewriting ---------------------------------------------------- */
  {
    const resolve = (target) => (target === "Other Idea" ? "Other Idea.md" : null);
    const stats = { rewritten: 0, kept: [], unresolved: [], missing: [] };
    const md = markdownManager().serialize(
      para("a [[Other Idea]] b [[Ghost]] c [[Other Idea#Bit]] d ![[pic.png]] e [[Other Idea|here]]"),
    );
    const out = rewriteWikilinks(md, resolve, stats);
    console.log("REWRITE:", JSON.stringify(out));
    check("rewrite: resolvable becomes a relative link", out.includes("[Other Idea](Other%20Idea.md)"), out);
    check("rewrite: alias becomes the label", out.includes("[here](Other%20Idea.md)"), out);
    check("rewrite: unresolvable stays a wikilink", out.includes("[[Ghost]]"), out);
    check("rewrite: heading link is kept", out.includes("[[Other Idea#Bit]]"), out);
    check("rewrite: media embed is kept", out.includes("![[pic.png]]"), out);
    check("rewrite: no escaped brackets survive", !out.includes("\\["), out);
    eq(
      "rewrite: tallies",
      [stats.rewritten, stats.kept.length, stats.unresolved.length, stats.missing.length],
      [2, 1, 1, 1],
    );
  }

  /* 6. End to end through the real tree builder -------------------------- */
  {
    const stamp = 1700000000000;
    const mkIdea = (id, title) => ({
      id,
      title,
      icon: null,
      pinned: 0,
      created_at: stamp,
      updated_at: stamp,
    });
    const block = (id, ideaId, order, dataJson, type = "text") => ({
      id,
      idea_id: ideaId,
      type,
      order_key: order,
      data_json: dataJson,
      created_at: 0,
      updated_at: 0,
    });

    const ideas = [mkIdea("i1", "Main"), mkIdea("i2", "Other Idea")];
    const blocks = {
      i1: [
        block("b1", "i1", "a0", JSON.stringify(para("Links to [[Other Idea]] and [[Nobody]]"))),
        block("b2", "i1", "a1", JSON.stringify(para("second block"))),
        // A block type markdown cannot carry: the export must say so plainly
        // rather than drop it or pretend it succeeded (plan §22).
        block("b3", "i1", "a2", "{}", "sketch"),
      ],
      i2: [block("b4", "i2", "a0", JSON.stringify(para("the other note")))],
    };

    /** Serves the two queries `exportIdeaTree` makes, keyed by the SQL text. */
    const serve = (ideaRows, blockRows) => {
      platform.db.all = async (sql, params) => {
        const text = String(sql);
        if (text.includes("FROM idea")) return ideaRows;
        if (text.includes("FROM block")) return blockRows[params[0]] || [];
        return [];
      };
    };

    serve(ideas, blocks);
    const summary = await exportIdeaTree(ideas[0], "/out");
    const keys = [...platform.written.keys()].sort();
    console.log("WROTE:", JSON.stringify(keys));
    console.log("SUMMARY:", JSON.stringify(summary));

    eq("e2e: tree", keys, ["/out/Main/Main.md", "/out/Main/Other Idea.md"]);
    eq("e2e: summary files", summary.ideas, ["Main.md", "Other Idea.md"]);
    eq("e2e: folder", summary.folder, "/out/Main");
    eq("e2e: blobs", summary.blobs, 0);
    eq("e2e: links rewritten", summary.linksRewritten, 1);

    const main = platform.written.get("/out/Main/Main.md");
    check("e2e: frontmatter", main.startsWith('---\ntitle: "Main"\n'), main.slice(0, 48));
    check(
      "e2e: frontmatter dates",
      main.includes(`created: ${new Date(stamp).toISOString()}`),
      main.slice(0, 120),
    );
    check("e2e: wikilink rewritten", main.includes("[Other Idea](Other%20Idea.md)"), main);
    check("e2e: unresolved kept", main.includes("[[Nobody]]"), main);
    check("e2e: unresolved reported", summary.notes.some((n) => n.includes("Nobody")), JSON.stringify(summary.notes));
    check("e2e: sketch reported", summary.notes.some((n) => n.includes("1 sketch block")), JSON.stringify(summary.notes));
    check("e2e: sketch gap marked", main.includes("<!-- sketchback: a sketch block"), main);
    check("e2e: both blocks present", main.includes("second block"), main);
    check("e2e: no escaped brackets leak into the file", !main.includes("\\["), main);
    check("e2e: no attachments copied", platform.copied.size === 0);
    check("e2e: report has a folder and a size", summary.bytes > 0, String(summary.bytes));

    /* Two ideas whose titles collide *after* sanitising must both survive.
       (`Main.` sanitises to `Main`, because a trailing dot is a Windows trap.) */
    platform.written.clear();
    serve([mkIdea("i1", "Main"), mkIdea("i3", "Main.")], {
      i1: [block("c1", "i1", "a0", JSON.stringify(para("see [[Main.]]")))],
      i3: [block("c2", "i3", "a0", JSON.stringify(para("the other Main")))],
    });
    await exportIdeaTree(mkIdea("i1", "Main"), "/out");
    eq(
      "e2e: colliding titles get distinct files",
      [...platform.written.keys()].sort(),
      ["/out/Main/Main 2.md", "/out/Main/Main.md"],
    );
    check(
      "e2e: link follows the renamed file",
      platform.written.get("/out/Main/Main.md").includes("[Main.](Main%202.md)"),
      platform.written.get("/out/Main/Main.md"),
    );

    /* A title that sanitises to nothing must still produce a file. */
    platform.written.clear();
    serve([mkIdea("i1", "???")], { i1: [] });
    await exportIdeaTree(mkIdea("i1", "???"), "/out");
    eq("e2e: unusable title falls back", [...platform.written.keys()], ["/out/Untitled/Untitled.md"]);

    /* A link to something that is not a note is reported, not fabricated: the
       blob store is plan §12 and there is nothing to copy yet. */
    platform.written.clear();
    serve([mkIdea("i1", "Main")], {
      i1: [block("m1", "i1", "a0", JSON.stringify(para("![[shot.png]]")))],
    });
    const mediaSummary = await exportIdeaTree(mkIdea("i1", "Main"), "/out");
    check(
      "e2e: media reference reported, not fabricated",
      mediaSummary.notes.some((n) => n.includes("shot.png")),
      JSON.stringify(mediaSummary.notes),
    );
    check(
      "e2e: media embed left as an Obsidian embed",
      platform.written.get("/out/Main/Main.md").includes("![[shot.png]]"),
      platform.written.get("/out/Main/Main.md"),
    );

    /* A cycle must terminate, and export each idea once. */
    platform.written.clear();
    serve([mkIdea("i1", "A"), mkIdea("i2", "B")], {
      i1: [block("d1", "i1", "a0", JSON.stringify(para("to [[B]]")))],
      i2: [block("d2", "i2", "a0", JSON.stringify(para("back to [[A]]")))],
    });
    const cycle = await exportIdeaTree(mkIdea("i1", "A"), "/out");
    eq("e2e: a link cycle terminates", [...platform.written.keys()].sort(), ["/out/A/A.md", "/out/A/B.md"]);
    eq("e2e: both cycle links rewritten", cycle.linksRewritten, 2);
  }

  /* 7. Slash menu (plan §9:612) ------------------------------------------ */

  /**
   * A fake editor state carrying only what `slashQueryAt` reads. `pos` is any
   * doc position; the result is expressed relative to it.
   */
  const slashStateOf = (before, kind = "paragraph", empty = true) => ({
    selection: {
      empty,
      $from: {
        parent: { type: { name: kind }, textBetween: () => before },
        parentOffset: before.length,
        pos: 100,
      },
    },
  });

  eq("slash: a bare slash opens empty", slashQueryAt(slashStateOf("/")), { query: "", from: 99, to: 100 });
  eq("slash: the query follows the slash", slashQueryAt(slashStateOf("/h1")), {
    query: "h1",
    from: 97,
    to: 100,
  });
  eq("slash: opens mid-line after a space", slashQueryAt(slashStateOf("see /qu")), {
    query: "qu",
    from: 97,
    to: 100,
  });
  eq("slash: a slash inside a word is not one", slashQueryAt(slashStateOf("a/b")), null);
  eq("slash: a URL is not one", slashQueryAt(slashStateOf("go http://exa")), null);
  eq("slash: a second slash ends the query", slashQueryAt(slashStateOf("/a/b")), null);
  eq("slash: a space ends the query", slashQueryAt(slashStateOf("/h1 ")), null);
  eq("slash: a heading can open one", slashQueryAt(slashStateOf("/h2", "heading")), {
    query: "h2",
    from: 97,
    to: 100,
  });
  eq("slash: a code block cannot", slashQueryAt(slashStateOf("/img", "codeBlock")), null);
  eq("slash: a live selection is not one", slashQueryAt(slashStateOf("/h1", "paragraph", false)), null);

  eq("slash menu: an empty query lists everything", filterSlash("").length, SLASH_COMMANDS.length);
  eq("slash menu: h1 finds one", filterSlash("h1").map((c) => c.label), ["Heading 1"]);
  eq("slash menu: head finds all three", filterSlash("head").length, 3);
  eq("slash menu: list finds both lists", filterSlash("list").length, 2);
  eq("slash menu: a keyword works too", filterSlash("hr").map((c) => c.label), ["Divider"]);
  eq("slash menu: nothing matches nothing", filterSlash("zzz"), []);
  eq(
    "slash menu: labels are unique",
    new Set(SLASH_COMMANDS.map((c) => c.label)).size,
    SLASH_COMMANDS.length,
  );
  check(
    "slash menu: every entry is runnable and searchable",
    SLASH_COMMANDS.every(
      (c) => c.label && c.icon && c.keywords.length > 0 && typeof c.run === "function",
    ),
  );
}

runTests().then(() => {
  const passed = checks - failures.length;
  console.log(`\n${passed}/${checks} checks passed`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const failure of failures) console.log(` - ${failure}`);
    process.exitCode = 1;
  }
});

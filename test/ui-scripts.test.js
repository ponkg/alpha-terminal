import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1].trim())
  .filter(Boolean);

test("all inline browser scripts parse", () => {
  assert.ok(scripts.length >= 2, "expected the app scripts and UI controller");
  scripts.forEach((source, index) => {
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: "public/index.html:inline-script-" + index }),
      "inline script " + index + " should be valid JavaScript"
    );
  });
});

test("persisted beta sessions only restore the terminal on its explicit route", () => {
  assert.match(
    html,
    /if\s*\(location\.hash\s*===\s*['"]#terminal['"]\)\s*boot\(enter\)/,
    "a saved session must not replace the public landing page"
  );
});

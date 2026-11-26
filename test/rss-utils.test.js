import test from "node:test";
import assert from "node:assert/strict";
import { cleanRssText, decodeRssEntities } from "../lib/rss-utils.js";

test("decodes named, decimal and hexadecimal entities", () => {
  assert.equal(decodeRssEntities("Fish &amp; Chips &#8217; &#x1F680;"), "Fish & Chips ’ 🚀");
});

test("decodes repeated entities and non-breaking spaces", () => {
  assert.equal(cleanRssText("alpha&amp;nbsp;&amp;nbsp;terminal"), "alpha terminal");
  assert.equal(cleanRssText("alpha&nbsp;&nbsp;terminal"), "alpha terminal");
});

test("strips markup and collapses RSS description whitespace", () => {
  const input = "<p>Fish &amp; Chips</p><p>It&#8217;s <b>fresh</b>.</p>";
  assert.equal(cleanRssText(input), "Fish & Chips It’s fresh.");
});

test("removes script and style content", () => {
  const input = "<p>Headline</p><script>alert('x')</script><style>.x{display:none}</style><p>Summary</p>";
  assert.equal(cleanRssText(input), "Headline Summary");
});

test("unwraps CDATA and leaves unknown entities unchanged", () => {
  assert.equal(cleanRssText("<![CDATA[<b>Inside</b> &mystery;]]>"), "Inside &mystery;");
});

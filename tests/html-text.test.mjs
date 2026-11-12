import test from "node:test";
import assert from "node:assert/strict";
import { htmlText } from "../server/safe-fetch.mjs";

test("a main containing an article example keeps every later section", () => {
  const source = `<title>Developing &amp; testing</title><article>Outside article is not the selected main.</article><main>
    <h1>Development tips</h1><h2>1. Structure</h2><p>Use headings.</p>
    <article><h2>2. A working article example</h2><p>Example body.</p></article>
    ${Array.from({ length: 8 }, (_, index) => `<h2>${index + 3}. Tip</h2><p>Actual advice ${index + 3}.</p>`).join("")}
    </main><aside>Unrelated page shell.</aside>`;
  const result = htmlText(source);
  assert.equal(result.title, "Developing & testing");
  assert.match(result.text, /Example body/);
  for (let index = 3; index <= 10; index++) assert.ok(result.text.includes(`Actual advice ${index}.`), `tip ${index} must survive the article closing tag`);
  assert.doesNotMatch(result.text, /Outside article|Unrelated page shell/);
});

test("nested main elements match their corresponding outer close and preserve the following paragraph", () => {
  const result = htmlText("<main><p>Outer beginning.</p><main><p>Nested main content.</p></main><p>Outer ending.</p></main><p>Outside main.</p>");
  assert.match(result.text, /Outer beginning/);
  assert.match(result.text, /Nested main content/);
  assert.match(result.text, /Outer ending/);
  assert.doesNotMatch(result.text, /Outside main/);
});

test("without a main the outer article owns nested articles and everything after them", () => {
  const result = htmlText("<nav><article>Navigation example must not win.</article></nav><article><p>Outer article.</p><article><p>Nested article.</p></article><p>Article ending.</p></article><p>Outside article.</p>");
  assert.match(result.text, /Outer article/);
  assert.match(result.text, /Nested article/);
  assert.match(result.text, /Article ending/);
  assert.doesNotMatch(result.text, /Navigation example|Outside article/);
});

test("fake closing tags and greater-than signs inside quoted attributes never cut the body", () => {
  const result = htmlText(`<title data-example="</title>">Real title</title><main data-example='</main> > <article>'>
    <p data-close="</main></article>" title='quote > continues'>Actual first paragraph.</p>
    <article data-close='</article>'><p>Nested actual body.</p></article>
    <p>Actual last paragraph.</p></main><p>Outside.</p>`);
  assert.equal(result.title, "Real title");
  assert.match(result.text, /Actual first paragraph/);
  assert.match(result.text, /Nested actual body/);
  assert.match(result.text, /Actual last paragraph/);
  assert.doesNotMatch(result.text, /data-example|data-close|quote > continues|Outside/);
});

test("comments containing complete fake containers and close tags never affect scope or become evidence", () => {
  const result = htmlText(`<!-- <main>Fake body.</main><title>Wrong title</title> --><title>Right title</title>
    <main><p>First real paragraph.</p><!-- </main><article>Secret comment.</article> -->
    <p>Last real paragraph.</p></main><p>Outside.</p>`);
  assert.equal(result.title, "Right title");
  assert.match(result.text, /First real paragraph/);
  assert.match(result.text, /Last real paragraph/);
  assert.doesNotMatch(result.text, /Fake body|Secret comment|Wrong title|Outside/);
});

test("raw script and style content cannot invent containers, and omitted regions remain omitted", () => {
  const result = htmlText(`<script>const fake = '<main>Wrong main</main>';</script><style>.fake::after{content:'</main>'}</style>
    <header>Header text.</header><main><p>Real start.</p>
    <nav data-close="</nav>"><nav>Nested navigation.</nav>Navigation tail.</nav>
    <script>const fakeClose = '</main>'; const fakeOpen = '<article>';</script>
    <style>.fake::after{content:'</main>'}</style>
    <noscript><main>Noscript fake main.</main></noscript>
    <svg><text>SVG internal label.</text></svg><footer>Footer text.</footer>
    <p>Real ending.</p></main>`);
  assert.match(result.text, /Real start/);
  assert.match(result.text, /Real ending/);
  assert.doesNotMatch(result.text, /Wrong main|fakeClose|fakeOpen|Navigation|navigation|Header text|Footer text|SVG internal|Noscript/);
});

test("encoded HTML examples remain visible text and raw textarea close examples do not close the main", () => {
  const result = htmlText("<MAIN><p>Use &lt;article&gt; and &lt;/article&gt; in examples.</p><textarea>Literal </main> is textarea data.</textarea><p>Actual final text.</p></MAIN>");
  assert.match(result.text, /Use <article> and <\/article> in examples/);
  assert.match(result.text, /Literal <\/main> is textarea data/);
  assert.match(result.text, /Actual final text/);
});

test("empty and unclosed main scopes do not fall back to unrelated content", () => {
  assert.equal(htmlText("<title>Title</title><main></main><article>Unrelated article</article>").text, "");
  const result = htmlText("<main><p>Opening paragraph.</p><article>Nested example.</article><p>Remaining source.</p>");
  assert.match(result.text, /Opening paragraph/);
  assert.match(result.text, /Remaining source/);
});

test("HTML trailing slashes do not make script or nav content visible and foreign self-closing roots do not swallow the page", () => {
  const result = htmlText("<title></title><main/><p>Start.</p><script/>Script content.</script><nav/>Navigation content.</nav><svg/><p>End.</p></main>");
  assert.equal(result.title, "网页收藏");
  assert.match(result.text, /Start/);
  assert.match(result.text, /End/);
  assert.doesNotMatch(result.text, /Script content|Navigation content/);
});

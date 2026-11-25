import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createApp } from "../server.mjs";

const script = await readFile(new URL("../resume-ai.js", import.meta.url), "utf8");
const { makeWorkPrompt, prepareAiText, readWorkDraft } = runInNewContext(
  script + "\n({ makeWorkPrompt, prepareAiText, readWorkDraft })",
);

test("opens on loopback and serves only files needed by the application", async t => {
  const server = createApp();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Черновик через ChatGPT/);
  assert.equal((await fetch(origin + "/template.b64.txt", { method: "HEAD" })).status, 200);
  assert.equal((await fetch(origin + "/server.mjs")).status, 404);
  assert.equal((await fetch(origin + "/api/resume-draft", { method: "POST" })).status, 404);
  assert.equal((await fetch(origin, { method: "POST" })).status, 405);
});

test("masks recognised contacts in the prompt and preserves employment dates", () => {
  const source = [
    "Тестов Иван Иванович", "Иван Иванович Тестов", "Контакты: @example", "test@example.com",
    "+7 (900) 000-00-00", "8 901 000 00 00", "https://example.com/me", "01.2020 – 05.2024", "QA, SQL",
  ].join("\n");
  const text = prepareAiText(source, { name_full: "Тестов Иван Иванович", knownValues: ["   "] });
  assert.doesNotMatch(text, /Тестов|Иванович|@|900|901|https/);
  assert.match(text, /01\.2020 – 05\.2024\nQA, SQL/);

  const prompt = makeWorkPrompt(text, "REST API, Kafka", "test-id");
  assert.match(prompt, /"request_id": "test-id"/);
  assert.match(prompt, /"vacancy": "REST API, Kafka"/);
  assert.doesNotMatch(prompt, /Тестов|example\.com/);
});

const draft = {
  request_id: "test-id", title: "QA", experience_line: "",
  skills_testing: ["Тестирование API"], skills_tech: [],
  jobs: [], education: [], courses: [], notes: ["Уточните опыт с Kafka."],
};

test("imports a JSON response from ChatGPT with or without a code fence", () => {
  const { request_id, ...expected } = draft;
  for (const reply of [JSON.stringify(draft), "Готово.\n```json\n" + JSON.stringify(draft) + "\n```"]) {
    assert.deepEqual(JSON.parse(JSON.stringify(readWorkDraft(reply, request_id))), expected);
  }
});

test("rejects replies from another request and malformed drafts", () => {
  assert.throws(() => readWorkDraft(JSON.stringify(draft), "another-id"), /другому запросу/);
  assert.throws(() => readWorkDraft(JSON.stringify({ ...draft, jobs: [null] }), "test-id"), /Не удалось прочитать/);
  assert.throws(() => readWorkDraft("комментарий без черновика", "test-id"), /Не удалось прочитать/);
  assert.throws(() => readWorkDraft(JSON.stringify({ ...draft, email: "fake@example.com" }), "test-id"), /Не удалось прочитать/);
});

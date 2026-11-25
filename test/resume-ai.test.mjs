import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createApp } from "../server.mjs";

async function startApp(t, options) {
  const server = createApp(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

const example = { resume: "Инженер QA. Тестировал REST API, использовал Postman.", vacancy: "REST API, Kafka." };
const exampleDraft = {
  title: "Инженер QA", experience_line: "",
  skills_testing: ["Тестирование REST API"], skills_tech: [{ label: "API", value: "Postman" }],
  jobs: [], education: [], courses: [], notes: ["Опыт работы с Kafka в резюме не указан."],
};

function requestDraft(origin, payload = example, sender = origin) {
  return fetch(`${origin}/api/resume-draft`, {
    method: "POST",
    headers: { Origin: sender, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function modelOutput(...content) {
  return Response.json({ status: "completed", output: [{ type: "message", content }] });
}

test("passes only the confirmed text to OpenAI and returns a structured draft", async t => {
  let request;
  const origin = await startApp(t, {
    apiKey: "local-test-key",
    fetchOpenAI: async (url, options) => {
      request = { url, headers: options.headers, body: JSON.parse(options.body) };
      return modelOutput({ type: "output_text", text: JSON.stringify(exampleDraft) });
    },
  });
  const result = await requestDraft(origin, { ...example, name_full: "Личные данные", photo: "Изображение" });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { draft: exampleDraft });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.headers.Authorization, "Bearer local-test-key");
  assert.deepEqual(JSON.parse(request.body.input), example);
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.text.format.schema.additionalProperties, false);
});

test("rejects other origins, empty or oversized input before contacting the model", async t => {
  let contacted = false;
  const origin = await startApp(t, { apiKey: "test", fetchOpenAI: async () => { contacted = true; } });
  const wrongOrigin = await requestDraft(origin, example, "https://example.com");
  const empty = await requestDraft(origin, { ...example, resume: " " });
  const oversize = await requestDraft(origin, { ...example, resume: "x".repeat(45_001) });
  assert.deepEqual([wrongOrigin.status, empty.status, oversize.status], [403, 400, 413]);
  assert.equal(contacted, false);
});

test("serves the app with no key and keeps local files outside the static routes", async t => {
  const origin = await startApp(t);
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Черновик с ИИ/);
  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  assert.equal((await fetch(`${origin}/server.mjs`)).status, 404);
  assert.equal((await requestDraft(origin)).status, 503);
});

test("leaves an invalid, incomplete or refused draft unapplied", async t => {
  const responses = [
    modelOutput({ type: "output_text", text: JSON.stringify({ ...exampleDraft, jobs: null }) }),
    Response.json({ status: "incomplete", output: [] }),
    modelOutput({ type: "refusal", refusal: "refused" }),
    Response.json({}, { status: 429 }),
  ];
  const origin = await startApp(t, { apiKey: "test", fetchOpenAI: async () => responses.shift() });
  for (const status of [502, 422, 422, 429]) {
    const response = await requestDraft(origin);
    assert.equal(response.status, status);
    const result = await response.json();
    assert.equal(typeof result.error, "string");
    assert.equal(result.draft, undefined);
  }
});

test("hides recognised contacts while preserving employment dates and skills", async () => {
  const script = await readFile(new URL("../resume-ai.js", import.meta.url), "utf8");
  const prepareAiText = runInNewContext(`${script}\nprepareAiText`);
  const redacted = prepareAiText([
    "Тестов Иван Иванович", "Иван Иванович Тестов", "Контакты: @example", "test@example.com",
    "+7 (900) 000-00-00", "8 901 000 00 00", "https://example.com/me", "01.2020 – 05.2024", "QA, SQL",
  ].join("\n"), { name_full: "Тестов Иван Иванович" });
  assert.doesNotMatch(redacted, /Тестов|Иванович|@|900|901|https/);
  assert.match(redacted, /01\.2020 – 05\.2024\nQA, SQL/);
});

function prepareAiText(source, identity) {
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const knownValues = new Set([identity.name_full, identity.name_short, identity.phone, identity.email]);
  const parts = (identity.name_full || "").trim().split(/\s+/);
  if (parts.length >= 2) {
    knownValues.add([parts[1], parts[0], ...parts.slice(2)].join(" "));
    knownValues.add([...parts.slice(1), parts[0]].join(" "));
  }
  let text = source;
  for (const value of knownValues) {
    if (value) text = text.replace(new RegExp(value.trim().split(/\s+/).map(escapeRegex).join("\\s+"), "gi"), "[скрыто]");
  }
  return text
    .replace(/^[ \t]*(?:ф\.?[ \t]*и\.?[ \t]*о\.?|имя|телефон|мобильный|e-?mail|эл\.?[ \t]*почта|контакты|адрес|дата рождения|гражданство|telegram|телеграм|skype|whatsapp)[ \t]*[:：][^\r\n]*/gim, "[скрыто]")
    .replace(/[\p{L}\d_.+-]+@[\p{L}\d.-]+\.[\p{L}]{2,}|(?:https?:\/\/|www\.|t\.me\/)[^\s<>]+/giu, "[скрыто]")
    .replace(/(?<![\p{L}\d])(?:\+\d(?:[ \t.()\u00a0-]*\d){9,14}|[78][ \t.(\u00a0-]*\d{3}[ \t.)\u00a0-]*\d{3}[ \t.\u00a0-]*\d{2}[ \t.\u00a0-]*\d{2}|\d{10,15})(?![\p{L}\d])/gu, "[скрыто]");
}

function draftText(data) {
  if (!data) return "Редактор пока пуст.";
  const list = items => items.map(item => `• ${item}`).join("\n");
  const withLabel = ({ label, value }) => [label?.replace(/[:：]$/, ""), value].filter(Boolean).join(": ");
  const section = (title, value) => value && `${title}\n${value}`;
  return [
    section("Должность и стаж", [data.title, data.experience_line].filter(Boolean).join("\n")),
    section("Тестирование", list(data.skills_testing)),
    section("Ключевые технологии", list(data.skills_tech.map(withLabel))),
    section("Места работы и проекты", data.jobs.map(job => [
      [job.period, job.company, job.role].filter(Boolean).join(" · "),
      job.description,
      ...job.fields.map(withLabel),
      list(job.duties),
      ...job.extras.map(group => section(group.label, list(group.items))),
      section("Технологии", job.tech),
    ].filter(Boolean).join("\n")).join("\n\n")),
    section("Образование", list(data.education.map(e => [e.period, e.institution, e.faculty, e.level].filter(Boolean).join(" · ")))),
    section("Курсы и сертификаты", list(data.courses.map(c => [c.period, c.name].filter(Boolean).join(" · ")))),
  ].filter(Boolean).join("\n\n") || "Нет заполненных полей.";
}

function initResumeAi({ source, identity, current, normalize, apply }) {
  const $ = id => document.getElementById(id);
  const prepare = $("aiPrepare");
  const review = $("aiReview");
  const status = $("aiStatus");
  const send = $("aiSend");
  const cancel = $("aiCancel");
  const draftButton = $("aiOpenDraft");
  let pending = null;
  let draft = null;

  function refresh() {
    $("aiOpenPrepare").disabled = !!pending || !source().trim();
    cancel.hidden = !pending;
    draftButton.hidden = !draft;
    draftButton.disabled = !!pending;
  }

  function report(message, error = false) {
    status.textContent = message;
    status.classList.toggle("err", error);
    status.classList.toggle("notice", error);
  }

  function stop() {
    pending?.abort();
    pending = null;
  }

  $("aiOpenPrepare").addEventListener("click", () => {
    $("aiSource").value = prepareAiText(source(), identity());
    $("aiVacancy").value = prepareAiText($("vacancy").value, identity());
    $("aiPrepareError").hidden = true;
    prepare.showModal();
  });

  $("aiClosePrepare").addEventListener("click", () => prepare.close());
  $("aiCloseReview").addEventListener("click", () => review.close());
  prepare.addEventListener("close", () => {
    $("aiSource").value = "";
    $("aiVacancy").value = "";
  });

  send.addEventListener("click", async () => {
    const resume = $("aiSource").value.trim();
    const vacancy = $("aiVacancy").value.trim();
    const error = $("aiPrepareError");
    if (!resume || resume.length > 45_000 || vacancy.length > 12_000) {
      error.textContent = !resume ? "Добавьте текст резюме." : "Сократите текст: до 45 000 символов для резюме и 12 000 для вакансии.";
      error.hidden = false;
      return;
    }

    const request = new AbortController();
    pending = request;
    prepare.close();
    report("OpenAI готовит черновик…");
    refresh();
    try {
      const response = await fetch("/api/resume-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume, vacancy }),
        signal: request.signal,
      });
      const result = await response.json().catch(() => null);
      if (pending !== request) return;
      if (!response.ok || !result?.draft) {
        report(result?.error || "Запустите приложение через локальный сервер и повторите запрос.", true);
        return;
      }
      draft = normalize(result.draft);
      report("Черновик готов. Сравните его с текущей версией перед применением.");
    } catch {
      if (pending === request) report("Связь с локальным сервером прервана. Повторите запрос.", true);
    } finally {
      if (pending === request) {
        pending = null;
        refresh();
      }
    }
  });

  cancel.addEventListener("click", () => {
    stop();
    report("Запрос отменён.");
    refresh();
    $("aiOpenPrepare").focus();
  });

  draftButton.addEventListener("click", () => {
    $("aiCurrentText").textContent = draftText(current());
    $("aiDraftText").textContent = draftText(draft);
    const notes = $("aiDraftNotes");
    notes.replaceChildren(...draft.notes.map(note => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    }));
    $("aiNotesBox").hidden = !draft.notes.length;
    review.showModal();
  });

  $("aiApplyDraft").addEventListener("click", () => {
    if (!draft) return;
    review.close();
    apply(draft);
    draft = null;
    report("Черновик перенесён в редактор. Проверьте поля и сформируйте файл.");
    refresh();
    $("editorTitle").focus();
    $("editorTitle").scrollIntoView({ block: "start" });
  });

  return {
    refresh,
    reset() {
      stop();
      draft = null;
      if (prepare.open) prepare.close();
      if (review.open) review.close();
      report("");
      refresh();
    },
  };
}

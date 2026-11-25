#!/usr/bin/env python3
"""Fill the Word template and export a corporate resume without network calls."""

import argparse
import base64
from copy import deepcopy
from io import BytesIO
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

from lxml import etree as xml


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
XML = "http://www.w3.org/XML/1998/namespace"
REG, MED = "Montserrat", "Montserrat Medium"
DOC = "word/document.xml"
TEMPLATE = Path(__file__).resolve().parents[1] / "assets" / "corporate-cv.docx"


def tag(name):
    return f"{{{W}}}{name}"


def children(node, name):
    return node.findall(tag(name))


def parse(content):
    return xml.fromstring(content, parser=xml.XMLParser(resolve_entities=False, no_network=True))


def serialize(root):
    return xml.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def text(node):
    return "".join(element.text or "" for element in node.iter(tag("t")))


def clean(value):
    return " ".join((value or "").split())


def copy(node):
    result = deepcopy(node)
    for element in result.iter():
        for key in (f"{{{W14}}}paraId", f"{{{W14}}}textId"):
            element.attrib.pop(key, None)
    return result


def cells(row):
    expanded = []
    for cell in children(row, "tc"):
        span = cell.find(f"{tag('tcPr')}/{tag('gridSpan')}")
        expanded.extend([cell] * (int(span.get(tag("val"), "1")) if span is not None else 1))
    return expanded


def put(paragraph, *parts):
    first_run = next(paragraph.iter(tag("r")), None)
    original = first_run.find(tag("rPr")) if first_run is not None else None
    for child in list(paragraph):
        if child.tag != tag("pPr"):
            paragraph.remove(child)
    for value, font in parts:
        run = xml.SubElement(paragraph, tag("r"))
        properties = deepcopy(original) if original is not None else xml.Element(tag("rPr"))
        if font:
            fonts = properties.find(tag("rFonts"))
            if fonts is None:
                fonts = xml.Element(tag("rFonts"))
                properties.insert(1 if properties.find(tag("rStyle")) is not None else 0, fonts)
            for key in ("ascii", "hAnsi", "eastAsia", "cs"):
                fonts.set(tag(key), font)
        run.append(properties)
        xml.SubElement(run, tag("t"), {f"{{{XML}}}space": "preserve"}).text = value


def label(value):
    return clean(value).rstrip(":：") + ":"


def row_values(row, values, start=0):
    for cell, value in zip(cells(row)[start:], values):
        put(children(cell, "p")[0], (clean(value), None))


def put_list(cell, items, start=0):
    old = children(cell, "p")[start:]
    prototype = old[0]
    for paragraph in old:
        cell.remove(paragraph)
    for parts in items or [[("", None)]]:
        paragraph = copy(prototype)
        if not items:
            properties = paragraph.find(tag("pPr"))
            numbering = properties.find(tag("numPr")) if properties is not None else None
            if numbering is not None:
                properties.remove(numbering)
        put(paragraph, *parts)
        cell.append(paragraph)


def fill_job(table, job):
    period, project, duties, tech = children(table, "tr")
    row_values(period, [job.get("period"), job.get("company")], start=1)
    cell = cells(project)[-1]
    old = children(cell, "p")
    for paragraph in old:
        cell.remove(paragraph)

    def add(style, *parts):
        paragraph = copy(old[style])
        put(paragraph, *parts)
        cell.append(paragraph)

    if job.get("role"):
        add(0, ("Должность: ", MED), (clean(job["role"]), REG))
    for field in job.get("fields", []):
        if field.get("label") and field.get("value"):
            add(0, (label(field["label"]) + " ", MED), (clean(field["value"]), REG))
    if job.get("description"):
        add(2, ("Краткое описание проекта:", MED))
        add(3, (clean(job["description"]), REG))
    for extra in job.get("extras", []):
        if extra.get("label") and extra.get("items"):
            add(2, (label(extra["label"]), MED))
            for item in extra["items"]:
                add(3, ("– " + clean(item), REG))
    if not children(cell, "p"):
        add(0, ("", None))

    items = [[(clean(item), None)] for item in job.get("duties", []) if clean(item)]
    if items:
        put_list(cells(duties)[0], items, start=1)
    else:
        table.remove(duties)
    if clean(job.get("tech")):
        put(children(children(tech, "tc")[-1], "p")[0], (clean(job["tech"]), None))
    else:
        table.remove(tech)
    for row in children(table, "tr")[:-1][:2]:
        for paragraph in row.iter(tag("p")):
            keep_next(paragraph)


def fill_table(table, entries):
    if not entries:
        table.getparent().remove(table)
        return
    rows = children(table, "tr")
    for row in rows[:2]:
        for paragraph in row.iter(tag("p")):
            keep_next(paragraph)
    for row in rows[2:]:
        table.remove(row)
    for values in entries:
        row = copy(rows[2])
        row_values(row, values)
        table.append(row)


def remove(node):
    node.getparent().remove(node)


def empty_paragraph(node):
    return (node is not None and node.tag == tag("p") and not text(node).strip()
            and not any(next(node.iter(tag(name)), None) is not None for name in ("pict", "drawing", "object")))


def keep_next(paragraph):
    properties = paragraph.find(tag("pPr"))
    if properties is None:
        properties = xml.Element(tag("pPr"))
        paragraph.insert(0, properties)
    if properties.find(tag("keepNext")) is None:
        properties.insert(1 if properties.find(tag("pStyle")) is not None else 0, xml.Element(tag("keepNext")))


def fill_body(body, data, mode):
    paragraphs = children(body, "p")
    name = clean(data.get("name_full" if mode == "full" else "name_short"))
    if mode == "short" and name and not re.fullmatch(r"[^\W\d_]+(?:[-’'][^\W\d_]+)* [^\W\d_]\.", name):
        raise ValueError("Используйте формат сокращённой шапки «Имя Ф.».")
    put(paragraphs[1], (name.upper(), None))
    put(paragraphs[2], (clean(data.get("title")), None))
    put(paragraphs[4], (clean(data.get("experience_line")), None))
    if mode == "full":
        anchor = paragraphs[2]
        for field, caption in (("phone", "Телефон: "), ("email", "Email: ")):
            if value := clean(data.get(field)):
                paragraph = copy(paragraphs[2])
                put(paragraph, (caption, MED), (value, REG))
                anchor.addnext(paragraph)
                anchor = paragraph

    skills, *jobs, education, courses = children(body, "tbl")
    skills_row = children(skills, "tr")[1]
    height = skills_row.find(f"{tag('trPr')}/{tag('trHeight')}")
    if height is not None:
        remove(height)
    testing, technologies = cells(skills_row)
    put_list(testing, [[(clean(item), None)] for item in data.get("skills_testing", []) if clean(item)])
    put_list(technologies, [[(label(item["label"]) + " ", MED), (clean(item.get("value")), REG)]
                            for item in data.get("skills_tech", []) if clean(item.get("label")) and clean(item.get("value"))])

    blocks = [(table.getprevious(), table) for table in jobs]
    for heading, table in blocks:
        prior = heading.getprevious()
        if empty_paragraph(prior):
            remove(prior)
        remove(heading)
        remove(table)
    for index, job in enumerate(data.get("jobs", [])):
        heading, table = map(copy, blocks[min(index, len(blocks) - 1)])
        keep_next(heading)
        fill_job(table, job)
        if index:
            education.getprevious().addprevious(xml.Element(tag("p")))
        education.getprevious().addprevious(heading)
        education.getprevious().addprevious(table)

    education_heading = education.getprevious()
    education_rows = [[e.get(key) for key in ("period", "institution", "faculty", "level")]
                      for e in data.get("education", []) if clean(e.get("institution"))]
    course_cells = [[c.get("period") or "—", c["name"]]
                    for c in data.get("courses", []) if clean(c.get("name"))]
    course_rows = [course_cells[i] + (course_cells[i + 1] if i + 1 < len(course_cells) else ["", ""])
                   for i in range(0, len(course_cells), 2)]
    fill_table(education, education_rows)
    fill_table(courses, course_rows)
    if not education_rows and not course_rows:
        remove(education_heading)
    elif not course_rows:
        put(education_heading, ("ОБРАЗОВАНИЕ", None))
    for paragraph in children(body, "p"):
        if text(paragraph) in ("ОБРАЗОВАНИЕ", "ОБРАЗОВАНИЕ И СЕРТИФИКАТЫ", "ПРОФЕССИОНАЛЬНЫЕ НАВЫКИ"):
            keep_next(paragraph)
        elif empty_paragraph(paragraph) and empty_paragraph(paragraph.getnext()):
            remove(paragraph)


def template_bytes(source):
    return base64.b64decode(source.read_bytes()) if source.suffix == ".txt" else source.read_bytes()


def write_zip(template, output, replacements):
    with ZipFile(BytesIO(template)) as source, ZipFile(output, "w", compression=ZIP_DEFLATED) as target:
        for item in source.namelist():
            target.writestr(item, replacements[item] if item in replacements else source.read(item))


def prepare_template(source, output):
    template = template_bytes(source)
    with ZipFile(BytesIO(template)) as archive:
        document = parse(archive.read(DOC))
        body = document.find(tag("body"))
        headings = {"ПРОФЕССИОНАЛЬНЫЕ НАВЫКИ", "СВЕДЕНИЯ О ТРУДОВОЙ ДЕЯТЕЛЬНОСТИ", "ОБРАЗОВАНИЕ И СЕРТИФИКАТЫ",
                    "ТЕСТИРОВАНИЕ", "КЛЮЧЕВЫЕ ТЕХНОЛОГИИ", "ПЕРИОД", "О ПРОЕКТЕ", "Обязанности:", "ТЕХНОЛОГИИ",
                    "ОБРАЗОВАНИЕ", "НАЗВАНИЕ УЧЕБНОГО ЗАВЕДЕНИЯ", "НАЗВАНИЕ ФАКУЛЬТЕТА", "УРОВЕНЬ",
                    "ПОВЫШЕНИЕ КВАЛИФИКАЦИИ", "КУРС / СЕРТИФИКАТ"}
        for run in body.iter(tag("t")):
            paragraph = next(run.iterancestors(tag("p")), None)
            if paragraph is None or text(paragraph) not in headings:
                run.text = None
        core = parse(archive.read("docProps/core.xml"))
        for field in list(core):
            core.remove(field)
    write_zip(template, output, {DOC: serialize(document), "docProps/core.xml": serialize(core)})


def add_photo(docx, photo):
    from docx import Document
    from docx.shared import Emu
    from PIL import Image, ImageOps

    image = BytesIO()
    with Image.open(photo) as source:
        ImageOps.fit(ImageOps.exif_transpose(source).convert("RGB"), (480, 640), centering=(0.5, 0.42)).save(image, "JPEG", quality=90)
    image.seek(0)
    document = Document(docx)
    paragraph = document.paragraphs[1]
    run = paragraph.add_run()
    picture = run.add_picture(image, width=Emu(864000), height=Emu(1152000))
    anchor = picture._inline
    anchor.tag = f"{{{WP}}}anchor"
    for key, value in {"distT": "0", "distB": "0", "distL": "114300", "distR": "0", "simplePos": "0",
                       "relativeHeight": "251659264", "behindDoc": "0", "locked": "0", "layoutInCell": "1", "allowOverlap": "1"}.items():
        anchor.set(key, value)
    for index, element in enumerate((
        xml.Element(f"{{{WP}}}simplePos", x="0", y="0"),
        xml.Element(f"{{{WP}}}positionH", relativeFrom="margin"),
        xml.Element(f"{{{WP}}}positionV", relativeFrom="paragraph"),
    )):
        if index:
            xml.SubElement(element, f"{{{WP}}}posOffset").text = "8775065" if index == 1 else "0"
        anchor.insert(index, element)
    anchor.insert(4, xml.Element(f"{{{WP}}}effectExtent", l="0", t="0", r="0", b="0"))
    anchor.insert(5, xml.Element(f"{{{WP}}}wrapSquare", wrapText="left"))
    paragraph._p.pPr.addnext(run._r)
    document.save(docx)


def export_docx(data, mode, template, output, photo):
    source = template_bytes(template)
    with ZipFile(BytesIO(source)) as archive:
        document = parse(archive.read(DOC))
    fill_body(document.find(tag("body")), data, mode)
    write_zip(source, output, {DOC: serialize(document)})
    if mode == "full" and photo:
        add_photo(output, photo)


def office_convert(source, outdir, extension, env=None):
    office = shutil.which("soffice")
    if office is None:
        raise ValueError(f"Для преобразования в {extension.upper()} требуется LibreOffice.")
    completed = subprocess.run([office, "--headless", "--convert-to", extension, "--outdir", str(outdir), str(source)],
                               env=env, capture_output=True, text=True, timeout=90)
    result = outdir / f"{source.stem}.{extension}"
    if completed.returncode or not result.is_file() or not result.stat().st_size:
        raise ValueError(f"Не удалось преобразовать файл в {extension.upper()}.")
    return result


def pdf_from_docx(source, output):
    with TemporaryDirectory() as temp:
        directory = Path(temp)
        fonts = directory / "fonts"
        fonts.mkdir()
        with ZipFile(source) as archive:
            rels = {item.get("Id"): item.get("Target") for item in parse(archive.read("word/_rels/fontTable.xml.rels"))}
            for font in parse(archive.read("word/fontTable.xml")):
                if not font.get(tag("name"), "").startswith(REG):
                    continue
                for embedded in font:
                    if target := rels.get(embedded.get(f"{{{R}}}id")):
                        key = bytes.fromhex(re.sub(r"[{}-]", "", embedded.get(tag("fontKey"))))[::-1]
                        raw = bytearray(archive.read(f"word/{target}"))
                        for index in range(32):
                            raw[index] ^= key[index % 16]
                        (fonts / Path(target).with_suffix(".ttf").name).write_bytes(raw)
        fonts_config = directory / "fonts.conf"
        fonts_config.write_text(f'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>{fonts}</dir></fontconfig>', encoding="utf-8")
        converted = office_convert(source, directory, "pdf", env={**os.environ, "FONTCONFIG_FILE": str(fonts_config)})
        shutil.copyfile(converted, output)


def extract(filepath):
    extension = filepath.suffix.lower()
    if extension in (".doc", ".rtf"):
        with TemporaryDirectory() as temp:
            return extract(office_convert(filepath, Path(temp), "docx"))
    if extension == ".pdf":
        if not shutil.which("pdftotext"):
            raise ValueError("Для извлечения текста PDF требуется pdftotext.")
        result = subprocess.run(["pdftotext", "-layout", str(filepath), "-"], capture_output=True, check=True, timeout=90)
        return result.stdout.decode("utf-8", errors="replace")
    if extension == ".docx":
        with ZipFile(filepath) as archive:
            return "\n".join(value for paragraph in parse(archive.read(DOC)).iter(tag("p")) if (value := text(paragraph).strip()))
    raise ValueError("Поддерживаются DOCX, DOC, RTF и PDF.")


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    extract_parser = commands.add_parser("extract")
    extract_parser.add_argument("source", type=Path)
    prepare = commands.add_parser("prepare-template")
    prepare.add_argument("source", type=Path)
    prepare.add_argument("output", type=Path)
    build = commands.add_parser("render")
    build.add_argument("data", type=Path)
    build.add_argument("output", type=Path)
    build.add_argument("--header", choices=("full", "short"), default="short")
    build.add_argument("--template", type=Path, default=TEMPLATE)
    build.add_argument("--photo", type=Path)
    args = cli.parse_args()
    if args.command == "extract":
        print(extract(args.source.resolve()))
    elif args.command == "prepare-template":
        prepare_template(args.source, args.output)
    else:
        data = json.loads(args.data.read_text(encoding="utf-8"))
        if args.output.suffix.lower() == ".pdf":
            with TemporaryDirectory() as temp:
                docx = Path(temp) / "resume.docx"
                export_docx(data, args.header, args.template, docx, args.photo)
                pdf_from_docx(docx, args.output)
        elif args.output.suffix.lower() == ".docx":
            export_docx(data, args.header, args.template, args.output, args.photo)
        else:
            cli.error("Выберите для выходного файла расширение .docx или .pdf.")


if __name__ == "__main__":
    main()

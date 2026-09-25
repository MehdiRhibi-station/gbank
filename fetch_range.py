#!/usr/bin/env python3
"""Download HUJI exams, extract their questions locally, and import them to Supabase.

This is the owner-only, one-command ingestion path. It does not create an
intermediate course JSON file and never exposes the Supabase service-role key to
the website. Each completed exam is written immediately and can be resumed.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import sys
import time
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

try:
    import fitz  # PyMuPDF
except (ModuleNotFoundError, ImportError):  # pragma: no cover - friendly message below
    fitz = None

try:
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
except (ModuleNotFoundError, ImportError):  # pragma: no cover - friendly message below
    requests = None
    HTTPAdapter = None
    Retry = None

try:
    from supabase import Client, create_client
except (ModuleNotFoundError, ImportError):  # pragma: no cover - friendly message below
    Client = Any
    create_client = None


HUJI_SEARCH_URL = "https://www4.huji.ac.il/htbin/exams/exams.cgi"
DEFAULT_FROM_YEAR = 2016
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "qwen3-vl:8b"
PDF_BUCKET = "exam-files"

NATURE_LABELS = {
    "compute": "חישוב",
    "prove": "הוכחה",
    "mixed": "חישוב והוכחה",
    "definition": "הגדרה",
    "true-false": "נכון או לא נכון",
    "multiple-choice": "שאלה אמריקאית",
}
VALID_DIFFICULTIES = {"easy", "mid", "hard"}


@dataclass(frozen=True)
class Exam:
    course_name: str
    course_number: str
    year: int
    semester: int
    moed: int
    version: int
    filename: str
    url: str
    ordinal: int = 0

    @property
    def new_id(self) -> str:
        return (
            f"{self.course_number}:e{self.year}s{self.semester}"
            f"m{self.moed}v{self.version}"
        )


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def real_secret(value: str | None) -> bool:
    return bool(value and "YOUR_" not in value and "replace-me" not in value)


def require_dependencies(*, database: bool, extraction: bool) -> None:
    missing: list[str] = []
    if requests is None:
        missing.append("requests")
    if database and create_client is None:
        missing.append("supabase")
    if extraction and fitz is None:
        missing.append("PyMuPDF")
    if missing:
        raise RuntimeError(
            "Missing Python packages: "
            + ", ".join(missing)
            + ". Run: python -m pip install -r requirements-ingest.txt"
        )


def parse_args(project_root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download HUJI exams, extract questions with local Ollama, and "
            "upsert each exam directly into Supabase."
        )
    )
    parser.add_argument("course_number", help="HUJI course number, for example 80131")
    parser.add_argument("--from", dest="from_year", type=int, default=DEFAULT_FROM_YEAR)
    parser.add_argument("--to", dest="to_year", type=int, default=datetime.now().year)
    parser.add_argument("--latest", action="store_true", help="Import only the newest exam")
    parser.add_argument("--course-name", help="Override the course name")
    parser.add_argument(
        "--department",
        default="האוניברסיטה העברית",
        help="Department shown on the website for a new course",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="PDF cache folder (default: imports/COURSE_NUMBER)",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL),
        help=f"Local Ollama vision model (default: {DEFAULT_OLLAMA_MODEL})",
    )
    parser.add_argument(
        "--ollama-url",
        default=os.environ.get("OLLAMA_URL", DEFAULT_OLLAMA_URL),
        help=f"Local Ollama address (default: {DEFAULT_OLLAMA_URL})",
    )
    parser.add_argument(
        "--force-extract",
        action="store_true",
        help="Re-extract exams that already have database questions",
    )
    parser.add_argument(
        "--skip-pdf-upload",
        action="store_true",
        help="Import question rows without uploading source PDFs",
    )
    parser.add_argument(
        "--delete-pdfs-after-upload",
        action="store_true",
        help="Delete each local PDF only after its database import succeeds",
    )
    parser.add_argument(
        "--keep-going",
        action="store_true",
        help="Continue with later exams if one exam fails",
    )
    parser.add_argument("--dry-run", action="store_true", help="Discover and list only")
    parser.add_argument("--yes", action="store_true", help="Skip the confirmation prompt")
    args = parser.parse_args()

    number = str(args.course_number).strip()
    if not re.fullmatch(r"\d{4,8}", number):
        parser.error("course_number must contain 4 to 8 digits")
    args.course_number = number
    if not (1900 <= args.from_year <= 2200 and 1900 <= args.to_year <= 2200):
        parser.error("--from and --to must be four-digit years")
    if args.from_year > args.to_year:
        parser.error("--from cannot be later than --to")
    if args.output_dir is None:
        args.output_dir = project_root / "imports" / number
    elif not args.output_dir.is_absolute():
        args.output_dir = (project_root / args.output_dir).resolve()
    return args


def make_session() -> Any:
    retry = Retry(
        total=5,
        connect=5,
        read=5,
        status=5,
        backoff_factor=1,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "POST"}),
    )
    session = requests.Session()
    session.headers.update({"User-Agent": "GBank owner import tool/1.0"})
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def plain_text(fragment: str) -> str:
    value = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.IGNORECASE)
    value = re.sub(r"<[^>]+>", " ", value)
    return " ".join(html.unescape(value).split())


def discover_exams(
    session: Any,
    course_number: str,
    from_year: int,
    to_year: int,
) -> list[Exam]:
    response = session.post(
        HUJI_SEARCH_URL,
        data={
            "action": "mode2",
            "coursenum": course_number,
            "year1": str(from_year),
            "year2": str(to_year),
            "moed": "0",
            "semester": "0",
        },
        timeout=(20, 120),
    )
    response.raise_for_status()
    page = response.content.decode("windows-1255", errors="replace")
    pattern = re.compile(
        rf"^{re.escape(course_number)}_(\d{{4}})_(\d+)_(\d+)_(\d+)\.pdf$",
        re.IGNORECASE,
    )
    found: dict[str, Exam] = {}
    for row in re.findall(r"<tr\b[^>]*>[\s\S]*?</tr>", page, flags=re.IGNORECASE):
        link = re.search(
            r"href\s*=\s*['\"]([^'\"]+\.pdf(?:\?[^'\"]*)?)['\"]",
            row,
            flags=re.IGNORECASE,
        )
        if not link:
            continue
        url = urljoin(HUJI_SEARCH_URL, html.unescape(link.group(1)))
        parsed = urlparse(url)
        filename = Path(parsed.path).name
        parts = pattern.fullmatch(filename)
        if (
            not parts
            or parsed.scheme != "https"
            or parsed.hostname != "www4.huji.ac.il"
            or not parsed.path.startswith("/exams/")
        ):
            continue
        cells = [
            plain_text(cell)
            for cell in re.findall(r"<td\b[^>]*>([\s\S]*?)</td>", row, flags=re.IGNORECASE)
        ]
        found[filename] = Exam(
            course_name=cells[0] if cells else "",
            course_number=course_number,
            year=int(parts.group(1)),
            semester=int(parts.group(2)),
            moed=int(parts.group(3)),
            version=int(parts.group(4)),
            filename=filename,
            url=url,
        )

    ordered = sorted(
        found.values(),
        key=lambda item: (item.year, item.semester, item.moed, item.version, item.filename),
    )
    return [
        Exam(**{**exam.__dict__, "ordinal": index})
        for index, exam in enumerate(ordered, start=1)
    ]


def valid_pdf(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 5:
        return False
    with path.open("rb") as stream:
        return stream.read(5) == b"%PDF-"


def download_exam(session: Any, exam: Exam, directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / exam.filename
    if valid_pdf(destination):
        print(f"  kept existing PDF: {exam.filename}")
        return destination

    partial = destination.with_suffix(destination.suffix + ".part")
    for attempt in range(1, 6):
        try:
            with session.get(exam.url, stream=True, timeout=(20, 180)) as response:
                response.raise_for_status()
                with partial.open("wb") as stream:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            stream.write(chunk)
            if not valid_pdf(partial):
                raise RuntimeError("HUJI returned a non-PDF response")
            os.replace(partial, destination)
            print(f"  downloaded: {exam.filename}")
            return destination
        except Exception:
            partial.unlink(missing_ok=True)
            if attempt == 5:
                raise
            delay = min(2**attempt, 16)
            print(f"  download failed; retrying in {delay}s ({attempt}/5)")
            time.sleep(delay)
    raise RuntimeError(f"Could not download {exam.filename}")


def local_ollama_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError(
            "OLLAMA_URL must point to this computer, for example http://127.0.0.1:11434"
        )
    return value.rstrip("/")


def ensure_ollama(session: Any, base_url: str, model: str) -> None:
    try:
        response = session.get(f"{base_url}/api/tags", timeout=(5, 15))
        response.raise_for_status()
    except Exception as error:
        raise RuntimeError(
            "Ollama is not running. Open Ollama and run this command again."
        ) from error
    names = {
        candidate
        for item in response.json().get("models", [])
        for candidate in (item.get("name"), item.get("model"))
        if candidate
    }
    if model not in names and f"{model}:latest" not in names:
        raise RuntimeError(f"Ollama model {model} is missing. Run: ollama pull {model}")


def extraction_schema() -> dict[str, Any]:
    string_field = {"type": "string"}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "courseName",
            "instructors",
            "examDate",
            "questionsToAnswer",
            "questions",
        ],
        "properties": {
            "courseName": string_field,
            "instructors": string_field,
            "examDate": string_field,
            "questionsToAnswer": string_field,
            "questions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": [
                        "questionNumber",
                        "subpart",
                        "points",
                        "nature",
                        "difficulty",
                        "topics",
                        "title",
                        "context",
                        "statement",
                        "uncertain",
                    ],
                    "properties": {
                        "questionNumber": string_field,
                        "subpart": string_field,
                        "points": string_field,
                        "nature": {"type": "string", "enum": list(NATURE_LABELS)},
                        "difficulty": {"type": "string", "enum": sorted(VALID_DIFFICULTIES)},
                        "topics": {"type": "array", "items": string_field},
                        "title": string_field,
                        "context": string_field,
                        "statement": string_field,
                        "uncertain": {"type": "boolean"},
                    },
                },
            },
        },
    }


def extraction_instructions(course_number: str, filename: str) -> str:
    return "\n".join(
        [
            "You are transcribing an official Hebrew University exam into a question bank.",
            f"Course number: {course_number}. Source filename: {filename}.",
            "Read every page, including scanned pages. Preserve the original Hebrew wording.",
            "Return one item for each MAIN numbered question, in source order.",
            "Keep all subparts (א, ב, ג, etc.) together inside that main question statement.",
            "Do not include solutions, answer keys, student handwriting, hints, or commentary.",
            "Write mathematical notation as LaTeX between $...$ or $$...$$.",
            "Use an empty string when metadata is not visible. Never invent missing text.",
            "Set uncertain=true if any important part is illegible or ambiguous.",
            "Choose short Hebrew topic labels and a concise searchable Hebrew title.",
            "Difficulty estimates the work required, not student performance.",
        ]
    )


def render_pdf(pdf_path: Path) -> list[str]:
    images: list[str] = []
    document = fitz.open(pdf_path)
    try:
        matrix = fitz.Matrix(2, 2)
        for page in document:
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            images.append(base64.b64encode(pixmap.tobytes("jpeg")).decode("ascii"))
    finally:
        document.close()
    if not images:
        raise RuntimeError(f"No pages could be rendered from {pdf_path.name}")
    return images


def parse_json_message(content: str, label: str) -> dict[str, Any]:
    value = str(content or "").strip()
    value = re.sub(r"^```(?:json)?\s*", "", value, flags=re.IGNORECASE)
    value = re.sub(r"\s*```$", "", value)
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        start, end = value.find("{"), value.rfind("}")
        if start < 0 or end <= start:
            raise RuntimeError(f"{label} returned invalid JSON")
        try:
            parsed = json.loads(value[start : end + 1])
        except json.JSONDecodeError as error:
            raise RuntimeError(f"{label} returned invalid JSON") from error
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{label} did not return a JSON object")
    return parsed


def extract_exam(
    session: Any,
    pdf_path: Path,
    exam: Exam,
    ollama_url: str,
    model: str,
) -> dict[str, Any]:
    images = render_pdf(pdf_path)
    schema = extraction_schema()
    response = session.post(
        f"{ollama_url}/api/chat",
        json={
            "model": model,
            "stream": False,
            "think": False,
            "keep_alive": "30m",
            "format": schema,
            "options": {
                "temperature": 0,
                "num_ctx": int(os.environ.get("OLLAMA_CONTEXT_LENGTH", "32768")),
            },
            "messages": [
                {
                    "role": "system",
                    "content": (
                        extraction_instructions(exam.course_number, exam.filename)
                        + "\nReturn JSON that exactly matches this schema: "
                        + json.dumps(schema, ensure_ascii=False)
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "These images are every page of the exam, in order. "
                        "Transcribe the exam into the required structure."
                    ),
                    "images": images,
                },
            ],
        },
        timeout=(30, 60 * 60),
    )
    if not response.ok:
        try:
            detail = response.json().get("error", response.text)
        except ValueError:
            detail = response.text
        raise RuntimeError(f"Ollama extraction failed: {detail or response.status_code}")
    payload = response.json()
    result = parse_json_message(
        payload.get("message", {}).get("content", ""),
        f"Ollama extraction for {exam.filename}",
    )
    return normalize_extraction(result, exam.filename)


def normalize_extraction(result: dict[str, Any], filename: str) -> dict[str, Any]:
    source_questions = result.get("questions")
    if not isinstance(source_questions, list) or not source_questions:
        raise RuntimeError(f"Extraction for {filename} has no questions")
    questions: list[dict[str, Any]] = []
    for index, raw in enumerate(source_questions, start=1):
        if not isinstance(raw, dict):
            raise RuntimeError(f"Question {index} in {filename} is not an object")
        number = str(raw.get("questionNumber", "")).strip()
        statement = str(raw.get("statement", "")).strip()
        title = str(raw.get("title", "")).strip()
        if not number or not statement or not title:
            raise RuntimeError(
                f"Question {index} in {filename} is missing its number, title, or statement"
            )
        nature = str(raw.get("nature", "mixed"))
        difficulty = str(raw.get("difficulty", "mid"))
        questions.append(
            {
                "questionNumber": number,
                "subpart": str(raw.get("subpart", "")).strip(),
                "points": str(raw.get("points", "")).strip(),
                "nature": nature if nature in NATURE_LABELS else "mixed",
                "difficulty": difficulty if difficulty in VALID_DIFFICULTIES else "mid",
                "topics": [
                    str(topic).strip()
                    for topic in raw.get("topics", [])
                    if str(topic).strip()
                ],
                "title": title,
                "context": str(raw.get("context", "")).strip(),
                "statement": statement,
                "uncertain": bool(raw.get("uncertain", False)),
            }
        )
    return {
        "courseName": str(result.get("courseName", "")).strip(),
        "instructors": str(result.get("instructors", "")).strip(),
        "examDate": str(result.get("examDate", "")).strip(),
        "questionsToAnswer": str(result.get("questionsToAnswer", "")).strip(),
        "questions": questions,
    }


def chunks(items: list[dict[str, Any]], size: int = 200) -> Iterable[list[dict[str, Any]]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


def normalized_label(value: str) -> str:
    return " ".join(value.strip().lower().split())


def next_topic_id(topics: dict[str, str]) -> str:
    number = 1
    while f"topic-{number:03d}" in topics:
        number += 1
    return f"topic-{number:03d}"


def topic_ids(labels: list[str], topics: dict[str, str]) -> list[str]:
    by_label = {normalized_label(label): key for key, label in topics.items()}
    ids: list[str] = []
    for label in labels:
        normalized = normalized_label(label)
        if not normalized:
            continue
        topic_id = by_label.get(normalized)
        if not topic_id:
            topic_id = next_topic_id(topics)
            topics[topic_id] = label
            by_label[normalized] = topic_id
        if topic_id not in ids:
            ids.append(topic_id)
    return ids


def slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value).lower()
    return re.sub(r"[^\w]+", "-", normalized, flags=re.UNICODE).strip("-")


def existing_course(client: Client, course_number: str) -> dict[str, Any] | None:
    response = (
        client.table("courses")
        .select("number,name,aliases,department,topics,natures,is_published")
        .eq("number", course_number)
        .limit(1)
        .execute()
    )
    return response.data[0] if response.data else None


def existing_exams(client: Client, course_number: str) -> dict[str, dict[str, Any]]:
    response = (
        client.table("exams")
        .select("id,source_filename,storage_path,ordinal,is_published")
        .eq("course_number", course_number)
        .execute()
    )
    return {row["source_filename"]: row for row in response.data or []}


def exam_questions(client: Client, exam_id: str) -> list[dict[str, Any]]:
    response = (
        client.table("questions")
        .select("id,question_number,subpart,is_published")
        .eq("exam_id", exam_id)
        .execute()
    )
    return list(response.data or [])


def upsert_course(client: Client, row: dict[str, Any]) -> None:
    client.table("courses").upsert(row, on_conflict="number").execute()


def upload_pdf(client: Client, pdf_path: Path, storage_path: str) -> None:
    with pdf_path.open("rb") as stream:
        client.storage.from_(PDF_BUCKET).upload(
            path=storage_path,
            file=stream,
            file_options={
                "cache-control": "3600",
                "content-type": "application/pdf",
                "upsert": "true",
            },
        )


def make_question_rows(
    course_number: str,
    exam_id: str,
    extraction: dict[str, Any],
    topics: dict[str, str],
    existing: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    existing_by_key: dict[tuple[str, str], list[str]] = {}
    for row in existing:
        key = (str(row.get("question_number", "")), str(row.get("subpart", "")))
        existing_by_key.setdefault(key, []).append(str(row["id"]))

    used_ids = {str(row["id"]) for row in existing}
    retained_ids: set[str] = set()
    rows: list[dict[str, Any]] = []
    for ordinal, question in enumerate(extraction["questions"], start=1):
        key = (question["questionNumber"], question["subpart"])
        candidates = existing_by_key.get(key, [])
        if candidates:
            question_id = candidates.pop(0)
        else:
            token = slug("-".join(part for part in key if part)) or f"q{ordinal:03d}"
            base = f"{exam_id}-{token}"
            question_id = base
            suffix = 2
            while question_id in used_ids:
                question_id = f"{base}-{suffix}"
                suffix += 1
        used_ids.add(question_id)
        retained_ids.add(question_id)
        rows.append(
            {
                "id": question_id,
                "exam_id": exam_id,
                "ordinal": ordinal,
                "question_number": question["questionNumber"],
                "subpart": question["subpart"],
                "points": question["points"],
                "nature": question["nature"],
                "difficulty": question["difficulty"],
                "topics": topic_ids(question["topics"], topics),
                "title": question["title"],
                "context": question["context"] or None,
                "statement": question["statement"],
                "uncertain": question["uncertain"],
                "is_published": True,
            }
        )
    stale_ids = [str(row["id"]) for row in existing if str(row["id"]) not in retained_ids]
    return rows, stale_ids


def import_extracted_exam(
    client: Client,
    exam: Exam,
    exam_id: str,
    extraction: dict[str, Any],
    pdf_path: Path,
    storage_path: str | None,
    upload_source_pdf: bool,
    course_row: dict[str, Any],
    existing_questions: list[dict[str, Any]],
) -> int:
    topics = dict(course_row.get("topics") or {})
    natures = dict(course_row.get("natures") or {})
    question_rows, stale_ids = make_question_rows(
        exam.course_number,
        exam_id,
        extraction,
        topics,
        existing_questions,
    )
    for question in extraction["questions"]:
        nature = question["nature"]
        natures.setdefault(nature, NATURE_LABELS.get(nature, nature))

    if storage_path and upload_source_pdf:
        upload_pdf(client, pdf_path, storage_path)

    course_row["topics"] = topics
    course_row["natures"] = natures
    if not course_row.get("name") or course_row["name"].startswith("קורס "):
        course_row["name"] = extraction.get("courseName") or exam.course_name or course_row["name"]
    upsert_course(client, course_row)

    client.table("exams").upsert(
        {
            "id": exam_id,
            "course_number": exam.course_number,
            "ordinal": exam.ordinal,
            "year": exam.year,
            "semester": {1: "א", 2: "ב", 3: "קיץ"}.get(exam.semester, str(exam.semester)),
            "moed": {1: "א", 2: "ב", 3: "ג"}.get(exam.moed, str(exam.moed)),
            "exam_date": extraction.get("examDate", ""),
            "instructors": extraction.get("instructors", ""),
            "source_filename": exam.filename,
            "storage_path": storage_path,
            "questions_to_answer": extraction.get("questionsToAnswer", ""),
            # Keep the exam hidden until every question row has been written.
            "is_published": False,
        },
        on_conflict="id",
    ).execute()

    for batch in chunks(question_rows):
        client.table("questions").upsert(batch, on_conflict="id").execute()

    for stale_batch in [stale_ids[index : index + 100] for index in range(0, len(stale_ids), 100)]:
        if stale_batch:
            (
                client.table("questions")
                .update({"is_published": False})
                .in_("id", stale_batch)
                .execute()
            )
    (
        client.table("exams")
        .update({"is_published": True})
        .eq("id", exam_id)
        .execute()
    )
    course_row["is_published"] = True
    upsert_course(client, course_row)
    return len(question_rows)


def ensure_existing_exam_pdf(
    client: Client,
    exam: Exam,
    exam_row: dict[str, Any],
    pdf_path: Path | None,
    skip_upload: bool,
) -> str | None:
    storage_path = exam_row.get("storage_path")
    if storage_path or skip_upload:
        (
            client.table("exams")
            .update({"ordinal": exam.ordinal})
            .eq("id", exam_row["id"])
            .execute()
        )
        return storage_path
    if pdf_path is None:
        raise RuntimeError(f"Missing local PDF for {exam.filename}")
    storage_path = f"{exam.course_number}/{exam.filename}"
    upload_pdf(client, pdf_path, storage_path)
    (
        client.table("exams")
        .update({"storage_path": storage_path, "ordinal": exam.ordinal})
        .eq("id", exam_row["id"])
        .execute()
    )
    return storage_path


def confirm_import(exams: list[Exam], args: argparse.Namespace) -> bool:
    if args.yes:
        return True
    if not sys.stdin.isatty():
        return False
    answer = input(
        f"Import {len(exams)} exam(s) directly into the production database? [y/N] "
    ).strip().lower()
    return answer in {"y", "yes"}


def main() -> int:
    project_root = Path(__file__).resolve().parent
    load_env_file(project_root / ".env.local")
    args = parse_args(project_root)
    require_dependencies(database=not args.dry_run, extraction=not args.dry_run)
    session = make_session()

    print(
        f"Searching HUJI for course {args.course_number} "
        f"({args.from_year}-{args.to_year})..."
    )
    discovered = discover_exams(session, args.course_number, args.from_year, args.to_year)
    if not discovered:
        raise RuntimeError("HUJI did not list any exams for that course and year range")
    selected = [discovered[-1]] if args.latest else discovered
    print(f"Found {len(discovered)} exam(s); selected {len(selected)}.")
    for exam in selected:
        print(f"  {exam.filename}")
    if args.dry_run:
        print("Dry run finished. The database and local files were not changed.")
        return 0

    supabase_url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not real_secret(supabase_url) or not real_secret(service_key):
        raise RuntimeError(
            "Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env.local"
        )
    ollama_url = local_ollama_url(args.ollama_url)
    ensure_ollama(session, ollama_url, args.model)
    if not confirm_import(selected, args):
        print("Stopped before downloading, extraction, or database changes.")
        return 0

    client = create_client(supabase_url, service_key)
    stored_course = existing_course(client, args.course_number)
    discovered_name = args.course_name or next(
        (exam.course_name for exam in selected if exam.course_name),
        f"קורס {args.course_number}",
    )
    course_row: dict[str, Any] = {
        "number": args.course_number,
        "name": args.course_name or (stored_course or {}).get("name") or discovered_name,
        "aliases": list((stored_course or {}).get("aliases") or []),
        "department": (stored_course or {}).get("department") or args.department,
        "topics": dict((stored_course or {}).get("topics") or {}),
        "natures": dict((stored_course or {}).get("natures") or {}),
        # A brand-new course stays hidden until its first exam is fully imported.
        "is_published": bool(stored_course and stored_course.get("is_published")),
    }
    upsert_course(client, course_row)
    known_exams = existing_exams(client, args.course_number)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    imported = 0
    skipped = 0
    failures: list[tuple[str, str]] = []
    for index, exam in enumerate(selected, start=1):
        print(f"\n[{index}/{len(selected)}] {exam.filename}")
        try:
            current_exam = known_exams.get(exam.filename)
            exam_id = str(current_exam["id"]) if current_exam else exam.new_id
            current_questions = exam_questions(client, exam_id) if current_exam else []

            if (
                current_questions
                and current_exam.get("is_published", True)
                and not args.force_extract
            ):
                pdf_path: Path | None = None
                if not current_exam.get("storage_path") and not args.skip_pdf_upload:
                    pdf_path = download_exam(session, exam, args.output_dir)
                stored_pdf = ensure_existing_exam_pdf(
                    client,
                    exam,
                    current_exam,
                    pdf_path,
                    args.skip_pdf_upload,
                )
                print(f"  skipped extraction: {len(current_questions)} question(s) already exist")
                course_row["is_published"] = True
                upsert_course(client, course_row)
                if args.delete_pdfs_after_upload and pdf_path and stored_pdf:
                    pdf_path.unlink(missing_ok=True)
                skipped += 1
                continue

            pdf_path = download_exam(session, exam, args.output_dir)
            print(f"  extracting with {args.model} on this computer...")
            extraction = extract_exam(session, pdf_path, exam, ollama_url, args.model)
            existing_storage_path = current_exam.get("storage_path") if current_exam else None
            storage_path = existing_storage_path or (
                None if args.skip_pdf_upload else f"{args.course_number}/{exam.filename}"
            )
            count = import_extracted_exam(
                client,
                exam,
                exam_id,
                extraction,
                pdf_path,
                storage_path,
                not args.skip_pdf_upload,
                course_row,
                current_questions,
            )
            print(f"  imported directly: {count} question(s)")
            imported += 1
            if args.delete_pdfs_after_upload and storage_path:
                pdf_path.unlink(missing_ok=True)
        except Exception as error:
            message = str(error)
            failures.append((exam.filename, message))
            print(f"  FAILED: {message}", file=sys.stderr)
            if not args.keep_going:
                break

    print("\nDirect import summary")
    print(f"  imported exams: {imported}")
    print(f"  already present: {skipped}")
    print(f"  failed exams: {len(failures)}")
    if failures:
        for filename, message in failures:
            print(f"  - {filename}: {message}", file=sys.stderr)
        print("Run the same command again to resume; completed exams will be skipped.")
        return 1
    print("The course is now available from the Supabase database.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nStopped by user. Completed exams remain in the database.", file=sys.stderr)
        raise SystemExit(130)
    except Exception as error:
        print(f"\nImport stopped: {error}", file=sys.stderr)
        raise SystemExit(1)

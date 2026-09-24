"""
Fetch the Infi 1 (80131) exam PDFs listed on the HUJI exam-bank page,
and write manifest.csv describing each file.

Filename convention (decoded from the listing you pasted):
    <course>_<year>_<semester>_<moed>_<version>.pdf
    semester: 1 = א, 2 = ב        moed: 1 = א, 2 = ב, 3 = ג

Usage:
    1. Log in to the exam bank in your browser.
    2. Right-click any PDF link -> copy link address. Everything before the
       filename is BASE_URL. If the link is not of the form BASE_URL + filename,
       adjust build_url() below.
    3. DevTools -> Network -> any request to the site -> copy the "Cookie"
       request header into COOKIE (needed only if the PDFs require login).
    4. pip install requests ; python fetch_exams.py
"""
import csv
import time
from pathlib import Path

import requests

BASE_URL = "PASTE_BASE_URL_HERE/"   # must end with "/"
COOKIE = ""                          # leave empty if the PDFs are public
COURSE_ID = "80131"
COURSE_NAME = "חשבון אינפיניטסימלי 1"
OUT_DIR = Path("exams") / COURSE_ID
DELAY_SECONDS = 1.0                  # be polite to the university server

# year -> list of "semester_moed_version"
FILES = {
    2000: ["1_1_1"],
    2001: ["1_1_1", "1_2_1"],
    2002: ["1_1_1", "1_2_1"],
    2003: ["1_1_1"],
    2004: ["1_1_1", "1_2_1"],
    2005: ["1_1_1", "1_2_1"],
    2006: ["1_1_1", "1_2_1"],
    2007: ["1_1_1", "1_2_1"],
    2009: ["1_1_1", "1_2_1"],
    2010: ["1_1_1", "1_2_1"],
    2011: ["2_1_1", "2_2_1"],
    2012: ["1_1_1"],
    2013: ["1_1_1", "1_2_1"],
    2014: ["1_1_1", "1_2_1"],
    2015: ["1_1_1", "1_2_1"],
    2016: ["1_1_1", "1_2_1"],
    2017: ["1_1_1", "1_2_1"],
    2018: ["1_1_1", "1_2_1", "2_1_1", "2_2_1"],
    2019: ["1_1_1", "1_2_1", "2_1_1", "2_2_1"],
    2020: ["1_1_1", "1_2_1", "1_3_1"],
    2021: ["2_1_1", "2_2_1"],
    2022: ["1_1_1", "1_2_1", "2_1_1", "2_2_1"],
    2023: ["1_1_1", "1_2_1", "2_1_1", "2_2_1"],
    2024: ["1_1_1", "1_2_1", "2_1_2", "2_2_1"],
    2025: ["1_1_1", "1_2_1", "2_1_1", "2_2_1"],
}

HEB = {"1": "א", "2": "ב", "3": "ג"}


def build_url(filename: str) -> str:
    return BASE_URL + filename


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "Mozilla/5.0"
    if COOKIE:
        session.headers["Cookie"] = COOKIE

    rows, failed = [], []
    for year, variants in FILES.items():
        for v in variants:
            semester, moed, version = v.split("_")
            filename = f"{COURSE_ID}_{year}_{v}.pdf"
            target = OUT_DIR / filename
            status = "exists"

            if not target.exists():
                r = session.get(build_url(filename), timeout=30)
                # A login page returned with HTTP 200 is the common silent
                # failure, so verify the PDF magic bytes, not just the status.
                if r.ok and r.content[:4] == b"%PDF":
                    target.write_bytes(r.content)
                    status = "downloaded"
                else:
                    status = f"FAILED (http {r.status_code})"
                    failed.append(filename)
                time.sleep(DELAY_SECONDS)

            print(f"{filename}: {status}")
            rows.append([COURSE_ID, COURSE_NAME, year, HEB[semester],
                         HEB[moed], version, filename, status])

    with open(OUT_DIR / "manifest.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["course_id", "course_name", "year", "semester",
                    "moed", "version", "filename", "status"])
        w.writerows(rows)

    print(f"\n{len(rows) - len(failed)}/{len(rows)} ok. Manifest: {OUT_DIR / 'manifest.csv'}")
    if failed:
        print("Failed:", ", ".join(failed))


if __name__ == "__main__":
    main()

# SIGNAL — AI Resume / Job Matcher

Paste, upload, or build a resume — get it scanned against every open role in the database with a ranked match score, then ask an AI assistant for advice.

![tech](https://img.shields.io/badge/backend-Python%20%2F%20FastAPI-FFB000)
![tech](https://img.shields.io/badge/frontend-JavaScript%20%2F%20HTML%20%2F%20CSS-4C6B87)
![tech](https://img.shields.io/badge/database-SQLite-7C8494)

## Features

- **Resume scanner** — paste text, or upload a `.txt` / `.pdf` / `.docx` file directly.
- **Skill extraction** — explicit "SKILLS" section parsing + a 130+ term vocabulary with synonyms (e.g. "programmer" → software development) + typo-tolerant fuzzy matching (e.g. "managemant" → management). Covers tech, business, healthcare, hospitality, education, HR, design, logistics, and more.
- **Job matching** — exact matches score fully; skills in the same *category* as something you have score as "related" (partial credit) — so cross-industry resumes get a fair score instead of a hard 0%.
- **Resume builder** — fill a form, pick from 3 visual templates (Minimal / Sidebar / Bold), add a photo, generate a resume, export to PDF or `.txt`.
- **AI Career Assistant** — chat about your resume/matches, powered by the real Anthropic API (needs your own key).

## Tech stack

| Layer      | Tech                          |
|------------|--------------------------------|
| Backend    | Python, FastAPI, Uvicorn       |
| Database   | SQLite (swap for PostgreSQL/MySQL in production) |
| Frontend   | HTML, CSS, vanilla JavaScript  |
| Skill engine | Rule-based NLP: vocabulary + synonyms + fuzzy matching (see `backend/app.py`) |
| AI Assistant | Anthropic API (`claude-sonnet-5` by default, configurable) |
| File parsing | `pypdf`, `python-docx` |

## Project structure
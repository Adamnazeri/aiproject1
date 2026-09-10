-- AI Resume / Job Matcher — Database Schema (SQLite)

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    plan TEXT DEFAULT 'free',           -- 'free' or 'pro' (mock subscription)
    plan_started_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resumes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    extracted_skills TEXT,          -- JSON array of skills, stored as text
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    description TEXT NOT NULL,
    required_skills TEXT NOT NULL,  -- JSON array of skills, stored as text
    preferred_skills TEXT DEFAULT '[]', -- JSON array, "nice to have" skills
    location TEXT,
    logo_emoji TEXT DEFAULT '🏢',
    salary_min INTEGER,
    salary_max INTEGER,
    currency TEXT DEFAULT 'MYR',
    employment_type TEXT,           -- e.g. Full-time, Part-time, Contract
    experience_required TEXT,       -- free-text range, e.g. "2-4 years"
    education_required TEXT,        -- free-text, e.g. "Degree"
    industry TEXT,
    application_url TEXT,
    source TEXT,                    -- where the listing came from
    posted_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    closing_date TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, job_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    resume_id INTEGER,
    status TEXT NOT NULL DEFAULT 'saved', -- saved, applied, screening, interview, offer, rejected
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id),
    FOREIGN KEY (resume_id) REFERENCES resumes(id)
);

CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resume_id INTEGER NOT NULL,
    job_id INTEGER NOT NULL,
    score REAL NOT NULL,            -- 0.0 - 100.0
    matched_skills TEXT,            -- JSON array
    missing_skills TEXT,            -- JSON array
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resume_id) REFERENCES resumes(id),
    FOREIGN KEY (job_id) REFERENCES jobs(id)
);

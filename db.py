"""Database access for SQLite (local, default) and PostgreSQL (DATABASE_URL, e.g. Render Postgres).

Application SQL is written once with `?` placeholders. The PostgreSQL adapter translates placeholders,
serializes writers with a transaction-scoped advisory lock (matching SQLite's BEGIN IMMEDIATE), and
returns rows that support both `row['column']` and `row[0]`.
"""
import os
import sqlite3

DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
POSTGRES = DATABASE_URL.startswith(('postgres://', 'postgresql://'))

if POSTGRES:
    import psycopg
    IntegrityErrors = (sqlite3.IntegrityError, psycopg.IntegrityError)
else:
    psycopg = None
    IntegrityErrors = (sqlite3.IntegrityError,)

SCHEMA = '''
CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,version INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,recovery TEXT NOT NULL,role TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,"user" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),email TEXT NOT NULL,role TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id {serial} PRIMARY KEY,tenant TEXT,"user" TEXT,action TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,terms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS guest_sessions(token TEXT PRIMARY KEY,guest TEXT NOT NULL REFERENCES guests(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY,code TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otp_log(id {serial} PRIMARY KEY,phone TEXT NOT NULL,ip TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id {serial} PRIMARY KEY,tenant TEXT NOT NULL,audience TEXT NOT NULL,guest TEXT,kind TEXT,title TEXT NOT NULL,body TEXT NOT NULL,ref TEXT,created INTEGER NOT NULL,read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ratings(tenant TEXT NOT NULL REFERENCES tenants(id),guest TEXT NOT NULL REFERENCES guests(id),stars INTEGER NOT NULL,comment TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(tenant,guest));
CREATE TABLE IF NOT EXISTS uploads(name TEXT PRIMARY KEY,mime TEXT NOT NULL,data {blob} NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notifications_guest ON notifications(guest,created);
CREATE INDEX IF NOT EXISTS notifications_tenant ON notifications(tenant,audience,created);
'''


class Row(dict):
    """Row usable by column name and by position."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def _row_factory(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: Row(zip(names, values))


class PostgresConnection:
    WRITE_LOCK = 734117  # arbitrary advisory-lock id shared by all Encore writers

    def __init__(self):
        self.raw = psycopg.connect(DATABASE_URL, row_factory=_row_factory, connect_timeout=10)

    def execute(self, sql, params=()):
        statement = sql.strip().upper()
        if statement == 'BEGIN IMMEDIATE':
            return self.raw.execute('SELECT pg_advisory_xact_lock(%s)', (self.WRITE_LOCK,))
        if statement == 'COMMIT':
            self.raw.commit()
            return None
        return self.raw.execute(sql.replace('?', '%s'), params)

    def executescript(self, script):
        for statement in script.split(';'):
            if statement.strip():
                self.raw.execute(statement)

    @property
    def in_transaction(self):
        return self.raw.info.transaction_status != psycopg.pq.TransactionStatus.IDLE

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if exc_type:
                self.raw.rollback()
            else:
                self.raw.commit()
        finally:
            self.raw.close()
        return False


def connect(sqlite_path):
    if POSTGRES:
        return PostgresConnection()
    c = sqlite3.connect(sqlite_path, timeout=10)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    return c


def create_schema(c):
    if POSTGRES:
        c.executescript(SCHEMA.format(serial='BIGSERIAL', blob='BYTEA'))
    else:
        c.executescript('PRAGMA journal_mode=WAL;' + SCHEMA.format(serial='INTEGER', blob='BLOB'))


def migrate(c):
    """Additive column migrations for databases created by earlier versions."""
    if POSTGRES:
        c.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT ''")
    else:
        columns = {r[1] for r in c.execute('PRAGMA table_info(users)')}
        if 'avatar' not in columns:
            c.execute("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")


def describe():
    return 'PostgreSQL' if POSTGRES else 'SQLite'

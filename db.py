"""PostgreSQL access for Encore. One database, everywhere: development, tests and production.

Set `DATABASE_URL`; there is no second database engine and no local file fallback. Application SQL is
written with `?` placeholders that this adapter translates, writers are serialized with a
transaction-scoped advisory lock (`BEGIN IMMEDIATE`), and rows support `row['column']` and `row[0]`.
"""
import os

import psycopg

DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()
POOL_SIZE = int(os.environ.get('DB_POOL_SIZE', '8'))
_pool = None
IntegrityErrors = (psycopg.IntegrityError,)

try:  # a pool avoids a TCP + TLS handshake on every request
    from psycopg_pool import ConnectionPool
except ImportError:  # pragma: no cover - one connection per request still works
    ConnectionPool = None


class NotConfigured(RuntimeError):
    """Raised when DATABASE_URL is missing or is not a PostgreSQL URL."""


def require_url():
    if not DATABASE_URL.startswith(('postgres://', 'postgresql://')):
        raise NotConfigured(
            'DATABASE_URL must be a PostgreSQL connection string, for example '
            'postgresql://encore:password@localhost:5432/encore. See README → Database.')
    return DATABASE_URL

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
CREATE TABLE IF NOT EXISTS platform_admins(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_sessions(token TEXT PRIMARY KEY,admin TEXT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_audit(id {serial} PRIMARY KEY,admin TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notifications_guest ON notifications(guest,created);
CREATE INDEX IF NOT EXISTS notifications_tenant ON notifications(tenant,audience,created);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires);
CREATE INDEX IF NOT EXISTS guest_sessions_expires ON guest_sessions(expires);
CREATE INDEX IF NOT EXISTS platform_sessions_expires ON platform_sessions(expires);
CREATE INDEX IF NOT EXISTS users_tenant ON users(tenant);
CREATE INDEX IF NOT EXISTS invites_expires ON invites(expires);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit(tenant,created);
CREATE INDEX IF NOT EXISTS otp_log_phone ON otp_log(phone,created);
CREATE INDEX IF NOT EXISTS uploads_created ON uploads(created);
'''

# Rows nobody reads again. Cleaned hourly so the database does not grow without limit.
RETENTION = [
    ('DELETE FROM sessions WHERE expires<?', 0),
    ('DELETE FROM guest_sessions WHERE expires<?', 0),
    ('DELETE FROM platform_sessions WHERE expires<?', 0),
    ('DELETE FROM invites WHERE expires<?', 0),
    ('DELETE FROM otps WHERE expires<?', 0),
    ('DELETE FROM otp_log WHERE created<?', 86400),
    ('DELETE FROM notifications WHERE read=1 AND created<?', 180 * 86400),
    ('DELETE FROM audit WHERE created<?', 400 * 86400),
    ('DELETE FROM platform_audit WHERE created<?', 400 * 86400),
]


class Row(dict):
    """Row usable by column name and by position."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)


def _row_factory(cursor):
    names = [c.name for c in cursor.description] if cursor.description else []
    return lambda values: Row(zip(names, values))


def pool():
    """Shared connection pool, opened on first use."""
    global _pool
    if _pool is None and ConnectionPool:
        _pool = ConnectionPool(require_url(), min_size=1, max_size=POOL_SIZE, timeout=15, max_idle=300,
                               kwargs={'row_factory': _row_factory, 'connect_timeout': 10}, open=True)
    return _pool


def reset_pool():
    """Close the pool so a new DATABASE_URL takes effect (used by the tests)."""
    global _pool, DATABASE_URL
    if _pool is not None:
        _pool.close()
        _pool = None
    DATABASE_URL = os.environ.get('DATABASE_URL', '').strip()


class PostgresConnection:
    WRITE_LOCK = 734117  # arbitrary advisory-lock id shared by all Encore writers

    def __init__(self):
        self.pooled = pool()
        self.raw = self.pooled.getconn() if self.pooled else psycopg.connect(require_url(), row_factory=_row_factory, connect_timeout=10)

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
            if self.pooled:
                self.pooled.putconn(self.raw)
            else:
                self.raw.close()
        return False


def connect():
    return PostgresConnection()


def create_schema(c):
    c.executescript(SCHEMA.format(serial='BIGSERIAL', blob='BYTEA'))


def migrate(c):
    """Additive column migrations for databases created by earlier versions."""
    added = [('users', 'avatar', "TEXT NOT NULL DEFAULT ''"),
             ('tenants', 'status', "TEXT NOT NULL DEFAULT 'active'"),
             ('tenants', 'status_note', "TEXT NOT NULL DEFAULT ''"),
             ('tenants', 'created', 'INTEGER NOT NULL DEFAULT 0')]
    for table, column, definition in added:
        c.execute(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {definition}')


def clean_old_rows(c, now):
    """Delete expired sessions, codes and stale logs. Safe to run at any time."""
    removed = 0
    for sql, age in RETENTION:
        cursor = c.execute(sql, (now - age,))
        removed += getattr(cursor, 'rowcount', 0) or 0
    return removed


def describe():
    """Human-readable target, without credentials: postgresql://user:pass@host:5432/name -> host:5432/name."""
    if not DATABASE_URL:
        return 'PostgreSQL (not configured)'
    tail = DATABASE_URL.split('@')[-1].split('?')[0].lstrip('/') or 'local socket'
    return f'PostgreSQL ({tail})'

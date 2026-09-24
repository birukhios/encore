using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Encore.Api.Persistence.Migrations
{
    /// <summary>
    /// Describes the schema db.py already created on every Encore database. It is written with IF NOT EXISTS,
    /// exactly as db.create_schema and db.migrate run it, so applying it to the live database changes nothing
    /// and applying it to an empty one produces the same tables Python expects.
    /// </summary>
    public partial class BaselineLegacySchema : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"
CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,version INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,recovery TEXT NOT NULL,role TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,""user"" TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY,tenant TEXT NOT NULL REFERENCES tenants(id),email TEXT NOT NULL,role TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id BIGSERIAL PRIMARY KEY,tenant TEXT,""user"" TEXT,action TEXT,created INTEGER);
CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL,created INTEGER NOT NULL,terms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS guest_sessions(token TEXT PRIMARY KEY,guest TEXT NOT NULL REFERENCES guests(id),expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otps(phone TEXT PRIMARY KEY,code TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,sent INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otp_log(id BIGSERIAL PRIMARY KEY,phone TEXT NOT NULL,ip TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id BIGSERIAL PRIMARY KEY,tenant TEXT NOT NULL,audience TEXT NOT NULL,guest TEXT,kind TEXT,title TEXT NOT NULL,body TEXT NOT NULL,ref TEXT,created INTEGER NOT NULL,read INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS ratings(tenant TEXT NOT NULL REFERENCES tenants(id),guest TEXT NOT NULL REFERENCES guests(id),stars INTEGER NOT NULL,comment TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(tenant,guest));
CREATE TABLE IF NOT EXISTS uploads(name TEXT PRIMARY KEY,mime TEXT NOT NULL,data BYTEA NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_admins(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_sessions(token TEXT PRIMARY KEY,admin TEXT NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS platform_audit(id BIGSERIAL PRIMARY KEY,admin TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL DEFAULT '',detail TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
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
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status_note TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created INTEGER NOT NULL DEFAULT 0;
");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            throw new NotSupportedException("The baseline holds live customer data and is never rolled back.");
        }
    }
}

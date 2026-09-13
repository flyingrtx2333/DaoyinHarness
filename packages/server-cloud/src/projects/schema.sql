CREATE TABLE IF NOT EXISTS harness_projects (
 id text PRIMARY KEY, owner_key text NOT NULL, title text NOT NULL,
 slug text NOT NULL UNIQUE, revision integer NOT NULL DEFAULT 1,
 active_version text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS harness_projects_owner ON harness_projects(owner_key);
CREATE TABLE IF NOT EXISTS harness_project_files (
 project_id text NOT NULL REFERENCES harness_projects(id), path text NOT NULL,
 content text NOT NULL, PRIMARY KEY(project_id,path)
);
CREATE TABLE IF NOT EXISTS harness_project_sessions (
 owner_key text NOT NULL, session_id text NOT NULL, project_id text NOT NULL REFERENCES harness_projects(id),
 PRIMARY KEY(owner_key,session_id)
);
CREATE TABLE IF NOT EXISTS harness_project_versions (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES harness_projects(id),
 revision integer NOT NULL, digest text NOT NULL, files jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(project_id,digest)
);
CREATE TABLE IF NOT EXISTS harness_project_operations (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES harness_projects(id), request_id text NOT NULL,
 kind text NOT NULL, input_hash text NOT NULL, status text NOT NULL DEFAULT 'queued',
 result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(project_id,request_id)
);
CREATE TABLE IF NOT EXISTS harness_project_deployments (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES harness_projects(id),
 version_id text NOT NULL REFERENCES harness_project_versions(id), operation_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS harness_project_preview_tickets (
 token_hash text PRIMARY KEY, project_id text NOT NULL REFERENCES harness_projects(id), owner_key text NOT NULL,
 expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE IF NOT EXISTS harness_project_preview_sessions (
 token_hash text PRIMARY KEY, project_id text NOT NULL REFERENCES harness_projects(id), owner_key text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS harness_project_executor_lease (
 singleton integer PRIMARY KEY CHECK(singleton=1), owner text NOT NULL, expires_at timestamptz NOT NULL
);

ALTER TABLE harness_project_operations ADD COLUMN IF NOT EXISTS authorization jsonb;
ALTER TABLE harness_project_operations ADD COLUMN IF NOT EXISTS source_run text;

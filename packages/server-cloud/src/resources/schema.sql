CREATE TABLE IF NOT EXISTS harness_resources (
 id text PRIMARY KEY, owner_key text NOT NULL, kind text NOT NULL, title text NOT NULL,
 version integer NOT NULL DEFAULT 1, capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind IN ('workspace','database','browser','artifact','deployment','business'))
);
CREATE INDEX IF NOT EXISTS harness_resources_owner ON harness_resources(owner_key,updated_at DESC);

CREATE TABLE IF NOT EXISTS harness_session_resources (
 owner_key text NOT NULL, session_id text NOT NULL, resource_id text NOT NULL REFERENCES harness_resources(id),
 attached_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_key,session_id,resource_id)
);

CREATE TABLE IF NOT EXISTS harness_runtime_bindings (
 resource_id text PRIMARY KEY REFERENCES harness_resources(id), host_path text NOT NULL, target_path text NOT NULL,
 read_only boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS harness_workspaces (
 resource_id text PRIMARY KEY REFERENCES harness_resources(id), source jsonb NOT NULL, runtime jsonb NOT NULL,
 active_snapshot_id text, state text NOT NULL DEFAULT 'creating', error text,
 CHECK(state IN ('creating','ready','failed','archived'))
);

CREATE TABLE IF NOT EXISTS harness_workspace_snapshots (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id), parent_snapshot_id text,
 digest text NOT NULL, manifest jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,digest)
);
CREATE INDEX IF NOT EXISTS harness_workspace_snapshots_workspace
 ON harness_workspace_snapshots(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS harness_artifacts (
 resource_id text PRIMARY KEY REFERENCES harness_resources(id), workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id),
 snapshot_id text, media_type text NOT NULL, size_bytes bigint NOT NULL, blob_hash text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS harness_deployments (
 resource_id text PRIMARY KEY REFERENCES harness_resources(id), workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id),
 artifact_id text NOT NULL REFERENCES harness_artifacts(resource_id), status text NOT NULL,
 endpoint text, previous_deployment_id text, operation_id text NOT NULL,
 CHECK(status IN ('queued','starting','healthy','failed','rolled_back'))
);
CREATE UNIQUE INDEX IF NOT EXISTS harness_deployments_operation
 ON harness_deployments(workspace_id,operation_id);
CREATE INDEX IF NOT EXISTS harness_deployments_endpoint
 ON harness_deployments(endpoint,status) WHERE endpoint IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_deployment_endpoints (
 endpoint text PRIMARY KEY, owner_key text NOT NULL, workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id),
 claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_workspace_operations (
 id text PRIMARY KEY, owner_key text NOT NULL, workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id),
 request_id text NOT NULL, kind text NOT NULL, input_hash text NOT NULL, status text NOT NULL DEFAULT 'queued',
 source_run text, result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,request_id)
);

CREATE TABLE IF NOT EXISTS harness_process_sessions (
 id text PRIMARY KEY, owner_key text NOT NULL, workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id),
 run_id text NOT NULL, executable text NOT NULL, args jsonb NOT NULL, cwd text NOT NULL, mode text NOT NULL,
 status text NOT NULL, exit_code integer, output_cursor bigint NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL DEFAULT now(), timeout_at timestamptz, finished_at timestamptz,
 CHECK(mode IN ('foreground','background','pty')),
 CHECK(status IN ('starting','running','exited','failed','cancelled','timed_out','interrupted'))
);
CREATE INDEX IF NOT EXISTS harness_process_sessions_workspace
 ON harness_process_sessions(workspace_id,started_at DESC);
ALTER TABLE harness_process_sessions ADD COLUMN IF NOT EXISTS timeout_at timestamptz;

CREATE TABLE IF NOT EXISTS harness_network_audit (
 id bigserial PRIMARY KEY, owner_key text NOT NULL, workspace_id text NOT NULL REFERENCES harness_workspaces(resource_id),
 run_id text NOT NULL, process_id text, hostname text NOT NULL, port integer NOT NULL, method text,
 bytes_sent bigint NOT NULL DEFAULT 0, bytes_received bigint NOT NULL DEFAULT 0,
 decision text NOT NULL, reason text, occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_resource_events (
 sequence bigserial PRIMARY KEY, owner_key text NOT NULL, session_id text, run_id text,
 request_id text, resource_id text, event_type text NOT NULL, payload jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS harness_resource_events_scope
 ON harness_resource_events(owner_key,sequence);
CREATE INDEX IF NOT EXISTS harness_resource_events_run
 ON harness_resource_events(run_id,sequence) WHERE run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION harness_resource_events_immutable() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'harness_resource_events is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS harness_resource_events_no_update ON harness_resource_events;
CREATE TRIGGER harness_resource_events_no_update BEFORE UPDATE OR DELETE ON harness_resource_events
 FOR EACH ROW EXECUTE FUNCTION harness_resource_events_immutable();

CREATE TABLE IF NOT EXISTS harness_resource_migrations (
 legacy_kind text NOT NULL, legacy_id text NOT NULL, resource_id text NOT NULL REFERENCES harness_resources(id),
 migrated_at timestamptz NOT NULL DEFAULT now(), digest text NOT NULL,
 PRIMARY KEY(legacy_kind,legacy_id), UNIQUE(resource_id)
);

DO $$ BEGIN
 ALTER TABLE harness_workspaces
  ADD CONSTRAINT harness_workspaces_active_snapshot_fk
  FOREIGN KEY(active_snapshot_id) REFERENCES harness_workspace_snapshots(id)
  DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

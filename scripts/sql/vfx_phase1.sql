-- VFX Studio — project table. Run once in the Supabase SQL editor.
--
-- The app keeps each project as ONE JSON document (src/lib/vfx/types.ts). Until this table
-- exists the document lives only in Storage (kruth-ai-assets/vfx_projects/<email>/<id>.json).
-- Once the table exists, src/lib/vfx/store.ts detects it (one probe per process) and starts
-- writing the document into `doc` with summary columns alongside, reading from the row first;
-- the storage file remains a write-through copy. No code change or redeploy is needed.
--
-- Existing storage-only projects appear in the table the next time they are saved
-- (any action on them), or run the backfill note at the bottom.

create table if not exists vfx_projects (
  id text primary key,
  user_id uuid,
  user_email text not null,
  name text not null,
  footage_url text not null,
  footage jsonb not null default '{}',        -- {seconds,width,height,fps}
  reference_urls jsonb not null default '[]',
  instruction text not null default '',
  engine text not null default 'matte',       -- matte | o3
  grade text not null default 'none',         -- none | match | warm | cool | cinematic
  status text not null default 'draft',       -- draft | planned | processing | review | exported
  estimated_credits numeric not null default 0,
  charged_credits numeric not null default 0,
  export_url text,
  shots_count int not null default 0,
  doc jsonb not null,                         -- the full project document (shots + layers + history)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists vfx_projects_user_idx on vfx_projects(user_email, updated_at desc);
create index if not exists vfx_projects_status_idx on vfx_projects(status);

-- Service-role access only (the app's server routes); no browser access.
alter table vfx_projects enable row level security;

-- Optional, for reporting: shots and layers flattened out of the document.
create or replace view vfx_shots_v as
select p.id as project_id, p.user_email, s->>'id' as shot_id, (s->>'order')::int as shot_order,
       (s->>'start')::numeric as start_sec, (s->>'end')::numeric as end_sec,
       s->>'status' as status, s->>'output_url' as output_url
from vfx_projects p, jsonb_array_elements(p.doc->'shots') s;

create or replace view vfx_layers_v as
select p.id as project_id, s->>'id' as shot_id, l->>'id' as layer_id, l->>'type' as type,
       (l->>'enabled')::boolean as enabled, (l->>'version')::int as version, l->>'status' as status,
       (l->>'cost_credits')::numeric as cost_credits, l->>'model_id' as model_id, l->'params' as params, l->'output' as output
from vfx_projects p, jsonb_array_elements(p.doc->'shots') s, jsonb_array_elements(s->'layers') l;

-- Layer jobs themselves ride on the existing `generations` table (metadata.mode = 'vfx-layer',
-- metadata.vfx_project_id / vfx_shot_id / vfx_layer_id), so the server-side driver
-- (/api/cron/drive) and /api/video-status carry them with no new worker.

-- Backfill: existing storage documents are imported by opening them in the studio (any
-- save writes the row). A bulk import script can be added if there are many.

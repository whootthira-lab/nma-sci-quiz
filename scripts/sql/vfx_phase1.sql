-- VFX Studio Phase 1 — relational form of the project document (src/lib/vfx/types.ts).
--
-- The running code keeps each project as ONE JSON document in Storage
-- (kruth-ai-assets/vfx_projects/<email>/<project_id>.json) because the app has no
-- direct database connection for migrations and nothing may block a deploy on a
-- manual step. Run this in the Supabase SQL editor when the document store should
-- move into tables; src/lib/vfx/store.ts is the only module that would change.

create table if not exists vfx_projects (
  id text primary key,
  user_id uuid references profiles(id),
  user_email text not null,
  name text not null,
  footage_url text not null,
  footage jsonb not null,             -- {seconds,width,height,fps}
  reference_urls jsonb not null default '[]',
  instruction text not null default '',
  engine text not null default 'matte', -- matte | o3
  grade text not null default 'none',
  status text not null default 'draft', -- draft | planned | processing | review | exported
  estimated_credits numeric not null default 0,
  charged_credits numeric not null default 0,
  export_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists vfx_shots (
  id text primary key,
  project_id text not null references vfx_projects(id) on delete cascade,
  "order" int not null,
  start_sec numeric not null,
  end_sec numeric not null,
  clip_url text not null,
  thumb_url text,
  width int, height int, fps numeric,
  analysis jsonb,
  status text not null default 'draft', -- draft | processing | review | approved | failed
  output_url text,
  error text
);

create table if not exists vfx_layers (
  id text primary key,
  shot_id text not null references vfx_shots(id) on delete cascade,
  type text not null,                 -- matte | background | grade | composite | edit
  enabled boolean not null default true,
  params jsonb not null default '{}',
  model_id text,
  cost_credits numeric not null default 0,
  version int not null default 1,
  status text not null default 'pending', -- pending | processing | done | failed | skipped
  job_request_id text,
  output jsonb not null default '{}',
  history jsonb not null default '[]',
  error text,
  updated_at timestamptz not null default now()
);

-- Layer jobs themselves ride on the existing `generations` table (metadata.mode = 'vfx-layer',
-- metadata.vfx_project_id / vfx_shot_id / vfx_layer_id), so the server-side driver
-- (/api/cron/drive) and /api/video-status carry them with no new worker.

create index if not exists vfx_projects_user_idx on vfx_projects(user_email, updated_at desc);
create index if not exists vfx_shots_project_idx on vfx_shots(project_id, "order");
create index if not exists vfx_layers_shot_idx on vfx_layers(shot_id);

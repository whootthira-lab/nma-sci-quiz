-- Columns the app writes but the live `characters` table does not have (checked 10 ก.ย. 2569).
-- Run in the Supabase SQL editor. Safe to re-run.
--   default_voice_id / default_tts_provider: DialogueTabForm "บันทึกเสียงประจำตัวละคร" (fails silently today)
--   lora_dataset_path: no longer written (train-lora derives the path from lora_dataset_url); add only if you want it
alter table public.characters add column if not exists default_voice_id text;
alter table public.characters add column if not exists default_tts_provider text;
